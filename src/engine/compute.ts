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

/** 成本基础状态：移动加权平均成本法下某基金的份额/剩余持仓成本/已实现收益/分红现金累计。 */
export interface CostBasisState {
  shares: number // 当前份额（直接累加，卖出存负值——与 sharesAsOf 同规则）
  costBasis: number // 剩余持仓成本基础（移动加权平均，含手续费）
  realizedGain: number // Σ卖出已实现收益 = 卖出回款 − 消耗成本
  cashDividends: number // Σ分红现金
}

const ZERO_BASIS: CostBasisState = { shares: 0, costBasis: 0, realizedGain: 0, cashDividends: 0 }

/** 单笔流水推进成本基础（纯函数）。规则：
 *  买入：shares += s，costBasis += amount（amount 已含手续费）
 *  卖出：sold = −shares，proceeds = −amount；sharesBefore ≤ 0 时消耗成本为 0（超卖防护）；
 *        否则 costConsumed = min(costBasis × sold / sharesBefore, costBasis)（部分超卖钳制）；
 *        realizedGain += proceeds − costConsumed；costBasis −= costConsumed；
 *        shares 归零（含超卖为负）时 costBasis 置 0（清仓兜底，消除浮点残留）
 *  分红再投入：shares += s，costBasis 不变（0 成本份额拉低均价，其市值在后续卖出时成为已实现收益）
 *  分红现金：cashDividends += amount，不动 shares/costBasis */
export function applyCostBasis(state: CostBasisState, t: Transaction): CostBasisState {
  if (t.type === '买入') {
    return { ...state, shares: state.shares + (t.shares ?? 0), costBasis: state.costBasis + t.amount }
  }
  if (t.type === '卖出') {
    const sold = -(t.shares ?? 0)
    const proceeds = -t.amount
    let costConsumed = 0
    if (state.shares > 0) costConsumed = Math.min((state.costBasis * sold) / state.shares, state.costBasis)
    const shares = state.shares - sold
    return {
      shares,
      costBasis: shares <= 0 ? 0 : state.costBasis - costConsumed,
      realizedGain: state.realizedGain + proceeds - costConsumed,
      cashDividends: state.cashDividends
    }
  }
  if (t.type === '分红再投入') {
    return { ...state, shares: state.shares + (t.shares ?? 0) }
  }
  return { ...state, cashDividends: state.cashDividends + t.amount }
}

/** 全时段成本基础映射：按日期升序稳定排序（同日保持输入顺序——库内查询 ORDER BY date, id
 *  与流水分页返回顺序同规则）；返回 Map<fundCode, CostBasisState>。 */
export function costBasisStates(transactions: Transaction[]): Map<string, CostBasisState> {
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const states = new Map<string, CostBasisState>()
  for (const t of sorted) {
    states.set(t.fundCode, applyCostBasis(states.get(t.fundCode) ?? ZERO_BASIS, t))
  }
  return states
}

/** 每只基金的持仓明细。口径与 Excel 持仓概览逐项一致。 */
export function computePositions(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): FundPosition[] {
  const basis = costBasisStates(transactions)
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
    const costBasis = basis.get(fund.code)?.costBasis ?? 0
    const nav = latestNavAsOf(navPoints, fund.code, NEVER)
    const marketValue = nav === null ? null : shares * nav.nav
    const pnl = marketValue === null ? null : marketValue - costBasis
    const pnlRatio = pnl === null || costBasis <= 0 ? null : pnl / costBasis
    return {
      fundCode: fund.code,
      name: fund.name,
      category: fund.category,
      fundType: fund.fundType,
      targetAmount: fund.targetAmount,
      invested,
      redeemed,
      netCost,
      costBasis,
      shares,
      latestNav: nav === null ? null : nav.nav,
      latestNavDate: nav === null ? null : nav.date,
      marketValue,
      pnl,
      pnlRatio
    }
  })
}

/** 汇总：总市值/持仓盈亏（浮动）/累计收益率/落袋收益/总收益。
 *  落袋收益按流水 fundCode 统计（含已删除基金的流水，与现状逐笔遍历一致）；
 *  总收益 = 持仓盈亏 + 落袋收益，数值与简单成本法（市值 − 净投入 + 分红）恒等。 */
export function computeTotals(positions: FundPosition[], transactions: Transaction[]): Totals {
  let realizedIncome = 0
  for (const st of costBasisStates(transactions).values()) {
    realizedIncome += st.realizedGain + st.cashDividends
  }
  let totalNetCost = 0
  let totalAssets = 0
  let totalCostBasis = 0
  for (const p of positions) {
    totalNetCost += p.netCost
    totalCostBasis += p.costBasis
    if (p.marketValue !== null) totalAssets += p.marketValue
  }
  const totalPnl = totalAssets - totalCostBasis
  const totalReturn = totalPnl + realizedIncome
  return {
    totalNetCost,
    totalAssets,
    totalPnl,
    totalReturnRate: totalNetCost <= 0 ? null : totalReturn / totalNetCost,
    realizedIncome,
    totalReturn
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

/** 收益统计时间序列：每个有净值记录的日期一个点；持仓成本/落袋收益按日期截断累计。 */
export function computeStatsSeries(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): StatsPoint[] {
  const series = computeTimeSeries(funds, transactions, navPoints)
  const weekly = weeklyReturnRows(series)
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const states = new Map<string, CostBasisState>()
  let idx = 0
  return series.map((p, i) => {
    while (idx < sorted.length && sorted[idx].date <= p.date) {
      const t = sorted[idx]
      states.set(t.fundCode, applyCostBasis(states.get(t.fundCode) ?? ZERO_BASIS, t))
      idx++
    }
    let costBasis = 0
    let realized = 0
    for (const st of states.values()) {
      costBasis += st.costBasis
      realized += st.realizedGain + st.cashDividends
    }
    return {
      ...p,
      costBasis,
      realizedIncome: realized,
      totalReturn: p.totalMarketValue - costBasis + realized,
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
