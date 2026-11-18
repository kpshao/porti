import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ALLOCATION_BUCKETS } from '../engine'
import type { ProductForm } from '../engine'
import { selectBucketTargets, selectFunds } from '../main/repo'
import { SCHEMA } from '../main/schema'
import type { CommitPayload, ImportedFund } from './types'
import { importToDb } from './write'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function planWithFund(
  productForm: ProductForm | null,
  rawCategoryLabel: string | null = null
): CommitPayload {
  const fund: ImportedFund = {
    code: '000001',
    name: '测试基金',
    fundType: null,
    productForm,
    rawCategoryLabel
  }
  return {
    funds: [fund],
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

describe('importToDb — 已解析的产品形态', () => {
  it('按产品形态写入账本大类与默认权益系数', () => {
    const db = freshDb()
    importToDb(db, planWithFund('固收+'))
    expect(selectFunds(db)).toEqual([
      {
        code: '000001',
        name: '测试基金',
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
})

describe('importToDb — 未知标签与目标列', () => {
  it('无法识别的类别明确报错，且不写入任何数据', () => {
    const db = freshDb()
    expect(() => importToDb(db, planWithFund(null, '股票型'))).toThrow(/股票型.*000001/)
    expect(selectFunds(db)).toEqual([])
    db.close()
  })

  it('导入不写配置桶目标，已有目标保持不变', () => {
    const db = freshDb()
    for (const [bucket, ratio] of [
      ['稳健', 0.6],
      ['权益', 0.3],
      ['黄金', 0.1]
    ] as const) {
      db.prepare('INSERT INTO bucket_targets (bucket, target_ratio) VALUES (?,?)').run(bucket, ratio)
    }

    importToDb(db, planWithFund('纯债'))

    expect(selectFunds(db)).toHaveLength(1)
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
