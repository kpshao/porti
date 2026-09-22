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
  targetAmount: number | null
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
  targetAmount: number | null
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

/** 概览持仓明细的大类分组：组头 + 组内明细 */
export interface PositionGroup {
  category: string // 组名：CATEGORIES 之一，或兜底组「其他」
  marketValue: number | null // 组头合计（口径见 groupPositionsByCategory）；组内全无净值时为 null
  positions: FundPosition[] // 组内明细，按基金代码升序
}

export interface Totals {
  totalNetCost: number
  totalAssets: number // 总市值
  totalPnl: number // 持仓盈亏（浮动盈亏）= 总市值 − Σ持仓成本
  totalReturnRate: number | null // 累计收益率 = 总收益 / 净投入成本（净投入 ≤ 0 时为 null）
  realizedIncome: number // 落袋收益 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 总收益 = 持仓盈亏 + 落袋收益（数值与简单成本法恒等）
}

export interface CategoryComparisonRow {
  category: string
  targetRatio: number
  investedRatio: number | null // 实际投入比例 = 大类净投入 / 总净投入
  marketRatio: number | null // 实际市值占比 = 大类市值 / 总市值
  deviation: number | null // 偏离 = 实际市值占比 − 目标比例
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

/** 收益统计页时间序列点：总资产/持仓成本/落袋收益/累计收益/周收益。 */
export interface StatsPoint extends TimePoint {
  costBasis: number // 截至当日持仓成本 = Σ各基金移动加权成本基础
  realizedIncome: number // 截至当日落袋收益 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 累计收益 = 总市值 − 持仓成本 + 落袋收益
  weeklyReturn: WeeklyReturn | null // 无 ≥7 天前基准则为 null
}

/** 单基金收益走势点：该基金某有净值记录日期的累计收益快照。 */
export interface FundSeriesPoint {
  date: string
  marketValue: number // 当日市值 = 截至当日份额 × 截至当日最新净值
  costBasis: number // 截至当日持仓成本（移动加权平均）
  realizedIncome: number // 截至当日落袋收益 = Σ分红现金 + Σ卖出已实现收益
  totalReturn: number // 累计盈亏 = 市值 − 持仓成本 + 落袋收益
  totalReturnRate: number | null // 累计收益率 = 累计盈亏 / 当日持仓成本（成本 ≤ 0 时为 null）
}

/** 收益走势时间范围：近1月/近3月/近1年 = 今天往前 30/90/365 天截取点集；全部不截取 */
export type FundSeriesRange = '1m' | '3m' | '1y' | 'all'

/** XIRR 现金流：金额为归一化符号（流出为负、流入为正） */
export interface XirrCashFlow {
  date: string
  amount: number
}

/** 年化收益率数据：按基金代码映射 + 整体（概览/流水页契约共用） */
export interface AnnualizedReturnData {
  perFund: Record<string, number | null>
  total: number | null
}
