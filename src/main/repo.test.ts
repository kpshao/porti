import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from './schema'
import { selectFunds } from './repo'
import { V4_FUND_COLUMNS } from './schemaMigration'

/** v3 结构的库：迁移失败时 db.ts 会保留旧 schema 继续运行，读取层必须仍可用 */
function v3Db(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  for (const col of V4_FUND_COLUMNS) db.exec(`ALTER TABLE funds DROP COLUMN ${col}`)
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, created_at) VALUES (?,?,?,?,?)`
  ).run('000001', '固收加基金', '固守+', '二级债基', '2026-01-01')
  return db
}

describe('selectFunds — 迁移未完成时按旧五类派生新模型字段', () => {
  it('v3 结构的基金仍可读取，并得到正确的分类与默认系数', () => {
    const db = v3Db()
    expect(selectFunds(db)).toEqual([
      {
        code: '000001',
        name: '固收加基金',
        category: '固守+',
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

  it('v3 结构中的未知大类给出明确错误，不静默兜底', () => {
    const db = v3Db()
    db.prepare("UPDATE funds SET category = '股票型'").run()
    expect(() => selectFunds(db)).toThrow(/股票型/)
    db.close()
  })
})
