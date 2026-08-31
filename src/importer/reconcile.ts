// 导入对账：计算引擎结果 vs Excel 期望值（持仓概览/收益汇总），逐项比对

import type { FundPosition, TimePoint, Totals } from '../engine'
import type { ExcelExpectation } from './types'

export interface FieldCheck {
  label: string
  excel: number
  computed: number
  diff: number // |excel − computed|
  match: boolean
}

export interface FundReconciliation {
  code: string
  name: string
  checks: FieldCheck[]
  match: boolean
}

export interface TotalsReconciliation {
  checks: FieldCheck[]
  match: boolean
}

export interface SeriesPointReconciliation {
  date: string
  excel: number
  computed: number
  diff: number
  match: boolean
}

export interface ReconciliationReport {
  totals: TotalsReconciliation
  funds: FundReconciliation[]
  series: SeriesPointReconciliation[]
  allMatch: boolean
}

/** 金额/份额容差 1 分（浮点求和顺序噪声远小于此）；比例容差 1e-6 */
const MONEY_TOLERANCE = 0.01
const RATIO_TOLERANCE = 1e-6

function check(label: string, excel: number, computed: number, tolerance: number): FieldCheck {
  const diff = Math.abs(excel - computed)
  return { label, excel, computed, diff, match: diff <= tolerance }
}

export function reconcileAgainstExcel(
  expectation: ExcelExpectation,
  positions: FundPosition[],
  totals: Totals,
  series: TimePoint[]
): ReconciliationReport {
  const totalsChecks: FieldCheck[] = [
    check('净投入成本', expectation.totals.totalNetCost, totals.totalNetCost, MONEY_TOLERANCE),
    check('总资产', expectation.totals.totalAssets, totals.totalAssets, MONEY_TOLERANCE),
    check('总盈亏', expectation.totals.totalPnl, totals.totalPnl, MONEY_TOLERANCE),
    check(
      '总收益率',
      expectation.totals.totalReturnRate,
      totals.totalReturnRate ?? NaN,
      RATIO_TOLERANCE
    )
  ]

  const byCode = new Map(positions.map((p) => [p.fundCode, p]))
  const funds = expectation.funds.map((f) => {
    const p = byCode.get(f.code)
    const checks =
      p === undefined
        ? [
            check('当前份额', f.shares, 0, MONEY_TOLERANCE),
            check('当前市值', f.marketValue, 0, MONEY_TOLERANCE),
            check('持仓盈亏', f.pnl, 0, MONEY_TOLERANCE)
          ]
        : [
            check('累计投入', f.invested, p.invested, MONEY_TOLERANCE),
            check('净投入成本', f.netCost, p.netCost, MONEY_TOLERANCE),
            check('当前份额', f.shares, p.shares, MONEY_TOLERANCE),
            check('当前市值', f.marketValue, p.marketValue ?? NaN, MONEY_TOLERANCE),
            check('持仓盈亏', f.pnl, p.pnl ?? NaN, MONEY_TOLERANCE),
            check('盈亏比例', f.pnlRatio, p.pnlRatio ?? NaN, RATIO_TOLERANCE)
          ]
    return {
      code: f.code,
      name: f.name,
      checks,
      match: checks.every((c) => c.match)
    }
  })

  const seriesMap = new Map(series.map((s) => [s.date, s.totalMarketValue]))
  const seriesPoints = expectation.series.map((s) => {
    const computed = seriesMap.get(s.date)
    const c = check('总市值', s.totalMarketValue, computed ?? NaN, MONEY_TOLERANCE)
    return { date: s.date, excel: s.totalMarketValue, computed: computed ?? NaN, diff: c.diff, match: c.match }
  })

  return {
    totals: { checks: totalsChecks, match: totalsChecks.every((c) => c.match) },
    funds,
    series: seriesPoints,
    allMatch: totalsChecks.every((c) => c.match) && funds.every((f) => f.match) && seriesPoints.every((s) => s.match)
  }
}
