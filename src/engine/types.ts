// 计算引擎的领域类型——与 spec 数据模型保持一致

export type OperationType = '买入' | '卖出' | '分红现金' | '分红再投入'
export type NavSource = 'import' | 'auto' | 'manual'

/** 净值来源中文标签（净值管理页与导出共用） */
export const NAV_SOURCE_LABEL: Record<NavSource, string> = {
  import: '导入',
  auto: '自动',
  manual: '手动'
}

export interface Fund {
  code: string
  name: string
  category: string // 资产大类：固守+/纯债/权益/黄金/流动性
  fundType: string | null
}

/** 交易流水。库内约定：卖出金额与份额均存负值；分红现金份额为空。 */
export interface Transaction {
  date: string // YYYY-MM-DD
  type: OperationType
  fundCode: string
  amount: number // 买入/分红现金为正；卖出为负
  shares: number | null // 买入/分红再投入为正；卖出为负；分红现金为空
  nav: number | null
  fee: number | null
  note: string | null
}

/** 流水行：领域字段 + 数据库主键（编辑/删除定位用） */
export type TransactionRow = Transaction & { id: number }

export interface NavPoint {
  fundCode: string
  date: string // YYYY-MM-DD
  nav: number
  source: NavSource
}

/** 收益快照：某日某基金的市值（导入重建净值历史用） */
export interface Snapshot {
  date: string
  fundCode: string
  marketValue: number
}

export interface CategoryTarget {
  category: string
  targetRatio: number
}

export interface FundPosition {
  fundCode: string
  name: string
  category: string
  fundType: string | null
  invested: number // 累计买入金额
  redeemed: number // 累计赎回金额（非负）
  netCost: number // 累计净投入 = 累计买入 − 累计赎回（大类对比与总收益率分母用）
  costBasis: number // 持仓成本（移动加权平均成本基础，含手续费）
  shares: number // 当前份额
  latestNav: number | null
  latestNavDate: string | null
  marketValue: number | null // 当前市值 = 份额 × 最新净值
  pnl: number | null // 持仓盈亏（浮动盈亏）= 市值 − 持仓成本
  pnlRatio: number | null // 盈亏比例 = 持仓盈亏 / 持仓成本（成本 ≤ 0 或无净值时为 null）
}

/** 单只基金在组合中的集中度权重：w_i = 基金市值 ÷ Σ可估值在持基金市值 */
export interface FundWeight {
  fundCode: string
  weight: number
}

/** 集中度指标：只统计可估值的在持基金（份额 > 0 且有最新净值）。
 *  口径见 CONTEXT.md「集中度指标」；已清仓与缺净值基金不参与权重。 */
export interface ConcentrationMetrics {
  weights: FundWeight[] // 每只可估值在持基金的权重，按权重降序、同权按基金代码升序
  maxWeight: number | null // 最大单只占比 = max(w_i)；无可估值持仓时为 null
  top3Weight: number | null // 前三大占比 = 权重降序前三之和（不足三只取全部）；无可估值持仓时为 null
  hhi: number // HHI = Σw_i²；无可估值持仓时为 0
  effectiveHoldings: number | null // 有效持仓数 = 1 ÷ HHI；HHI 为 0 时为 null（界面显示「—」）
  valuedCount: number // 计入权重的可估值在持基金数（等权基准 1/N 的 N）
  missingNavCount: number // 缺最新净值的在持基金数（不计入权重，界面提示用）
}

/** 概览持仓明细的大类分组：组头 + 组内明细 */
export interface PositionGroup {
  category: string // 组名：CATEGORIES 之一、兜底组「其他」，或表尾组「已清仓」
  marketValue: number | null // 组头合计（口径见 groupPositionsByCategory）；组内全无净值时为 null
  pnlRatio: number | null // 大类盈亏比例 = Σ持仓盈亏 / Σ持仓成本（仅组内在持；任一市值未知或成本合计 ≤ 0 时为 null）
  annualized: number | null // 大类年化收益率（XIRR；口径见 groupPositionsByCategory，无定义时为 null）
  positions: FundPosition[] // 组内明细，按基金代码升序
}

export interface Totals {
  totalNetCost: number
  totalAssets: number // 总市值
  totalPnl: number // 持仓盈亏（浮动盈亏）= 总市值 − Σ持仓成本
  totalReturnRate: number | null // 累计收益率 = 总收益 / 净投入成本（净投入 ≤ 0 时为 null）
  realizedIncome: number // 已实现盈亏 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 总收益 = 持仓盈亏 + 已实现盈亏（数值与简单成本法恒等）
}

/** 汇总口径：全部基金 / 在持基金（份额 > 0） */
export type SummaryScope = 'all' | 'held'

/** 口径化汇总：该统计范围的 Totals 与整体年化收益率（无定义时为 null） */
export interface ScopedSummary {
  totals: Totals
  annualized: number | null
}

/** 汇总数据：两种口径的完整汇总 + 单基金年化映射（持仓明细年化列用）。
 *  整体年化只存在于 all/held 的 ScopedSummary 中，不另存第二份事实来源。 */
export interface SummaryData {
  all: ScopedSummary
  held: ScopedSummary
  perFundAnnualized: Record<string, number | null>
}

export interface CategoryComparisonRow {
  category: string
  targetRatio: number
  investedRatio: number | null // 实际投入比例 = 大类在持持仓（份额 > 0）净投入 / 全部在持持仓净投入
  marketRatio: number | null // 实际市值占比 = 大类市值 / 总市值
  deviation: number | null // 偏离 = 实际市值占比 − 目标比例；该大类已清空（曾有流水、现无份额）或市值占比无定义时为 null
}

export interface TimePoint {
  date: string
  totalMarketValue: number
}

/** 周收益：数值与基准日期成对出现（找不到基准时整体为 null）。 */
export interface WeeklyReturn {
  value: number // 周收益 = 本日市值 − ≥7 天前最近记录日市值
  baseDate: string // 基准日期（≥7 天前最近的记录日）
}

/** 收益统计页时间序列点：总资产/持仓成本/已实现盈亏/累计收益/周收益。 */
export interface StatsPoint extends TimePoint {
  costBasis: number // 截至当日持仓成本 = Σ各基金移动加权成本基础
  realizedIncome: number // 截至当日已实现盈亏 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 累计收益 = 总市值 − 持仓成本 + 已实现盈亏
  weeklyReturn: WeeklyReturn | null // 无 ≥7 天前基准则为 null
}

/** 单基金收益走势点：该基金某有净值记录日期的累计收益快照。 */
export interface FundSeriesPoint {
  date: string
  marketValue: number // 当日市值 = 截至当日份额 × 截至当日最新净值
  costBasis: number // 截至当日持仓成本（移动加权平均）
  realizedIncome: number // 截至当日已实现盈亏 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 累计盈亏 = 市值 − 持仓成本 + 已实现盈亏
  totalReturnRate: number | null // 累计收益率 = 累计盈亏 / 当日持仓成本（成本 ≤ 0 时为 null）
}

/** 收益走势时间范围：近1月/近3月/近1年 = 今天往前 30/90/365 天截取点集；全部不截取 */
export type FundSeriesRange = '1m' | '3m' | '1y' | 'all'

/** XIRR 现金流：金额为归一化符号（流出为负、流入为正） */
export interface XirrCashFlow {
  date: string
  amount: number
}
