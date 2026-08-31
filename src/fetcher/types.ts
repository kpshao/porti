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
