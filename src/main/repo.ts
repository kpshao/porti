// 数据访问层：数据库行 ↔ 领域类型（snake_case ↔ camelCase）

import type Database from 'better-sqlite3'
import { resolveLegacyCategory } from '../engine'
import type {
  BucketTarget,
  CategoryTarget,
  ClassifiedFund,
  NavPoint,
  Transaction,
  TransactionRow
} from '../engine'

/** 写入完整基金行；创建基金与 Excel 导入共用同一列集合，避免加列时漏改 */
export function insertFund(db: Database.Database, fund: ClassifiedFund, createdAt: string): void {
  db.prepare(
    `INSERT INTO funds
       (code, name, category, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    fund.code,
    fund.name,
    fund.category,
    fund.fundType,
    fund.ledgerCategory,
    fund.productForm,
    fund.equityRatio,
    fund.equityRatioSource,
    fund.equityRatioAsOf,
    createdAt
  )
}

/** 基金读取：funds 表还没有新模型字段时按旧五类派生，令旧结构与迁移中的库仍可读取 */
export function selectFunds(db: Database.Database): ClassifiedFund[] {
  const columns = (db.prepare('PRAGMA table_info(funds)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!columns.includes('product_form')) {
    const rows = db
      .prepare('SELECT code, name, category, fund_type FROM funds ORDER BY code')
      .all() as { code: string; name: string; category: string; fund_type: string | null }[]
    return rows.map((r) => {
      const legacy = resolveLegacyCategory(r.category)
      if (legacy === null) {
        throw new Error(`无法识别的旧大类「${r.category}」（基金 ${r.code}），迁移尚未完成`)
      }
      return {
        code: r.code,
        name: r.name,
        category: r.category,
        fundType: r.fund_type,
        ...legacy.classification
      }
    })
  }

  const rows = db
    .prepare(
      `SELECT code, name, category, fund_type, ledger_category, product_form,
              equity_ratio, equity_ratio_source, equity_ratio_as_of
       FROM funds ORDER BY code`
    )
    .all() as {
    code: string
    name: string
    category: string
    fund_type: string | null
    ledger_category: ClassifiedFund['ledgerCategory']
    product_form: ClassifiedFund['productForm']
    equity_ratio: number
    equity_ratio_source: ClassifiedFund['equityRatioSource']
    equity_ratio_as_of: string | null
  }[]
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    fundType: r.fund_type,
    ledgerCategory: r.ledger_category,
    productForm: r.product_form,
    equityRatio: r.equity_ratio,
    equityRatioSource: r.equity_ratio_source,
    equityRatioAsOf: r.equity_ratio_as_of
  }))
}

/** 大类目标比例。顺序不属于本函数的契约——消费方 computeCategoryComparison 负责按 CATEGORIES 排序。 */
export function selectCategoryTargets(db: Database.Database): CategoryTarget[] {
  const rows = db
    .prepare('SELECT category, target_ratio FROM category_targets')
    .all() as { category: string; target_ratio: number }[]
  return rows.map((r) => ({ category: r.category, targetRatio: r.target_ratio }))
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
