// 概览页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { CategoryComparisonRow, Fund, PositionGroup, SummaryData } from '../engine'

/** 概览页全量数据（顶部卡片/持仓明细/大类对比一次取回） */
export interface OverviewData {
  funds: Fund[]
  positionGroups: PositionGroup[] // 在持持仓按大类分组（组序与组头合计口径见 compute.groupPositionsByCategory）
  closedGroup: PositionGroup | null // 已清仓持仓（份额 ≤ 0）单列的表尾组；无已清仓时为 null（口径见 compute.groupClosedPositions）
  summary: SummaryData | null // 两种口径的汇总与单基金年化；空库为 null（不渲染汇总卡片）
  comparison: CategoryComparisonRow[]
}
