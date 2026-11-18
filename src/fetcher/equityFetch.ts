// 权益系数抓取编排：固定东方财富域名 + 注入式 HTTP（mock 接缝）+ 默认实现。
// 候选值只读公开数据，不写数据库；确认写入见 main/equityFetchService。

import { normalizeFundCode } from '../engine'
import { parseF10AssetAllocation, parsePingzhongAssetAllocation } from './assetAllocation'
import { createHttpGet } from './http'
import type { AssetAllocationQuarter, EquityFetchResult, HttpGet } from './types'

/** 固定域名：优先 pingzhongdata 脚本，失败时回退 F10 资产配置页 */
export const PINGZHONG_DATA_BASE = 'https://fund.eastmoney.com/pingzhongdata/'
export const F10_BASE = 'https://fundf10.eastmoney.com/zcpz_'

/** 单次请求超时（spec：设置超时，超时按行报错、批次继续） */
export const DEFAULT_EQUITY_TIMEOUT_MS = 10000

/** 批量请求间隔（spec：顺序执行并控制频率） */
export const DEFAULT_EQUITY_FETCH_INTERVAL_MS = 300

const ALLOWED_HOSTS = ['fund.eastmoney.com', 'fundf10.eastmoney.com'] as const

export function buildPingzhongDataUrl(fundCode: string): string {
  return `${PINGZHONG_DATA_BASE}${fundCode}.js`
}

export function buildF10Url(fundCode: string): string {
  return `${F10_BASE}${fundCode}.html`
}

/** 默认 HTTP：固定域名白名单、10s 超时、响应体大小上限，不携带任何凭据 */
export const defaultEquityHttpGet: HttpGet = createHttpGet({
  label: '基金公开数据接口',
  allowedHosts: ALLOWED_HOSTS,
  maxResponseBytes: 2_000_000
})

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 报告期最新的一季（数据源可能乱序或含空季度） */
function latestQuarter(quarters: AssetAllocationQuarter[]): AssetAllocationQuarter | null {
  let latest: AssetAllocationQuarter | null = null
  for (const quarter of quarters) {
    if (latest === null || quarter.reportDate > latest.reportDate) latest = quarter
  }
  return latest
}

/**
 * 抓取单只基金的股票占净比候选值。pingzhongdata 优先，任何失败都回退 F10；
 * 两个数据源都失败时返回逐行错误，不抛出（批次可继续）。
 */
export async function fetchEquityCandidate(
  fundCode: string,
  httpGet: HttpGet,
  timeoutMs: number = DEFAULT_EQUITY_TIMEOUT_MS
): Promise<EquityFetchResult> {
  const code = normalizeFundCode(fundCode)
  if (code === null) return { ok: false, fundCode: String(fundCode), error: '基金代码需为 6 位数字' }

  let primaryError: string
  try {
    const body = await httpGet(buildPingzhongDataUrl(code), timeoutMs)
    const latest = latestQuarter(parsePingzhongAssetAllocation(body))
    if (latest !== null) {
      return {
        ok: true,
        candidate: {
          fundCode: code,
          stockRatio: latest.stockRatio,
          reportDate: latest.reportDate,
          dataSource: 'pingzhongdata',
          includesDepositaryReceipts: latest.includesDepositaryReceipts
        }
      }
    }
    primaryError = 'pingzhongdata 未返回有效资产配置数据'
  } catch (e) {
    primaryError = errorMessage(e)
  }

  try {
    const body = await httpGet(buildF10Url(code), timeoutMs)
    const latest = latestQuarter(parseF10AssetAllocation(body))
    if (latest !== null) {
      return {
        ok: true,
        candidate: {
          fundCode: code,
          stockRatio: latest.stockRatio,
          reportDate: latest.reportDate,
          dataSource: 'f10',
          includesDepositaryReceipts: latest.includesDepositaryReceipts
        }
      }
    }
    return {
      ok: false,
      fundCode: code,
      error: `抓取失败：${primaryError}；回退 F10 失败：F10 未返回有效资产配置数据`
    }
  } catch (e) {
    return {
      ok: false,
      fundCode: code,
      error: `抓取失败：${primaryError}；回退 F10 失败：${errorMessage(e)}`
    }
  }
}

export interface EquityFetchBatchOptions {
  intervalMs?: number
  sleep?: (ms: number) => Promise<void> // 测试接缝：批量间隔不真实等待
  onStart?: (fundCode: string) => void // 逐行「抓取中」进展
  onResult?: (result: EquityFetchResult) => void // 逐行结果（成功或失败）
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 顺序批量抓取：单只失败不中断，逐行回调；请求之间按 intervalMs 控制频率 */
export async function fetchEquityCandidateBatch(
  fundCodes: string[],
  httpGet: HttpGet,
  options: EquityFetchBatchOptions = {}
): Promise<EquityFetchResult[]> {
  const results: EquityFetchResult[] = []
  const sleep = options.sleep ?? defaultSleep
  const intervalMs = options.intervalMs ?? DEFAULT_EQUITY_FETCH_INTERVAL_MS

  for (let i = 0; i < fundCodes.length; i += 1) {
    if (i > 0) await sleep(intervalMs)
    const fundCode = fundCodes[i]
    options.onStart?.(fundCode)
    let result: EquityFetchResult
    try {
      result = await fetchEquityCandidate(fundCode, httpGet)
    } catch (e) {
      // fetchEquityCandidate 设计上不抛错；此处兜底保证批次不会因单只异常而中断
      result = { ok: false, fundCode, error: errorMessage(e) }
    }
    results.push(result)
    options.onResult?.(result)
  }
  return results
}
