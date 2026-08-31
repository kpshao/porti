// 净值抓取编排：批量接口 URL 拼接 + 注入式 HTTP（mock 接缝）+ 默认实现

import { parseNavQuoteList } from './parse'
import type { HttpGet, NavQuote } from './types'

/** 天天基金（东方财富）公开行情接口：批量查询基金最新单位净值 */
export const FUND_NAV_API = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo'

/** 默认超时（spec：HTTP 超时抛错交由 UI 提示手动补录） */
export const DEFAULT_TIMEOUT_MS = 8000

/** 拼接批量查询 URL（Fcodes 以逗号分隔一次取回） */
export function buildBatchUrl(codes: string[]): string {
  const params = new URLSearchParams({
    pageIndex: '1',
    pageSize: '100',
    plat: 'Android',
    appType: 'ttjj',
    product: 'EFund',
    Version: '1',
    deviceid: 'porti-v1',
    Fcodes: codes.join(',')
  })
  return `${FUND_NAV_API}?${params.toString()}`
}

/**
 * 抓取 codes 的最新净值。HTTP 失败/超时原样抛出；
 * 个别基金净值缺失时不在结果中出现（由调用方按「抓取失败」处理）。
 */
export async function fetchNavQuotes(
  codes: string[],
  httpGet: HttpGet,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<NavQuote[]> {
  if (codes.length === 0) return []
  const body = await httpGet(buildBatchUrl(codes), timeoutMs)
  return parseNavQuoteList(body)
}

/** 默认 HTTP 实现（Node/Electron 全局 fetch + AbortController 超时） */
export const defaultHttpGet: HttpGet = async (url, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Porti/0.1' }
    })
    if (!res.ok) throw new Error(`接口返回状态码 ${res.status}`)
    return await res.text()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    if (detail.toLowerCase().includes('abort')) throw new Error('净值接口请求超时，请稍后重试')
    throw new Error(`净值接口请求失败：${detail}`)
  } finally {
    clearTimeout(timer)
  }
}
