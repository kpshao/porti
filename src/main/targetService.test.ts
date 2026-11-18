import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { computeAllocationComparison, computePositions } from '../engine'
import type { AllocationBucket } from '../engine'
import { SCHEMA } from './schema'
import { selectBucketTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { loadBucketTargets, saveBucketTargets } from './targetService'
import { createFund } from './transactionService'

/** 测试辅助：从库内数据计算持仓（引擎输入） */
function computePositionsOf(db: Database.Database): ReturnType<typeof computePositions> {
  return computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

/** 写入一笔在持权益基金：净投入与市值都是 1000 */
function seedHeldEquityFund(db: Database.Database): void {
  createFund(db, { code: '000001', name: '基金甲', productForm: '权益', fundType: null })
  db.prepare(
    'INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run('2026-01-15', '买入', '000001', 1000, 100, 10, 0, null, 'x', 'x')
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
    '000001',
    '2026-01-20',
    10,
    'manual'
  )
}

function targetsOf(
  ratios: [number, number, number]
): { bucket: AllocationBucket; targetRatio: number }[] {
  return [
    { bucket: '稳健', targetRatio: ratios[0] },
    { bucket: '权益', targetRatio: ratios[1] },
    { bucket: '黄金', targetRatio: ratios[2] }
  ]
}

describe('loadBucketTargets — 配置桶目标读取', () => {
  it('尚未保存：按固定三桶返回全 0（未配置状态）', () => {
    expect(loadBucketTargets(freshDb())).toEqual(targetsOf([0, 0, 0]))
  })

  it('已保存的三桶目标（含全 0）按固定顺序返回', () => {
    const db = freshDb()
    saveBucketTargets(db, targetsOf([0.5, 0.3, 0.2]))
    expect(loadBucketTargets(db)).toEqual(targetsOf([0.5, 0.3, 0.2]))

    saveBucketTargets(db, targetsOf([0, 0, 0]))
    expect(loadBucketTargets(db)).toEqual(targetsOf([0, 0, 0]))
  })
})

describe('saveBucketTargets — 配置桶目标逐行保存', () => {
  it('保存后按固定三桶回读，覆盖已有的值', () => {
    const db = freshDb()
    saveBucketTargets(db, targetsOf([0.5, 0.3, 0.2]))
    expect(selectBucketTargets(db)).toEqual(targetsOf([0.5, 0.3, 0.2]))

    saveBucketTargets(db, targetsOf([0.4, 0.35, 0.25]))
    expect(selectBucketTargets(db)).toEqual(targetsOf([0.4, 0.35, 0.25]))
  })

  it('非法输入给出中文错误：桶名错误、重复、缺行、比例越界、非数字', () => {
    const db = freshDb()
    expect(() =>
      saveBucketTargets(db, [
        { bucket: '股票' as AllocationBucket, targetRatio: 0.5 },
        { bucket: '权益', targetRatio: 0.3 },
        { bucket: '黄金', targetRatio: 0.2 }
      ])
    ).toThrow(/稳健\/权益\/黄金/)
    expect(() => saveBucketTargets(db, targetsOf([0.5, 0.3, 0.2]).slice(0, 2))).toThrow(
      /稳健\/权益\/黄金/
    )
    expect(() =>
      saveBucketTargets(db, [
        { bucket: '稳健', targetRatio: 0.5 },
        { bucket: '稳健', targetRatio: 0.3 },
        { bucket: '黄金', targetRatio: 0.2 }
      ])
    ).toThrow(/重复/)
    expect(() => saveBucketTargets(db, targetsOf([1.2, 0, 0]))).toThrow(/0 到 1/)
    expect(() => saveBucketTargets(db, targetsOf([-0.1, 0, 0]))).toThrow(/0 到 1/)
    expect(() => saveBucketTargets(db, targetsOf([Number.NaN, 0, 0]))).toThrow(/0 到 1/)
  })

  it('更新目标后配置对比按新目标与归一化口径重算偏离', () => {
    const db = freshDb()
    seedHeldEquityFund(db)

    saveBucketTargets(db, targetsOf([0.5, 0.3, 0.2]))
    const before = computeAllocationComparison(
      computePositionsOf(db),
      selectFunds(db),
      loadBucketTargets(db)
    )
    expect(before.rows.find((r) => r.bucket === '权益')?.targetRatio).toBeCloseTo(0.3)
    expect(before.rows.find((r) => r.bucket === '权益')?.deviation).toBeCloseTo(0.7, 9)

    // 合计 70%：偏离按归一化目标计算（权益 30/70 ≈ 42.86%）
    saveBucketTargets(db, targetsOf([0.4, 0.3, 0]))
    const after = computeAllocationComparison(
      computePositionsOf(db),
      selectFunds(db),
      loadBucketTargets(db)
    )
    expect(after.targetNormalized).toBe(true)
    expect(after.rows.find((r) => r.bucket === '权益')?.deviation).toBeCloseTo(1 - 0.3 / 0.7, 9)
    expect(after.rows.find((r) => r.bucket === '黄金')?.deviation).toBeCloseTo(0, 9)
  })
})
