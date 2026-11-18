// 权益系数抓取服务：批量抓取候选值（只读、不写库）与用户确认后的写入。
// 联网边界见 ADR-0006：仅用户点击触发、固定东方财富公开数据域名、不携带凭据。

import type Database from 'better-sqlite3'
import { isValidDateString, normalizeFundCode } from '../engine'
import type { Fund } from '../engine'
import { defaultEquityHttpGet, fetchEquityCandidateBatch } from '../fetcher/equityFetch'
import type { EquityFetchBatchOptions } from '../fetcher/equityFetch'
import type { EquityFetchResult, HttpGet } from '../fetcher/types'
import type { EquityRatioConfirmInput } from './fundConfigTypes'
import { selectFunds, updateFundEquityRatio } from './repo'

/** 抓取库内全部基金的候选值；逐行结果，单只失败不写库也不影响其他基金 */
export async function fetchAllEquityCandidates(
  db: Database.Database,
  httpGet: HttpGet = defaultEquityHttpGet,
  options: EquityFetchBatchOptions = {}
): Promise<EquityFetchResult[]> {
  const codes = selectFunds(db).map((fund) => fund.code)
  return fetchEquityCandidateBatch(codes, httpGet, options)
}

/**
 * 确认抓取候选值：未修改抓取值 → 来源记为抓取；修改过 → 来源记为手工。
 * 两种情况下数据日期都保留报告期；只写权益系数相关三列。
 */
export function confirmEquityRatio(
  db: Database.Database,
  input: EquityRatioConfirmInput
): Fund {
  const code = normalizeFundCode(input.fundCode)
  if (code === null) throw new Error('基金代码需为 6 位数字')
  if (
    !Number.isFinite(input.fetchedRatio) ||
    input.fetchedRatio < 0 ||
    input.fetchedRatio > 1
  ) {
    throw new Error('抓取到的股票占净比无效')
  }
  if (
    !Number.isFinite(input.confirmedRatio) ||
    input.confirmedRatio < 0 ||
    input.confirmedRatio > 1
  ) {
    throw new Error('权益系数需为 0 到 100% 之间的数字')
  }
  if (!isValidDateString(input.reportDate)) throw new Error('报告期需为合法 YYYY-MM-DD')

  const current = selectFunds(db).find((fund) => fund.code === code)
  if (current === undefined) throw new Error(`基金 ${code} 不存在`)

  // 百分比文本回换算会引入浮点尾差：保留 6 位小数清理后再比较，
  // 既避免把「未改值」误判为手工，也避免把 0.7820999999999999 这类尾差写进库。
  const confirmedRatio = Math.round(input.confirmedRatio * 1e6) / 1e6
  const source = Math.abs(confirmedRatio - input.fetchedRatio) < 1e-9 ? 'fetch' : 'manual'
  updateFundEquityRatio(db, {
    code,
    equityRatio: confirmedRatio,
    equityRatioSource: source,
    equityRatioAsOf: input.reportDate
  })

  return selectFunds(db).find((fund) => fund.code === code)!
}
