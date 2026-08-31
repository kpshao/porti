import type { Snapshot, Transaction } from './types'
import { sharesAsOf } from './compute'

export interface ReconstructedNav {
  fundCode: string
  date: string
  nav: number
}

export interface SkippedSnapshot {
  date: string
  fundCode: string
  reason: string
}

export interface ReconstructionResult {
  points: ReconstructedNav[] // 调用方以 import 来源写入净值历史
  skipped: SkippedSnapshot[]
}

/** 由收益快照重建净值历史：NAV = 快照市值 ÷ 当日累计份额。 */
export function reconstructNavPoints(
  snapshots: Snapshot[],
  transactions: Transaction[]
): ReconstructionResult {
  const points: ReconstructedNav[] = []
  const skipped: SkippedSnapshot[] = []
  for (const s of snapshots) {
    const shares = sharesAsOf(transactions, s.fundCode, s.date)
    if (shares > 0) {
      points.push({ fundCode: s.fundCode, date: s.date, nav: s.marketValue / shares })
    } else {
      skipped.push({ date: s.date, fundCode: s.fundCode, reason: '无有效份额' })
    }
  }
  return { points, skipped }
}
