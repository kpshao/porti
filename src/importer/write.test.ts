import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { selectFunds } from '../main/repo'
import { SCHEMA } from '../main/schema'
import type { CommitPayload } from './types'
import { importToDb } from './write'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function planWithFund(category: string): CommitPayload {
  return {
    funds: [{ code: '000001', name: '测试基金', category, fundType: null }],
    categoryTargets: [],
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

  it('未知大类明确报错，且不写入任何数据', () => {
    const db = freshDb()
    expect(() => importToDb(db, planWithFund('股票型'))).toThrow(/股票型/)
    expect(selectFunds(db)).toEqual([])
    db.close()
  })
})
