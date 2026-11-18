// 净值抓取器领域类型

/** 一条抓取到的基金净值（来源为公开行情接口） */
export interface NavQuote {
  fundCode: string // 6 位基金代码
  name: string // 接口返回的基金简称（仅展示/校验用，不写库）
  date: string // 净值日期 YYYY-MM-DD
  nav: number // 单位净值
}

/** 可注入的 HTTP GET：返回响应体文本；超时/网络错误以 reject 表达（mock 接缝） */
export type HttpGet = (url: string, timeoutMs: number) => Promise<string>

/** 权益系数抓取的数据源：pingzhongdata 脚本优先，失败时回退 F10 资产配置页 HTML */
export type EquityFetchDataSource = 'pingzhongdata' | 'f10'

/** 单季资产配置（占净比；股票为 0–1，债券/现金通常 0–1 但可能因杠杆超过 1；来源数据缺失为 null） */
export interface AssetAllocationQuarter {
  reportDate: string // 报告期 YYYY-MM-DD
  stockRatio: number // 股票占净比（QDII 的 F10 行含存托凭证）
  bondRatio: number | null
  cashRatio: number | null
  includesDepositaryReceipts: boolean // 股票占净比是否加上了存托凭证占净比
}

/** 抓取得到的权益系数候选值（未写入数据库，等待用户确认） */
export interface EquityRatioCandidate {
  fundCode: string
  stockRatio: number // 股票占净比，0–1
  reportDate: string // 报告期 YYYY-MM-DD
  dataSource: EquityFetchDataSource
  includesDepositaryReceipts: boolean
}

/** 单只基金抓取结果：失败按行返回中文错误，不抛出（批次继续） */
export type EquityFetchResult =
  | { ok: true; candidate: EquityRatioCandidate }
  | { ok: false; fundCode: string; error: string }

/** 批量抓取的逐行进展事件 */
export type EquityFetchEvent =
  | { type: 'started'; fundCode: string }
  | { type: 'result'; result: EquityFetchResult }
