// 分析快照构建器（纯函数）：把当前组合数据整理成固定字段、固定排序的 JSON，供 AI 一次性阅读。
// 口径全部复用 engine：汇总（全部/在持）、大类偏离、集中度、区间收益与年化。
// 安全/隐私边界：只输出白名单字段；不含密钥、数据文件路径与原始逐日净值序列；
// 每次发送时重新构建，不落库。

import {
  computeAnnualizedReturns,
  computeCategoryComparison,
  computeConcentrationMetrics,
  computeFundSeries,
  computePositions,
  computeScopedSummary,
  costBasisStates,
  realizedPerSale
} from '../engine'
import type {
  CategoryComparisonRow,
  CategoryTarget,
  ConcentrationMetrics,
  Fund,
  FundPosition,
  NavPoint,
  ScopedSummary,
  TransactionRow
} from '../engine'
import { estimateTokens, SNAPSHOT_TOKEN_WARN } from './aiConfig'
import type { SnapshotPreview } from './aiTypes'

export interface SnapshotHolding {
  fundCode: string
  name: string
  category: string
  shares: number
  costBasis: number
  latestNav: number | null
  latestNavDate: string | null
  marketValue: number | null
  pnl: number | null
  pnlRatio: number | null
  /** 集中度权重；仅可估值在持基金有值，已清仓与缺净值为 null */
  weight: number | null
  /** 已实现盈亏 = Σ卖出已实现收益 + Σ分红现金 */
  realizedIncome: number
}

export interface SnapshotCategoryRow {
  category: string
  targetRatio: number
  marketRatio: number | null
  deviation: number | null
}

/** 单基金区间收益摘要：净值区间涨跌 + 区间末累计盈亏/收益率 + 年化（与界面同口径） */
export interface FundReturnSummary {
  fundCode: string
  name: string
  navStartDate: string | null
  navStart: number | null
  navEndDate: string | null
  latestNav: number | null
  /** 最新净值 ÷ 区间首日净值 − 1（只反映净值涨跌，不含申赎与分红） */
  navChangeRate: number | null
  /** 区间末累计盈亏 = 市值 − 持仓成本 + 已实现盈亏 */
  cumulativeReturn: number | null
  /** 区间末累计收益率（持仓成本 ≤ 0 时无定义） */
  cumulativeReturnRate: number | null
  annualized: number | null
}

export interface SnapshotTransaction {
  date: string
  type: string
  fundCode: string
  fundName: string | null
  amount: number
  shares: number | null
  nav: number | null
  fee: number | null
  note: string | null
  /** 本笔已实现（仅卖出；其余为 null） */
  realized: number | null
}

export interface AnalysisSnapshot {
  dataFreshness: {
    today: string
    latestNavDate: string | null
  }
  summary: {
    all: ScopedSummary
    held: ScopedSummary
  }
  categoryComparison: SnapshotCategoryRow[]
  concentration: ConcentrationMetrics
  holdings: SnapshotHolding[]
  closedHoldings: SnapshotHolding[]
  fundReturns: FundReturnSummary[]
  transactions: SnapshotTransaction[]
}

export interface AnalysisSnapshotInput {
  funds: Fund[]
  transactions: TransactionRow[]
  navPoints: NavPoint[]
  categoryTargets: CategoryTarget[]
  /** 期末估值日（YYYY-MM-DD），显式入参以保证年化口径可测 */
  today: string
}

/** 基金排序：市值降序；市值未知（缺净值）排最后；同市值按基金代码升序（稳定契约） */
function byMarketValueDesc(a: FundPosition, b: FundPosition): number {
  if (a.marketValue === null && b.marketValue === null) return byFundCode(a, b)
  if (a.marketValue === null) return 1
  if (b.marketValue === null) return -1
  if (a.marketValue !== b.marketValue) return b.marketValue - a.marketValue
  return byFundCode(a, b)
}

function byFundCode(a: { fundCode: string }, b: { fundCode: string }): number {
  return a.fundCode < b.fundCode ? -1 : a.fundCode > b.fundCode ? 1 : 0
}

/** 流水排序：日期升序、同日按主键升序（与库内查询 ORDER BY date, id 同一契约） */
function byDateThenId(a: TransactionRow, b: TransactionRow): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return a.id - b.id
}

/** 是否已清仓（交易过且份额 ≤ 0）：与引擎 groupClosedPositions 同口径 */
function isClosed(p: FundPosition): boolean {
  return p.shares <= 0 && (p.invested !== 0 || p.redeemed !== 0)
}

export function buildAnalysisSnapshot(input: AnalysisSnapshotInput): AnalysisSnapshot {
  const { funds, transactions, navPoints, categoryTargets, today } = input
  const positions = computePositions(funds, transactions, navPoints)
  const metrics = computeConcentrationMetrics(positions)
  const weightByCode = new Map(metrics.weights.map((w) => [w.fundCode, w.weight]))
  const realizedByCode = new Map(
    [...costBasisStates(transactions)].map(([code, state]) => [
      code,
      state.realizedGain + state.cashDividends
    ])
  )
  const annualizedByCode = computeAnnualizedReturns(transactions, navPoints, today)

  const toHolding = (p: FundPosition): SnapshotHolding => ({
    fundCode: p.fundCode,
    name: p.name,
    category: p.category,
    shares: p.shares,
    costBasis: p.costBasis,
    latestNav: p.latestNav,
    latestNavDate: p.latestNavDate,
    marketValue: p.marketValue,
    pnl: p.pnl,
    pnlRatio: p.pnlRatio,
    weight: weightByCode.get(p.fundCode) ?? null,
    realizedIncome: realizedByCode.get(p.fundCode) ?? 0
  })

  const held = positions.filter((p) => p.shares > 0).sort(byMarketValueDesc)
  const closed = positions.filter(isClosed).sort(byMarketValueDesc)

  const fundByName = new Map(funds.map((f) => [f.code, f]))
  const realizedPerTransaction = realizedPerSale(transactions)

  const fundReturns: FundReturnSummary[] = funds
    .map((fund) => {
      const points = navPoints.filter((p) => p.fundCode === fund.code).sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      )
      const first = points[0] ?? null
      const last = points[points.length - 1] ?? null
      const series = computeFundSeries(fund.code, funds, transactions, navPoints)
      const end = series[series.length - 1] ?? null
      return {
        fundCode: fund.code,
        name: fund.name,
        navStartDate: first === null ? null : first.date,
        navStart: first === null ? null : first.nav,
        navEndDate: last === null ? null : last.date,
        latestNav: last === null ? null : last.nav,
        navChangeRate:
          first === null || last === null || first.nav === 0 ? null : last.nav / first.nav - 1,
        cumulativeReturn: end === null ? null : end.totalReturn,
        cumulativeReturnRate: end === null ? null : end.totalReturnRate,
        annualized: annualizedByCode.get(fund.code) ?? null
      }
    })
    .sort(byFundCode)

  const transactionsOut: SnapshotTransaction[] = [...transactions]
    .sort(byDateThenId)
    .map((t) => ({
      date: t.date,
      type: t.type,
      fundCode: t.fundCode,
      fundName: fundByName.get(t.fundCode)?.name ?? null,
      amount: t.amount,
      shares: t.shares,
      nav: t.nav,
      fee: t.fee,
      note: t.note,
      realized: t.type === '卖出' ? (realizedPerTransaction.get(t.id) ?? null) : null
    }))

  let latestNavDate: string | null = null
  for (const point of navPoints) {
    if (latestNavDate === null || point.date > latestNavDate) latestNavDate = point.date
  }

  const categoryComparison: SnapshotCategoryRow[] = computeCategoryComparison(
    positions,
    categoryTargets
  ).map((row: CategoryComparisonRow) => ({
    category: row.category,
    targetRatio: row.targetRatio,
    marketRatio: row.marketRatio,
    deviation: row.deviation
  }))

  return {
    dataFreshness: { today, latestNavDate },
    summary: {
      all: computeScopedSummary('all', positions, transactions, navPoints, today),
      held: computeScopedSummary('held', positions, transactions, navPoints, today)
    },
    categoryComparison,
    concentration: metrics,
    holdings: held.map(toHolding),
    closedHoldings: closed.map(toHolding),
    fundReturns,
    transactions: transactionsOut
  }
}

/** 快照 → 发送前预览：格式化 JSON + 粗略 token 估算；超阈值只提示、不裁剪。 */
export function serializeSnapshot(snapshot: AnalysisSnapshot): SnapshotPreview {
  const json = JSON.stringify(snapshot, null, 2)
  const estimatedTokens = estimateTokens(json)
  return {
    json,
    estimatedTokens,
    exceedsEstimateLimit: estimatedTokens > SNAPSHOT_TOKEN_WARN
  }
}
