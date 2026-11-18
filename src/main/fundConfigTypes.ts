// 基金配置页契约类型与展示标签（主进程与界面共用；只含类型与常量，无运行时依赖）

import type { Fund } from '../engine'
import type {
  EquityFetchDataSource,
  EquityFetchEvent,
  EquityFetchResult,
  EquityRatioCandidate
} from '../fetcher/types'

export type { EquityFetchEvent, EquityFetchResult, EquityRatioCandidate }

/** 基金配置页数据：全部基金（含已清仓与从未建仓的基金） */
export interface FundConfigData {
  funds: Fund[]
}

/** 抓取候选值确认写入输入；报告期与抓取值由主进程内存中的候选值提供 */
export interface EquityRatioConfirmInput {
  fundCode: string
  confirmedRatio: number // 用户确认后的权益系数 0–1
}

/** 抓取数据源展示标签 */
export const EQUITY_FETCH_DATA_SOURCE_LABEL: Record<EquityFetchDataSource, string> = {
  pingzhongdata: '东方财富 pingzhongdata',
  f10: '东方财富 F10（回退）'
}
