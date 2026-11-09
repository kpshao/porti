import type {
  Fund,
  Transaction,
  TransactionRow,
  NavPoint,
  FundPosition,
  ConcentrationMetrics,
  PositionGroup,
  Totals,
  SummaryScope,
  ScopedSummary,
  CategoryComparisonRow,
  CategoryTarget,
  TimePoint,
  StatsPoint,
  FundSeriesPoint,
  FundSeriesRange,
  WeeklyReturn,
  XirrCashFlow
} from './types'
import { CATEGORIES } from './validation'

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

/** 流水时序：按 (date, id) 升序——库内查询 ORDER BY date, id 同规则，全代码库的时序约定
 *  只此一处定义。未入库的流水没有 id（调用方按库内次序传入），退化为按日期稳定排序。 */
function byDateThenId(a: Transaction & { id?: number }, b: Transaction & { id?: number }): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return (a.id ?? 0) - (b.id ?? 0)
}

/** 全时段成本基础映射：按 byDateThenId 推进；返回 Map<fundCode, CostBasisState>。 */
export function costBasisStates(transactions: Transaction[]): Map<string, CostBasisState> {
  const sorted = [...transactions].sort(byDateThenId)
  const states = new Map<string, CostBasisState>()
  for (const t of sorted) {
    states.set(t.fundCode, applyCostBasis(states.get(t.fundCode) ?? ZERO_BASIS, t))
  }
  return states
}

/** 候选流水（尚未入库）的占位主键：保证它在同日流水里排在最后，
 *  与库内查询 ORDER BY date, id 下新流水 id 最大的事实一致。 */
const CANDIDATE_ID = Number.MAX_SAFE_INTEGER

/** 每笔卖出的已实现收益：Map<流水主键, 金额>，非卖出行不入表（含 0 的卖出保留）。
 *  推进复用 applyCostBasis 的同一套移动加权平均，故各笔之和 = costBasisStates 的累计已实现收益。 */
export function realizedPerSale(rows: TransactionRow[]): Map<number, number> {
  const states = new Map<string, CostBasisState>()
  const result = new Map<number, number>()
  for (const t of [...rows].sort(byDateThenId)) {
    const before = states.get(t.fundCode) ?? ZERO_BASIS
    const after = applyCostBasis(before, t)
    states.set(t.fundCode, after)
    if (t.type === '卖出') result.set(t.id, after.realizedGain - before.realizedGain)
  }
  return result
}

/** 候选卖出的已实现收益（卖出表单保存前预览用）：同基金、候选日（含）之前的既有流水先按
 *  byDateThenId 推进成本基础（候选日之后的流水不参与），再把候选这一笔虚拟推进，返回其已实现收益。
 *  候选的排序位次与保存后一致，故预览值与流水表列上的值一致——
 *  新建用占位主键 CANDIDATE_ID（新流水 id 最大，排在当日最后）；
 *  编辑传 editingId 用原主键（旧行被同 id 的候选取代，位次不变）。
 *  与 realizedPerSale 同一套口径（同一 applyCostBasis）。非卖出返回 null。 */
export function realizedForSale(
  rows: TransactionRow[],
  sale: Transaction,
  editingId?: number
): number | null {
  if (sale.type !== '卖出') return null
  const id = editingId ?? CANDIDATE_ID
  const before = rows.filter((t) => t.fundCode === sale.fundCode && t.date <= sale.date && t.id !== id)
  return realizedPerSale([...before, { ...sale, id }]).get(id) ?? null
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

/** 集中度指标（分析页）：口径与公式见 CONTEXT.md「集中度指标」。
 *  missingNavCount 计入在持但 marketValue 为 null（缺最新净值）的基金；
 *  weights 的排序契约见 ConcentrationMetrics.weights。 */
export function computeConcentrationMetrics(positions: FundPosition[]): ConcentrationMetrics {
  const held = positions.filter(isHeld)
  const valued = held.filter((p) => p.marketValue !== null)
  const missingNavCount = held.length - valued.length
  const total = valued.reduce((sum, p) => sum + (p.marketValue ?? 0), 0)
  // 市值合计为 0（净值异常）时权重无定义：不产出权重
  if (valued.length === 0 || total <= 0) {
    return {
      weights: [],
      maxWeight: null,
      top3Weight: null,
      hhi: 0,
      effectiveHoldings: null,
      valuedCount: valued.length,
      missingNavCount
    }
  }
  const weights = valued
    .map((p) => ({ fundCode: p.fundCode, weight: (p.marketValue as number) / total }))
    .sort((a, b) => b.weight - a.weight || (a.fundCode < b.fundCode ? -1 : a.fundCode > b.fundCode ? 1 : 0))
  const hhi = weights.reduce((sum, w) => sum + w.weight * w.weight, 0)
  return {
    weights,
    maxWeight: weights[0].weight,
    top3Weight: weights.slice(0, 3).reduce((sum, w) => sum + w.weight, 0),
    hhi,
    effectiveHoldings: hhi > 0 ? 1 / hhi : null,
    valuedCount: weights.length,
    missingNavCount
  }
}

/** 汇总：总市值/持仓盈亏（浮动）/累计收益率/已实现盈亏/总收益。
 *  已实现盈亏按流水 fundCode 统计（含已删除基金的流水，与现状逐笔遍历一致）；
 *  总收益 = 持仓盈亏 + 已实现盈亏，数值与简单成本法（市值 − 净投入 + 分红）恒等。 */
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

/** 兜底组名：category 不在 CATEGORIES 内的持仓（脏值、空串）归入此组，恒定排在五类之后 */
export const OTHER_CATEGORY = '其他'

/** 是否为标准资产大类（CATEGORIES 闭集） */
function isCategory(value: string): boolean {
  return (CATEGORIES as readonly string[]).includes(value)
}

/** 组内排序：基金代码升序。代码是主键、不并列，故无需 tie-break；
 *  与导出「持仓明细」同向（那边也是代码升序），界面与导出在同一大类内部排序一致。 */
function byFundCode(a: FundPosition, b: FundPosition): number {
  return a.fundCode < b.fundCode ? -1 : a.fundCode > b.fundCode ? 1 : 0
}

/** 组头合计：Σ市值（缺失按 0 计入，与 computeTotals().totalAssets 同口径）；组内全无净值时为空 */
function groupMarketValue(rows: FundPosition[]): number | null {
  if (rows.every((p) => p.marketValue === null)) return null
  return rows.reduce((sum, p) => sum + (p.marketValue ?? 0), 0)
}

/** 组内所有在持持仓的市值都已知：大类指标的共享守卫——任一市值未知时两项皆空，
 *  不展示残缺汇总（与逐基金列「有成本、无净值 → —」一致）。 */
function allMarketValuesKnown(rows: FundPosition[]): boolean {
  return rows.every((p) => p.marketValue !== null)
}

/** 大类盈亏比例 = Σ持仓盈亏 ÷ Σ持仓成本（仅组内在持持仓，与逐基金「盈亏比例」同一公式）。
 *  组内任一持仓市值未知 → null（见 allMarketValuesKnown）；持仓成本合计 ≤ 0 → null（比例无定义）。 */
function groupPnlRatio(rows: FundPosition[]): number | null {
  if (!allMarketValuesKnown(rows)) return null
  let pnl = 0
  let costBasis = 0
  for (const p of rows) {
    pnl += p.pnl ?? 0
    costBasis += p.costBasis
  }
  return costBasis <= 0 ? null : pnl / costBasis
}

/** 大类年化收益率（XIRR）：现金流取组内基金代码集合的全部流水（含清仓重建前的历史），
 *  期末估值 = 组内当前市值之和；组内任一市值未知 → null（与大类盈亏比例同一守卫）。 */
function groupAnnualized(
  rows: FundPosition[],
  transactions: Transaction[],
  today: string
): number | null {
  if (!allMarketValuesKnown(rows)) return null
  const codes = new Set(rows.map((p) => p.fundCode))
  const scoped = transactions.filter((t) => codes.has(t.fundCode))
  const terminal = rows.reduce((sum, p) => sum + (p.marketValue ?? 0), 0)
  return annualizedReturn(scoped, terminal, today)
}

/** 是否在持：份额 > 0 才算是一个仓位。份额 ≤ 0 的是已清仓（归零）或超卖（负份额数据错误），
 *  两者都不该出现在按大类分的持仓里，也不该参与投入比例。 */
function isHeld(p: FundPosition): boolean {
  return p.shares > 0
}

/** 持仓明细的大类分组（概览页表格的组织方式）。规则：
 *  只纳入在持持仓（见 isHeld），过滤后为空的大类不产生组；
 *  已清仓持仓不在此，由 groupClosedPositions 收成表尾一组；
 *  组序按 CATEGORIES 声明顺序，兜底组「其他」恒定置底；组内按基金代码升序（见 byFundCode）。
 *  大类指标只统计组内在持持仓；组内任一市值未知时大类盈亏比例与大类年化收益率两项皆空。 */
export function groupPositionsByCategory(
  positions: FundPosition[],
  transactions: Transaction[],
  today: string
): PositionGroup[] {
  const buckets = new Map<string, FundPosition[]>()
  for (const p of positions) {
    if (!isHeld(p)) continue
    const key = isCategory(p.category) ? p.category : OTHER_CATEGORY
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [p])
    else bucket.push(p)
  }
  const groups: PositionGroup[] = []
  for (const category of [...CATEGORIES, OTHER_CATEGORY]) {
    const rows = buckets.get(category)
    if (rows === undefined) continue
    rows.sort(byFundCode)
    groups.push({
      category,
      marketValue: groupMarketValue(rows),
      pnlRatio: groupPnlRatio(rows),
      annualized: groupAnnualized(rows, transactions, today),
      positions: rows
    })
  }
  return groups
}

/** 已清仓组名：不是资产大类，只作持仓明细表尾分组的显示名（基金详情入口靠这些行保留） */
export const CLOSED_CATEGORY = '已清仓'

/** 是否交易过（买入或赎回过）：份额为 0 的两种情形靠它区分——
 *  交易过 = 已清仓（战绩与历史值得回顾）；从无流水 = 从未建仓（不冒充已清仓）。 */
function hasTraded(p: FundPosition): boolean {
  return p.invested !== 0 || p.redeemed !== 0
}

/** 已清仓持仓（交易过、现份额 ≤ 0）合成表尾单独一组；无此类持仓时为 null。
 *  组头市值恒为 null（份额 ≤ 0 时市值恒为 0 或未知，没有可合计的口径）；组内按基金代码升序。
 *  与 groupPositionsByCategory 互补：两者并集 = 有过流水的持仓、交集为空（从未建仓的两边都不在）。 */
export function groupClosedPositions(positions: FundPosition[]): PositionGroup | null {
  const rows = positions.filter((p) => !isHeld(p) && hasTraded(p)).sort(byFundCode)
  if (rows.length === 0) return null
  // 已清仓组不是资产大类，没有大类收益指标：两项恒为空
  return { category: CLOSED_CATEGORY, marketValue: null, pnlRatio: null, annualized: null, positions: rows }
}

/** 大类配置对比：目标比例 / 实际投入比例 / 实际市值占比 / 偏离。
 *  投入比例只统计仍**在持**的持仓（份额 > 0，判据是份额而非市值——持仓成本在、净值未录入时市值未知，
 *  但钱确实投在里面）：已清仓基金留下的净投入残留不进分子也不进分母，否则清空的大类会凭空占着比例
 *  （如止损清仓后净投入 = 亏损额，黄金 10358.20 / 总净投入 = 50.88%）。
 *  已清空的大类（曾有流水、现无在持份额）偏离为 null——不提示低配，也不假装配平；
 *  从未配置的大类偏离仍是 −目标比例（提示该仓位尚未建立）。
 *  行序按 CATEGORIES 声明顺序；闭集之外的类目排在其后（保留其在并集中的相对次序）。 */
export function computeCategoryComparison(
  positions: FundPosition[],
  targets: CategoryTarget[]
): CategoryComparisonRow[] {
  const targetMap = new Map(targets.map((t) => [t.category, t.targetRatio]))
  const categories = [...new Set([...targets.map((t) => t.category), ...positions.map((p) => p.category)])]
  const rank = new Map<string, number>(CATEGORIES.map((c, i): [string, number] => [c, i]))
  categories.sort(
    (a, b) => (rank.get(a) ?? CATEGORIES.length) - (rank.get(b) ?? CATEGORIES.length)
  )
  const totalNetCost = positions.reduce((s, p) => s + (isHeld(p) ? p.netCost : 0), 0)
  const totalAssets = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0)
  return categories.map((category) => {
    const rows = positions.filter((p) => p.category === category)
    const held = rows.filter(isHeld)
    const catNetCost = held.reduce((s, p) => s + p.netCost, 0)
    const catMarket = rows.reduce((s, p) => s + (p.marketValue ?? 0), 0)
    const investedRatio = totalNetCost === 0 ? null : catNetCost / totalNetCost
    const marketRatio = totalAssets === 0 ? null : catMarket / totalAssets
    const cleared = held.length === 0 && rows.some(hasTraded)
    const deviation =
      marketRatio === null || cleared ? null : marketRatio - (targetMap.get(category) ?? 0)
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

/** 收益统计时间序列：每个有净值记录的日期一个点；持仓成本/已实现盈亏按日期截断累计。 */
export function computeStatsSeries(
  funds: Fund[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): StatsPoint[] {
  const series = computeTimeSeries(funds, transactions, navPoints)
  const weekly = weeklyReturnRows(series)
  const sorted = [...transactions].sort(byDateThenId)
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

/** 单基金收益走势：该基金每个有净值记录的日期一个点；持仓成本/已实现盈亏按日期截断
 * 推进（applyCostBasis，同日按 date, id 顺序——库内查询 ORDER BY date, id 同规则）；
 * 累计盈亏 = 市值 − 持仓成本 + 已实现盈亏；累计收益率 = 累计盈亏 / 当日持仓成本
 * （持仓成本 ≤ 0 时为 null，曲线断开）。基金不存在或无净值记录返回空序列。 */
export function computeFundSeries(
  fundCode: string,
  funds: Fund[],
  transactions: TransactionRow[],
  navPoints: NavPoint[]
): FundSeriesPoint[] {
  if (!funds.some((f) => f.code === fundCode)) return []
  const dates = [...new Set(navPoints.filter((p) => p.fundCode === fundCode).map((p) => p.date))].sort()
  const sorted = transactions.filter((t) => t.fundCode === fundCode).sort(byDateThenId)
  let state = ZERO_BASIS
  let idx = 0
  const series: FundSeriesPoint[] = []
  for (const date of dates) {
    while (idx < sorted.length && sorted[idx].date <= date) {
      state = applyCostBasis(state, sorted[idx])
      idx++
    }
    const nav = latestNavAsOf(navPoints, fundCode, date)
    if (nav === null) continue // 防御：点日期即该基金自身净值日期，正常必存在
    const marketValue = state.shares * nav.nav
    const realizedIncome = state.realizedGain + state.cashDividends
    const totalReturn = marketValue - state.costBasis + realizedIncome
    series.push({
      date,
      marketValue,
      costBasis: state.costBasis,
      realizedIncome,
      totalReturn,
      totalReturnRate: state.costBasis > 0 ? totalReturn / state.costBasis : null
    })
  }
  return series
}

/** 收益走势范围过滤：近1月/近3月/近1年 = 今天往前 30/90/365 天截取点集（含边界日）；
 * 全部不截取。「今天」显式入参以保证可测。 */
export function filterFundSeriesRange(
  series: FundSeriesPoint[],
  range: FundSeriesRange,
  today: string
): FundSeriesPoint[] {
  if (range === 'all') return series
  const days = { '1m': 30, '3m': 90, '1y': 365 }[range]
  return series.filter((p) => daysBetween(p.date, today) <= days)
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

/** 共享年化求根入口（整体年化与大类年化收益率共用，现金流归一化与守卫公式只此一处）：
 *  流水 → 归一化现金流与净投入；无流水、首笔流水（任意类型）不足 30 天、净投入 ≤ 0 → null；
 *  否则以调用方给定的期末估值求 XIRR。期末估值按统计范围求和（整体 = 全部在持市值；大类 = 组内在持市值）。 */
function annualizedReturn(
  transactions: Transaction[],
  terminalValue: number,
  today: string
): number | null {
  if (transactions.length === 0) return null
  const firstTxDate = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date)
  if (daysBetween(firstTxDate, today) < 30) return null
  const flows: XirrCashFlow[] = []
  let netCost = 0
  for (const t of transactions) {
    const { flow, netCostDelta } = cashFlowOf(t)
    if (flow !== null) flows.push(flow)
    netCost += netCostDelta
  }
  if (netCost <= 0) return null
  return xirr(flows, terminalValue, today)
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
  const sharesByFund = new Map<string, number>()
  for (const t of transactions) {
    sharesByFund.set(t.fundCode, (sharesByFund.get(t.fundCode) ?? 0) + (t.shares ?? 0))
  }
  let terminal = 0
  for (const [fundCode, shares] of sharesByFund) {
    if (shares <= 0) continue
    const nav = latestNavAsOf(navPoints, fundCode, NEVER)
    if (nav === null) continue
    terminal += shares * nav.nav
  }
  return annualizedReturn(transactions, terminal, today)
}

/** 口径化汇总入口：按统计范围返回 Totals 与整体年化收益率。
 *  all = 全部基金：直接复用 computeTotals 与 computeTotalAnnualizedReturn，与改动前逐值一致。
 *  held = 在持基金：用 isHeld（份额 > 0）过滤出在持持仓与其基金代码集合，把这批持仓与
 *  这批基金的全部流水（含清仓重建前的历史）交给同一对纯函数——不复制收益/年化公式。 */
export function computeScopedSummary(
  scope: SummaryScope,
  positions: FundPosition[],
  transactions: Transaction[],
  navPoints: NavPoint[],
  today: string
): ScopedSummary {
  let scopedPositions = positions
  let scopedTransactions = transactions
  if (scope === 'held') {
    scopedPositions = positions.filter(isHeld)
    const heldCodes = new Set(scopedPositions.map((p) => p.fundCode))
    scopedTransactions = transactions.filter((t) => heldCodes.has(t.fundCode))
  }
  return {
    totals: computeTotals(scopedPositions, scopedTransactions),
    annualized: computeTotalAnnualizedReturn(scopedTransactions, navPoints, today)
  }
}
