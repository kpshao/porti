// 收益统计页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { FundPosition, StatsPoint } from '../engine'

/** 收益统计页全量数据（曲线/周收益列表/单基金盈亏排序一次取回） */
export interface StatsData {
  series: StatsPoint[]
  positions: FundPosition[]
}
