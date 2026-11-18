import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from './schema'
import { selectFunds } from './repo'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

describe('selectFunds — 最终三层模型', () => {
  it('按基金代码升序返回账本大类、产品形态、权益系数与来源', () => {
    const db = freshDb()
    db.prepare(
      `INSERT INTO funds (code, name, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
       VALUES ('000002', '固收加基金', '二级债基', '债', '固收+', 0.2, 'manual', NULL, '2026-01-01'),
              ('000001', '纯债基金', NULL, '债', '纯债', 0, 'manual', NULL, '2026-01-01')`
    ).run()

    expect(selectFunds(db)).toEqual([
      {
        code: '000001',
        name: '纯债基金',
        fundType: null,
        ledgerCategory: '债',
        productForm: '纯债',
        equityRatio: 0,
        equityRatioSource: 'manual',
        equityRatioAsOf: null
      },
      {
        code: '000002',
        name: '固收加基金',
        fundType: '二级债基',
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
