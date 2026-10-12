import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from './schema'
import { selectFunds, selectNavPoints, selectTransactions } from './repo'
import { computePositions, computeTotals } from '../engine'
import { createFund, createTransaction, deleteTransaction, updateTransaction } from './transactionService'
import type { TransactionInput } from '../engine'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function seedFund(db: Database.Database): void {
  createFund(db, { code: '000001', name: '测试基金', category: '权益', fundType: null, targetAmount: null })
}

const buy: TransactionInput = {
  date: '2026-01-15', type: '买入', fundCode: '000001', amount: 1000, shares: 100, nav: 10, fee: null, note: null
}

describe('createFund — 新建基金', () => {
  it('代码补前导零后入库', () => {
    const db = freshDb()
    createFund(db, { code: '2065', name: '补零基金', category: '固守+', fundType: '二级债基', targetAmount: null })
    const funds = selectFunds(db)
    expect(funds).toHaveLength(1)
    expect(funds[0]).toMatchObject({
      code: '002065', name: '补零基金', category: '固守+', fundType: '二级债基', targetAmount: null
    })
  })

  it('代码已存在给出中文错误', () => {
    const db = freshDb()
    seedFund(db)
    expect(() =>
      createFund(db, { code: '000001', name: '重复', category: '权益', fundType: null, targetAmount: null })
    ).toThrow(/已存在/)
  })
})

describe('createTransaction — 四种操作类型入库', () => {
  it('买入：手续费为空默认 0', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, buy)
    const [t] = selectTransactions(db)
    expect(t).toMatchObject({ date: '2026-01-15', type: '买入', fundCode: '000001', amount: 1000, shares: 100, nav: 10, fee: 0, note: null })
  })

  it('卖出：录入正数、库内取负', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, { ...buy, type: '卖出', amount: 1200, shares: 500 })
    const [t] = selectTransactions(db)
    expect(t.amount).toBe(-1200)
    expect(t.shares).toBe(-500)
  })

  it('分红现金：份额强制置空', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, { ...buy, type: '分红现金', amount: 500, shares: 999 })
    const [t] = selectTransactions(db)
    expect(t.amount).toBe(500)
    expect(t.shares).toBeNull()
  })

  it('分红再投入：金额为空按 0 计、只加份额', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, { ...buy, type: '分红再投入', amount: null, shares: 50 })
    const [t] = selectTransactions(db)
    expect(t.amount).toBe(0)
    expect(t.shares).toBe(50)
  })

  it('基金不存在给出中文错误', () => {
    const db = freshDb()
    expect(() => createTransaction(db, buy)).toThrow(/基金.*不存在/)
  })
})

describe('updateTransaction / deleteTransaction', () => {
  it('编辑后流水更新、删除后消失', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, buy)
    const [t] = selectTransactions(db)
    updateTransaction(db, t.id, { ...buy, amount: 1500, note: '补录' })
    const [updated] = selectTransactions(db)
    expect(updated.amount).toBe(1500)
    expect(updated.note).toBe('补录')
    deleteTransaction(db, t.id)
    expect(selectTransactions(db)).toHaveLength(0)
  })

  it('编辑/删除不存在的流水给出中文错误', () => {
    const db = freshDb()
    seedFund(db)
    expect(() => updateTransaction(db, 999, buy)).toThrow(/流水不存在/)
    expect(() => deleteTransaction(db, 999)).toThrow(/流水不存在/)
  })
})

describe('新建流水后计算引擎输出与手算一致（ticket 验收）', () => {
  it('两笔买入 + 净值点：持仓/总资产/总盈亏/总收益率手算一致', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, buy) // 1000 元 / 100 份
    createTransaction(db, { ...buy, date: '2026-02-01', amount: 2400, shares: 200, nav: 12 }) // 2400 元 / 200 份
    // 净值历史（净值管理里程碑前测试直接写入）
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-02-10', 12, 'manual'
    )

    const positions = computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
    const totals = computeTotals(positions, selectTransactions(db))

    // 手算：累计投入 3400、份额 300、净值 12 → 市值 3600、盈亏 200、收益率 200/3400
    expect(positions[0].invested).toBe(3400)
    expect(positions[0].shares).toBe(300)
    expect(positions[0].marketValue).toBeCloseTo(3600, 6)
    expect(positions[0].pnl).toBeCloseTo(200, 6)
    expect(positions[0].pnlRatio).toBeCloseTo(200 / 3400, 9)
    expect(totals.totalAssets).toBeCloseTo(3600, 2)
    expect(totals.totalPnl).toBeCloseTo(200, 2)
    expect(totals.totalReturnRate).toBeCloseTo(200 / 3400, 9)
  })

  it('手续费计入成本：金额为含手续费的实付总额（spec 口径，引擎不重复累加）', () => {
    const db = freshDb()
    seedFund(db)
    // 金额 1002 = 份额 100 × 净值 10 + 手续费 2
    createTransaction(db, { ...buy, amount: 1002, shares: 100, nav: 10, fee: 2 })
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-01-20', 10, 'manual'
    )
    const positions = computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
    expect(positions[0].invested).toBe(1002) // 净投入成本含手续费
    expect(positions[0].shares).toBe(100)
  })

  it('卖出与分红现金：净投入成本、已实现盈亏实时重算', () => {
    const db = freshDb()
    seedFund(db)
    createTransaction(db, buy) // 买入 1000 元 / 100 份
    createTransaction(db, { ...buy, date: '2026-02-01', type: '卖出', amount: 400, shares: 40, nav: 11 })
    createTransaction(db, { ...buy, date: '2026-03-01', type: '分红现金', amount: 60, shares: null, nav: null })
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-03-05', 11.5, 'manual'
    )

    const positions = computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
    const totals = computeTotals(positions, selectTransactions(db))

    // 手算：净投入 1000−400=600、份额 60、净值 11.5 → 市值 690、持仓盈亏 90、已实现盈亏 60
    // 严格成本法：卖出 40/100 份 @11 恰为均价 10 的消耗成本 400，已实现收益 0，已实现盈亏仍 = 分红 60
    expect(positions[0].netCost).toBe(600)
    expect(positions[0].costBasis).toBe(600)
    expect(positions[0].shares).toBe(60)
    expect(positions[0].pnl).toBeCloseTo(90, 6)
    expect(totals.realizedIncome).toBe(60)
    expect(totals.totalReturn).toBeCloseTo(150, 6)
    expect(totals.totalReturnRate).toBeCloseTo(150 / 600, 9)
  })
})
