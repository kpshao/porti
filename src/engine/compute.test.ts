import { describe, expect, it } from 'vitest'
import type {
  Fund,
  Transaction,
  TransactionRow,
  NavPoint,
  FundSeriesPoint,
  FundPosition,
  PositionGroup,
  CategoryTarget
} from './types'
import {
  computePositions,
  computeTotals,
  computeCategoryComparison,
  computeTimeSeries,
  computeWeeklyReturn,
  computeStatsSeries,
  computeFundSeries,
  filterFundSeriesRange,
  computeAnnualizedReturns,
  computeTotalAnnualizedReturn,
  applyCostBasis,
  costBasisStates,
  realizedPerSale,
  realizedForSale,
  groupPositionsByCategory,
  groupClosedPositions,
  OTHER_CATEGORY,
  CLOSED_CATEGORY,
  computeScopedSummary,
  computeConcentrationMetrics,
  latestNavDate,
  xirr
} from './compute'

/** 构造持仓：只关心分组与对比用到的字段，其余给中性值 */
function mkPosition(
  fundCode: string,
  category: string,
  marketValue: number | null,
  shares = 100
): FundPosition {
  return {
    fundCode,
    name: fundCode,
    category,
    fundType: null,
    invested: 0,
    redeemed: 0,
    netCost: 0,
    costBasis: 0,
    shares,
    latestNav: null,
    latestNavDate: null,
    marketValue,
    pnl: null,
    pnlRatio: null
  }
}

/** 既有分组用例的适配入口：这些用例不关心大类指标，流水给空值、今天给固定日。 */
function groupHeldPositions(positions: FundPosition[]): PositionGroup[] {
  return groupPositionsByCategory(positions, [], '2026-01-01')
}

describe('数据新鲜度日期（latestNavDate）', () => {
  const nav = (date: string): NavPoint => ({ fundCode: '000001', date, nav: 1, source: 'manual' })

  it('空集返回 null（没有净值记录即没有数据新鲜度日期）', () => {
    expect(latestNavDate([])).toBeNull()
  })

  it('乱序三点取最大日期', () => {
    expect(latestNavDate([nav('2024-03-01'), nav('2024-01-15'), nav('2024-12-31')])).toBe(
      '2024-12-31'
    )
  })
})

// ---------- Golden fixtures：取自 投资跟踪.xlsx 持仓概览的真实数据 ----------

const goldenFunds: Fund[] = [
  { code: '110017', name: '易方达增强回报债券A', category: '固守+', fundType: '二级债基' },
  { code: '002009', name: '中欧瑾通A', category: '固守+', fundType: '偏债混合' },
  { code: '512890', name: '华泰柏瑞红利低波ETF', category: '权益', fundType: '红利ETF' },
  { code: '000217', name: '华安黄金ETF联接C', category: '黄金', fundType: '黄金' },
  { code: '007824', name: '天弘弘择短债债券C', category: '流动性', fundType: '短债' }
]

const goldenTransactions: Transaction[] = [
  // 110017 易方达增强回报债券A：1 笔买入
  { date: '2026-03-03', type: '买入', fundCode: '110017', amount: 70000, shares: 50067.32, nav: 1.397, fee: 55.96, note: null },
  // 002009 中欧瑾通A：4 笔买入 + 1 笔分红再投入（金额 0、只加份额）
  { date: '2026-03-03', type: '买入', fundCode: '002009', amount: 30000, shares: 19295.67, nav: 1.5532, fee: 29.97, note: null },
  { date: '2026-04-16', type: '分红再投入', fundCode: '002009', amount: 0, shares: 77.56, nav: 1.553, fee: 0, note: null },
  { date: '2026-06-12', type: '买入', fundCode: '002009', amount: 10000, shares: 6497.99, nav: 1.5374, fee: 0, note: null },
  { date: '2026-06-16', type: '买入', fundCode: '002009', amount: 10000, shares: 6459.34, nav: 1.5466, fee: null, note: null },
  { date: '2026-06-19', type: '买入', fundCode: '002009', amount: 10000, shares: 6419.49, nav: 1.4462, fee: null, note: null },
  // 512890 华泰柏瑞红利低波ETF：14 笔买入
  { date: '2026-03-03', type: '买入', fundCode: '512890', amount: 39878.2, shares: 33200, nav: 1.201, fee: 0, note: null },
  { date: '2026-06-25', type: '买入', fundCode: '512890', amount: 1097, shares: 1000, nav: 1.092, fee: null, note: null },
  { date: '2026-06-29', type: '买入', fundCode: '512890', amount: 1092, shares: 1000, nav: 1.087, fee: null, note: null },
  { date: '2026-06-30', type: '买入', fundCode: '512890', amount: 537.5, shares: 500, nav: 1.065, fee: null, note: null },
  { date: '2026-07-06', type: '买入', fundCode: '512890', amount: 558, shares: 500, nav: 1.106, fee: null, note: null },
  { date: '2026-07-09', type: '买入', fundCode: '512890', amount: 559, shares: 500, nav: 1.108, fee: null, note: null },
  { date: '2026-07-10', type: '买入', fundCode: '512890', amount: 555, shares: 500, nav: 1.1, fee: null, note: null },
  { date: '2026-07-13', type: '买入', fundCode: '512890', amount: 566.5, shares: 500, nav: 1.123, fee: null, note: null },
  { date: '2026-07-16', type: '买入', fundCode: '512890', amount: 575, shares: 500, nav: 1.14, fee: null, note: null },
  { date: '2026-07-17', type: '买入', fundCode: '512890', amount: 580, shares: 500, nav: 1.15, fee: null, note: null },
  { date: '2026-08-05', type: '买入', fundCode: '512890', amount: 587.5, shares: 500, nav: 1.165, fee: null, note: null },
  { date: '2026-08-06', type: '买入', fundCode: '512890', amount: 584.5, shares: 500, nav: 1.159, fee: null, note: null },
  { date: '2026-08-10', type: '买入', fundCode: '512890', amount: 587.5, shares: 500, nav: 1.165, fee: null, note: null },
  { date: '2026-08-11', type: '买入', fundCode: '512890', amount: 586.5, shares: 500, nav: 1.163, fee: null, note: null },
  // 000217 华安黄金ETF联接C：1 笔买入
  { date: '2026-02-26', type: '买入', fundCode: '000217', amount: 59050, shares: 16032.86, nav: 3.6831, fee: 0, note: null },
  // 007824 天弘弘择短债债券C：1 笔买入
  { date: '2026-06-12', type: '买入', fundCode: '007824', amount: 40000, shares: 34314.15, nav: 1.1657, fee: 0, note: null }
]

// 持仓概览中的最新净值（2026-08-11）
const goldenNavPoints: NavPoint[] = [
  { fundCode: '110017', date: '2026-08-11', nav: 1.41, source: 'import' },
  { fundCode: '002009', date: '2026-08-11', nav: 1.5336, source: 'import' },
  { fundCode: '512890', date: '2026-08-11', nav: 1.176, source: 'import' },
  { fundCode: '000217', date: '2026-08-11', nav: 3.3078, source: 'import' },
  { fundCode: '007824', date: '2026-08-11', nav: 1.1678, source: 'import' }
]

describe('computePositions — Excel golden values（持仓概览 5 只基金逐项一致）', () => {
  const positions = computePositions(goldenFunds, goldenTransactions, goldenNavPoints)
  const byCode = new Map(positions.map((p) => [p.fundCode, p]))

  it('110017 易方达增强回报债券A', () => {
    const p = byCode.get('110017')!
    expect(p.invested).toBeCloseTo(70000, 2)
    expect(p.netCost).toBeCloseTo(70000, 2)
    expect(p.costBasis).toBeCloseTo(70000, 2) // 无卖出：持仓成本 = 累计买入
    expect(p.shares).toBeCloseTo(50067.32, 6)
    expect(p.marketValue).toBeCloseTo(70594.9212, 2)
    expect(p.pnl).toBeCloseTo(594.9212, 2)
    expect(p.pnlRatio).toBeCloseTo(594.9212 / 70000, 9)
  })

  it('002009 中欧瑾通A（含分红再投入：份额加、成本不变）', () => {
    const p = byCode.get('002009')!
    expect(p.invested).toBeCloseTo(60000, 2)
    expect(p.netCost).toBeCloseTo(60000, 2)
    expect(p.costBasis).toBeCloseTo(60000, 2) // 分红再投入 0 成本份额：持仓成本不变
    expect(p.shares).toBeCloseTo(38750.05, 6)
    expect(p.marketValue).toBeCloseTo(59427.07668, 2)
    expect(p.pnl).toBeCloseTo(-572.92332, 2)
  })

  it('512890 华泰柏瑞红利低波ETF（14 笔买入）', () => {
    const p = byCode.get('512890')!
    expect(p.invested).toBeCloseTo(48344.2, 2)
    expect(p.costBasis).toBeCloseTo(48344.2, 2)
    expect(p.shares).toBeCloseTo(40700, 6)
    expect(p.marketValue).toBeCloseTo(47863.2, 2)
    expect(p.pnl).toBeCloseTo(-481, 2)
  })

  it('000217 华安黄金ETF联接C', () => {
    const p = byCode.get('000217')!
    expect(p.netCost).toBeCloseTo(59050, 2)
    expect(p.costBasis).toBeCloseTo(59050, 2)
    expect(p.shares).toBeCloseTo(16032.86, 6)
    expect(p.marketValue).toBeCloseTo(53033.494308, 2)
    expect(p.pnl).toBeCloseTo(-6016.505692, 2)
  })

  it('007824 天弘弘择短债债券C', () => {
    const p = byCode.get('007824')!
    expect(p.netCost).toBeCloseTo(40000, 2)
    expect(p.costBasis).toBeCloseTo(40000, 2)
    expect(p.shares).toBeCloseTo(34314.15, 6)
    expect(p.marketValue).toBeCloseTo(40072.06437, 2)
    expect(p.pnl).toBeCloseTo(72.06437, 2)
  })

  it('汇总数字与 5 只基金合计一致', () => {
    const totals = computeTotals(positions, goldenTransactions)
    expect(totals.totalNetCost).toBeCloseTo(277394.2, 2)
    expect(totals.totalAssets).toBeCloseTo(270990.756558, 2)
    expect(totals.totalPnl).toBeCloseTo(-6403.443442, 2)
    expect(totals.totalReturnRate).toBeCloseTo(-6403.443442 / 277394.2, 9)
    expect(totals.realizedIncome).toBe(0)
    expect(totals.totalReturn).toBeCloseTo(-6403.443442, 2)
  })
})

describe('卖出与分红现金', () => {
  const fund: Fund = { code: '999001', name: '测试基金', category: '权益', fundType: null }
  const transactions: Transaction[] = [
    { date: '2026-01-01', type: '买入', fundCode: '999001', amount: 2000, shares: 1000, nav: 2, fee: 0, note: null },
    { date: '2026-02-01', type: '卖出', fundCode: '999001', amount: -1100, shares: -500, nav: 2.2, fee: 0, note: null },
    { date: '2026-03-01', type: '分红现金', fundCode: '999001', amount: 100, shares: null, nav: null, fee: null, note: null }
  ]
  const navPoints: NavPoint[] = [{ fundCode: '999001', date: '2026-03-15', nav: 2.5, source: 'auto' }]

  it('卖出扣减份额与成本（严格成本法：移动加权平均）', () => {
    const [p] = computePositions([fund], transactions, navPoints)
    expect(p.invested).toBe(2000)
    expect(p.redeemed).toBe(1100)
    expect(p.netCost).toBe(900)
    // 卖出 500/1000 份：消耗成本 1000，剩余持仓成本 1000
    expect(p.costBasis).toBeCloseTo(1000, 6)
    expect(p.shares).toBe(500)
    expect(p.marketValue).toBeCloseTo(1250, 6)
    expect(p.pnl).toBeCloseTo(250, 6)
    expect(p.pnlRatio).toBeCloseTo(250 / 1000, 9)
  })

  it('已实现盈亏 = 分红现金 + 卖出已实现收益，总收益数值与简单成本法恒等', () => {
    const [p] = computePositions([fund], transactions, navPoints)
    const totals = computeTotals([p], transactions)
    // 卖出已实现 = 1100 − 1000 = 100；已实现盈亏 = 100 + 分红 100 = 200
    expect(totals.realizedIncome).toBeCloseTo(200, 6)
    // 总收益 = 浮动 250 + 已实现盈亏 200 = 450（简单成本法口径亦为 350 + 100 = 450）
    expect(totals.totalReturn).toBeCloseTo(450, 6)
    expect(totals.totalReturnRate).toBeCloseTo(450 / 900, 9)
    expect(p.pnl).toBeCloseTo(250, 6)
  })
})

describe('边界情况', () => {
  const fund: Fund = { code: '999002', name: '空基金', category: '纯债', fundType: null }

  it('无任何流水：零持仓，收益率保护为 null', () => {
    const [p] = computePositions([fund], [], [])
    expect(p.netCost).toBe(0)
    expect(p.costBasis).toBe(0)
    expect(p.shares).toBe(0)
    expect(p.marketValue).toBeNull()
    expect(p.pnl).toBeNull()
    const totals = computeTotals([p], [])
    expect(totals.totalReturnRate).toBeNull()
  })

  it('有成本但无净值：市值与盈亏为 null，总盈亏 = −持仓成本', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: '999002', amount: 10000, shares: 10000, nav: 1, fee: 0, note: null }
    ]
    const [p] = computePositions([fund], txs, [])
    expect(p.marketValue).toBeNull()
    expect(p.pnl).toBeNull()
    const totals = computeTotals([p], txs)
    expect(totals.totalPnl).toBe(-10000)
  })

  it('分红再投入：份额增加、投入不变', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: '999002', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2026-02-01', type: '分红再投入', fundCode: '999002', amount: 0, shares: 100, nav: 1.1, fee: 0, note: null }
    ]
    const [p] = computePositions([fund], txs, [])
    expect(p.shares).toBe(1100)
    expect(p.invested).toBe(1000)
  })
})

describe('大类配置对比', () => {
  it('投入比例/市值占比/偏离计算正确', () => {
    // 在持（份额 > 0）——投入比例只统计这类持仓
    const positions = [
      { fundCode: 'A', name: 'A', category: '固守+', fundType: null, invested: 300, redeemed: 0, netCost: 300, costBasis: 300, shares: 300, latestNav: null, latestNavDate: null, marketValue: 330, pnl: 30, pnlRatio: 0.1 },
      { fundCode: 'B', name: 'B', category: '权益', fundType: null, invested: 100, redeemed: 0, netCost: 100, costBasis: 100, shares: 100, latestNav: null, latestNavDate: null, marketValue: 110, pnl: 10, pnlRatio: 0.1 },
      { fundCode: 'C', name: 'C', category: '黄金', fundType: null, invested: 100, redeemed: 0, netCost: 100, costBasis: 100, shares: 100, latestNav: null, latestNavDate: null, marketValue: 100, pnl: 0, pnlRatio: 0 }
    ]
    const targets: CategoryTarget[] = [
      { category: '固守+', targetRatio: 0.25 },
      { category: '纯债', targetRatio: 0.45 },
      { category: '权益', targetRatio: 0.2 },
      { category: '黄金', targetRatio: 0.05 },
      { category: '流动性', targetRatio: 0.05 }
    ]
    const rows = computeCategoryComparison(positions, targets)
    const byCat = new Map(rows.map((r) => [r.category, r]))

    const gs = byCat.get('固守+')!
    expect(gs.investedRatio).toBeCloseTo(0.6, 9) // 300/500
    expect(gs.marketRatio).toBeCloseTo(330 / 540, 9)
    expect(gs.deviation).toBeCloseTo(330 / 540 - 0.25, 9)

    const eq = byCat.get('权益')!
    expect(eq.investedRatio).toBeCloseTo(0.2, 9)
    expect(eq.marketRatio).toBeCloseTo(110 / 540, 9)
    expect(eq.deviation).toBeCloseTo(110 / 540 - 0.2, 9)

    // 无持仓大类：比例为 0，偏离 = −目标比例
    const pure = byCat.get('纯债')!
    expect(pure.investedRatio).toBeCloseTo(0, 9)
    expect(pure.marketRatio).toBeCloseTo(0, 9)
    expect(pure.deviation).toBeCloseTo(-0.45, 9)

    // 有持仓但无目标的大类：目标按 0 处理
    const gold = byCat.get('黄金')!
    expect(gold.targetRatio).toBe(0.05)
    expect(rows.length).toBe(5)
  })

  it('大类清仓后：投入比例记 0、偏离为 null；分母只含仍在持的持仓', () => {
    // 真实场景：000217 华安黄金ETF联接C 清仓（净投入 10358.20 残留），黄金大类只剩它
    const clearedGold: FundPosition = {
      ...mkPosition('000217', '黄金', 0, 0),
      invested: 59050,
      redeemed: 48691.8,
      netCost: 10358.2
    }
    const heldEquity: FundPosition = {
      ...mkPosition('512890', '权益', 12000),
      invested: 10000,
      netCost: 10000,
      costBasis: 10000
    }
    const targets: CategoryTarget[] = [
      { category: '纯债', targetRatio: 0.45 },
      { category: '权益', targetRatio: 0.2 },
      { category: '黄金', targetRatio: 0.05 }
    ]
    const rows = computeCategoryComparison([clearedGold, heldEquity], targets)
    const byCat = new Map(rows.map((r) => [r.category, r]))

    // 清仓大类：投入比例 0（不再凭空占 10358.20 / 20358.20 = 50.88%）
    const gold = byCat.get('黄金')!
    expect(gold.investedRatio).toBe(0)
    expect(gold.marketRatio).toBe(0)
    expect(gold.deviation).toBeNull() // 已清空 → 不再提示低配

    // 分母只含仍在持的持仓（10000，而非 20358.20）
    const equity = byCat.get('权益')!
    expect(equity.investedRatio).toBeCloseTo(1, 9)
    expect(equity.marketRatio).toBeCloseTo(1, 9)
    expect(equity.deviation).toBeCloseTo(0.8, 9)

    // 从未配置的大类：口径不变，仍是 −目标比例（提示尚未建立该仓位）
    expect(byCat.get('纯债')!.investedRatio).toBe(0)
    expect(byCat.get('纯债')!.deviation).toBeCloseTo(-0.45, 9)
  })

  it('混合场景：部分大类清仓时分母只累加在持持仓的净投入', () => {
    const positions: FundPosition[] = [
      { ...mkPosition('100001', '固守+', 30000), invested: 30000, netCost: 30000, costBasis: 30000 },
      { ...mkPosition('200001', '权益', 8000), invested: 10000, netCost: 10000, costBasis: 10000 },
      // 两只已清仓基金：净投入残留分别 5000 / 8000，均不得进入分母
      { ...mkPosition('400001', '黄金', 0, 0), invested: 20000, redeemed: 15000, netCost: 5000 },
      { ...mkPosition('500001', '流动性', 0, 0), invested: 8000, redeemed: 8000, netCost: 0 }
    ]
    const targets: CategoryTarget[] = [
      { category: '固守+', targetRatio: 0.8 },
      { category: '权益', targetRatio: 0.2 },
      { category: '黄金', targetRatio: 0 },
      { category: '流动性', targetRatio: 0 }
    ]
    const rows = computeCategoryComparison(positions, targets)
    const byCat = new Map(rows.map((r) => [r.category, r]))

    // 分母 = 30000 + 10000 = 40000（不含清仓残留的 5000）
    expect(byCat.get('固守+')!.investedRatio).toBeCloseTo(0.75, 9)
    expect(byCat.get('权益')!.investedRatio).toBeCloseTo(0.25, 9)
    // 净资产全部赎回（净投入恰好为 0）的已清仓大类：比例 0，偏离亦为 null
    expect(byCat.get('流动性')!.investedRatio).toBe(0)
    expect(byCat.get('流动性')!.deviation).toBeNull()
    expect(byCat.get('黄金')!.deviation).toBeNull()
    // 市值占比的分母不受清仓影响（清仓持仓市值恒为 0）
    expect(byCat.get('固守+')!.marketRatio).toBeCloseTo(30000 / 38000, 9)
  })

  it('行序按 CATEGORIES 声明顺序；闭集之外的类目排在其后且保持并集内相对次序', () => {
    const positions = [
      mkPosition('200001', '黄金', 100),
      mkPosition('300001', '股票型', 100),
      mkPosition('300002', 'QDII', 100),
      mkPosition('100001', '固守+', 100)
    ]
    const targets: CategoryTarget[] = [
      { category: '流动性', targetRatio: 0.05 },
      { category: '固守+', targetRatio: 0.25 }
    ]
    const rows = computeCategoryComparison(positions, targets)
    // 并集顺序为 流动性/固守+/黄金/股票型/QDII；按 CATEGORIES 排名后 = 固守+(0) → 黄金(3) → 流动性(4)
    // → 闭集外的股票型、QDII（同分，稳定排序保持并集内相对次序）
    expect(rows.map((r) => r.category)).toEqual(['固守+', '黄金', '流动性', '股票型', 'QDII'])
  })
})

describe('持仓明细按大类分组', () => {
  it('组序按 CATEGORIES 声明顺序（输入乱序也如此），组内按基金代码升序', () => {
    const groups = groupHeldPositions([
      mkPosition('300001', '流动性', 300),
      mkPosition('200002', '权益', 100),
      mkPosition('200001', '权益', 200),
      mkPosition('100001', '固守+', 500)
    ])
    expect(groups.map((g) => g.category)).toEqual(['固守+', '权益', '流动性'])
    // 组内按代码升序，与市值无关（200001 市值更小仍排在 200002 前面）
    expect(groups[1].positions.map((p) => p.fundCode)).toEqual(['200001', '200002'])
  })

  it('组头合计 = Σ市值；无持仓的大类不产生组', () => {
    const groups = groupHeldPositions([
      mkPosition('200001', '权益', 100),
      mkPosition('200002', '权益', 250.5),
      mkPosition('100001', '固守+', 500)
    ])
    expect(groups.map((g) => g.category)).toEqual(['固守+', '权益'])
    expect(groups[0].marketValue).toBeCloseTo(500, 9)
    expect(groups[1].marketValue).toBeCloseTo(350.5, 9)
  })

  it('已清仓（份额为 0）被过滤；过滤后为空的大类不产生组', () => {
    const groups = groupHeldPositions([
      mkPosition('200001', '权益', 100),
      mkPosition('400001', '黄金', 0, 0) // 已清仓：黄金组过滤后为空，不应出现
    ])
    expect(groups.map((g) => g.category)).toEqual(['权益'])
  })

  it('非五类的脏值与空串归入「其他」并置底', () => {
    const groups = groupHeldPositions([
      mkPosition('900002', '股票', 10),
      mkPosition('900001', '', 20),
      mkPosition('100001', '固守+', 500)
    ])
    expect(groups.map((g) => g.category)).toEqual(['固守+', OTHER_CATEGORY])
    expect(groups[1].marketValue).toBeCloseTo(30, 9)
    expect(groups[1].positions.map((p) => p.fundCode)).toEqual(['900001', '900002'])
  })

  it('市值有无与大小都不影响组内次序（代码是主键、不并列，无需 tie-break）', () => {
    const groups = groupHeldPositions([
      mkPosition('200003', '权益', null),
      mkPosition('200001', '权益', 999),
      mkPosition('200002', '权益', 1)
    ])
    expect(groups[0].positions.map((p) => p.fundCode)).toEqual(['200001', '200002', '200003'])
  })

  it('组内全部无净值时组头合计为空值', () => {
    const groups = groupHeldPositions([
      mkPosition('200001', '权益', null),
      mkPosition('200002', '权益', null)
    ])
    expect(groups[0].marketValue).toBeNull()
  })

  it('负份额（超卖数据错误）也不留在在持组里', () => {
    const groups = groupHeldPositions([
      mkPosition('200001', '权益', 100),
      mkPosition('400002', '黄金', -1200, -100) // 超卖：份额为负，市值随之为负
    ])
    expect(groups.map((g) => g.category)).toEqual(['权益'])
  })

  it('各组头合计之和 == 总资产（含已清仓持仓时为同一口径）', () => {
    const positions = [
      mkPosition('100001', '固守+', 500),
      mkPosition('200001', '权益', 100),
      mkPosition('200002', '权益', null),
      mkPosition('400001', '黄金', 0, 0) // 已清仓：对两个口径都贡献 0
    ]
    const groups = groupHeldPositions(positions)
    const sum = groups.reduce((s, g) => s + (g.marketValue ?? 0), 0)
    expect(sum).toBeCloseTo(computeTotals(positions, []).totalAssets, 9)
  })
})

describe('已清仓分组（持仓明细表尾单独一组）', () => {
  it('无已清仓持仓时为空；从未建仓（无流水、份额 0）不算已清仓', () => {
    expect(groupClosedPositions([mkPosition('200001', '权益', 100)])).toBeNull()
    expect(groupClosedPositions([])).toBeNull()
    expect(groupClosedPositions([mkPosition('000385', '固守+', 0, 0)])).toBeNull()
  })

  it('交易过且份额 ≤ 0 的持仓收进一组：组名「已清仓」，组内按代码升序，组头无市值口径', () => {
    const group = groupClosedPositions([
      { ...mkPosition('400002', '黄金', 0, 0), invested: 59050, redeemed: 48691.8 }, // 清仓
      mkPosition('200001', '权益', 100), // 在持，不进来
      { ...mkPosition('400001', '固守+', -50, -10), invested: 1000, redeemed: 1100 } // 超卖（负份额）也算已清仓
    ])
    expect(group).not.toBeNull()
    expect(group!.category).toBe(CLOSED_CATEGORY)
    expect(group!.positions.map((p) => p.fundCode)).toEqual(['400001', '400002'])
    expect(group!.marketValue).toBeNull() // 组头「大类市值」显示「—」：无在持份额即无市值口径
    expect(group!.pnlRatio).toBeNull() // 已清仓组不是资产大类：两项指标恒为空
    expect(group!.annualized).toBeNull()
  })

  it('与在持分组互补：并集 = 有过流水的持仓，交集为空', () => {
    const positions = [
      mkPosition('200001', '权益', 100),
      mkPosition('100001', '固守+', 500),
      { ...mkPosition('400001', '黄金', 0, 0), invested: 20000, redeemed: 15000 },
      { ...mkPosition('400002', '黄金', -1200, -100), invested: 5000, redeemed: 6200 },
      mkPosition('000385', '固守+', 0, 0) // 从未建仓：哪边都不在
    ]
    const held = groupHeldPositions(positions).flatMap((g) => g.positions)
    const closed = groupClosedPositions(positions)!.positions
    const all = [...held, ...closed].map((p) => p.fundCode).sort()
    expect(all).toEqual(['100001', '200001', '400001', '400002'])
    expect(held.filter((p) => closed.includes(p))).toEqual([])
  })
})

describe('持仓明细大类指标（大类盈亏比例 / 大类年化收益率）', () => {
  const TODAY = '2027-01-01'
  const fundOf = (code: string, category: string): Fund => ({
    code,
    name: `基金${code}`,
    category,
    fundType: null
  })
  const tx = (
    date: string,
    type: Transaction['type'],
    fundCode: string,
    amount: number,
    shares: number | null
  ): Transaction => ({ date, type, fundCode, amount, shares, nav: null, fee: 0, note: null })
  const nav = (fundCode: string, date: string, value: number): NavPoint => ({
    fundCode,
    date,
    nav: value,
    source: 'import'
  })
  const groupsOf = (
    funds: Fund[],
    txs: Transaction[],
    navs: NavPoint[]
  ): ReturnType<typeof groupPositionsByCategory> => {
    const positions = computePositions(funds, txs, navs)
    return groupPositionsByCategory(positions, txs, TODAY)
  }

  it('大类盈亏比例 = Σ持仓盈亏 ÷ Σ持仓成本（多基金加权，不是各基金比例的平均）', () => {
    // A：成本 1000，市值 1200（+200，+20%）；B：成本 3000，市值 2700（−300，−10%）
    const [group] = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '权益')],
      [tx('2025-01-01', '买入', 'A', 1000, 1000), tx('2025-01-01', '买入', 'B', 3000, 3000)],
      [nav('A', TODAY, 1.2), nav('B', TODAY, 0.9)]
    )
    expect(group.pnlRatio).toBeCloseTo(-100 / 4000, 9) // 加权后 −2.5%
    expect(group.pnlRatio).not.toBeCloseTo(0.05, 9) // 等权平均是 +5%，两者可区分
  })

  it('大类年化收益率 = 组内在持基金完整现金流的 XIRR（两基金手算黄金值）', () => {
    // A、B 均在 2025-01-01 买入 1000；今天 2027-01-01（730 天）市值 1320 + 1100 = 2420。
    // 1 + r = √(2420 / 2000) = 1.1 → r = 10%
    const [group] = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '权益')],
      [tx('2025-01-01', '买入', 'A', 1000, 1000), tx('2025-01-01', '买入', 'B', 1000, 1000)],
      [nav('A', TODAY, 1.32), nav('B', TODAY, 1.1)]
    )
    expect(group.pnlRatio).toBeCloseTo(420 / 2000, 9) // 盈亏比例 21%：与年化 10% 口径不同
    expect(group.annualized).toBeCloseTo(0.1, 9)
  })

  it('只有一个基金的大类：大类值与逐基金列相同（同一公式、同一流水）', () => {
    const funds = [fundOf('A', '权益')]
    const txs = [tx('2025-01-01', '买入', 'A', 1000, 1000)]
    const navs = [nav('A', TODAY, 1.32)]
    const positions = computePositions(funds, txs, navs)
    const [group] = groupPositionsByCategory(positions, txs, TODAY)
    expect(group.pnlRatio).toBeCloseTo(positions[0].pnlRatio!, 12)
    expect(group.annualized).toBeCloseTo(
      computeAnnualizedReturns(txs, navs, TODAY).get('A')!,
      12
    )
  })

  it('组内任一在持基金市值未知：大类盈亏比例与大类年化收益率两项皆空（不展示残缺汇总）', () => {
    // B 没有净值记录：marketValue 为 null；A 正常
    const [group] = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '权益')],
      [tx('2025-01-01', '买入', 'A', 1000, 1000), tx('2025-01-01', '买入', 'B', 1000, 1000)],
      [nav('A', TODAY, 1.1)]
    )
    expect(group.marketValue).toBeCloseTo(1100, 9) // 组头市值仍按缺失计 0（既有口径）
    expect(group.pnlRatio).toBeNull()
    expect(group.annualized).toBeNull()
  })

  it('持仓成本合计为 0：大类盈亏比例为空（比例无定义），大类年化收益率同样为空', () => {
    // 只有分红再投入（0 成本份额）：份额 > 0、市值存在，但 Σ持仓成本 = 0
    const [group] = groupsOf(
      [fundOf('A', '权益')],
      [tx('2025-01-01', '分红再投入', 'A', 0, 100)],
      [nav('A', TODAY, 1)]
    )
    expect(group.marketValue).toBeCloseTo(100, 9)
    expect(group.pnlRatio).toBeNull()
    expect(group.annualized).toBeNull() // 净投入 0 ≤ 0
  })

  it('已清仓基金不参与盈亏比例（只统计组内在持持仓）', () => {
    // B 已清仓（高收益卖出回款）：它的盈亏与成本都不进权益组
    const [group] = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '权益')],
      [
        tx('2025-01-01', '买入', 'A', 1000, 1000),
        tx('2025-01-01', '买入', 'B', 1000, 1000),
        tx(TODAY, '卖出', 'B', -2000, -1000)
      ],
      [nav('A', TODAY, 1.2), nav('B', TODAY, 2)]
    )
    expect(group.positions.map((p) => p.fundCode)).toEqual(['A'])
    expect(group.pnlRatio).toBeCloseTo(0.2, 9) // 仅 A：200 / 1000
  })

  it('「其他」兜底组同规则：脏值类目也按同一公式算出大类指标', () => {
    const [group] = groupsOf(
      [fundOf('A', '股票'), fundOf('B', '')],
      [tx('2025-01-01', '买入', 'A', 1000, 1000), tx('2025-01-01', '买入', 'B', 1000, 1000)],
      [nav('A', TODAY, 1.2), nav('B', TODAY, 0.9)]
    )
    expect(group.category).toBe(OTHER_CATEGORY)
    expect(group.pnlRatio).toBeCloseTo(100 / 2000, 9) // 320 − 100 的加权合计
    expect(group.annualized).toBeCloseTo(Math.sqrt(1.05) - 1, 9) // −2000 → 2100，730 天 → √1.05 − 1
  })

  it('大类年化收益率的现金流只取组内基金：不同大类互不串流', () => {
    // 权益 A：1000 → 1210（年化 +10%）；黄金 B：1000 → 810（年化 −10%）；均为 730 天
    const groups = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '黄金')],
      [tx('2025-01-01', '买入', 'A', 1000, 1000), tx('2025-01-01', '买入', 'B', 1000, 1000)],
      [nav('A', TODAY, 1.21), nav('B', TODAY, 0.81)]
    )
    expect(groups[0].annualized).toBeCloseTo(0.1, 9)
    expect(groups[1].annualized).toBeCloseTo(-0.1, 9)
  })

  it('已清仓基金的卖出回款不进大类年化收益率（仅组内在持基金参与）', () => {
    // A 在持：1000 → 1210（730 天，10%）；B 已清仓：1000 → 2000（若串入会把组年化抬高）
    const [group] = groupsOf(
      [fundOf('A', '权益'), fundOf('B', '权益')],
      [
        tx('2025-01-01', '买入', 'A', 1000, 1000),
        tx('2025-01-01', '买入', 'B', 1000, 1000),
        tx(TODAY, '卖出', 'B', -2000, -1000)
      ],
      [nav('A', TODAY, 1.21), nav('B', TODAY, 2)]
    )
    expect(group.annualized).toBeCloseTo(0.1, 9)
  })

  it('首笔现金流距今天不足 30 天：大类年化收益率为空，大类盈亏比例照常', () => {
    const [group] = groupsOf(
      [fundOf('A', '权益')],
      [tx('2026-12-03', '买入', 'A', 1000, 1000)], // 距 2027-01-01 仅 29 天
      [nav('A', TODAY, 1.1)]
    )
    expect(group.pnlRatio).toBeCloseTo(0.1, 9)
    expect(group.annualized).toBeNull()
  })

  it('净投入 ≤ 0：大类年化收益率为空（求根无经济意义），大类盈亏比例照常', () => {
    const [group] = groupsOf(
      [fundOf('A', '权益')],
      [
        tx('2025-01-01', '买入', 'A', 1000, 1000),
        tx('2026-01-01', '卖出', 'A', -1200, -500) // 仍在持 500 份，但净投入 −200
      ],
      [nav('A', TODAY, 1)]
    )
    expect(group.pnlRatio).toBeCloseTo(0, 9) // 市值 500 − 持仓成本 500
    expect(group.annualized).toBeNull()
  })

  it('清仓后重建：大类年化收益率含完整历史，时钟不重置（手算 10%）', () => {
    // 与口径化汇总同一场景：−1000 / +1200 / −500 与期末 440（三轮现金流跨两年）
    const [group] = groupsOf(
      [fundOf('A', '权益')],
      [
        tx('2025-01-01', '买入', 'A', 1000, 1000),
        tx('2026-01-01', '卖出', 'A', -1200, -1000), // 第一轮清仓：已实现 +200
        tx('2026-01-01', '买入', 'A', 500, 500) // 同日重建
      ],
      [nav('A', TODAY, 0.88)]
    )
    expect(group.pnlRatio).toBeCloseTo(-60 / 500, 9) // 市值 440 − 持仓成本 500
    expect(group.annualized).toBeCloseTo(0.1, 9)
  })
})

describe('总市值时间序列与周收益', () => {
  const funds: Fund[] = [
    { code: 'A', name: '基金A', category: '权益', fundType: null },
    { code: 'B', name: '基金B', category: '权益', fundType: null }
  ]
  const transactions: Transaction[] = [
    { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
    { date: '2026-01-05', type: '买入', fundCode: 'B', amount: 100, shares: 50, nav: 2, fee: 0, note: null }
  ]
  const navPoints: NavPoint[] = [
    { fundCode: 'A', date: '2026-01-01', nav: 1, source: 'import' },
    { fundCode: 'B', date: '2026-01-05', nav: 2, source: 'import' },
    { fundCode: 'A', date: '2026-01-05', nav: 1, source: 'import' },
    { fundCode: 'A', date: '2026-01-10', nav: 1.1, source: 'import' },
    { fundCode: 'B', date: '2026-01-10', nav: 2.2, source: 'import' }
  ]

  it('按日聚合总市值（未建仓基金不参与）', () => {
    const series = computeTimeSeries(funds, transactions, navPoints)
    expect(series.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-05', '2026-01-10'])
    expect(series.map((p) => p.totalMarketValue)).toEqual([
      100,
      200,
      expect.closeTo(220, 6)
    ])
  })

  it('周收益 = 最新记录 vs ≥7 天前最近记录', () => {
    const series = [
      { date: '2026-03-01', totalMarketValue: 100 },
      { date: '2026-03-05', totalMarketValue: 110 },
      { date: '2026-03-12', totalMarketValue: 105 },
      { date: '2026-03-19', totalMarketValue: 120 }
    ]
    const weekly = computeWeeklyReturn(series)
    expect(weekly[0]).toBeNull()
    expect(weekly[1]).toBeNull() // 与 03-01 仅差 4 天
    expect(weekly[2]).toBeCloseTo(-5, 6) // 03-12 vs 03-05 差 7 天
    expect(weekly[3]).toBeCloseTo(15, 6) // 03-19 vs 03-12 差 7 天
  })
})

describe('收益统计时间序列（含卖出与分红现金，期望值手算）', () => {
  const funds: Fund[] = [
    { code: 'A', name: '基金A', category: '权益', fundType: null },
    { code: 'B', name: '基金B', category: '权益', fundType: null }
  ]
  const transactions: Transaction[] = [
    { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
    { date: '2026-01-05', type: '买入', fundCode: 'B', amount: 100, shares: 50, nav: 2, fee: 0, note: null },
    { date: '2026-01-12', type: '分红现金', fundCode: 'A', amount: 20, shares: null, nav: null, fee: null, note: null },
    { date: '2026-01-20', type: '卖出', fundCode: 'B', amount: -60, shares: -25, nav: 2.4, fee: 0, note: null }
  ]
  const navPoints: NavPoint[] = [
    { fundCode: 'A', date: '2026-01-01', nav: 1, source: 'import' },
    { fundCode: 'A', date: '2026-01-05', nav: 1, source: 'import' },
    { fundCode: 'A', date: '2026-01-10', nav: 1.1, source: 'import' },
    { fundCode: 'A', date: '2026-01-15', nav: 1.2, source: 'import' },
    { fundCode: 'A', date: '2026-01-20', nav: 1.3, source: 'import' },
    { fundCode: 'B', date: '2026-01-05', nav: 2, source: 'import' },
    { fundCode: 'B', date: '2026-01-10', nav: 2.2, source: 'import' },
    { fundCode: 'B', date: '2026-01-15', nav: 2.1, source: 'import' },
    { fundCode: 'B', date: '2026-01-20', nav: 2.4, source: 'import' }
  ]

  it('逐日累计：持仓成本/已实现盈亏按日期截断，累计收益 = 市值 − 持仓成本 + 已实现盈亏', () => {
    const series = computeStatsSeries(funds, transactions, navPoints)
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-05',
      '2026-01-10',
      '2026-01-15',
      '2026-01-20'
    ])
    // 01-01：仅 A 建仓 100；持仓成本 100；累计收益 0
    expect(series[0]).toMatchObject({
      totalMarketValue: expect.closeTo(100, 6),
      costBasis: expect.closeTo(100, 6),
      realizedIncome: 0,
      totalReturn: expect.closeTo(0, 6),
      weeklyReturn: null
    })
    // 01-05：A 100 + B 100；持仓成本 200；无 ≥7 天前基准
    expect(series[1]).toMatchObject({
      totalMarketValue: expect.closeTo(200, 6),
      costBasis: expect.closeTo(200, 6),
      realizedIncome: 0,
      totalReturn: 0,
      weeklyReturn: null
    })
    // 01-10：市值 110+110；基准 01-01（差 9 天）：220 − 100 = 120
    expect(series[2]).toMatchObject({
      totalMarketValue: expect.closeTo(220, 6),
      costBasis: 200,
      realizedIncome: 0,
      totalReturn: expect.closeTo(20, 6),
      weeklyReturn: { value: expect.closeTo(120, 6), baseDate: '2026-01-01' }
    })
    // 01-15：市值 120+105；分红现金 01-12 起计入已实现盈亏；基准 01-05（差 10 天）：225 − 200 = 25
    expect(series[3]).toMatchObject({
      totalMarketValue: expect.closeTo(225, 6),
      costBasis: 200,
      realizedIncome: expect.closeTo(20, 6),
      totalReturn: expect.closeTo(45, 6),
      weeklyReturn: { value: expect.closeTo(25, 6), baseDate: '2026-01-05' }
    })
    // 01-20：卖出 B 25/50 份（消耗成本 50，已实现 10）；持仓成本 150；已实现盈亏 20+10=30；基准 01-10：190 − 220 = −30
    expect(series[4]).toMatchObject({
      totalMarketValue: expect.closeTo(190, 6),
      costBasis: expect.closeTo(150, 6),
      realizedIncome: expect.closeTo(30, 6),
      totalReturn: expect.closeTo(70, 6),
      weeklyReturn: { value: expect.closeTo(-30, 6), baseDate: '2026-01-10' }
    })
  })

  it('最后一个点与引擎汇总口径一致（总收益 = 持仓盈亏 + 已实现盈亏）', () => {
    const series = computeStatsSeries(funds, transactions, navPoints)
    const positions = computePositions(funds, transactions, navPoints)
    const totals = computeTotals(positions, transactions)
    const last = series[series.length - 1]
    expect(last.totalMarketValue).toBeCloseTo(totals.totalAssets, 6)
    expect(last.totalReturn).toBeCloseTo(totals.totalReturn, 6)
  })
})

describe('单基金收益走势（computeFundSeries，手算黄金值）', () => {
  const fund: Fund = { code: 'A', name: '基金A', category: '权益', fundType: null }
  const nav = (date: string, value: number): NavPoint => ({ fundCode: 'A', date, nav: value, source: 'import' })

  it('单笔买入 + 两日净值上涨：收益率 =（市值 − 成本）/ 成本', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null }
    ]
    const series = computeFundSeries('A', [fund], txs, [nav('2026-01-01', 1), nav('2026-01-02', 1.1)])
    expect(series.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02'])
    expect(series[0]).toMatchObject({
      marketValue: expect.closeTo(1000, 6),
      costBasis: 1000,
      realizedIncome: 0,
      totalReturn: expect.closeTo(0, 6),
      totalReturnRate: expect.closeTo(0, 9)
    })
    expect(series[1]).toMatchObject({
      marketValue: expect.closeTo(1100, 6),
      costBasis: 1000,
      totalReturn: expect.closeTo(100, 6),
      totalReturnRate: expect.closeTo(0.1, 9)
    })
  })

  it('买入 → 部分卖出 → 分红现金：移动加权成本与已实现盈亏逐日手算一致', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { id: 2, date: '2026-01-02', type: '卖出', fundCode: 'A', amount: -750, shares: -500, nav: 1.5, fee: 0, note: null },
      { id: 3, date: '2026-01-03', type: '分红现金', fundCode: 'A', amount: 100, shares: null, nav: null, fee: null, note: null }
    ]
    const series = computeFundSeries('A', [fund], txs, [
      nav('2026-01-01', 1),
      nav('2026-01-02', 1.5),
      nav('2026-01-03', 1.6)
    ])
    // 01-02：卖出 500/1000 份，消耗成本 500，已实现 = 750 − 500 = 250
    expect(series[1]).toMatchObject({
      marketValue: expect.closeTo(750, 6),
      costBasis: expect.closeTo(500, 6),
      realizedIncome: expect.closeTo(250, 6),
      totalReturn: expect.closeTo(500, 6),
      totalReturnRate: expect.closeTo(1, 9)
    })
    // 01-03：已实现盈亏 = 250 + 分红现金 100 = 350
    expect(series[2]).toMatchObject({
      marketValue: expect.closeTo(800, 6),
      costBasis: expect.closeTo(500, 6),
      realizedIncome: expect.closeTo(350, 6),
      totalReturn: expect.closeTo(650, 6),
      totalReturnRate: expect.closeTo(1.3, 9)
    })
  })

  it('分红再投入：份额加、成本不变，累计盈亏跳升', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { id: 2, date: '2026-01-02', type: '分红再投入', fundCode: 'A', amount: 0, shares: 100, nav: 1.2, fee: 0, note: null }
    ]
    const series = computeFundSeries('A', [fund], txs, [nav('2026-01-01', 1), nav('2026-01-02', 1.2)])
    expect(series[1]).toMatchObject({
      marketValue: expect.closeTo(1320, 6),
      costBasis: 1000,
      realizedIncome: 0,
      totalReturn: expect.closeTo(320, 6),
      totalReturnRate: expect.closeTo(0.32, 9)
    })
  })

  it('全部卖出后：持仓成本为 0，收益率为 null、累计盈亏为已实现盈亏平台', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { id: 2, date: '2026-01-02', type: '卖出', fundCode: 'A', amount: -1500, shares: -1000, nav: 1.5, fee: 0, note: null }
    ]
    const series = computeFundSeries('A', [fund], txs, [
      nav('2026-01-01', 1),
      nav('2026-01-02', 1.5),
      nav('2026-01-03', 1.6)
    ])
    expect(series[1]).toMatchObject({
      marketValue: 0,
      costBasis: 0,
      realizedIncome: expect.closeTo(500, 6),
      totalReturn: expect.closeTo(500, 6),
      totalReturnRate: null
    })
    expect(series[2]).toMatchObject({
      marketValue: 0,
      costBasis: 0,
      realizedIncome: expect.closeTo(500, 6),
      totalReturn: expect.closeTo(500, 6),
      totalReturnRate: null
    })
  })

  it('同日多笔按 date, id 顺序截断（输入乱序也一致）', () => {
    const buyRow: TransactionRow = {
      id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null
    }
    const sellRow: TransactionRow = {
      id: 2, date: '2026-01-01', type: '卖出', fundCode: 'A', amount: -750, shares: -500, nav: 1.5, fee: 0, note: null
    }
    // 乱序输入（先卖后买）：按 date, id 排序后仍先买后卖，消耗成本 500、已实现 250
    const series = computeFundSeries('A', [fund], [sellRow, buyRow], [nav('2026-01-01', 1.5)])
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      marketValue: expect.closeTo(750, 6),
      costBasis: expect.closeTo(500, 6),
      realizedIncome: expect.closeTo(250, 6),
      totalReturn: expect.closeTo(500, 6),
      totalReturnRate: expect.closeTo(1, 9)
    })
  })

  it('无净值记录 → 空序列；未知基金代码 → 空序列', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null }
    ]
    expect(computeFundSeries('A', [fund], txs, [])).toEqual([])
    expect(computeFundSeries('X', [fund], txs, [nav('2026-01-01', 1)])).toEqual([])
  })

  it('净值日期早于首笔流水：份额为 0，市值与成本为 0，收益率为 null', () => {
    const txs: TransactionRow[] = [
      { id: 1, date: '2026-01-02', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null }
    ]
    const series = computeFundSeries('A', [fund], txs, [nav('2026-01-01', 1), nav('2026-01-02', 1)])
    expect(series[0]).toMatchObject({
      marketValue: 0,
      costBasis: 0,
      realizedIncome: 0,
      totalReturn: 0,
      totalReturnRate: null
    })
    expect(series[1]).toMatchObject({
      marketValue: expect.closeTo(1000, 6),
      costBasis: 1000,
      totalReturnRate: expect.closeTo(0, 9)
    })
  })
})

describe('收益走势范围过滤（filterFundSeriesRange，边界手算）', () => {
  const point = (date: string): FundSeriesPoint => ({
    date,
    marketValue: 0,
    costBasis: 1,
    realizedIncome: 0,
    totalReturn: 0,
    totalReturnRate: 0
  })
  const series = [point('2025-12-30'), point('2025-12-31'), point('2026-01-30'), point('2026-01-31'), point('2026-02-28')]

  it('全部：不截取', () => {
    expect(filterFundSeriesRange(series, 'all', '2026-03-02')).toHaveLength(5)
  })

  it('近1月：今天往前 30 天（含边界日 01-31）', () => {
    const filtered = filterFundSeriesRange(series, '1m', '2026-03-02')
    expect(filtered.map((p) => p.date)).toEqual(['2026-01-31', '2026-02-28'])
  })

  it('近3月：今天往前 90 天（含边界日 12-31）', () => {
    const filtered = filterFundSeriesRange(series, '3m', '2026-03-31')
    expect(filtered.map((p) => p.date)).toEqual(['2025-12-31', '2026-01-30', '2026-01-31', '2026-02-28'])
  })

  it('近1年：今天往前 365 天（含边界日，一年前整日）', () => {
    const filtered = filterFundSeriesRange(series, '1y', '2027-01-01')
    expect(filtered.map((p) => p.date)).toEqual(['2026-01-30', '2026-01-31', '2026-02-28'])
  })
})

describe('严格成本法 — 移动加权平均', () => {
  const fund = (code: string, category = '权益'): Fund => ({
    code,
    name: `基金${code}`,
    category,
    fundType: null
  })

  it('多次买入均价 + 部分卖出获利', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 10, nav: 10, fee: 0, note: null },
      { date: '2026-02-01', type: '买入', fundCode: 'A', amount: 240, shares: 20, nav: 12, fee: 0, note: null },
      { date: '2026-03-01', type: '卖出', fundCode: 'A', amount: -195, shares: -15, nav: 13, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-03-01', nav: 13, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    // 均价 = 340/30；卖出消耗 340×15/30 = 170；已实现 = 195 − 170 = 25
    expect(p.costBasis).toBeCloseTo(170, 6)
    expect(p.shares).toBe(15)
    expect(p.pnl).toBeCloseTo(25, 6) // 195 − 170
    expect(p.pnlRatio).toBeCloseTo(25 / 170, 9)
    const totals = computeTotals([p], txs)
    expect(totals.realizedIncome).toBeCloseTo(25, 6)
    expect(totals.totalReturn).toBeCloseTo(50, 6) // 简单成本法口径：195 − 145 = 50
  })

  it('部分卖出亏损：已实现盈亏含负数', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-02-01', type: '卖出', fundCode: 'A', amount: -32, shares: -40, nav: 0.8, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-02-01', nav: 0.8, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    // 消耗成本 40，已实现 = 32 − 40 = −8
    expect(p.costBasis).toBeCloseTo(60, 6)
    expect(p.pnl).toBeCloseTo(-12, 6) // 48 − 60
    const totals = computeTotals([p], txs)
    expect(totals.realizedIncome).toBeCloseTo(-8, 6)
    expect(totals.totalReturn).toBeCloseTo(-20, 6) // 简单成本法口径：48 − 68 = −20
  })

  it('分红再投入 0 成本拉低均价：卖出时其市值成为已实现收益', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-02-01', type: '分红再投入', fundCode: 'A', amount: 0, shares: 20, nav: 1.1, fee: 0, note: null },
      { date: '2026-03-01', type: '卖出', fundCode: 'A', amount: -66, shares: -60, nav: 1.1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-03-01', nav: 1.1, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    // 均价 = 100/120；消耗成本 = 100×60/120 = 50；已实现 = 66 − 50 = 16
    expect(p.costBasis).toBeCloseTo(50, 6)
    expect(p.pnl).toBeCloseTo(16, 6) // 66 − 50
    const totals = computeTotals([p], txs)
    expect(totals.realizedIncome).toBeCloseTo(16, 6)
    expect(totals.totalReturn).toBeCloseTo(32, 6) // 简单成本法口径：66 − 34 = 32
  })

  it('清仓：份额与持仓成本归零，盈亏与盈亏比例为 0/null，已实现收益全额计入已实现盈亏', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-02-01', type: '卖出', fundCode: 'A', amount: -150, shares: -100, nav: 1.5, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-02-01', nav: 1.5, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    expect(p.shares).toBe(0)
    expect(p.costBasis).toBe(0)
    expect(p.marketValue).toBe(0)
    expect(p.pnl).toBe(0)
    expect(p.pnlRatio).toBeNull()
    const totals = computeTotals([p], txs)
    expect(totals.realizedIncome).toBeCloseTo(50, 6)
    expect(totals.totalPnl).toBe(0)
    expect(totals.totalReturn).toBeCloseTo(50, 6)
  })

  it('清仓后再买：成本基础重建，历史已实现收益不参与新仓位', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-02-01', type: '卖出', fundCode: 'A', amount: -150, shares: -100, nav: 1.5, fee: 0, note: null },
      { date: '2026-03-01', type: '买入', fundCode: 'A', amount: 100, shares: 50, nav: 2, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-03-01', nav: 2, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    expect(p.costBasis).toBe(100)
    expect(p.pnl).toBe(0) // 100 − 100
    const totals = computeTotals([p], txs)
    expect(totals.realizedIncome).toBeCloseTo(50, 6)
    expect(totals.totalReturn).toBeCloseTo(50, 6)
    expect(totals.totalReturnRate).toBeCloseTo(1, 9) // 总收益 50 / 净投入 50
  })

  it('超卖防护：sharesBefore ≤ 0 时消耗成本为 0；部分超卖钳制到持仓成本', () => {
    let st = applyCostBasis({ shares: 0, costBasis: 0, realizedGain: 0, cashDividends: 0 }, {
      date: '2026-01-01',
      type: '买入',
      fundCode: 'A',
      amount: 100,
      shares: 100,
      nav: 1,
      fee: 0,
      note: null
    })
    st = applyCostBasis(st, {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -150,
      shares: -150,
      nav: 1,
      fee: 0,
      note: null
    })
    // 部分超卖：消耗成本钳制为 100，已实现 = 150 − 100 = 50；份额 −50 → 持仓成本置 0
    expect(st.shares).toBe(-50)
    expect(st.costBasis).toBe(0)
    expect(st.realizedGain).toBe(50)
    st = applyCostBasis(st, {
      date: '2026-03-01',
      type: '卖出',
      fundCode: 'A',
      amount: -10,
      shares: -10,
      nav: 1,
      fee: 0,
      note: null
    })
    // sharesBefore ≤ 0：消耗成本 0，已实现 = 全额回款
    expect(st.costBasis).toBe(0)
    expect(st.realizedGain).toBe(60)
  })

  it('货基资金池全流程：已实现盈亏一次锁定，资金池中转不冲减，货基一视同仁', () => {
    const funds = [fund('A'), fund('007824', '流动性'), fund('B')]
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      // 再平衡：卖超配 40 份（回款 60，已实现 60 − 40 = 20）
      { date: '2026-02-01', type: '卖出', fundCode: 'A', amount: -60, shares: -40, nav: 1.5, fee: 0, note: null },
      // 回款买入资金池货基
      { date: '2026-02-01', type: '买入', fundCode: '007824', amount: 60, shares: 60, nav: 1, fee: 0, note: null },
      // 资金池赎出买 B（货基无盈亏，已实现 0）
      { date: '2026-03-01', type: '卖出', fundCode: '007824', amount: -60, shares: -60, nav: 1, fee: 0, note: null },
      { date: '2026-03-01', type: '买入', fundCode: 'B', amount: 60, shares: 60, nav: 1, fee: 0, note: null },
      // A 分红现金
      { date: '2026-04-01', type: '分红现金', fundCode: 'A', amount: 10, shares: null, nav: null, fee: null, note: null }
    ]
    const navs: NavPoint[] = [
      { fundCode: 'A', date: '2026-04-01', nav: 1.5, source: 'auto' },
      { fundCode: '007824', date: '2026-03-01', nav: 1, source: 'auto' },
      { fundCode: 'B', date: '2026-04-01', nav: 1, source: 'auto' }
    ]
    const positions = computePositions(funds, txs, navs)
    const byCode = new Map(positions.map((p) => [p.fundCode, p]))
    // A：剩余 60 份 ×1.5 = 90，持仓成本 60，浮动 30
    expect(byCode.get('A')!.pnl).toBeCloseTo(30, 6)
    // 货基已清仓：与其它基金同一路径，无特殊分支
    expect(byCode.get('007824')!.shares).toBe(0)
    expect(byCode.get('007824')!.costBasis).toBe(0)
    expect(byCode.get('007824')!.pnl).toBe(0)
    expect(byCode.get('B')!.pnl).toBe(0)
    const totals = computeTotals(positions, txs)
    // 已实现盈亏 = 卖出已实现 20 + 分红 10 = 30；浮动 = 30；总收益 = 60（与简单成本法恒等）
    expect(totals.realizedIncome).toBeCloseTo(30, 6)
    expect(totals.totalPnl).toBeCloseTo(30, 6)
    expect(totals.totalReturn).toBeCloseTo(60, 6)
  })

  it('净投入为负：总收益率返回 null，其余数字照常', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2026-07-01', type: '卖出', fundCode: 'A', amount: -1200, shares: -500, nav: 2.4, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-07-01', nav: 2.4, source: 'auto' }]
    const [p] = computePositions([fund('A')], txs, navs)
    const totals = computeTotals([p], txs)
    expect(totals.totalNetCost).toBe(-200)
    expect(totals.totalReturnRate).toBeNull()
    // 已实现 = 1200 − 500 = 700；浮动 = 1200 − 500 = 700；总收益 1400
    expect(totals.realizedIncome).toBeCloseTo(700, 6)
    expect(totals.totalReturn).toBeCloseTo(1400, 6)
  })

  it('同日多笔按输入顺序推进成本基础', () => {
    const buy: Transaction = { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null }
    const sell: Transaction = { date: '2026-01-01', type: '卖出', fundCode: 'A', amount: -50, shares: -50, nav: 1, fee: 0, note: null }
    // 先买后卖：消耗成本 50，已实现 0
    const buyFirst = costBasisStates([buy, sell]).get('A')!
    expect(buyFirst.costBasis).toBe(50)
    expect(buyFirst.realizedGain).toBe(0)
    // 先卖后买（数据异常序）：sharesBefore ≤ 0，已实现按全额回款计
    const sellFirst = costBasisStates([sell, buy]).get('A')!
    expect(sellFirst.realizedGain).toBe(50)
  })
})

describe('年化收益率（XIRR 核心求根，手算黄金值）', () => {
  it('单笔买入 365 天：r = 期末估值/买入金额 − 1', () => {
    expect(xirr([{ date: '2026-01-01', amount: -100 }], 110, '2027-01-01')).toBeCloseTo(0.1, 9)
  })

  it('多笔定投（第二笔与期末同日）：r = 10%', () => {
    const flows = [
      { date: '2026-01-01', amount: -100 },
      { date: '2027-01-01', amount: -100 }
    ]
    expect(xirr(flows, 210, '2027-01-01')).toBeCloseTo(0.1, 9)
  })

  it('含卖出回款与分红现金（流入）：r = 15%', () => {
    const flows = [
      { date: '2026-01-01', amount: -1000 },
      { date: '2027-01-01', amount: 600 }
    ]
    expect(xirr(flows, 550, '2027-01-01')).toBeCloseTo(0.15, 9)
  })

  it('已清仓现金流 + 零期末估值：r = 20%', () => {
    const flows = [
      { date: '2026-01-01', amount: -1000 },
      { date: '2027-01-01', amount: 1200 }
    ]
    expect(xirr(flows, 0, '2027-01-01')).toBeCloseTo(0.2, 9)
  })

  it('不收敛（只有流出、零终值）返回 null', () => {
    const flows = [
      { date: '2026-01-01', amount: -100 },
      { date: '2026-02-01', amount: -100 }
    ]
    expect(xirr(flows, 0, '2027-01-01')).toBeNull()
  })

  it('不收敛（只有流入）返回 null', () => {
    expect(xirr([{ date: '2026-01-01', amount: 100 }], 100, '2027-01-01')).toBeNull()
  })

  it('空现金流返回 null', () => {
    expect(xirr([], 100, '2027-01-01')).toBeNull()
  })

  it('期末估值日早于首笔现金流返回 null', () => {
    expect(xirr([{ date: '2027-01-01', amount: -100 }], 110, '2026-01-01')).toBeNull()
  })
})

describe('单基金年化映射（XIRR，手算黄金值）', () => {
  it('golden fixtures：5 只基金年化与手算黄金值一致（today = 净值日 2026-08-11）', () => {
    const map = computeAnnualizedReturns(goldenTransactions, goldenNavPoints, '2026-08-11')
    expect(map.size).toBe(5)
    expect(map.get('110017')).toBeCloseTo(0.0193714569, 8)
    expect(map.get('002009')).toBeCloseTo(-0.0317483574, 8)
    expect(map.get('512890')).toBeCloseTo(-0.0261994222, 8)
    expect(map.get('000217')).toBeCloseTo(-0.2104439255, 8)
    expect(map.get('007824')).toBeCloseTo(0.0110100987, 8)
  })

  it('首笔现金流距今天 29 天 → null；恰好 30 天 → 0%（期末估值 = 买入额）', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-01-30', nav: 1, source: 'import' }]
    expect(computeAnnualizedReturns(txs, navs, '2026-01-30').get('A')).toBeNull()
    expect(computeAnnualizedReturns(txs, navs, '2026-01-31').get('A')).toBeCloseTo(0, 9)
  })

  it('分红再投入只加份额、不产生现金流（期末估值按再投入后的份额）', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-04-01', type: '分红再投入', fundCode: 'A', amount: 0, shares: 20, nav: 1.1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2027-01-01', nav: 1.1, source: 'import' }]
    expect(computeAnnualizedReturns(txs, navs, '2027-01-01').get('A')).toBeCloseTo(0.32, 9)
  })

  it('含卖出与分红现金：r = 15%', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2027-01-01', type: '卖出', fundCode: 'A', amount: -550, shares: -500, nav: 1.1, fee: 0, note: null },
      { date: '2027-01-01', type: '分红现金', fundCode: 'A', amount: 50, shares: null, nav: null, fee: null, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2027-01-01', nav: 1.1, source: 'import' }]
    expect(computeAnnualizedReturns(txs, navs, '2027-01-01').get('A')).toBeCloseTo(0.15, 9)
  })

  it('无净值记录 → null（市值不计入期末估值）', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null }
    ]
    expect(computeAnnualizedReturns(txs, [], '2027-01-01').get('A')).toBeNull()
  })

  it('净成本为负 → null（异常返回空）', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2026-07-01', type: '卖出', fundCode: 'A', amount: -1200, shares: -500, nav: 2.4, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2027-01-01', nav: 1, source: 'import' }]
    expect(computeAnnualizedReturns(txs, navs, '2027-01-01').get('A')).toBeNull()
  })

  it('已清仓、净成本为正：全部现金流 + 零期末估值 → r = −50%', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2027-01-01', type: '卖出', fundCode: 'A', amount: -50, shares: -100, nav: 0.5, fee: 0, note: null }
    ]
    expect(computeAnnualizedReturns(txs, [], '2027-01-01').get('A')).toBeCloseTo(-0.5, 9)
  })
})

describe('整体年化（XIRR，手算黄金值）', () => {
  it('golden fixtures 整体：全部买入现金流 + 期末总市值（today = 2026-08-11）', () => {
    expect(computeTotalAnnualizedReturn(goldenTransactions, goldenNavPoints, '2026-08-11')).toBeCloseTo(
      -0.0625911619,
      8
    )
  })

  it('已清仓基金的卖出回款计入整体：r = 0%；单基金 A 净成本为负 → 空，B → −10%', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2027-01-01', type: '卖出', fundCode: 'A', amount: -1200, shares: -1000, nav: 1.2, fee: 0, note: null },
      { date: '2026-01-01', type: '买入', fundCode: 'B', amount: 2000, shares: 2000, nav: 1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'B', date: '2027-01-01', nav: 0.9, source: 'import' }]
    expect(computeTotalAnnualizedReturn(txs, navs, '2027-01-01')).toBeCloseTo(0, 9)
    const map = computeAnnualizedReturns(txs, navs, '2027-01-01')
    expect(map.get('A')).toBeNull()
    expect(map.get('B')).toBeCloseTo(-0.1, 9)
  })

  it('无净值记录的持仓市值不计入期末估值：r = −45%', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
      { date: '2026-01-01', type: '买入', fundCode: 'B', amount: 100, shares: 100, nav: 1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2027-01-01', nav: 1.1, source: 'import' }]
    expect(computeTotalAnnualizedReturn(txs, navs, '2027-01-01')).toBeCloseTo(-0.45, 9)
  })

  it('首笔流水（任意类型）距今天 29 天 → null；恰好 30 天 → 计算；单基金按首笔现金流日仍为空', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '分红再投入', fundCode: 'A', amount: 0, shares: 20, nav: 1, fee: 0, note: null },
      { date: '2026-01-05', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2026-01-30', nav: 1, source: 'import' }]
    expect(computeTotalAnnualizedReturn(txs, navs, '2026-01-30')).toBeNull() // 首笔流水 01-01 → 29 天
    expect(computeTotalAnnualizedReturn(txs, navs, '2026-01-31')).toBeCloseTo(11.9295341392, 6) // 恰好 30 天
    expect(computeAnnualizedReturns(txs, navs, '2026-01-31').get('A')).toBeNull() // 首笔现金流 01-05 → 26 天
  })

  it('整体净成本为负 → null', () => {
    const txs: Transaction[] = [
      { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 1000, shares: 1000, nav: 1, fee: 0, note: null },
      { date: '2026-07-01', type: '卖出', fundCode: 'A', amount: -1200, shares: -500, nav: 2.4, fee: 0, note: null }
    ]
    const navs: NavPoint[] = [{ fundCode: 'A', date: '2027-01-01', nav: 1, source: 'import' }]
    expect(computeTotalAnnualizedReturn(txs, navs, '2027-01-01')).toBeNull()
  })

  it('无流水 → null', () => {
    expect(computeTotalAnnualizedReturn([], [], '2027-01-01')).toBeNull()
  })
})

describe('按笔已实现收益（realizedPerSale / realizedForSale，手算黄金值）', () => {
  /** 流水行：id 显式给出（同日的先后由 id 决定，与库内 order by date, id 同规则） */
  const mk = (
    id: number,
    date: string,
    type: Transaction['type'],
    amount: number,
    shares: number | null,
    fundCode = 'A'
  ): TransactionRow => ({ id, date, type, fundCode, amount, shares, nav: null, fee: 0, note: null })

  it('单笔全清：000217 止损 −10358.20（卖出回款 − 持仓成本）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-02-26', '买入', 59050, 16032.86, '000217'),
      mk(2, '2026-10-09', '卖出', -48691.8, -16032.86, '000217')
    ]
    expect(realizedPerSale(rows).get(2)).toBeCloseTo(-10358.2, 6)
  })

  it('多次买入 + 部分卖出：按移动加权均价消耗成本', () => {
    // 均价 340/30；卖出 15 份消耗 170；已实现 = 195 − 170 = 25
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 10),
      mk(2, '2026-02-01', '买入', 240, 20),
      mk(3, '2026-03-01', '卖出', -195, -15)
    ]
    const map = realizedPerSale(rows)
    expect(map.get(3)).toBeCloseTo(25, 6)
    expect(map.size).toBe(1)
  })

  it('清仓后再买再卖：两笔各自独立，历史已实现不参与新仓位', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100),
      mk(2, '2026-02-01', '卖出', -150, -100), // 全清：150 − 100 = 50
      mk(3, '2026-03-01', '买入', 100, 50),
      mk(4, '2026-04-01', '卖出', -70, -25) // 均价 100/50；消耗 50；70 − 50 = 20
    ]
    const map = realizedPerSale(rows)
    expect(map.get(2)).toBeCloseTo(50, 6)
    expect(map.get(4)).toBeCloseTo(20, 6)
  })

  it('同基金多笔卖出 + 多基金交错：归属到各自 id（盈利与亏损都在）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100, 'A'),
      mk(2, '2026-01-02', '买入', 200, 100, 'B'),
      mk(3, '2026-02-01', '卖出', -150, -100, 'A'), // 150 − 100 = 50
      mk(4, '2026-02-01', '卖出', -160, -100, 'B') // 160 − 200 = −40
    ]
    const map = realizedPerSale(rows)
    expect(map.get(3)).toBeCloseTo(50, 6)
    expect(map.get(4)).toBeCloseTo(-40, 6)
    expect(map.size).toBe(2)
  })

  it('同一基金多笔卖出：各归各的 id（两笔值不同，对调即红）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100),
      mk(2, '2026-02-01', '卖出', -70, -50), // 消耗 50 → 20
      mk(3, '2026-03-01', '买入', 200, 100), // 均价 250/150
      mk(4, '2026-04-01', '卖出', -210, -105) // 消耗 175 → 35
    ]
    const map = realizedPerSale(rows)
    expect(map.get(2)).toBeCloseTo(20, 6)
    expect(map.get(4)).toBeCloseTo(35, 6)
  })

  it('非卖出行不入表（买入 / 分红现金 / 分红再投入）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100),
      mk(2, '2026-02-01', '分红再投入', 0, 20),
      mk(3, '2026-03-01', '分红现金', 10, null),
      mk(4, '2026-04-01', '卖出', -66, -60) // 均价 100/120；消耗 50；66 − 50 = 16
    ]
    const map = realizedPerSale(rows)
    expect([...map.keys()]).toEqual([4])
    expect(map.get(4)).toBeCloseTo(16, 6)
  })

  it('已实现收益为 0 的卖出仍在表内（列显示 0.00 而非留空）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100),
      mk(2, '2026-02-01', '卖出', -50, -50) // 消耗 50 → 已实现 0
    ]
    expect(realizedPerSale(rows).get(2)).toBe(0)
  })

  it('恒等回归：逐笔之和 = costBasisStates 的累计已实现收益（各基金分别成立）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100, 'A'),
      mk(2, '2026-01-01', '买入', 200, 100, 'B'),
      mk(3, '2026-02-01', '卖出', -150, -100, 'A'),
      mk(4, '2026-03-01', '买入', 120, 60, 'A'),
      mk(5, '2026-04-01', '卖出', -80, -30, 'A'),
      mk(6, '2026-05-01', '分红现金', 10, null, 'B'),
      mk(7, '2026-06-01', '卖出', -160, -100, 'B'),
      mk(8, '2026-07-01', '买入', 50, 25, 'B'),
      mk(9, '2026-08-01', '卖出', -40, -25, 'B')
    ]
    const map = realizedPerSale(rows)
    const states = costBasisStates(rows)
    for (const [fundCode, state] of states) {
      const sum = rows
        .filter((t) => t.fundCode === fundCode)
        .reduce((s, t) => s + (map.get(t.id) ?? 0), 0)
      expect(sum).toBeCloseTo(state.realizedGain, 6)
      expect(state.realizedGain).not.toBe(0) // 样本本身有非零已实现，恒等式非空转
    }
    // 全局合计同样成立
    const all = [...map.values()].reduce((s, v) => s + v, 0)
    const total = [...states.values()].reduce((s, st) => s + st.realizedGain, 0)
    expect(all).toBeCloseTo(total, 6)
  })

  it('realizedForSale：候选卖出与入库后逐笔计算同源', () => {
    const rows: TransactionRow[] = [mk(1, '2026-01-01', '买入', 100, 100)]
    const sale: Transaction = {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -150,
      shares: -100,
      nav: 1.5,
      fee: 0,
      note: null
    }
    expect(realizedForSale(rows, sale)).toBeCloseTo(50, 6)
    expect(realizedForSale(rows, sale)).toBeCloseTo(
      realizedPerSale([...rows, { ...sale, id: 99 }]).get(99)!,
      6
    )
  })

  it('realizedForSale：编辑已有卖出沿用原主键位次（同日更大 id 的流水仍在它之后）', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100),
      mk(2, '2026-02-01', '卖出', -70, -50), // 被编辑的旧行
      mk(3, '2026-02-01', '买入', 200, 100) // 同日、id 更大：编辑后仍排在它之后
    ]
    const edited: Transaction = {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -180,
      shares: -100,
      nav: 1.8,
      fee: 0,
      note: null
    }
    // 原 id 位次：本笔先入账（消耗 100 → 80），同日买入在其后；按占位主键排最后则先入账两笔买入
    //（均价 300/200、消耗 150 → 30），故位次错则值错
    expect(realizedForSale(rows, edited, 2)).toBeCloseTo(80, 6)
    // 与「把新值写回原 id 后逐笔计算」同源（= 保存后流水表列上的值）
    expect(realizedForSale(rows, edited, 2)).toBeCloseTo(
      realizedPerSale([rows[0], { ...edited, id: 2 }, rows[2]]).get(2)!,
      6
    )
  })

  it('realizedForSale：候选日当日的既有流水先入账（候选视为当日最后一笔）', () => {
    const rows: TransactionRow[] = [mk(1, '2026-02-01', '买入', 100, 100)]
    const sale: Transaction = {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -150,
      shares: -100,
      nav: 2,
      fee: 0,
      note: null
    }
    // 同日买入先入账：消耗成本 100，已实现 50（若不先入账则是超卖，已实现 150）
    expect(realizedForSale(rows, sale)).toBeCloseTo(50, 6)
  })

  it('realizedForSale：其他基金的流水与候选日之后的流水都不参与', () => {
    const rows: TransactionRow[] = [
      mk(1, '2026-01-01', '买入', 100, 100, 'A'),
      mk(2, '2026-01-01', '买入', 900, 100, 'B'),
      mk(3, '2026-03-01', '买入', 500, 100, 'A') // 候选日之后，不计入成本
    ]
    const sale: Transaction = {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -150,
      shares: -100,
      nav: 1.5,
      fee: 0,
      note: null
    }
    expect(realizedForSale(rows, sale)).toBeCloseTo(50, 6)
  })

  it('realizedForSale：非卖出返回 null', () => {
    const buy: Transaction = {
      date: '2026-02-01',
      type: '买入',
      fundCode: 'A',
      amount: 100,
      shares: 100,
      nav: 1,
      fee: 0,
      note: null
    }
    expect(realizedForSale([], buy)).toBeNull()
  })

  it('realizedForSale：无任何历史流水时超卖（份额 ≤ 0）→ 消耗成本为 0，全额回款计入', () => {
    const sale: Transaction = {
      date: '2026-02-01',
      type: '卖出',
      fundCode: 'A',
      amount: -150,
      shares: -100,
      nav: 1.5,
      fee: 0,
      note: null
    }
    expect(realizedForSale([], sale)).toBeCloseTo(150, 6)
  })
})

describe('口径化汇总（computeScopedSummary）', () => {
  const fundOf = (code: string): Fund => ({ code, name: `基金${code}`, category: '权益', fundType: null })
  const tx = (
    date: string,
    type: Transaction['type'],
    fundCode: string,
    amount: number,
    shares: number | null
  ): Transaction => ({ date, type, fundCode, amount, shares, nav: null, fee: 0, note: null })
  const nav = (fundCode: string, date: string, value: number): NavPoint => ({
    fundCode,
    date,
    nav: value,
    source: 'import'
  })
  const positionsOf = (codes: string[], txs: Transaction[], navs: NavPoint[]): FundPosition[] =>
    computePositions(codes.map(fundOf), txs, navs)

  it('all 口径与 computeTotals + computeTotalAnnualizedReturn 逐值一致（golden fixtures）', () => {
    const positions = computePositions(goldenFunds, goldenTransactions, goldenNavPoints)
    const summary = computeScopedSummary('all', positions, goldenTransactions, goldenNavPoints, '2026-08-11')
    expect(summary.totals).toEqual(computeTotals(positions, goldenTransactions))
    expect(summary.totals.totalNetCost).toBeCloseTo(277394.2, 2)
    expect(summary.totals.totalReturn).toBeCloseTo(-6403.443442, 2)
    expect(summary.annualized).toBeCloseTo(-0.0625911619, 8)
  })

  it('held 排除已清仓基金：净投入、已实现盈亏、现金流与市值都不进任何在持指标', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 1000, 1000),
      tx('2025-01-01', '买入', 'B', 500, 500),
      tx('2025-06-01', '分红现金', 'B', 50, null),
      tx('2026-01-01', '卖出', 'B', -800, -500) // 清仓：已实现 300，另有分红 50
    ]
    const navs = [nav('A', '2026-01-01', 1.2), nav('B', '2026-01-01', 1.6)]
    const positions = positionsOf(['A', 'B'], txs, navs)

    const held = computeScopedSummary('held', positions, txs, navs, '2026-01-01')
    expect(held.totals.totalNetCost).toBe(1000) // 仅 A 的买入，不含 B 的 500 − 800
    expect(held.totals.totalAssets).toBeCloseTo(1200, 6) // B 已清仓，市值为 0
    expect(held.totals.totalPnl).toBeCloseTo(200, 6)
    expect(held.totals.realizedIncome).toBe(0) // B 的 300 + 50 不进在持
    expect(held.totals.totalReturn).toBeCloseTo(200, 6)
    expect(held.totals.totalReturnRate).toBeCloseTo(0.2, 9)
    expect(held.annualized).toBeCloseTo(0.2, 9) // 仅 A：−1000 → 1200，恰好一年

    const all = computeScopedSummary('all', positions, txs, navs, '2026-01-01')
    expect(all.totals.totalNetCost).toBe(700)
    expect(all.totals.realizedIncome).toBeCloseTo(350, 6)
    expect(all.annualized).not.toBeCloseTo(0.2, 6)
  })

  it('held 保留在持基金的部分卖出已实现收益与分红现金', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 1000, 1000),
      tx('2025-07-01', '卖出', 'A', -300, -200), // 消耗成本 200，已实现 100
      tx('2025-09-01', '分红现金', 'A', 50, null)
    ]
    const navs = [nav('A', '2026-01-01', 1.2)]
    const positions = positionsOf(['A'], txs, navs)
    const held = computeScopedSummary('held', positions, txs, navs, '2026-01-01')
    expect(held.totals.realizedIncome).toBeCloseTo(150, 6) // 100 + 50
    // 市值 800 × 1.2 = 960；持仓成本 800；浮动 160；总收益 310
    expect(held.totals.totalAssets).toBeCloseTo(960, 6)
    expect(held.totals.totalPnl).toBeCloseTo(160, 6)
    expect(held.totals.totalReturn).toBeCloseTo(310, 6)
    expect(held.totals.totalNetCost).toBe(700)
    expect(held.totals.totalReturnRate).toBeCloseTo(310 / 700, 9)
  })

  it('held 年化只用非清仓基金的现金流，期末估值为在持市值（手算 XIRR）', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 1000, 1000),
      tx('2025-01-01', '买入', 'B', 1000, 1000),
      tx('2026-01-01', '卖出', 'B', -2000, -1000) // 已清仓的高收益基金
    ]
    const navs = [nav('A', '2026-01-01', 1.1)]
    const positions = positionsOf(['A', 'B'], txs, navs)
    const held = computeScopedSummary('held', positions, txs, navs, '2026-01-01')
    // 仅 A：−1000 → 期末 1100（恰好一年）→ 10%
    expect(held.annualized).toBeCloseTo(0.1, 9)
    const all = computeScopedSummary('all', positions, txs, navs, '2026-01-01')
    expect(all.annualized).not.toBeCloseTo(0.1, 6) // B 的大量回款不进在持
  })

  it('份额 = 0 与超卖负份额都排除', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 1000, 1000),
      tx('2025-01-01', '买入', 'Z', 100, 100),
      tx('2025-06-01', '卖出', 'Z', -150, -100), // 份额归零：已实现 50
      tx('2025-01-01', '买入', 'N', 100, 100),
      tx('2025-06-01', '卖出', 'N', -180, -150) // 超卖：份额 −50，已实现 80
    ]
    const navs = [nav('A', '2026-01-01', 1.1), nav('Z', '2026-01-01', 1.5), nav('N', '2026-01-01', 1)]
    const positions = positionsOf(['A', 'Z', 'N'], txs, navs)
    const held = computeScopedSummary('held', positions, txs, navs, '2026-01-01')
    expect(held.totals.totalNetCost).toBe(1000)
    expect(held.totals.totalAssets).toBeCloseTo(1100, 6) // N 的负市值 −50 不进
    expect(held.totals.realizedIncome).toBe(0) // Z 的 50 与 N 的 80 都不进
    expect(held.totals.totalReturn).toBeCloseTo(100, 6)
    expect(held.annualized).toBeCloseTo(0.1, 9)
  })

  it('没有在持基金：Totals 全 0、比率为 null、年化为 null', () => {
    const txs = [
      tx('2025-01-01', '买入', 'B', 200, 100),
      tx('2025-06-01', '卖出', 'B', -150, -100) // 清仓，已实现 −50
    ]
    const navs = [nav('B', '2026-01-01', 1.5)]
    const positions = positionsOf(['B', 'C'], txs, navs) // C 从未建仓
    const held = computeScopedSummary('held', positions, txs, navs, '2026-01-01')
    expect(held.totals).toEqual({
      totalNetCost: 0,
      totalAssets: 0,
      totalPnl: 0,
      totalReturnRate: null,
      realizedIncome: 0,
      totalReturn: 0
    })
    expect(held.annualized).toBeNull()
    // 全部基金口径仍能算出已清仓基金的战绩（对照）
    expect(computeScopedSummary('all', positions, txs, navs, '2026-01-01').annualized).not.toBeNull()
  })

  it('无净值的在持基金：市值不进 totalAssets，也不进年化期末估值', () => {
    const txs = [tx('2025-01-01', '买入', 'A', 1000, 1000)]
    const positions = positionsOf(['A'], txs, [])
    const held = computeScopedSummary('held', positions, txs, [], '2026-01-01')
    expect(held.totals.totalAssets).toBe(0)
    expect(held.totals.totalPnl).toBe(-1000) // 市值按 0 计：浮动 = −持仓成本
    expect(held.totals.totalReturn).toBe(-1000)
    expect(held.totals.totalNetCost).toBe(1000)
    expect(held.annualized).toBeNull() // 期末估值缺失 → 无解
  })

  it('守卫：首笔现金流距今天不足 30 天 → 年化为 null', () => {
    const txs = [tx('2025-12-03', '买入', 'A', 100, 100)] // 距 2026-01-01 仅 29 天
    const navs = [nav('A', '2026-01-01', 1.1)]
    const held = computeScopedSummary('held', positionsOf(['A'], txs, navs), txs, navs, '2026-01-01')
    expect(held.annualized).toBeNull()
  })

  it('守卫：净成本 ≤ 0 → 年化为 null（累计收益率也为 null）', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 100, 100),
      tx('2025-06-01', '卖出', 'A', -200, -50) // 仍在持 50 份，净投入 −100
    ]
    const navs = [nav('A', '2026-01-01', 1)]
    const held = computeScopedSummary('held', positionsOf(['A'], txs, navs), txs, navs, '2026-01-01')
    expect(held.totals.totalNetCost).toBe(-100)
    expect(held.totals.totalReturnRate).toBeNull()
    expect(held.annualized).toBeNull()
  })

  it('守卫：求根失败（只有流出、期末估值为 0）→ 年化为 null', () => {
    const txs = [tx('2025-01-01', '买入', 'A', 1000, 1000)]
    const navs = [nav('A', '2026-01-01', 0)] // 期末估值 0：现金流全为负，无符号变化
    const held = computeScopedSummary('held', positionsOf(['A'], txs, navs), txs, navs, '2026-01-01')
    expect(held.annualized).toBeNull()
  })

  it('清仓后重建：held 含完整历史（上一轮已实现盈亏也计入），年化时钟不重置', () => {
    const txs = [
      tx('2025-01-01', '买入', 'A', 1000, 1000),
      tx('2026-01-01', '卖出', 'A', -1200, -1000), // 第一轮清仓：已实现 +200
      tx('2026-01-01', '买入', 'A', 500, 500) // 同日重建
    ]
    const navs = [nav('A', '2027-01-01', 0.88)]
    const positions = positionsOf(['A'], txs, navs)
    const held = computeScopedSummary('held', positions, txs, navs, '2027-01-01')
    expect(held.totals.totalNetCost).toBe(300) // 1000 − 1200 + 500
    expect(held.totals.realizedIncome).toBeCloseTo(200, 6) // 上一轮卖出已实现
    expect(held.totals.totalAssets).toBeCloseTo(440, 6) // 500 × 0.88
    expect(held.totals.totalReturn).toBeCloseTo(140, 6) // 浮动 −60 + 已实现 200
    expect(held.totals.totalReturnRate).toBeCloseTo(140 / 300, 9)
    // 完整现金流：−1000（2025-01-01）、+1200 与 −500（2026-01-01）、期末 440（2027-01-01），
    // 按整年折现手算 r = 10%；若年化时钟从重建日重置，则为 440/500 − 1 = −12%
    expect(held.annualized).toBeCloseTo(0.1, 9)
  })
})

describe('集中度指标（computeConcentrationMetrics，手算黄金值）', () => {
  /** 构造在持持仓：集中度只关心份额与市值，其余字段给中性值 */
  const pos = (fundCode: string, marketValue: number | null, shares = 100): FundPosition =>
    mkPosition(fundCode, '权益', marketValue, shares)

  it('空持仓：无可估值与缺净值，HHI 为 0，其余指标无定义', () => {
    const m = computeConcentrationMetrics([])
    expect(m.weights).toEqual([])
    expect(m.valuedCount).toBe(0)
    expect(m.missingNavCount).toBe(0)
    expect(m.maxWeight).toBeNull()
    expect(m.top3Weight).toBeNull()
    expect(m.hhi).toBe(0)
    expect(m.effectiveHoldings).toBeNull()
  })

  it('有可估值持仓但市值合计为 0（异常净值）：不产出权重，valuedCount 仍为可估值只数', () => {
    const m = computeConcentrationMetrics([pos('A', 0), pos('B', 0), pos('C', null)])
    expect(m.weights).toEqual([])
    expect(m.maxWeight).toBeNull()
    expect(m.top3Weight).toBeNull()
    expect(m.hhi).toBe(0)
    expect(m.effectiveHoldings).toBeNull()
    expect(m.valuedCount).toBe(2) // 可估值只数，不受市值合计异常影响
    expect(m.missingNavCount).toBe(1)
  })

  it('单只基金：权重 1、最大单只占比 1、前三大占比 1、HHI = 1、有效持仓数 = 1', () => {
    const m = computeConcentrationMetrics([pos('A', 10000)])
    expect(m.weights).toEqual([{ fundCode: 'A', weight: 1 }])
    expect(m.maxWeight).toBe(1)
    expect(m.top3Weight).toBe(1)
    expect(m.hhi).toBe(1)
    expect(m.effectiveHoldings).toBeCloseTo(1, 12)
    expect(m.valuedCount).toBe(1)
    expect(m.missingNavCount).toBe(0)
  })

  it('等权多只：每只 1/N、HHI = 1/N、有效持仓数 = N（权重和 = 1）', () => {
    const m = computeConcentrationMetrics([pos('A', 250), pos('B', 250), pos('C', 250), pos('D', 250)])
    expect(m.weights.map((w) => w.fundCode)).toEqual(['A', 'B', 'C', 'D'])
    for (const w of m.weights) expect(w.weight).toBeCloseTo(0.25, 12)
    expect(m.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12)
    expect(m.maxWeight).toBeCloseTo(0.25, 12)
    expect(m.top3Weight).toBeCloseTo(0.75, 12)
    expect(m.hhi).toBeCloseTo(0.25, 12)
    expect(m.effectiveHoldings).toBeCloseTo(4, 12)
    expect(m.valuedCount).toBe(4)
  })

  it('前三大占比：不足三只取全部；超过三只取权重降序前三之和', () => {
    const two = computeConcentrationMetrics([pos('A', 75), pos('B', 25)])
    expect(two.top3Weight).toBe(1) // 只有两只：前三大占比 = 全部市值
    expect(two.maxWeight).toBeCloseTo(0.75, 12)

    const five = computeConcentrationMetrics([
      pos('A', 40),
      pos('B', 30),
      pos('C', 20),
      pos('D', 6),
      pos('E', 4)
    ])
    expect(five.top3Weight).toBeCloseTo(0.9, 12) // 40% + 30% + 20%
    expect(five.maxWeight).toBeCloseTo(0.4, 12)
    // 40,30,20,6,4 → HHI = 0.16 + 0.09 + 0.04 + 0.0036 + 0.0016 = 0.2952
    expect(five.hhi).toBeCloseTo(0.2952, 12)
    expect(five.effectiveHoldings).toBeCloseTo(1 / 0.2952, 12)
    expect(five.weights.map((w) => w.fundCode)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('缺净值的在持基金排除并计数：不进入权重分母与 HHI', () => {
    const m = computeConcentrationMetrics([pos('A', 300), pos('B', null), pos('C', 100)])
    expect(m.valuedCount).toBe(2)
    expect(m.missingNavCount).toBe(1)
    expect(m.heldCount).toBe(3) // 可估值 + 缺净值
    expect(m.weights).toEqual([
      { fundCode: 'A', weight: 0.75 },
      { fundCode: 'C', weight: 0.25 }
    ])
    expect(m.maxWeight).toBeCloseTo(0.75, 12)
    expect(m.top3Weight).toBe(1) // 可估值只有两只：仍取全部
    expect(m.hhi).toBeCloseTo(0.625, 12)
    expect(m.effectiveHoldings).toBeCloseTo(1.6, 12)
  })

  it('已清仓（份额 ≤ 0）排除：即使带市值也不计权重，且不算缺净值', () => {
    const m = computeConcentrationMetrics([
      pos('A', 500),
      pos('B', 999, 0), // 份额归零
      pos('C', 999, -10) // 超卖负份额
    ])
    expect(m.valuedCount).toBe(1)
    expect(m.missingNavCount).toBe(0)
    expect(m.heldCount).toBe(1) // 已清仓不计入在持
    expect(m.weights).toEqual([{ fundCode: 'A', weight: 1 }])
    expect(m.hhi).toBe(1)
    expect(m.maxWeight).toBe(1)
    expect(m.top3Weight).toBe(1)
    expect(m.effectiveHoldings).toBeCloseTo(1, 12)
  })

  it('权重和恒为 1（含缺净值与已清仓混合）；权重降序、同权按基金代码升序', () => {
    const m = computeConcentrationMetrics([
      pos('300001', 100),
      pos('100001', 300),
      pos('200001', null),
      pos('400001', 600, 0)
    ])
    expect(m.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12)
    expect(m.weights.map((w) => w.fundCode)).toEqual(['100001', '300001'])
    expect(m.weights[0].weight).toBeCloseTo(0.75, 12)
    expect(m.valuedCount).toBe(2)
    expect(m.missingNavCount).toBe(1)
  })

  it('原始值不按界面精度舍入：A:B = 1:2 → 最大占比 2/3、HHI 5/9、有效持仓数 9/5', () => {
    const m = computeConcentrationMetrics([pos('A', 1), pos('B', 2)])
    expect(m.maxWeight).toBeCloseTo(2 / 3, 15)
    expect(m.hhi).toBeCloseTo(5 / 9, 15)
    expect(m.effectiveHoldings).toBeCloseTo(9 / 5, 15)
  })
})
