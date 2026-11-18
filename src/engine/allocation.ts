// 配置桶：把基金市值按权益系数穿透到 稳健 / 权益 / 黄金 三桶（口径见 CONTEXT.md「配置桶」）。

import type { LedgerCategory } from './classification'
import { isHeld } from './compute'
import { ALLOCATION_BUCKETS } from './types'
import type { AllocationBucket, BucketTarget, FundPosition } from './types'

/** 配置对比所需的基金分类字段（Fund 结构上满足） */
export interface AllocationFund {
  code: string
  ledgerCategory: LedgerCategory
  equityRatio: number
}

export interface AllocationComparisonRow {
  bucket: AllocationBucket
  targetRatio: number // 用户输入的原始目标（合计不要求 100%）
  investedRatio: number | null // 口径见 CONTEXT.md「配置桶」
  marketRatio: number | null
  deviation: number | null // 市值占比 − 归一化目标；无目标或无市值定义时为 null
}

/** 权益构成（占总市值）；口径见 CONTEXT.md「权益构成」 */
export interface AllocationEquityComposition {
  direct: number | null
  debtPassthrough: number | null
}

export interface AllocationComparison {
  rows: AllocationComparisonRow[] // 固定三行，顺序同 ALLOCATION_BUCKETS
  targetTotal: number // 原始目标合计
  targetNormalized: boolean // 合计 > 0 且 ≠ 100%
  equityComposition: AllocationEquityComposition
  missingNavCount: number // 缺最新净值的在持基金数
}

/** 空桶计数 */
function zeroBuckets(): Record<AllocationBucket, number> {
  return { 稳健: 0, 权益: 0, 黄金: 0 }
}

/**
 * 单只基金的桶分摊：权益部分按权益系数进权益桶；非权益部分按账本大类进稳健桶（债/权益类）
 * 或黄金桶（黄金类）。黄金类若被覆盖出非零权益系数，其权益部分同样穿透进权益桶。
 */
function splitByBucket(
  ledgerCategory: LedgerCategory,
  equityRatio: number,
  amount: number
): Record<AllocationBucket, number> {
  const equity = amount * equityRatio
  if (ledgerCategory === '黄金') return { 稳健: 0, 权益: equity, 黄金: amount - equity }
  return { 稳健: amount - equity, 权益: equity, 黄金: 0 }
}

/** 三桶配置对比；口径与不变量见 CONTEXT.md「配置桶」与 ADR-0004。 */
export function computeAllocationComparison(
  positions: FundPosition[],
  funds: AllocationFund[],
  targets: BucketTarget[]
): AllocationComparison {
  const fundByCode = new Map(funds.map((f) => [f.code, f]))
  const invested = zeroBuckets()
  const market = zeroBuckets()
  let totalNetCost = 0
  let totalAssets = 0
  let directEquity = 0
  let debtPassthrough = 0
  let missingNavCount = 0

  for (const position of positions) {
    if (!isHeld(position)) continue
    const fund = fundByCode.get(position.fundCode)
    if (fund === undefined) continue
    const marketValue = position.marketValue ?? 0
    if (position.marketValue === null) missingNavCount += 1
    totalNetCost += position.netCost
    totalAssets += marketValue
    const investedSplit = splitByBucket(fund.ledgerCategory, fund.equityRatio, position.netCost)
    const marketSplit = splitByBucket(fund.ledgerCategory, fund.equityRatio, marketValue)
    for (const bucket of ALLOCATION_BUCKETS) {
      invested[bucket] += investedSplit[bucket]
      market[bucket] += marketSplit[bucket]
    }
    if (fund.ledgerCategory === '权益') directEquity += marketValue * fund.equityRatio
    if (fund.ledgerCategory === '债') debtPassthrough += marketValue * fund.equityRatio
  }

  const targetMap = new Map(targets.map((t) => [t.bucket, t.targetRatio]))
  const targetTotal = ALLOCATION_BUCKETS.reduce(
    (sum, bucket) => sum + (targetMap.get(bucket) ?? 0),
    0
  )
  const targetNormalized = targetTotal > 0 && Math.abs(targetTotal - 1) > 1e-9
  const rows: AllocationComparisonRow[] = ALLOCATION_BUCKETS.map((bucket) => {
    const targetRatio = targetMap.get(bucket) ?? 0
    const marketRatio = totalAssets === 0 ? null : market[bucket] / totalAssets
    const investedRatio = totalNetCost === 0 ? null : invested[bucket] / totalNetCost
    const normalizedTarget = targetTotal > 0 ? targetRatio / targetTotal : null
    const deviation =
      normalizedTarget === null || marketRatio === null ? null : marketRatio - normalizedTarget
    return { bucket, targetRatio, investedRatio, marketRatio, deviation }
  })

  return {
    rows,
    targetTotal,
    targetNormalized,
    equityComposition: {
      direct: totalAssets === 0 ? null : directEquity / totalAssets,
      debtPassthrough: totalAssets === 0 ? null : debtPassthrough / totalAssets
    },
    missingNavCount
  }
}
