import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  computeAllocationComparison,
  computePositions,
  groupPositionsByProductForm
} from '../engine'
import type { FundUpdateInput } from '../engine'
import { SCHEMA } from './schema'
import { selectFunds, selectNavPoints, selectTransactions } from './repo'
import { createFund, createTransaction } from './transactionService'
import { listFundConfigs, updateFund } from './fundConfigService'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

/** 在持基金：净投入 1000，净值 1.5 → 市值 1500 */
function seedHeldFund(db: Database.Database): void {
  createFund(db, { code: '000001', name: '测试基金', productForm: '纯债', fundType: '一级债基' })
  createTransaction(db, {
    date: '2026-01-15',
    type: '买入',
    fundCode: '000001',
    amount: 1000,
    shares: 1000,
    nav: 1,
    fee: null,
    note: null
  })
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
    '000001',
    '2026-01-20',
    1.5,
    'manual'
  )
}

function updateOf(overrides: Partial<FundUpdateInput> = {}): FundUpdateInput {
  return {
    code: '000001',
    name: '测试基金',
    productForm: '纯债',
    ledgerCategory: '债',
    equityRatio: 0,
    ...overrides
  }
}

function positionsOf(db: Database.Database): ReturnType<typeof computePositions> {
  return computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
}

describe('listFundConfigs — 基金配置页列表', () => {
  it('列出全部基金，含已清仓与从未建仓的基金', () => {
    const db = freshDb()
    seedHeldFund(db)
    createFund(db, { code: '000002', name: '已清仓基金', productForm: '权益', fundType: null })
    createTransaction(db, {
      date: '2026-01-10', type: '买入', fundCode: '000002', amount: 500, shares: 500, nav: 1, fee: null, note: null
    })
    createTransaction(db, {
      date: '2026-01-12', type: '卖出', fundCode: '000002', amount: 600, shares: 500, nav: 1.2, fee: null, note: null
    })
    createFund(db, { code: '000003', name: '未建仓基金', productForm: '黄金', fundType: null })

    expect(listFundConfigs(db).map((f) => f.code)).toEqual(['000001', '000002', '000003'])
  })
})

describe('updateFund — 基金配置更新', () => {
  it('只改名称：代码不变、分类与系数不变', () => {
    const db = freshDb()
    createFund(db, { code: '000001', name: '旧名称', productForm: '固收+', fundType: null })
    updateFund(db, updateOf({ name: '  新名称  ', productForm: '固收+', ledgerCategory: '债', equityRatio: 0.2 }))

    const funds = selectFunds(db)
    expect(funds).toHaveLength(1)
    expect(funds[0]).toMatchObject({
      code: '000001',
      name: '新名称',
      productForm: '固收+',
      ledgerCategory: '债',
      equityRatio: 0.2,
      equityRatioSource: 'manual'
    })
  })

  it('改产品形态与账本大类：历史分组与配置桶一起重分类', () => {
    const db = freshDb()
    seedHeldFund(db)
    const before = groupPositionsByProductForm(positionsOf(db), selectTransactions(db), '2026-02-01')
    expect(before.map((g) => g.name)).toEqual(['纯债'])

    updateFund(
      db,
      updateOf({ productForm: '权益', ledgerCategory: '权益', equityRatio: 1 })
    )

    expect(selectFunds(db)[0]).toMatchObject({
      productForm: '权益',
      ledgerCategory: '权益',
      equityRatio: 1
    })
    expect(
      groupPositionsByProductForm(positionsOf(db), selectTransactions(db), '2026-02-01').map(
        (g) => g.name
      )
    ).toEqual(['权益'])
    const comparison = computeAllocationComparison(positionsOf(db), selectFunds(db), [
      { bucket: '稳健', targetRatio: 1 / 3 },
      { bucket: '权益', targetRatio: 1 / 3 },
      { bucket: '黄金', targetRatio: 1 / 3 }
    ])
    expect(comparison.rows.find((r) => r.bucket === '稳健')?.marketRatio).toBe(0)
    expect(comparison.rows.find((r) => r.bucket === '权益')?.marketRatio).toBe(1)
  })

  it('产品形态与账本大类不一致时拒绝，且不写入任何字段', () => {
    const db = freshDb()
    seedHeldFund(db)
    expect(() =>
      updateFund(db, updateOf({ name: '也不该写入', productForm: '权益', ledgerCategory: '债' }))
    ).toThrow(/不一致/)

    expect(selectFunds(db)[0]).toMatchObject({
      name: '测试基金',
      productForm: '纯债',
      ledgerCategory: '债'
    })
  })

  it('权益系数限制在 0–1；越界不写入', () => {
    const db = freshDb()
    seedHeldFund(db)
    expect(() => updateFund(db, updateOf({ equityRatio: -0.01 }))).toThrow(/权益系数/)
    expect(() => updateFund(db, updateOf({ equityRatio: 1.01 }))).toThrow(/权益系数/)
    expect(() => updateFund(db, updateOf({ equityRatio: Number.NaN }))).toThrow(/权益系数/)
    expect(selectFunds(db)[0].equityRatio).toBe(0)

    updateFund(db, updateOf({ equityRatio: 0.35 }))
    expect(selectFunds(db)[0].equityRatio).toBe(0.35)
  })

  it('改系数把来源记为手工并保留数据日期；只改其他字段不动来源', () => {
    const db = freshDb()
    seedHeldFund(db)
    db.prepare(
      "UPDATE funds SET equity_ratio = 0.18, equity_ratio_source = 'fetch', equity_ratio_as_of = '2026-09-30' WHERE code = '000001'"
    ).run()

    updateFund(db, updateOf({ name: '只改名', equityRatio: 0.18 }))
    expect(selectFunds(db)[0]).toMatchObject({
      equityRatio: 0.18,
      equityRatioSource: 'fetch',
      equityRatioAsOf: '2026-09-30'
    })

    updateFund(db, updateOf({ name: '只改名', equityRatio: 0.25 }))
    expect(selectFunds(db)[0]).toMatchObject({
      equityRatio: 0.25,
      equityRatioSource: 'manual',
      equityRatioAsOf: '2026-09-30'
    })
  })

  it('基金不存在时给出中文错误', () => {
    const db = freshDb()
    expect(() => updateFund(db, updateOf({ code: '999999' }))).toThrow(/不存在/)
  })
})
