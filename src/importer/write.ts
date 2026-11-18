// 导入写入：确认后的导入计划 → SQLite（单事务），含重复导入防护

import type Database from 'better-sqlite3'
import { normalizeFundInput, reconstructNavPoints, resolveProductFormLabel } from '../engine'
import type { ClassifiedFund, Fund } from '../engine'
import { hasAnyData, insertFund } from '../main/repo'
import type { CommitPayload, ImportCounts } from './types'

/**
 * 导入基金归一化：大类/产品形态标签映射为产品形态后，复用新建基金的同一校验与默认值，
 * 保证导入不会绕过产品形态 / 账本大类的一致性与权益系数规则。
 */
function normalizeImportedFund(fund: Fund): ClassifiedFund {
  const productForm = fund.productForm ?? resolveProductFormLabel(fund.category)
  if (productForm === null) {
    const label = fund.category.trim() === '' ? (fund.fundType ?? '空') : fund.category
    throw new Error(`无法识别的大类或类型「${label}」（基金 ${fund.code}）`)
  }
  return normalizeFundInput({
    code: fund.code,
    name: fund.name,
    productForm,
    fundType: fund.fundType
  })
}

export function importToDb(db: Database.Database, plan: CommitPayload): ImportCounts {
  // 重复导入防护：库内已有数据则拒绝（明确提示，不静默去重）
  if (hasAnyData(db)) {
    throw new Error('数据库已有数据，重复导入会产生重复数据，已阻止导入。如需重新导入，请先清空数据库。')
  }

  // 统一写入校验：标签映射产品形态后，走新建基金同一套规则（派生账本大类与默认系数）；
  // 未知标签明确报错，不静默兜底（预览阶段的警告见 parse.ts）
  const funds = plan.funds.map(normalizeImportedFund)

  // 以确认后的最终流水重建净值历史；当前净值日期校正为流水最大日期
  const { points, skipped } = reconstructNavPoints(plan.snapshots, plan.transactions)
  const maxDate = plan.transactions.reduce((m, t) => (t.date > m ? t.date : m), '')
  const currentNavs = plan.currentNavs.map((p) => ({ ...p, date: maxDate }))

  const now = new Date().toISOString()
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
    for (const f of funds) {
      insertFund(db, f, now)
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
    transactions: plan.transactions.length,
    reconstructedNavs: points.length,
    currentNavs: currentNavs.length,
    skippedSnapshots: skipped.length
  }
}
