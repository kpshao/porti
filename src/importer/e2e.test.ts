// M1 端到端对账验收：真实投资跟踪.xlsx → 解析 → 导入 → 回读 → 计算引擎 → 与 Excel 逐项比对
// 期望值全部取自 Excel 持仓概览/收益汇总的独立数字（spec Testing Decisions）

import { describe, expect, it } from 'vitest'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SCHEMA } from '../main/schema'
import { selectFunds, selectNavPoints, selectTransactions } from '../main/repo'
import { computePositions, computeTimeSeries, computeTotals } from '../engine'
import { parseExcelFile } from './parse'
import { importToDb } from './write'
import { reconcileAgainstExcel } from './reconcile'
import type { CommitPayload } from './types'

const FIXTURE = join(process.cwd(), '投资跟踪.xlsx')

function buildPlan(): CommitPayload {
  const parsed = parseExcelFile(FIXTURE)
  return {
    funds: parsed.funds,
    categoryTargets: parsed.categoryTargets,
    transactions: parsed.transactionRows.map((r) => r.transaction),
    snapshots: parsed.snapshots,
    currentNavs: parsed.currentNavPoints,
    expectation: parsed.expectation
  }
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

describe('M1 端到端对账 — 真实 Excel → 导入 → 计算 → 逐项比对', () => {
  const parsed = parseExcelFile(FIXTURE)
  const db = freshDb()
  const counts = importToDb(db, buildPlan())

  it('导入计数：10 只基金、5 大类、69 笔流水、92 条快照重建 + 9 条当前净值', () => {
    expect(counts).toEqual({
      funds: 10,
      categoryTargets: 5,
      transactions: 69,
      reconstructedNavs: 92,
      currentNavs: 9,
      skippedSnapshots: 0
    })
  })

  it('数据库回读与导入一致', () => {
    expect(selectFunds(db)).toHaveLength(10)
    expect(selectTransactions(db)).toHaveLength(69)
    expect(selectNavPoints(db)).toHaveLength(92 + 9)
    // 净值来源全部为 import
    for (const p of selectNavPoints(db)) expect(p.source).toBe('import')
  })

  const funds = selectFunds(db)
  const transactions = selectTransactions(db)
  const navPoints = selectNavPoints(db)
  const positions = computePositions(funds, transactions, navPoints)
  const totals = computeTotals(positions, transactions)
  const series = computeTimeSeries(funds, transactions, navPoints)
  const report = reconcileAgainstExcel(parsed.expectation, positions, totals, series)

  it('总资产 775,962.32、总盈亏 −8,351.48、总收益率 −1.06% 与 Excel 完全一致', () => {
    const check = (label: string): { excel: number; computed: number; match: boolean } => {
      const c = report.totals.checks.find((x) => x.label === label)!
      expect(c).toBeDefined()
      return c
    }
    const assets = check('总资产')
    expect(assets.excel).toBeCloseTo(775962.32, 2)
    expect(assets.computed).toBeCloseTo(775962.32, 2)
    expect(assets.match).toBe(true)

    const pnl = check('总盈亏')
    expect(pnl.computed).toBeCloseTo(-8351.48, 2)
    expect(pnl.match).toBe(true)

    const rate = check('总收益率')
    expect(rate.excel).toBeCloseTo(-0.010648138382876898, 9)
    expect(rate.computed).toBeCloseTo(-0.010648138382876898, 9)
    expect(rate.match).toBe(true)

    const netCost = check('净投入成本')
    expect(netCost.computed).toBeCloseTo(784313.8, 2)
    expect(netCost.match).toBe(true)
  })

  it('9 只基金逐项（份额/市值/盈亏）与 Excel 持仓概览一致', () => {
    expect(report.funds).toHaveLength(9)
    for (const f of report.funds) {
      expect(f.match).toBe(true)
    }
    // 抽样：563360 A500ETF华泰柏瑞
    const a500 = report.funds.find((f) => f.code === '563360')!
    const share = a500.checks.find((c) => c.label === '当前份额')!
    expect(share.computed).toBeCloseTo(64600, 2)
    const mv = a500.checks.find((c) => c.label === '当前市值')!
    expect(mv.computed).toBeCloseTo(83398.6, 2)
    const pnl = a500.checks.find((c) => c.label === '持仓盈亏')!
    expect(pnl.computed).toBeCloseTo(-4394.7, 2)
  })

  it('14 期收益汇总的总市值逐期一致', () => {
    expect(report.series).toHaveLength(14)
    for (const s of report.series) {
      expect(s.match).toBe(true)
    }
    expect(report.series[0].date).toBe('2026-03-13')
    expect(report.series[0].computed).toBeCloseTo(199788.954552, 2)
    expect(report.series[13].date).toBe('2026-08-11')
    expect(report.series[13].computed).toBeCloseTo(758627.24876, 2)
    // 额外当前净值点（2026-08-24）与总资产闭合：时间序列最后一个点 = 总资产
    expect(series).toHaveLength(15)
    expect(series[14].date).toBe('2026-08-24')
    expect(series[14].totalMarketValue).toBeCloseTo(totals.totalAssets, 2)
  })

  it('整体对账通过', () => {
    expect(report.allMatch).toBe(true)
  })
})

describe('重复导入防护', () => {
  it('已有数据时拒绝导入并给出明确提示', () => {
    const db = freshDb()
    importToDb(db, buildPlan())
    expect(() => importToDb(db, buildPlan())).toThrow(/重复导入/)
    // 数据未被二次写入
    expect(selectTransactions(db)).toHaveLength(69)
    expect(selectNavPoints(db)).toHaveLength(101)
  })
})
