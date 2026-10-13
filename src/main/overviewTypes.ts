// 概览页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { AnnualizedReturnData, CategoryComparisonRow, Fund, PositionGroup, Totals } from '../engine'

/** 概览页全量数据（顶部卡片/持仓明细/大类对比一次取回） */
export interface OverviewData {
  funds: Fund[]
  positionGroups: PositionGroup[] // 在持持仓按大类分组（组序与组头合计口径见 compute.groupPositionsByCategory）
  closedGroup: PositionGroup | null // 已清仓持仓（份额 ≤ 0）单列的表尾组；无已清仓时为 null（口径见 compute.groupClosedPositions）
  totals: Totals | null
  comparison: CategoryComparisonRow[]
  annualized: AnnualizedReturnData // 年化收益率：按基金代码映射 + 整体
}
