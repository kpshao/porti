import type {
  Fund,
  Transaction,
  NavPoint,
  FundPosition,
  Totals,
  CategoryComparisonRow,
  CategoryTarget,
  TimePoint
} from './types'

const NEVER = '9999-12-31'

/** 截至某日（含当日）的累计份额。卖出份额按库内约定存负值，直接累加。 */
export function sharesAsOf(transactions: Transaction[], fundCode: string, date: string): number {
  let shares = 0
  for (const t of transactions) {
    if (t.fundCode !== fundCode || t.date > date) continue
    shares += t.shares ?? 0
  }
  return shares
}

/** 截至某日（含当日）的最新净值点。 */
export function latestNavAsOf(
  navPoints: NavPoint[],
  fundCode: string,
  date: string
): { nav: number; date: string } | null {
  let best: { nav: number; date: string } | null = null
  for (const p of navPoints) {
    if (p.fundCode !== fundCode || p.date > date) continue
    if (best === null || p.date > best.date) best = { nav: p.nav, date: p.date }
  }
  return best
}

/** 每只基金的持仓明细。口径与 Excel 持仓概览逐项一致。 */
export function computePositions(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): FundPosition[] {
  return funds.map((fund) => {
    let invested = 0
    let redeemed = 0
    let shares = 0
    for (const t of transactions) {
      if (t.fundCode !== fund.code) continue
      if (t.type === '买入') invested += t.amount
      else if (t.type === '卖出') redeemed += -t.amount
      shares += t.shares ?? 0
    }
    const netCost = invested - redeemed
    const nav = latestNavAsOf(navPoints, fund.code, NEVER)
    const marketValue = nav === null ? null : shares * nav.nav
    const pnl = marketValue === null ? null : marketValue - netCost
    const pnlRatio = pnl === null || netCost === 0 ? null : pnl / netCost
    return {
      fundCode: fund.code,
      name: fund.name,
      category: fund.category,
      fundType: fund.fundType,
      targetAmount: fund.targetAmount,
      invested,
      redeemed,
      netCost,
      shares,
      latestNav: nav === null ? null : nav.nav,
      latestNavDate: nav === null ? null : nav.date,
      marketValue,
      pnl,
      pnlRatio
    }
  })
}

/** 汇总：总市值/总盈亏/总收益率/落袋收益/总收益。 */
export function computeTotals(positions: FundPosition[], transactions: Transaction[]): Totals {
  let realizedIncome = 0
  for (const t of transactions) {
    if (t.type === '分红现金') realizedIncome += t.amount
  }
  let totalNetCost = 0
  let totalAssets = 0
  for (const p of positions) {
    totalNetCost += p.netCost
    if (p.marketValue !== null) totalAssets += p.marketValue
  }
  const totalPnl = totalAssets - totalNetCost
  return {
    totalNetCost,
    totalAssets,
    totalPnl,
    totalReturnRate: totalNetCost === 0 ? null : totalPnl / totalNetCost,
    realizedIncome,
    totalReturn: totalPnl + realizedIncome
  }
}

/** 大类配置对比：目标比例 / 实际投入比例 / 实际市值占比 / 偏离。 */
export function computeCategoryComparison(
  positions: FundPosition[],
  targets: CategoryTarget[]
): CategoryComparisonRow[] {
  const targetMap = new Map(targets.map((t) => [t.category, t.targetRatio]))
  const categories = [...new Set([...targets.map((t) => t.category), ...positions.map((p) => p.category)])]
  const totalNetCost = positions.reduce((s, p) => s + p.netCost, 0)
  const totalAssets = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0)
  return categories.map((category) => {
    const rows = positions.filter((p) => p.category === category)
    const catNetCost = rows.reduce((s, p) => s + p.netCost, 0)
    const catMarket = rows.reduce((s, p) => s + (p.marketValue ?? 0), 0)
    const investedRatio = totalNetCost === 0 ? null : catNetCost / totalNetCost
    const marketRatio = totalAssets === 0 ? null : catMarket / totalAssets
    const deviation = marketRatio === null ? null : marketRatio - (targetMap.get(category) ?? 0)
    return {
      category,
      targetRatio: targetMap.get(category) ?? 0,
      investedRatio,
      marketRatio,
      deviation
    }
  })
}

/** 总市值时间序列：每个有净值记录的日期一个点。 */
export function computeTimeSeries(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): TimePoint[] {
  const dates = [...new Set(navPoints.map((p) => p.date))].sort()
  return dates.map((date) => {
    let total = 0
    for (const fund of funds) {
      const shares = sharesAsOf(transactions, fund.code, date)
      if (shares <= 0) continue
      const nav = latestNavAsOf(navPoints, fund.code, date)
      if (nav === null) continue
      total += shares * nav.nav
    }
    return { date, totalMarketValue: total }
  })
}

/** 两个 YYYY-MM-DD 日期的天数差（b − a，正数表示 b 更晚）。 */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
  return (db - da) / 86400000
}

/** 周收益（与时间序列等长）：最新记录日 vs ≥7 天前最近记录日的市值差；找不到基准则为 null。 */
export function computeWeeklyReturn(series: TimePoint[]): (number | null)[] {
  const result: (number | null)[] = new Array(series.length).fill(null)
  for (let i = 0; i < series.length; i++) {
    let j = i - 1
    while (j >= 0 && daysBetween(series[j].date, series[i].date) < 7) j--
    if (j >= 0) result[i] = series[i].totalMarketValue - series[j].totalMarketValue
  }
  return result
}
