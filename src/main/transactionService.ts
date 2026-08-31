// 流水与基金的增删改服务（数据访问层 + 领域校验）

import type Database from 'better-sqlite3'
import { normalizeFundInput, normalizeTransactionInput } from '../engine'
import type { Fund, FundInput, TransactionInput } from '../engine'

export function createFund(db: Database.Database, input: FundInput): Fund {
  const fund = normalizeFundInput(input)
  const exists = db.prepare('SELECT 1 FROM funds WHERE code = ?').get(fund.code)
  if (exists !== undefined) throw new Error(`基金代码 ${fund.code} 已存在`)
  db.prepare(
    'INSERT INTO funds (code, name, category, fund_type, target_amount, created_at) VALUES (?,?,?,?,?,?)'
  ).run(fund.code, fund.name, fund.category, fund.fundType, fund.targetAmount, new Date().toISOString())
  return fund
}

function ensureFundExists(db: Database.Database, fundCode: string): void {
  const exists = db.prepare('SELECT 1 FROM funds WHERE code = ?').get(fundCode)
  if (exists === undefined) throw new Error(`基金 ${fundCode} 不存在，请先在基金列表新建`)
}

export function createTransaction(db: Database.Database, input: TransactionInput): void {
  const t = normalizeTransactionInput(input)
  ensureFundExists(db, t.fundCode)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(t.date, t.type, t.fundCode, t.amount, t.shares, t.nav, t.fee, t.note, now, now)
}

export function updateTransaction(db: Database.Database, id: number, input: TransactionInput): void {
  const t = normalizeTransactionInput(input)
  ensureFundExists(db, t.fundCode)
  const info = db
    .prepare(
      `UPDATE transactions SET date = ?, type = ?, fund_code = ?, amount = ?, shares = ?, nav = ?, fee = ?, note = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(t.date, t.type, t.fundCode, t.amount, t.shares, t.nav, t.fee, t.note, new Date().toISOString(), id)
  if (info.changes === 0) throw new Error('流水不存在或已删除')
}

export function deleteTransaction(db: Database.Database, id: number): void {
  const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(id)
  if (info.changes === 0) throw new Error('流水不存在或已删除')
}
