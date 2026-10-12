// 基金详情契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { FundPosition, FundSeriesPoint, OperationType } from '../engine'

/** 流水事件（收益走势图上标注买入/卖出/分红） */
export interface FundDetailEvent {
  date: string
  type: OperationType
}

/** 基金详情全量数据（指标行/收益走势曲线一次取回） */
export interface FundDetailData {
  position: FundPosition | null // 无持仓（基金不存在或份额为 0）时为 null
  annualized: number | null // 年化收益率（XIRR，不足 30 天/异常为空）
  realizedIncome: number // 已实现盈亏 = Σ分红现金 + Σ卖出已实现收益
  series: FundSeriesPoint[] // 收益走势（已按范围过滤）
  events: FundDetailEvent[] // 该基金全部流水事件（图上仅标注有净值记录的日期）
}
