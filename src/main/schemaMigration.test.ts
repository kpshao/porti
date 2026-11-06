import { mkdirSync, mkdtempSync, readdirSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from './schema'
import { migrateDatabase } from './schemaMigration'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'porti-schema-migration-'))
}

/** v1 夹具：在当前 schema 上加回已被删除的 target_amount 列，版本标为 1 */
function seedV1Db(path: string): Database.Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  db.exec('ALTER TABLE funds ADD COLUMN target_amount REAL')
  db.pragma('user_version = 1')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, target_amount, created_at)
     VALUES ('002065', '测试基金', '固守+', NULL, 50000, '2026-01-01')`
  ).run()
  return db
}

function fundColumns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(funds)').all() as { name: string }[]).map((c) => c.name)
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.bak-'))
}

describe('migrateDatabase — v1 → v2 删除单只基金目标金额', () => {
  it('删列前用 VACUUM INTO 留备份；列消失但基金数据保留', () => {
    const dir = tempDir()
    const path = join(dir, 'porti.db')
    const db = seedV1Db(path)

    migrateDatabase(db, 1)

    expect(fundColumns(db)).not.toContain('target_amount')
    expect(db.prepare('SELECT code, name FROM funds').get()).toEqual({
      code: '002065',
      name: '测试基金'
    })

    const backups = backupFiles(dir)
    expect(backups).toHaveLength(1)
    const backup = new Database(join(dir, backups[0]), { readonly: true })
    expect(fundColumns(backup)).toContain('target_amount')
    expect(
      (backup.prepare('SELECT target_amount FROM funds').get() as { target_amount: number })
        .target_amount
    ).toBe(50000)
    backup.close()
    db.close()
  })

  it('重复迁移幂等：列已不存在时不再产生备份', () => {
    const dir = tempDir()
    const db = seedV1Db(join(dir, 'porti.db'))

    migrateDatabase(db, 1)
    migrateDatabase(db, 1)

    expect(backupFiles(dir)).toHaveLength(1)
    db.close()
  })

  it('备份失败时抛错且不删列（调用方保留旧版本）', () => {
    const dir = tempDir()
    const sub = join(dir, 'data')
    mkdirSync(sub)
    const db = seedV1Db(join(sub, 'porti.db'))
    // 移走目录：VACUUM INTO 的目标路径不可写 → 备份失败
    renameSync(sub, join(dir, 'moved'))

    expect(() => migrateDatabase(db, 1)).toThrow()
    expect(fundColumns(db)).toContain('target_amount')
    db.close()
  })
})
