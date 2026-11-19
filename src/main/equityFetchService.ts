// 权益系数抓取服务：批量抓取候选值（只读、不写库）与用户确认后的写入。
// 候选值只保存在主进程内存中；确认时用主进程持有的候选值决定报告期与来源，不信任渲染进程回传。
// 联网边界见 ADR-0006。

import type Database from 'better-sqlite3'
import {
  EQUITY_RATIO_ERROR_TEXT,
  isValidEquityRatio,
  normalizeFundCode
} from '../engine'
import type { Fund } from '../engine'
import {
  defaultEquityHttpGet,
  fetchEquityCandidate,
  fetchEquityCandidateBatch
} from '../fetcher/equityFetch'
import type { EquityFetchBatchOptions } from '../fetcher/equityFetch'
import type { EquityFetchResult, EquityRatioCandidate, HttpGet } from '../fetcher/types'
import type { EquityRatioConfirmInput } from './fundConfigTypes'
import { selectFunds, updateFundEquityRatio } from './repo'

export interface EquityFetchService {
  /** 抓取单只基金候选值（成功时暂存，失败时清除该基金旧候选） */
  fetchForFund(fundCode: string): Promise<EquityFetchResult>
  /** 抓取库内全部基金候选值；逐行结果，单只失败不写库也不影响其他基金 */
  fetchAll(
    db: Database.Database,
    options?: EquityFetchBatchOptions
  ): Promise<EquityFetchResult[]>
  /** 确认已抓取的候选值并写入权益系数（来源与数据日期规则见 ADR-0006） */
  confirm(db: Database.Database, input: EquityRatioConfirmInput): Fund
  /** 忽略候选值（界面「忽略」或重新抓取失败时调用） */
  discard(fundCode: string): void
}

export function createEquityFetchService(
  httpGet: HttpGet = defaultEquityHttpGet
): EquityFetchService {
  const pending = new Map<string, EquityRatioCandidate>()

  const remember = (result: EquityFetchResult): EquityFetchResult => {
    if (result.ok) pending.set(result.candidate.fundCode, result.candidate)
    else pending.delete(result.fundCode)
    return result
  }

  return {
    async fetchForFund(fundCode) {
      return remember(await fetchEquityCandidate(fundCode, httpGet))
    },

    async fetchAll(db, options = {}) {
      const codes = selectFunds(db).map((fund) => fund.code)
      return fetchEquityCandidateBatch(codes, httpGet, {
        ...options,
        onResult: (result) => {
          remember(result)
          options.onResult?.(result)
        }
      })
    },

    confirm(db, input) {
      const code = normalizeFundCode(input.fundCode)
      if (code === null) throw new Error('基金代码需为 6 位数字')
      if (!isValidEquityRatio(input.confirmedRatio)) throw new Error(EQUITY_RATIO_ERROR_TEXT)

      const candidate = pending.get(code)
      if (candidate === undefined) throw new Error('请先抓取股票占净比候选值，再确认写入')
      if (selectFunds(db).find((fund) => fund.code === code) === undefined) {
        throw new Error(`基金 ${code} 不存在`)
      }

      // 百分比文本回换算会引入浮点尾差：保留 6 位小数清理后再比较，
      // 既避免把「未改值」误判为手工，也避免把 0.7820999999999999 这类尾差写进库。
      const confirmedRatio = Math.round(input.confirmedRatio * 1e6) / 1e6
      const source = Math.abs(confirmedRatio - candidate.stockRatio) < 1e-9 ? 'fetch' : 'manual'
      updateFundEquityRatio(db, {
        code,
        equityRatio: confirmedRatio,
        equityRatioSource: source,
        equityRatioAsOf: candidate.reportDate
      })
      return selectFunds(db).find((fund) => fund.code === code)!
    },

    discard(fundCode) {
      const code = normalizeFundCode(fundCode)
      if (code !== null) pending.delete(code)
    }
  }
}
