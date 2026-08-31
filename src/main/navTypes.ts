// 净值管理契约类型（主进程服务与界面共用，纯类型无运行时依赖）

import type { Fund, NavPoint } from '../engine'

/** 手动补录输入 */
export interface NavInput {
  fundCode: string
  date: string // YYYY-MM-DD
  nav: number
}

/** 净值管理页数据（基金列表 + 全部净值历史） */
export interface NavData {
  funds: Fund[]
  navPoints: NavPoint[]
}

/** 一次抓取的结果（写入/跳过/失败明细） */
export interface NavFetchResult {
  inserted: number // 新写入条数
  skipped: number // 同基金同日已有记录，跳过
  failedCodes: string[] // 接口无数据的基金代码
  message: string // 中文汇总
}

export type FetchStatusState = 'idle' | 'running' | 'ok' | 'failed'

/** 启动自动抓取的最近一次状态（净值管理页展示用） */
export interface FetchStatus {
  state: FetchStatusState
  message: string
  finishedAt: string | null // 完成时间（ISO）
}
