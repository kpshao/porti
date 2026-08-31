// 天天基金（东方财富）批量净值接口 FundMNFInfo 的响应解析（纯函数，可单测）

import { isValidDateString, normalizeFundCode } from '../engine'
import type { NavQuote } from './types'

/** 接口响应中的单基金条目（仅用到字段） */
interface RawFundInfo {
  FCODE?: unknown
  SHORTNAME?: unknown
  PDATE?: unknown
  NAV?: unknown
}

interface FundMNFInfoResponse {
  Datas?: RawFundInfo[] | null
  ErrCode?: unknown
}

/**
 * 解析批量查询响应体。结构异常/错误码非零时抛中文错误；
 * 个别基金净值缺失或日期非法时跳过该条目（由调用方按「抓取失败」处理，不阻塞其余基金）。
 */
export function parseNavQuoteList(body: string): NavQuote[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error('净值接口返回内容无法解析（非 JSON）')
  }
  const resp = json as FundMNFInfoResponse
  if (typeof resp !== 'object' || resp === null || !Array.isArray(resp.Datas)) {
    throw new Error('净值接口响应缺少数据列表')
  }
  const errCode = Number(resp.ErrCode ?? 0)
  if (!Number.isFinite(errCode) || errCode !== 0) {
    throw new Error(`净值接口返回错误码 ${resp.ErrCode}`)
  }

  const quotes: NavQuote[] = []
  for (const item of resp.Datas) {
    if (item === null || typeof item !== 'object') continue
    const code = normalizeFundCode(item.FCODE)
    const nav = Number(item.NAV)
    const date = typeof item.PDATE === 'string' ? item.PDATE : ''
    if (code === null || !Number.isFinite(nav) || nav <= 0 || !isValidDateString(date)) continue
    quotes.push({ fundCode: code, name: String(item.SHORTNAME ?? ''), date, nav })
  }
  return quotes
}
