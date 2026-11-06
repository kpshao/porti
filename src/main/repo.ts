// 数据访问层：数据库行 ↔ 领域类型（snake_case ↔ camelCase）

import type Database from 'better-sqlite3'
import type { CategoryTarget, Fund, NavPoint, Transaction, TransactionRow } from '../engine'

export function selectFunds(db: Database.Database): Fund[] {
  const rows = db
    .prepare('SELECT code, name, category, fund_type FROM funds ORDER BY code')
    .all() as { code: string; name: string; category: string; fund_type: string | null }[]
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    fundType: r.fund_type
  }))
}

/** 大类目标比例。顺序不属于本函数的契约——消费方 computeCategoryComparison 负责按 CATEGORIES 排序。 */
export function selectCategoryTargets(db: Database.Database): CategoryTarget[] {
  const rows = db
    .prepare('SELECT category, target_ratio FROM category_targets')
    .all() as { category: string; target_ratio: number }[]
  return rows.map((r) => ({ category: r.category, targetRatio: r.target_ratio }))
}

export function selectTransactions(db: Database.Database): TransactionRow[] {
  const rows = db
    .prepare(
      'SELECT id, date, type, fund_code, amount, shares, nav, fee, note FROM transactions ORDER BY date, id'
    )
    .all() as {
    id: number
    date: string
    type: Transaction['type']
    fund_code: string
    amount: number
    shares: number | null
    nav: number | null
    fee: number | null
    note: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    type: r.type,
    fundCode: r.fund_code,
    amount: r.amount,
    shares: r.shares,
    nav: r.nav,
    fee: r.fee,
    note: r.note
  }))
}

export function selectNavPoints(db: Database.Database): NavPoint[] {
  const rows = db
    .prepare('SELECT fund_code, date, nav, source FROM nav_history ORDER BY date, fund_code')
    .all() as { fund_code: string; date: string; nav: number; source: NavPoint['source'] }[]
  return rows.map((r) => ({
    fundCode: r.fund_code,
    date: r.date,
    nav: r.nav,
    source: r.source
  }))
}

/** 库内是否已有任何数据（重复导入防护用） */
export function hasAnyData(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM funds) + (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM nav_history) AS n`
    )
    .get() as { n: number }
  return row.n > 0
}
