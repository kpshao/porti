import { describe, expect, it } from 'vitest'
import { computeAllocationComparison, convertLegacyCategoryTargets } from './allocation'
import type { AllocationFund } from './allocation'
import type { BucketTarget, CategoryTarget, FundPosition } from './types'

function byBucket(targets: ReturnType<typeof convertLegacyCategoryTargets>): Record<string, number> {
  return Object.fromEntries(targets.map((t) => [t.bucket, t.targetRatio]))
}

/** 构造持仓：只关心对比用到的字段，其余给中性值 */
function mkPosition(
  fundCode: string,
  marketValue: number | null,
  netCost: number,
  shares = 100
): FundPosition {
  return {
    fundCode,
    name: fundCode,
    category: '权益',
    productForm: '权益',
    fundType: null,
    invested: netCost,
    redeemed: 0,
    netCost,
    costBasis: netCost,
    shares,
    latestNav: null,
    latestNavDate: null,
    marketValue,
    pnl: null,
    pnlRatio: null
  }
}

function mkFund(
  code: string,
  ledgerCategory: AllocationFund['ledgerCategory'],
  equityRatio: number
): AllocationFund {
  return { code, ledgerCategory, equityRatio }
}

describe('convertLegacyCategoryTargets — 旧大类目标折算为配置桶目标', () => {
  it('默认五类目标（25/45/20/5/5）：剔除流动性后归一化，固收+ 按 20% 拆入权益', () => {
    const legacy: CategoryTarget[] = [
      { category: '固守+', targetRatio: 0.25 },
      { category: '纯债', targetRatio: 0.45 },
      { category: '权益', targetRatio: 0.2 },
      { category: '黄金', targetRatio: 0.05 },
      { category: '流动性', targetRatio: 0.05 }
    ]

    const result = byBucket(convertLegacyCategoryTargets(legacy))

    // 保留四类归一化：25/95、45/95、20/95、5/95；固收+ 的 20% 进权益、80% 进稳健
    expect(result['稳健']).toBeCloseTo(65 / 95, 9)
    expect(result['权益']).toBeCloseTo(25 / 95, 9)
    expect(result['黄金']).toBeCloseTo(5 / 95, 9)
    // 三桶合计恒为 100%（流动性目标被剔除）
    expect(result['稳健'] + result['权益'] + result['黄金']).toBeCloseTo(1, 9)
  })

  it('未知旧类别不参与归一化（导入器可能写入数据源里的任意标签）', () => {
    const result = byBucket(
      convertLegacyCategoryTargets([
        { category: '纯债', targetRatio: 0.5 },
        { category: '股票型', targetRatio: 0.5 }
      ])
    )

    expect(result).toEqual({ 稳健: 1, 权益: 0, 黄金: 0 })
  })
})

describe('computeAllocationComparison — 三桶配置对比', () => {
  it('按权益系数把债/权益/黄金基金拆进三桶，四列与权益构成口径正确', () => {
    const positions = [
      mkPosition('A', 800, 800), // 债类，系数 20%：稳健 640 / 权益 160
      mkPosition('B', 100, 100), // 权益类，系数 100%：权益 100
      mkPosition('C', 100, 100) // 黄金类，系数 0%：黄金 100
    ]
    const funds = [mkFund('A', '债', 0.2), mkFund('B', '权益', 1), mkFund('C', '黄金', 0)]
    const targets: BucketTarget[] = [
      { bucket: '稳健', targetRatio: 0.6 },
      { bucket: '权益', targetRatio: 0.3 },
      { bucket: '黄金', targetRatio: 0.1 }
    ]

    const result = computeAllocationComparison(positions, funds, targets)
    const rows = Object.fromEntries(result.rows.map((r) => [r.bucket, r]))

    expect(result.rows.map((r) => r.bucket)).toEqual(['稳健', '权益', '黄金'])
    expect(rows['稳健'].marketRatio).toBeCloseTo(0.64, 9)
    expect(rows['权益'].marketRatio).toBeCloseTo(0.26, 9)
    expect(rows['黄金'].marketRatio).toBeCloseTo(0.1, 9)
    expect(rows['稳健'].investedRatio).toBeCloseTo(0.64, 9)
    expect(rows['权益'].investedRatio).toBeCloseTo(0.26, 9)
    expect(rows['黄金'].investedRatio).toBeCloseTo(0.1, 9)
    expect(rows['稳健'].deviation).toBeCloseTo(0.04, 9)
    expect(rows['权益'].deviation).toBeCloseTo(-0.04, 9)
    expect(rows['黄金'].deviation).toBeCloseTo(0, 9)
    expect(result.targetTotal).toBeCloseTo(1, 9)
    expect(result.targetNormalized).toBe(false)
    // 权益构成：直接 = 权益类基金权益部分；债类穿透 = 债类基金按系数计入权益的部分
    expect(result.equityComposition.direct).toBeCloseTo(0.1, 9)
    expect(result.equityComposition.debtPassthrough).toBeCloseTo(0.16, 9)
    expect(result.missingNavCount).toBe(0)
  })

  it('已清仓基金不参与当前比例：分子分母都只统计在持持仓', () => {
    const held = mkPosition('A', 800, 800)
    const closed = { ...mkPosition('Z', 999, 5000, 0), invested: 20000, redeemed: 15000 }
    const funds = [mkFund('A', '债', 0), mkFund('Z', '权益', 1)]

    const result = computeAllocationComparison([held, closed], funds, [
      { bucket: '稳健', targetRatio: 0.5 },
      { bucket: '权益', targetRatio: 0.5 }
    ])
    const rows = Object.fromEntries(result.rows.map((r) => [r.bucket, r]))

    expect(rows['稳健'].investedRatio).toBe(1)
    expect(rows['稳健'].marketRatio).toBe(1)
    expect(rows['权益'].investedRatio).toBe(0)
    expect(rows['权益'].marketRatio).toBe(0)
    // 清仓残留的净投入与市值都不进分母；偏离按归一化目标计算
    expect(rows['权益'].deviation).toBeCloseTo(-0.5, 9)
  })

  it('缺净值的在持基金：投入比例计入、市值按 0 计，缺净值数量单独返回', () => {
    const positions = [mkPosition('A', 800, 800), mkPosition('B', null, 200)]
    const funds = [mkFund('A', '债', 0), mkFund('B', '权益', 1)]

    const result = computeAllocationComparison(positions, funds, [])
    const rows = Object.fromEntries(result.rows.map((r) => [r.bucket, r]))

    expect(result.missingNavCount).toBe(1)
    expect(rows['稳健'].investedRatio).toBeCloseTo(0.8, 9)
    expect(rows['权益'].investedRatio).toBeCloseTo(0.2, 9)
    // 市值分母只含可估值持仓：B 的市值按 0 计，三桶市值占比仍合计 100%
    expect(rows['稳健'].marketRatio).toBe(1)
    expect(rows['权益'].marketRatio).toBe(0)
    const marketSum = result.rows.reduce((sum, r) => sum + (r.marketRatio ?? 0), 0)
    expect(marketSum).toBeCloseTo(1, 9)
  })

  it('全部在持基金都缺净值：市值占比无定义（「—」），不显示为 0%', () => {
    const result = computeAllocationComparison(
      [mkPosition('A', null, 800)],
      [mkFund('A', '债', 0)],
      [{ bucket: '稳健', targetRatio: 1 }]
    )

    expect(result.rows.every((r) => r.marketRatio === null)).toBe(true)
    expect(result.rows.every((r) => r.deviation === null)).toBe(true)
    expect(result.equityComposition.direct).toBeNull()
    expect(result.equityComposition.debtPassthrough).toBeNull()
  })

  it('目标合计不等于 100%：警告标记为真，偏离按归一化目标计算', () => {
    const result = computeAllocationComparison(
      [mkPosition('A', 600, 600), mkPosition('B', 400, 400)],
      [mkFund('A', '债', 0), mkFund('B', '权益', 1)],
      [
        { bucket: '稳健', targetRatio: 0.3 },
        { bucket: '权益', targetRatio: 0.2 },
        { bucket: '黄金', targetRatio: 0.2 }
      ]
    )
    const rows = Object.fromEntries(result.rows.map((r) => [r.bucket, r]))

    expect(result.targetTotal).toBeCloseTo(0.7, 9)
    expect(result.targetNormalized).toBe(true)
    // 归一化目标：稳健 30/70、权益 20/70、黄金 20/70
    expect(rows['稳健'].deviation).toBeCloseTo(0.6 - 0.3 / 0.7, 9)
    expect(rows['权益'].deviation).toBeCloseTo(0.4 - 0.2 / 0.7, 9)
    expect(rows['黄金'].deviation).toBeCloseTo(0 - 0.2 / 0.7, 9)
  })

  it('目标合计为 0 视为未配置：偏离为空，不伪造低配；黄金行仍常驻', () => {
    const result = computeAllocationComparison(
      [mkPosition('A', 100, 100)],
      [mkFund('A', '权益', 1)],
      []
    )

    expect(result.rows.map((r) => r.bucket)).toEqual(['稳健', '权益', '黄金'])
    expect(result.targetTotal).toBe(0)
    expect(result.targetNormalized).toBe(false)
    expect(result.rows.every((r) => r.targetRatio === 0)).toBe(true)
    expect(result.rows.every((r) => r.deviation === null)).toBe(true)
  })

  it('黄金类基金被覆盖出非零权益系数时，权益部分穿透进权益桶', () => {
    const result = computeAllocationComparison(
      [mkPosition('G', 100, 100)],
      [mkFund('G', '黄金', 0.3)],
      []
    )
    const rows = Object.fromEntries(result.rows.map((r) => [r.bucket, r]))

    expect(rows['权益'].marketRatio).toBeCloseTo(0.3, 9)
    expect(rows['黄金'].marketRatio).toBeCloseTo(0.7, 9)
    expect(rows['稳健'].marketRatio).toBe(0)
  })
})
