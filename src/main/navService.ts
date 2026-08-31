// 净值服务：联网抓取写入（auto 来源）、手动补录（manual 来源）、启动自动抓取状态

import type Database from 'better-sqlite3'
import { defaultHttpGet, fetchNavQuotes } from '../fetcher/fetch'
import type { HttpGet } from '../fetcher/types'
import { isValidDateString, normalizeFundCode } from '../engine'
import type { NavPoint } from '../engine'
import { selectFunds } from './repo'
import type { FetchStatus, NavFetchResult, NavInput } from './navTypes'
import { ensureFundExists } from './transactionService'

let lastFetchStatus: FetchStatus = { state: 'idle', message: '尚未尝试抓取', finishedAt: null }

export function getFetchStatus(): FetchStatus {
  return lastFetchStatus
}

/** 校验并归一化手动补录输入 */
export function normalizeNavInput(input: NavInput): NavPoint {
  const errors: string[] = []
  const code = normalizeFundCode(input.fundCode)
  if (code === null) errors.push('基金代码需为 6 位数字')
  if (!isValidDateString(input.date)) errors.push('日期需为合法 YYYY-MM-DD')
  if (!Number.isFinite(input.nav) || input.nav <= 0) errors.push('净值必须为正数')
  if (errors.length > 0) throw new Error(errors.join('；'))
  return { fundCode: code!, date: input.date, nav: input.nav, source: 'manual' }
}

/**
 * 手动补录：同基金同日已有记录时覆盖（来源变为 manual）——覆盖行为由界面确认后调用。
 */
export function upsertManualNav(db: Database.Database, input: NavInput): void {
  const point = normalizeNavInput(input)
  ensureFundExists(db, point.fundCode)
  db.prepare(
    `INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)
     ON CONFLICT (fund_code, date) DO UPDATE SET nav = excluded.nav, source = 'manual'`
  ).run(point.fundCode, point.date, point.nav, 'manual')
}

/**
 * 一键抓取：为库内全部基金拉取最新净值并写入（auto 来源）。
 * 同基金同日已有记录不覆盖（auto 不覆盖 import/manual 数据）；网络错误原样抛出。
 */
export async function fetchAndSaveNavs(
  db: Database.Database,
  httpGet: HttpGet,
  timeoutMs?: number
): Promise<NavFetchResult> {
  const funds = selectFunds(db)
  if (funds.length === 0) return { inserted: 0, skipped: 0, failedCodes: [], message: '暂无基金，无需抓取' }

  const quotes = await fetchNavQuotes(funds.map((f) => f.code), httpGet, timeoutMs)
  const byCode = new Map(quotes.map((q) => [q.fundCode, q]))

  const failedCodes = funds.filter((f) => !byCode.has(f.code)).map((f) => f.code)

  const insert = db.prepare(
    `INSERT OR IGNORE INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)`
  )
  let inserted = 0
  let skipped = 0
  for (const fund of funds) {
    const quote = byCode.get(fund.code)
    if (quote === undefined) continue
    const info = insert.run(quote.fundCode, quote.date, quote.nav, 'auto')
    if (info.changes === 1) inserted += 1
    else skipped += 1
  }

  const parts = [`成功写入 ${inserted} 条最新净值`, skipped > 0 ? `同日已有记录跳过 ${skipped} 条` : null]
  if (failedCodes.length > 0) parts.push(`抓取失败（接口无数据）：${failedCodes.join('、')}`)
  return { inserted, skipped, failedCodes, message: parts.filter((p): p is string => p !== null).join('，') }
}

/** 执行一次抓取并记录状态。网络错误时状态置 failed 后重新抛出（界面据此提示手动补录）。 */
export async function runNavFetch(
  db: Database.Database,
  httpGet: HttpGet = defaultHttpGet
): Promise<NavFetchResult> {
  lastFetchStatus = { state: 'running', message: '正在抓取最新净值…', finishedAt: null }
  try {
    const result = await fetchAndSaveNavs(db, httpGet)
    lastFetchStatus = { state: 'ok', message: result.message, finishedAt: new Date().toISOString() }
    return result
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    lastFetchStatus = { state: 'failed', message: `抓取失败：${detail}`, finishedAt: new Date().toISOString() }
    throw e
  }
}

/** 启动自动抓取：成功静默更新，失败静默不阻塞（状态经 getFetchStatus 供界面展示） */
export async function autoFetchNavs(db: Database.Database, httpGet: HttpGet = defaultHttpGet): Promise<void> {
  try {
    await runNavFetch(db, httpGet)
  } catch {
    // 静默：失败状态已记录
  }
}
