import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ALLOCATION_BUCKETS } from '../engine'
import type { ProductForm } from '../engine'
import { selectBucketTargets, selectCategoryTargets, selectFunds } from '../main/repo'
import { SCHEMA } from '../main/schema'
import type { CommitPayload } from './types'
import { importToDb } from './write'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function planWithFund(category: string, productForm?: ProductForm): CommitPayload {
  return {
    funds: [{ code: '000001', name: '测试基金', category, fundType: null, productForm }],
    transactions: [],
    snapshots: [],
    currentNavs: [],
    expectation: {
      totals: { totalNetCost: 0, totalAssets: 0, totalPnl: 0, totalReturnRate: 0 },
      funds: [],
      series: []
    }
  }
}

describe('importToDb — 旧大类与兼容列', () => {
  it('新拼写「固收+」写入兼容列时归一化为「固守+」，新模型字段正确', () => {
    const db = freshDb()
    importToDb(db, planWithFund('固收+'))

    expect(selectFunds(db)).toEqual([
      {
        code: '000001',
        name: '测试基金',
        category: '固守+',
        fundType: null,
        ledgerCategory: '债',
        productForm: '固收+',
        equityRatio: 0.2,
        equityRatioSource: 'manual',
        equityRatioAsOf: null
      }
    ])
    db.close()
  })

  it('旧「流动性」归入 债 / 纯债', () => {
    const db = freshDb()
    importToDb(db, planWithFund('流动性'))

    expect(selectFunds(db)[0]).toMatchObject({
      category: '纯债',
      ledgerCategory: '债',
      productForm: '纯债',
      equityRatio: 0
    })
    db.close()
  })

  it('未知大类明确报错，且不写入任何数据', () => {
    const db = freshDb()
    expect(() => importToDb(db, planWithFund('股票型'))).toThrow(/股票型.*000001/)
    expect(selectFunds(db)).toEqual([])
    db.close()
  })
})

describe('importToDb — 目标列被忽略', () => {
  it('导入不写大类目标或配置桶目标，已有目标保持不变', () => {
    const db = freshDb()
    db.prepare('INSERT INTO category_targets (category, target_ratio) VALUES (?,?)').run('权益', 0.3)
    db.prepare('INSERT INTO category_targets (category, target_ratio) VALUES (?,?)').run('纯债', 0.7)
    for (const [bucket, ratio] of [
      ['稳健', 0.6],
      ['权益', 0.3],
      ['黄金', 0.1]
    ] as const) {
      db.prepare('INSERT INTO bucket_targets (bucket, target_ratio) VALUES (?,?)').run(bucket, ratio)
    }

    importToDb(db, planWithFund('纯债'))

    expect(selectFunds(db)).toHaveLength(1)
    expect(selectCategoryTargets(db)).toEqual(
      expect.arrayContaining([
        { category: '纯债', targetRatio: 0.7 },
        { category: '权益', targetRatio: 0.3 }
      ])
    )
    expect(selectCategoryTargets(db)).toHaveLength(2)
    expect(
      selectBucketTargets(db).sort(
        (a, b) => ALLOCATION_BUCKETS.indexOf(a.bucket) - ALLOCATION_BUCKETS.indexOf(b.bucket)
      )
    ).toEqual([
      { bucket: '稳健', targetRatio: 0.6 },
      { bucket: '权益', targetRatio: 0.3 },
      { bucket: '黄金', targetRatio: 0.1 }
    ])
    db.close()
  })
})
