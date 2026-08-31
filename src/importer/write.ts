// 导入写入：确认后的导入计划 → SQLite（单事务），含重复导入防护

import type Database from 'better-sqlite3'
import { reconstructNavPoints } from '../engine'
import { hasAnyData } from '../main/repo'
import type { CommitPayload, ImportCounts } from './types'

export function importToDb(db: Database.Database, plan: CommitPayload): ImportCounts {
  // 重复导入防护：库内已有数据则拒绝（明确提示，不静默去重）
  if (hasAnyData(db)) {
    throw new Error('数据库已有数据，重复导入会产生重复数据，已阻止导入。如需重新导入，请先清空数据库。')
  }

  // 以确认后的最终流水重建净值历史；当前净值日期校正为流水最大日期
  const { points, skipped } = reconstructNavPoints(plan.snapshots, plan.transactions)
  const maxDate = plan.transactions.reduce((m, t) => (t.date > m ? t.date : m), '')
  const currentNavs = plan.currentNavs.map((p) => ({ ...p, date: maxDate }))

  const now = new Date().toISOString()
  const insertFund = db.prepare(
    'INSERT INTO funds (code, name, category, fund_type, target_amount, created_at) VALUES (?,?,?,?,?,?)'
  )
  const insertTarget = db.prepare(
    'INSERT OR REPLACE INTO category_targets (category, target_ratio) VALUES (?,?)'
  )
  const insertTx = db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  const insertNav = db.prepare(
    'INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)'
  )
  // 当前净值用 REPLACE：若最大流水日恰为某快照日，以持仓概览当前净值为准
  const replaceNav = db.prepare(
    'INSERT OR REPLACE INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)'
  )

  db.transaction(() => {
    for (const f of plan.funds) {
      insertFund.run(f.code, f.name, f.category, f.fundType, f.targetAmount, now)
    }
    for (const t of plan.categoryTargets) {
      insertTarget.run(t.category, t.targetRatio)
    }
    for (const t of plan.transactions) {
      insertTx.run(t.date, t.type, t.fundCode, t.amount, t.shares, t.nav, t.fee, t.note, now, now)
    }
    for (const p of points) {
      insertNav.run(p.fundCode, p.date, p.nav, 'import')
    }
    for (const p of currentNavs) {
      replaceNav.run(p.fundCode, p.date, p.nav, 'import')
    }
  })()

  return {
    funds: plan.funds.length,
    categoryTargets: plan.categoryTargets.length,
    transactions: plan.transactions.length,
    reconstructedNavs: points.length,
    currentNavs: currentNavs.length,
    skippedSnapshots: skipped.length
  }
}
