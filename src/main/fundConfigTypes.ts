// 基金配置页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { ClassifiedFund } from '../engine'

/** 基金配置页数据：全部基金（含已清仓与从未建仓的基金） */
export interface FundConfigData {
  funds: ClassifiedFund[]
}
