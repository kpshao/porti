import type {
  Fund,
  Transaction,
  NavPoint,
  FundPosition,
  Totals,
  CategoryComparisonRow,
  CategoryTarget,
  TimePoint,
  StatsPoint,
  WeeklyReturn,
  XirrCashFlow
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
  return weeklyReturnRows(series).map((r) => (r === null ? null : r.value))
}

/** 周收益明细：数值 + 基准日期（≥7 天前最近的记录日；无基准时整体为 null）。 */
function weeklyReturnRows(series: TimePoint[]): (WeeklyReturn | null)[] {
  return series.map((point, i) => {
    let j = i - 1
    while (j >= 0 && daysBetween(series[j].date, point.date) < 7) j--
    return j >= 0
      ? { value: point.totalMarketValue - series[j].totalMarketValue, baseDate: series[j].date }
      : null
  })
}

/** 收益统计时间序列：每个有净值记录的日期一个点；净投入/落袋收益按日期截断累计。 */
export function computeStatsSeries(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): StatsPoint[] {
  const series = computeTimeSeries(funds, transactions, navPoints)
  const weekly = weeklyReturnRows(series)
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let idx = 0
  let netCost = 0
  let realized = 0
  return series.map((p, i) => {
    while (idx < sorted.length && sorted[idx].date <= p.date) {
      const t = sorted[idx]
      // 库内约定：卖出金额存负值，直接累加即 买入 − 赎回；分红再投入金额为 0，成本不变
      if (t.type === '买入' || t.type === '卖出') netCost += t.amount
      else if (t.type === '分红现金') realized += t.amount
      idx++
    }
    return {
      ...p,
      netCost,
      realizedIncome: realized,
      totalReturn: p.totalMarketValue - netCost + realized,
      weeklyReturn: weekly[i]
    }
  })
}

/** 资金加权年化收益率（XIRR）：求 r 使全部现金流与期末估值按 (1+r)^(−天数/365)
 * 折现后净现值为 0。cashFlows 金额为归一化符号（流出为负、流入为正）；
 * terminalValue 为「今天」的期末估值（流入）。不收敛/无解/退化返回 null。 */
export function xirr(cashFlows: XirrCashFlow[], terminalValue: number, today: string): number | null {
  if (cashFlows.length === 0) return null
  // 金额全为 0：任意 r 均满足，视为无解
  if (cashFlows.every((f) => f.amount === 0) && terminalValue === 0) return null
  let firstDate = cashFlows[0].date
  for (const f of cashFlows) if (f.date < firstDate) firstDate = f.date
  if (daysBetween(firstDate, today) < 0) return null

  const npv = (r: number): number => {
    let sum = 0
    for (const f of cashFlows) {
      sum += f.amount * Math.pow(1 + r, -daysBetween(firstDate, f.date) / 365)
    }
    return sum + terminalValue * Math.pow(1 + r, -daysBetween(firstDate, today) / 365)
  }

  // 符号变化扫描：起点取首个 NPV 有限的负利率（老数据在 r→−1 附近折现会溢出为无穷），
  // 上界翻倍扩展；全程同号说明无解
  const CANDIDATES = [-0.9999, -0.999, -0.99, -0.9, -0.5, -0.1]
  const startLo = CANDIDATES.find((r) => Number.isFinite(npv(r)))
  if (startLo === undefined) return null
  let lo = startLo
  let flo = npv(lo)
  if (flo === 0) return lo // 根恰落在扫描起点
  let hi = 1
  let fhi = npv(hi)
  while (fhi * flo > 0) {
    hi *= 2
    if (hi > 1e9) return null
    fhi = npv(hi)
  }
  // 二分求根
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fmid = npv(mid)
    if (fmid === 0 || hi - lo < 1e-9) return mid
    if (flo * fmid < 0) {
      hi = mid
      fhi = fmid
    } else {
      lo = mid
      flo = fmid
    }
  }
  return (lo + hi) / 2
}

/** 单基金年化收益率映射（XIRR）：键为基金代码，值为年化收益率；
 * 首笔现金流日距今天不足 30 天、无净值记录、净成本 ≤ 0 或求根失败均为 null。 */
export function computeAnnualizedReturns(
  transactions: Transaction[],
  navPoints: NavPoint[],
  today: string
): Map<string, number | null> {
  const byFund = new Map<string, Transaction[]>()
  for (const t of transactions) {
    const list = byFund.get(t.fundCode)
    if (list === undefined) byFund.set(t.fundCode, [t])
    else list.push(t)
  }
  const result = new Map<string, number | null>()
  for (const [fundCode, txs] of byFund) {
    result.set(fundCode, annualizedForFund(fundCode, txs, navPoints, today))
  }
  return result
}

/** 流水 → 现金流与净成本增量：买入/卖出为现金流（库内约定卖出存负值，取反后流出为负、
 * 流入为正；金额直接累加即 买入 − 赎回）；分红现金为流入；分红再投入无现金流。 */
function cashFlowOf(t: Transaction): { flow: XirrCashFlow | null; netCostDelta: number } {
  if (t.type === '买入' || t.type === '卖出') {
    return { flow: { date: t.date, amount: -t.amount }, netCostDelta: t.amount }
  }
  if (t.type === '分红现金') {
    return { flow: { date: t.date, amount: t.amount }, netCostDelta: 0 }
  }
  return { flow: null, netCostDelta: 0 }
}

/** 单基金年化：现金流（买入流出/卖出流入/分红现金流入）+ 期末估值 = 当前份额 × 最新净值 */
function annualizedForFund(
  fundCode: string,
  txs: Transaction[],
  navPoints: NavPoint[],
  today: string
): number | null {
  const flows: XirrCashFlow[] = []
  let netCost = 0
  let shares = 0
  for (const t of txs) {
    const { flow, netCostDelta } = cashFlowOf(t)
    if (flow !== null) flows.push(flow)
    netCost += netCostDelta
    shares += t.shares ?? 0
  }
  if (flows.length === 0 || netCost <= 0) return null
  const firstFlowDate = flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0].date)
  if (daysBetween(firstFlowDate, today) < 30) return null
  let terminal = 0
  if (shares > 0) {
    const nav = latestNavAsOf(navPoints, fundCode, NEVER)
    if (nav === null) return null
    terminal = shares * nav.nav
  }
  return xirr(flows, terminal, today)
}

/** 整体年化收益率（XIRR）：全部历史流水（含已清仓基金的卖出回款与分红现金）为现金流，
 * 期末估值 = 全部持仓市值之和（无净值记录的持仓不计入）；
 * 首笔流水日距今天不足 30 天、净成本 ≤ 0 或求根失败返回 null。 */
export function computeTotalAnnualizedReturn(
  transactions: Transaction[],
  navPoints: NavPoint[],
  today: string
): number | null {
  if (transactions.length === 0) return null
  const firstTxDate = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date)
  if (daysBetween(firstTxDate, today) < 30) return null
  const flows: XirrCashFlow[] = []
  let netCost = 0
  const sharesByFund = new Map<string, number>()
  for (const t of transactions) {
    const { flow, netCostDelta } = cashFlowOf(t)
    if (flow !== null) flows.push(flow)
    netCost += netCostDelta
    sharesByFund.set(t.fundCode, (sharesByFund.get(t.fundCode) ?? 0) + (t.shares ?? 0))
  }
  if (netCost <= 0) return null
  let terminal = 0
  for (const [fundCode, shares] of sharesByFund) {
    if (shares <= 0) continue
    const nav = latestNavAsOf(navPoints, fundCode, NEVER)
    if (nav === null) continue
    terminal += shares * nav.nav
  }
  return xirr(flows, terminal, today)
}
