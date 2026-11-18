// 数据访问层：数据库行 ↔ 领域类型（snake_case ↔ camelCase）

import type Database from 'better-sqlite3'
import type { BucketTarget, Fund, NavPoint, Transaction, TransactionRow } from '../engine'

/** 写入完整基金行；创建基金与 Excel 导入共用同一列集合，避免加列时漏改 */
export function insertFund(db: Database.Database, fund: Fund, createdAt: string): void {
  db.prepare(
    `INSERT INTO funds
       (code, name, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    fund.code,
    fund.name,
    fund.fundType,
    fund.ledgerCategory,
    fund.productForm,
    fund.equityRatio,
    fund.equityRatioSource,
    fund.equityRatioAsOf,
    createdAt
  )
}

/** 基金配置更新：代码只作定位条件、不参与写入；可变字段的列集合集中于此 */
export function updateFundRow(
  db: Database.Database,
  fund: Pick<
    Fund,
    'code' | 'name' | 'productForm' | 'ledgerCategory' | 'equityRatio' | 'equityRatioSource'
  >
): void {
  db.prepare(
    `UPDATE funds
     SET name = ?, product_form = ?, ledger_category = ?, equity_ratio = ?, equity_ratio_source = ?
     WHERE code = ?`
  ).run(
    fund.name,
    fund.productForm,
    fund.ledgerCategory,
    fund.equityRatio,
    fund.equityRatioSource,
    fund.code
  )
}

/** 抓取候选值确认写入：只更新权益系数、来源与数据日期（名称/分类/代码不动） */
export function updateFundEquityRatio(
  db: Database.Database,
  update: Pick<Fund, 'code' | 'equityRatio' | 'equityRatioSource' | 'equityRatioAsOf'>
): void {
  const info = db
    .prepare(
      `UPDATE funds
       SET equity_ratio = ?, equity_ratio_source = ?, equity_ratio_as_of = ?
       WHERE code = ?`
    )
    .run(update.equityRatio, update.equityRatioSource, update.equityRatioAsOf, update.code)
  if (info.changes === 0) throw new Error(`基金 ${update.code} 不存在`)
}

/** 基金读取（最终模型） */
export function selectFunds(db: Database.Database): Fund[] {
  const rows = db
    .prepare(
      `SELECT code, name, fund_type, ledger_category, product_form,
              equity_ratio, equity_ratio_source, equity_ratio_as_of
       FROM funds ORDER BY code`
    )
    .all() as {
    code: string
    name: string
    fund_type: string | null
    ledger_category: Fund['ledgerCategory']
    product_form: Fund['productForm']
    equity_ratio: number
    equity_ratio_source: Fund['equityRatioSource']
    equity_ratio_as_of: string | null
  }[]
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    fundType: r.fund_type,
    ledgerCategory: r.ledger_category,
    productForm: r.product_form,
    equityRatio: r.equity_ratio,
    equityRatioSource: r.equity_ratio_source,
    equityRatioAsOf: r.equity_ratio_as_of
  }))
}

/** 配置桶目标比例；顺序不属于本函数的契约（见 ALLOCATION_BUCKETS）。 */
export function selectBucketTargets(db: Database.Database): BucketTarget[] {
  const rows = db
    .prepare('SELECT bucket, target_ratio FROM bucket_targets')
    .all() as { bucket: BucketTarget['bucket']; target_ratio: number }[]
  return rows.map((r) => ({ bucket: r.bucket, targetRatio: r.target_ratio }))
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
