// 概览页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { AnnualizedReturnData, CategoryComparisonRow, Fund, PositionGroup, Totals } from '../engine'

/** 概览页全量数据（顶部卡片/持仓明细/大类对比一次取回） */
export interface OverviewData {
  funds: Fund[]
  positionGroups: PositionGroup[] // 持仓明细按大类分组（组序与组头合计口径见 compute.groupPositionsByCategory）
  totals: Totals | null
  comparison: CategoryComparisonRow[]
  annualized: AnnualizedReturnData // 年化收益率：按基金代码映射 + 整体
}
