// 分析页契约类型（主进程与界面共用，纯类型无运行时依赖）

import type { ConcentrationMetrics } from '../engine'

/** 分析页全量数据（集中度指标一次取回；只读、本地计算） */
export interface AnalysisData {
  metrics: ConcentrationMetrics
}
