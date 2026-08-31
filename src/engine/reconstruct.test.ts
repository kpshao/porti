import { describe, expect, it } from 'vitest'
import type { Snapshot, Transaction } from './types'
import { reconstructNavPoints } from './reconstruct'

const transactions: Transaction[] = [
  { date: '2026-01-01', type: '买入', fundCode: 'A', amount: 100, shares: 100, nav: 1, fee: 0, note: null },
  { date: '2026-01-10', type: '分红再投入', fundCode: 'A', amount: 0, shares: 5, nav: 1.05, fee: 0, note: null }
]

describe('reconstructNavPoints — 快照重建净值', () => {
  it('NAV = 快照市值 ÷ 当日累计份额', () => {
    const snapshots: Snapshot[] = [
      { date: '2026-01-05', fundCode: 'A', marketValue: 102 } // 份额 100 → NAV 1.02
    ]
    const { points, skipped } = reconstructNavPoints(snapshots, transactions)
    expect(points).toEqual([{ fundCode: 'A', date: '2026-01-05', nav: 1.02 }])
    expect(skipped).toEqual([])
  })

  it('分红再投入后份额计入当日重建', () => {
    const snapshots: Snapshot[] = [
      { date: '2026-01-15', fundCode: 'A', marketValue: 105 } // 份额 105 → NAV 1
    ]
    const { points } = reconstructNavPoints(snapshots, transactions)
    expect(points[0].nav).toBeCloseTo(1, 9)
  })

  it('无流水或份额为 0 的快照跳过并给出原因', () => {
    const snapshots: Snapshot[] = [
      { date: '2026-01-05', fundCode: 'B', marketValue: 100 } // 基金 B 无任何流水
    ]
    const { points, skipped } = reconstructNavPoints(snapshots, transactions)
    expect(points).toEqual([])
    expect(skipped).toEqual([{ date: '2026-01-05', fundCode: 'B', reason: '无有效份额' }])
  })

  it('快照当日之后的流水不参与当日份额推算', () => {
    const snapshots: Snapshot[] = [
      { date: '2026-01-05', fundCode: 'A', marketValue: 200 } // 01-10 的分红再投入不算入 → 份额 100
    ]
    const { points } = reconstructNavPoints(snapshots, transactions)
    expect(points[0].nav).toBeCloseTo(2, 9)
  })
})
