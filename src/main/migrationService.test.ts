import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA, SCHEMA_VERSION } from './schema'
import {
  createMigrationBundle,
  readMigrationMeta,
  replaceDbFile,
  uniqueBackupPath,
  validateMigrationBundle
} from './migrationService'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'porti-migration-'))
}

/** 造一个带一只基金 + 一笔流水的文件库（WAL 模式，与生产一致） */
function seedFileDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, created_at)
     VALUES ('002065', '测试基金', '固守+', NULL, '2026-01-01')`
  ).run()
  db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, note, created_at, updated_at)
     VALUES ('2026-01-02', '买入', '002065', 1000, 900, 1.1, NULL, '2026-01-02', '2026-01-02')`
  ).run()
  return db
}

describe('migrationService — 迁移包（.portibak）生成/校验/替换', () => {
  it('导出迁移包可读回元信息，副本数据与源库一致', async () => {
    const dir = tempDir()
    const source = seedFileDb(join(dir, 'source.db'))
    const bundlePath = join(dir, 'porti-迁移-2026-09-07.portibak')

    const meta = await createMigrationBundle(source, bundlePath, '0.1.0')
    source.close()

    expect(meta.appVersion).toBe('0.1.0')
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const readBack = readMigrationMeta(bundlePath)
    expect(readBack).toEqual(meta)

    // 副本可独立打开，数据与源库一致
    const bundle = new Database(bundlePath, { readonly: true })
    const funds = bundle.prepare('SELECT COUNT(*) AS n FROM funds').get() as { n: number }
    const txs = bundle.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
    bundle.close()
    expect(funds.n).toBe(1)
    expect(txs.n).toBe(1)
  })

  it('重复导出到同一路径：覆盖旧包而非残留合并', async () => {
    const dir = tempDir()
    const source = seedFileDb(join(dir, 'source.db'))
    const bundlePath = join(dir, 'bundle.portibak')

    await createMigrationBundle(source, bundlePath, '0.1.0')
    await createMigrationBundle(source, bundlePath, '0.1.1')
    source.close()

    const readBack = readMigrationMeta(bundlePath)
    expect(readBack?.appVersion).toBe('0.1.1')
    const bundle = new Database(bundlePath, { readonly: true })
    const rows = bundle.prepare('SELECT COUNT(*) AS n FROM migration_meta').get() as { n: number }
    bundle.close()
    expect(rows.n).toBe(1)
  })

  it('校验通过：往返产物，返回元信息与内容概况', async () => {
    const dir = tempDir()
    const source = seedFileDb(join(dir, 'source.db'))
    const bundlePath = join(dir, 'bundle.portibak')
    await createMigrationBundle(source, bundlePath, '0.1.0')
    source.close()

    const result = validateMigrationBundle(bundlePath, SCHEMA_VERSION)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.info.meta.appVersion).toBe('0.1.0')
      expect(result.info.funds).toBe(1)
      expect(result.info.transactions).toBe(1)
      expect(result.info.navPoints).toBe(0)
    }
  })

  it('校验拒绝：不是数据库文件', () => {
    const dir = tempDir()
    const junk = join(dir, 'junk.portibak')
    writeFileSync(junk, '这不是数据库', 'utf8')
    const result = validateMigrationBundle(junk, SCHEMA_VERSION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('数据库文件')
  })

  it('校验拒绝：普通 SQLite 文件缺少迁移元信息', () => {
    const dir = tempDir()
    const plain = join(dir, 'plain.portibak')
    seedFileDb(plain).close()
    const result = validateMigrationBundle(plain, SCHEMA_VERSION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('迁移元信息')
  })

  it('校验拒绝：由更新版本导出（schema 版本高于当前）', async () => {
    const dir = tempDir()
    const source = seedFileDb(join(dir, 'source.db'))
    source.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    const bundlePath = join(dir, 'bundle.portibak')
    await createMigrationBundle(source, bundlePath, '0.1.0')
    source.close()

    const result = validateMigrationBundle(bundlePath, SCHEMA_VERSION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('更新版本')
  })

  it('校验拒绝：文件被截断（完整性检查未通过）', async () => {
    const dir = tempDir()
    const source = seedFileDb(join(dir, 'source.db'))
    const bundlePath = join(dir, 'bundle.portibak')
    await createMigrationBundle(source, bundlePath, '0.1.0')
    source.close()

    const full = readFileSync(bundlePath)
    writeFileSync(bundlePath, full.subarray(0, Math.floor(full.length / 2)))
    const result = validateMigrationBundle(bundlePath, SCHEMA_VERSION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('损坏')
  })

  it('替换数据文件：关闭连接后覆盖，重开即新数据', async () => {
    const dir = tempDir()
    // 目标库：一只基金（旧数据）
    const targetDb = seedFileDb(join(dir, 'target.db'))
    // 源库：两只基金 → 导出迁移包
    const source = seedFileDb(join(dir, 'source.db'))
    source
      .prepare(
        `INSERT INTO funds (code, name, category, fund_type, created_at)
         VALUES ('002066', '第二只', '纯债', NULL, '2026-01-01')`
      )
      .run()
    const bundlePath = join(dir, 'bundle.portibak')
    await createMigrationBundle(source, bundlePath, '0.1.0')
    source.close()

    replaceDbFile(targetDb, bundlePath)

    const reopened = new Database(join(dir, 'target.db'), { readonly: true })
    const funds = reopened
      .prepare('SELECT code FROM funds ORDER BY code')
      .all() as { code: string }[]
    reopened.close()
    expect(funds.map((f) => f.code)).toEqual(['002065', '002066'])
    expect(existsSync(bundlePath)).toBe(true) // 复制而非移动，迁移包保留
  })

  it('备份文件名：带时间戳；冲突时追加 -2/-3 序号', () => {
    const dir = tempDir()
    const now = new Date(2026, 8, 7, 12, 0, 0) // 2026-09-07 12:00:00
    expect(uniqueBackupPath(dir, now)).toBe(join(dir, 'porti-备份-20260907-120000.portibak'))

    writeFileSync(join(dir, 'porti-备份-20260907-120000.portibak'), 'x')
    expect(uniqueBackupPath(dir, now)).toBe(join(dir, 'porti-备份-20260907-120000-2.portibak'))

    writeFileSync(join(dir, 'porti-备份-20260907-120000-2.portibak'), 'x')
    expect(uniqueBackupPath(dir, now)).toBe(join(dir, 'porti-备份-20260907-120000-3.portibak'))
  })
})
