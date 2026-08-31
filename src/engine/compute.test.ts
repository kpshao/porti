import { describe, expect, it } from 'vitest'
import type { Fund, Transaction, NavPoint, CategoryTarget } from './types'
import {
  computePositions,
  computeTotals,
  computeCategoryComparison,
  computeTimeSeries,
  computeWeeklyReturn,
  computeStatsSeries
} from './compute'

// ---------- Golden fixtures：取自 投资跟踪.xlsx 持仓概览的真实数据 ----------

const goldenFunds: Fund[] = [
  { code: '110017', name: '易方达增强回报债券A', category: '固守+', fundType: '二级债基', targetAmount: 70000 },
  { code: '002009', name: '中欧瑾通A', category: '固守+', fundType: '偏债混合', targetAmount: 60000 },
  { code: '512890', name: '华泰柏瑞红利低波ETF', category: '权益', fundType: '红利ETF', targetAmount: 50000 },
  { code: '000217', name: '华安黄金ETF联接C', category: '黄金', fundType: '黄金', targetAmount: 40000 },
  { code: '007824', name: '天弘弘择短债债券C', category: '流动性', fundType: '短债', targetAmount: 40000 }
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
    expect(p.shares).toBeCloseTo(50067.32, 6)
    expect(p.marketValue).toBeCloseTo(70594.9212, 2)
    expect(p.pnl).toBeCloseTo(594.9212, 2)
    expect(p.pnlRatio).toBeCloseTo(594.9212 / 70000, 9)
  })

  it('002009 中欧瑾通A（含分红再投入：份额加、成本不变）', () => {
    const p = byCode.get('002009')!
    expect(p.invested).toBeCloseTo(60000, 2)
    expect(p.netCost).toBeCloseTo(60000, 2)
    expect(p.shares).toBeCloseTo(38750.05, 6)
    expect(p.marketValue).toBeCloseTo(59427.07668, 2)
    expect(p.pnl).toBeCloseTo(-572.92332, 2)
  })

  it('512890 华泰柏瑞红利低波ETF（14 笔买入）', () => {
    const p = byCode.get('512890')!
    expect(p.invested).toBeCloseTo(48344.2, 2)
    expect(p.shares).toBeCloseTo(40700, 6)
    expect(p.marketValue).toBeCloseTo(47863.2, 2)
    expect(p.pnl).toBeCloseTo(-481, 2)
  })

  it('000217 华安黄金ETF联接C', () => {
    const p = byCode.get('000217')!
    expect(p.netCost).toBeCloseTo(59050, 2)
    expect(p.shares).toBeCloseTo(16032.86, 6)
    expect(p.marketValue).toBeCloseTo(53033.494308, 2)
    expect(p.pnl).toBeCloseTo(-6016.505692, 2)
  })

  it('007824 天弘弘择短债债券C', () => {
    const p = byCode.get('007824')!
    expect(p.netCost).toBeCloseTo(40000, 2)
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
  const fund: Fund = { code: '999001', name: '测试基金', category: '权益', fundType: null, targetAmount: null }
  const transactions: Transaction[] = [
    { date: '2026-01-01', type: '买入', fundCode: '999001', amount: 2000, shares: 1000, nav: 2, fee: 0, note: null },
    { date: '2026-02-01', type: '卖出', fundCode: '999001', amount: -1100, shares: -500, nav: 2.2, fee: 0, note: null },
    { date: '2026-03-01', type: '分红现金', fundCode: '999001', amount: 100, shares: null, nav: null, fee: null, note: null }
  ]
  const navPoints: NavPoint[] = [{ fundCode: '999001', date: '2026-03-15', nav: 2.5, source: 'auto' }]

  it('卖出扣减份额与成本（简单成本法）', () => {
    const [p] = computePositions([fund], transactions, navPoints)
    expect(p.invested).toBe(2000)
    expect(p.redeemed).toBe(1100)
    expect(p.netCost).toBe(900)
    expect(p.shares).toBe(500)
    expect(p.marketValue).toBeCloseTo(1250, 6)
    expect(p.pnl).toBeCloseTo(350, 6)
    expect(p.pnlRatio).toBeCloseTo(350 / 900, 9)
  })

  it('分红现金计入落袋收益，不影响持仓盈亏', () => {
    const [p] = computePositions([fund], transactions, navPoints)
    const totals = computeTotals([p], transactions)
    expect(totals.realizedIncome).toBe(100)
    expect(totals.totalReturn).toBeCloseTo(350 + 100, 6)
    expect(p.pnl).toBeCloseTo(350, 6)
  })
})

describe('边界情况', () => {
  const fund: Fund = { code: '999002', name: '空基金', category: '纯债', fundType: null, targetAmount: null }

  it('无任何流水：零持仓，收益率保护为 null', () => {
    const [p] = computePositions([fund], [], [])
    expect(p.netCost).toBe(0)
    expect(p.shares).toBe(0)
    expect(p.marketValue).toBeNull()
    expect(p.pnl).toBeNull()
    const totals = computeTotals([p], [])
    expect(totals.totalReturnRate).toBeNull()
  })

  it('有成本但无净值：市值与盈亏为 null，总盈亏 = −总成本（简单成本法）', () => {
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
    const positions = [
      { fundCode: 'A', name: 'A', category: '固守+', fundType: null, targetAmount: null, invested: 300, redeemed: 0, netCost: 300, shares: 0, latestNav: null, latestNavDate: null, marketValue: 330, pnl: 30, pnlRatio: 0.1 },
      { fundCode: 'B', name: 'B', category: '权益', fundType: null, targetAmount: null, invested: 100, redeemed: 0, netCost: 100, shares: 0, latestNav: null, latestNavDate: null, marketValue: 110, pnl: 10, pnlRatio: 0.1 },
      { fundCode: 'C', name: 'C', category: '黄金', fundType: null, targetAmount: null, invested: 100, redeemed: 0, netCost: 100, shares: 0, latestNav: null, latestNavDate: null, marketValue: 100, pnl: 0, pnlRatio: 0 }
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
})

describe('总市值时间序列与周收益', () => {
  const funds: Fund[] = [
    { code: 'A', name: '基金A', category: '权益', fundType: null, targetAmount: null },
    { code: 'B', name: '基金B', category: '权益', fundType: null, targetAmount: null }
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
    { code: 'A', name: '基金A', category: '权益', fundType: null, targetAmount: null },
    { code: 'B', name: '基金B', category: '权益', fundType: null, targetAmount: null }
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

  it('逐日累计：净投入/落袋收益按日期截断，累计收益 = 市值 − 净投入 + 落袋', () => {
    const series = computeStatsSeries(funds, transactions, navPoints)
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-05',
      '2026-01-10',
      '2026-01-15',
      '2026-01-20'
    ])
    // 01-01：仅 A 建仓 100；净投入 100；累计收益 0
    expect(series[0]).toMatchObject({
      totalMarketValue: expect.closeTo(100, 6),
      netCost: expect.closeTo(100, 6),
      realizedIncome: 0,
      totalReturn: expect.closeTo(0, 6),
      weeklyReturn: null
    })
    // 01-05：A 100 + B 100；净投入 200；无 ≥7 天前基准
    expect(series[1]).toMatchObject({
      totalMarketValue: expect.closeTo(200, 6),
      netCost: expect.closeTo(200, 6),
      realizedIncome: 0,
      totalReturn: 0,
      weeklyReturn: null
    })
    // 01-10：市值 110+110；基准 01-01（差 9 天）：220 − 100 = 120
    expect(series[2]).toMatchObject({
      totalMarketValue: expect.closeTo(220, 6),
      netCost: 200,
      realizedIncome: 0,
      totalReturn: expect.closeTo(20, 6),
      weeklyReturn: { value: expect.closeTo(120, 6), baseDate: '2026-01-01' }
    })
    // 01-15：市值 120+105；分红现金 01-12 起计入落袋；基准 01-05（差 10 天）：225 − 200 = 25
    expect(series[3]).toMatchObject({
      totalMarketValue: expect.closeTo(225, 6),
      netCost: 200,
      realizedIncome: expect.closeTo(20, 6),
      totalReturn: expect.closeTo(45, 6),
      weeklyReturn: { value: expect.closeTo(25, 6), baseDate: '2026-01-05' }
    })
    // 01-20：卖出后 B 剩 25 份 ×2.4 = 60，市值 130+60；净投入 200−60=140；基准 01-10：190 − 220 = −30
    expect(series[4]).toMatchObject({
      totalMarketValue: expect.closeTo(190, 6),
      netCost: expect.closeTo(140, 6),
      realizedIncome: 20,
      totalReturn: expect.closeTo(70, 6),
      weeklyReturn: { value: expect.closeTo(-30, 6), baseDate: '2026-01-10' }
    })
  })

  it('最后一个点与引擎汇总口径一致（总收益 = 持仓盈亏 + 落袋收益）', () => {
    const series = computeStatsSeries(funds, transactions, navPoints)
    const positions = computePositions(funds, transactions, navPoints)
    const totals = computeTotals(positions, transactions)
    const last = series[series.length - 1]
    expect(last.totalMarketValue).toBeCloseTo(totals.totalAssets, 6)
    expect(last.totalReturn).toBeCloseTo(totals.totalReturn, 6)
  })
})
