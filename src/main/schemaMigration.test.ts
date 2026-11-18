import { mkdirSync, mkdtempSync, readdirSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA } from './schema'
import { migrateDatabase, V4_FUND_COLUMNS } from './schemaMigration'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'porti-schema-migration-'))
}

/** 把当前 schema 还原成 v4 结构（v5 之前没有配置桶目标表，旧分类列与旧目标表仍在） */
function toV4Structure(db: Database.Database): void {
  db.exec('DROP TABLE bucket_targets')
  db.exec("ALTER TABLE funds ADD COLUMN category TEXT NOT NULL DEFAULT ''")
  db.exec(`CREATE TABLE category_targets (
    category TEXT PRIMARY KEY,
    target_ratio REAL NOT NULL
  )`)
}

/** 把当前 schema 还原成 v3 结构（v4 之前没有新模型字段） */
function toV3Structure(db: Database.Database): void {
  toV4Structure(db)
  for (const col of V4_FUND_COLUMNS) db.exec(`ALTER TABLE funds DROP COLUMN ${col}`)
}

/** v1 夹具：v3 结构上加回已被删除的 target_amount 列，版本标为 1 */
function seedV1Db(path: string): Database.Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  toV3Structure(db)
  db.exec('ALTER TABLE funds ADD COLUMN target_amount REAL')
  db.pragma('user_version = 1')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, target_amount, created_at)
     VALUES ('002065', '测试基金', '固守+', NULL, 50000, '2026-01-01')`
  ).run()
  return db
}

/** v2 夹具：v3 结构去掉 v3 新增的对话表，版本标为 2 */
function seedV2Db(path: string): Database.Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  toV3Structure(db)
  db.exec('DROP TABLE ai_messages')
  db.pragma('user_version = 2')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, created_at)
     VALUES ('002066', '迁移保留基金', '权益', NULL, '2026-01-01')`
  ).run()
  return db
}

/** v3 夹具：v4 结构去掉新字段，版本标为 3。覆盖旧五类（含已清仓的流动性基金）。 */
function seedV3Db(path: string): Database.Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  toV3Structure(db)
  db.pragma('user_version = 3')
  const insertFund = db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, created_at) VALUES (?,?,?,?,?)`
  )
  insertFund.run('000001', '纯债基金', '纯债', '一级债基', '2026-01-01')
  insertFund.run('000002', '固收加基金', '固守+', '二级债基', '2026-01-01')
  insertFund.run('000003', '权益基金', '权益', '宽基指数', '2026-01-01')
  insertFund.run('000004', '黄金基金', '黄金', '黄金', '2026-01-01')
  insertFund.run('000005', '短债基金', '流动性', '短债', '2026-01-01')
  // 已清仓的旧流动性基金：迁移同样要补齐新字段
  const insertTx = db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  insertTx.run('2026-01-02', '买入', '000005', 1000, 900, 1.1, 0, null, '2026-01-02', '2026-01-02')
  insertTx.run('2026-02-02', '卖出', '000005', -1100, -900, 1.2, 0, null, '2026-02-02', '2026-02-02')
  return db
}

/** v4 夹具：v5 结构去掉配置桶目标表，版本标为 4；旧目标表保留（折算来源） */
function seedV4Db(path: string): Database.Database {
  const db = new Database(path)
  db.exec(SCHEMA)
  toV4Structure(db)
  db.pragma('user_version = 4')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES ('002067', 'v4 保留基金', '固守+', NULL, '债', '固收+', 0.2, 'manual', NULL, '2026-01-01')`
  ).run()
  db.prepare(
    "INSERT INTO category_targets (category, target_ratio) VALUES ('固守+', 0.25), ('纯债', 0.45), ('权益', 0.2), ('黄金', 0.05), ('流动性', 0.05)"
  ).run()
  return db
}

interface FundModelRow {
  code: string
  ledger_category: string
  product_form: string
  equity_ratio: number
  equity_ratio_source: string
  equity_ratio_as_of: string | null
}

function fundModelRows(db: Database.Database): FundModelRow[] {
  return db
    .prepare(
      `SELECT code, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of
       FROM funds ORDER BY code`
    )
    .all() as FundModelRow[]
}

function fundColumns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(funds)').all() as { name: string }[]).map((c) => c.name)
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name)
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.bak-'))
}

function bucketTargetRatios(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT bucket, target_ratio FROM bucket_targets').all() as {
    bucket: string
    target_ratio: number
  }[]
  return Object.fromEntries(rows.map((row) => [row.bucket, row.target_ratio]))
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

    // 逐级迁移会先后执行 v1→v2、v3→v4、v5→v6，三次破坏性变更各留一份迁移前备份
    const backups = backupFiles(dir)
    expect(backups).toHaveLength(3)
    const backup = backups
      .map((f) => new Database(join(dir, f), { readonly: true }))
      .find((b) => fundColumns(b).includes('target_amount'))
    expect(backup).toBeDefined()
    expect(
      (backup!.prepare('SELECT target_amount FROM funds').get() as { target_amount: number })
        .target_amount
    ).toBe(50000)
    backup!.close()
    db.close()
  })

  it('重复迁移幂等：列已不存在时不再产生备份', () => {
    const dir = tempDir()
    const db = seedV1Db(join(dir, 'porti.db'))

    migrateDatabase(db, 1)
    migrateDatabase(db, 1)

    // 第一次产生 v1→v2、v3→v4、v5→v6 三份备份；重复迁移不再新增
    expect(backupFiles(dir)).toHaveLength(3)
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

describe('migrateDatabase — v2 → v3 新增单线程对话表', () => {
  it('纯新增 ai_messages 表，保留旧数据且不产生备份', () => {
    const dir = tempDir()
    const db = seedV2Db(join(dir, 'porti.db'))

    migrateDatabase(db, 2)

    expect(tableNames(db)).toContain('ai_messages')
    expect(db.prepare('SELECT code, name FROM funds').get()).toEqual({
      code: '002066',
      name: '迁移保留基金'
    })
    // v2→v3 本身纯新增；同一次调用会继续执行 v3→v4 与 v5→v6，各留一份备份
    expect(backupFiles(dir)).toHaveLength(2)
    db.close()
  })

  it('重复迁移幂等：表已存在时不报错', () => {
    const db = seedV2Db(join(tempDir(), 'porti.db'))
    migrateDatabase(db, 2)
    expect(() => migrateDatabase(db, 2)).not.toThrow()
    db.close()
  })
})

describe('migrateDatabase — v3 → 当前版本（新模型字段 + 旧模型收缩）', () => {
  it('旧五类映射到账本大类/产品形态，并补默认系数、手工来源与空数据日期', () => {
    const db = seedV3Db(join(tempDir(), 'porti.db'))

    migrateDatabase(db, 3)

    // 新字段覆盖全部旧类别；旧分类列与旧目标表已在本轮迁移末尾删除。
    expect(fundColumns(db)).not.toContain('category')
    expect(tableNames(db)).not.toContain('category_targets')
    expect(fundModelRows(db)).toEqual([
      {
        code: '000001',
        ledger_category: '债',
        product_form: '纯债',
        equity_ratio: 0,
        equity_ratio_source: 'manual',
        equity_ratio_as_of: null
      },
      {
        code: '000002',
        ledger_category: '债',
        product_form: '固收+',
        equity_ratio: 0.2,
        equity_ratio_source: 'manual',
        equity_ratio_as_of: null
      },
      {
        code: '000003',
        ledger_category: '权益',
        product_form: '权益',
        equity_ratio: 1,
        equity_ratio_source: 'manual',
        equity_ratio_as_of: null
      },
      {
        code: '000004',
        ledger_category: '黄金',
        product_form: '黄金',
        equity_ratio: 0,
        equity_ratio_source: 'manual',
        equity_ratio_as_of: null
      },
      {
        // 已清仓的旧流动性基金：映射为 债 / 纯债，同样补齐默认系数
        code: '000005',
        ledger_category: '债',
        product_form: '纯债',
        equity_ratio: 0,
        equity_ratio_source: 'manual',
        equity_ratio_as_of: null
      }
    ])
    db.close()
  })

  it('迁移前自动备份：备份保留 v3 结构与数据，迁移后的库才出现新字段', () => {
    const dir = tempDir()
    const db = seedV3Db(join(dir, 'porti.db'))

    migrateDatabase(db, 3)

    const backups = backupFiles(dir)
    expect(backups).toHaveLength(2)
    const backup = backups
      .map((f) => new Database(join(dir, f), { readonly: true }))
      .find((b) => !fundColumns(b).includes('ledger_category'))
    expect(backup).toBeDefined()
    expect((backup!.prepare('SELECT COUNT(*) AS n FROM funds').get() as { n: number }).n).toBe(5)
    backup!.close()

    expect(fundColumns(db)).toEqual(expect.arrayContaining(V4_FUND_COLUMNS))
    expect(fundColumns(db)).not.toContain('category')
    db.close()
  })

  it('重复迁移幂等：已迁移的库不再备份，字段与旧数据保持不变', () => {
    const dir = tempDir()
    const db = seedV3Db(join(dir, 'porti.db'))

    migrateDatabase(db, 3)
    const first = fundModelRows(db)
    migrateDatabase(db, 3)

    expect(fundModelRows(db)).toEqual(first)
    expect(backupFiles(dir)).toHaveLength(2)
    db.close()
  })

  it('同时接受新拼写「固收+」作为旧 Excel 别名', () => {
    const db = seedV3Db(join(tempDir(), 'porti.db'))
    db.prepare("UPDATE funds SET category = '固收+' WHERE code = '000002'").run()

    migrateDatabase(db, 3)

    expect(fundModelRows(db).find((r) => r.code === '000002')).toEqual({
      code: '000002',
      ledger_category: '债',
      product_form: '固收+',
      equity_ratio: 0.2,
      equity_ratio_source: 'manual',
      equity_ratio_as_of: null
    })
    db.close()
  })

  it('无法识别的旧大类中止迁移：报出具体基金与值，不做静默兜底', () => {
    const dir = tempDir()
    const db = seedV3Db(join(dir, 'porti.db'))
    db.prepare("UPDATE funds SET category = '股票型' WHERE code = '000003'").run()

    expect(() => migrateDatabase(db, 3)).toThrow(/股票型/)
    expect(() => migrateDatabase(db, 3)).toThrow(/000003/)

    // 中止时结构未变更、未产生备份，旧数据原样保留
    expect(fundColumns(db)).not.toContain('ledger_category')
    expect(backupFiles(dir)).toHaveLength(0)
    expect(db.prepare("SELECT category FROM funds WHERE code = '000003'").get()).toEqual({
      category: '股票型'
    })
    db.close()
  })
})

/** v5 结构：显式冻结完整 DDL，不从当前 SCHEMA 反推——当前 schema 变更不应掩盖历史迁移问题。 */
const V5_SCHEMA_SQL = `
CREATE TABLE funds (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  fund_type TEXT,
  ledger_category TEXT NOT NULL,
  product_form TEXT NOT NULL,
  equity_ratio REAL NOT NULL,
  equity_ratio_source TEXT NOT NULL,
  equity_ratio_as_of TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE category_targets (
  category TEXT PRIMARY KEY,
  target_ratio REAL NOT NULL
);
CREATE TABLE bucket_targets (
  bucket TEXT PRIMARY KEY,
  target_ratio REAL NOT NULL
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('买入','卖出','分红现金','分红再投入')),
  fund_code TEXT NOT NULL REFERENCES funds(code),
  amount REAL NOT NULL,
  shares REAL,
  nav REAL,
  fee REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE nav_history (
  fund_code TEXT NOT NULL REFERENCES funds(code),
  date TEXT NOT NULL,
  nav REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('import','auto','manual')),
  PRIMARY KEY (fund_code, date)
);
CREATE TABLE ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`

function seedV5Db(
  path: string,
  options: { bucketTargets?: [string, number][]; legacyTargets?: [string, number][] } = {}
): Database.Database {
  const db = new Database(path)
  db.exec(V5_SCHEMA_SQL)
  db.pragma('user_version = 5')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES ('002068', 'v5 保留基金', '固守+', '二级债基', '债', '固收+', 0.2, 'manual', NULL, '2026-01-01')`
  ).run()
  db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES ('2026-01-02', '买入', '002068', 1000, 900, 1.1, 0, NULL, '2026-01-02', '2026-01-02')`
  ).run()
  for (const [category, ratio] of options.legacyTargets ?? []) {
    db.prepare('INSERT INTO category_targets (category, target_ratio) VALUES (?,?)').run(category, ratio)
  }
  for (const [bucket, ratio] of options.bucketTargets ?? []) {
    db.prepare('INSERT INTO bucket_targets (bucket, target_ratio) VALUES (?,?)').run(bucket, ratio)
  }
  return db
}

describe('migrateDatabase — v5 → v6 收缩旧五类模型', () => {
  it('旧目标折算并写入配置桶，删除旧目标表与旧分类列，保留基金与流水，迁移前备份', () => {
    const dir = tempDir()
    const db = seedV5Db(join(dir, 'porti.db'), {
      legacyTargets: [
        ['固守+', 0.25],
        ['纯债', 0.45],
        ['权益', 0.2],
        ['黄金', 0.05],
        ['流动性', 0.05]
      ]
    })

    migrateDatabase(db, 5)

    // 旧目标表与旧分类列消失，基金与流水原样保留
    expect(tableNames(db)).not.toContain('category_targets')
    expect(fundColumns(db)).not.toContain('category')
    expect(db.prepare('SELECT code, name, product_form FROM funds').get()).toEqual({
      code: '002068',
      name: 'v5 保留基金',
      product_form: '固收+'
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 1 })

    // 旧目标先剔除流动性再归一化，固收+ 按默认系数拆分；迁移写入归一化后的值
    const byBucket = bucketTargetRatios(db)
    expect(byBucket['稳健']).toBeCloseTo(65 / 95, 9)
    expect(byBucket['权益']).toBeCloseTo(25 / 95, 9)
    expect(byBucket['黄金']).toBeCloseTo(5 / 95, 9)

    // 清理前备份：备份仍保留旧结构与旧目标
    const backups = backupFiles(dir)
    expect(backups).toHaveLength(1)
    const backup = new Database(join(dir, backups[0]), { readonly: true })
    expect(fundColumns(backup)).toContain('category')
    expect(backup.prepare('SELECT COUNT(*) AS n FROM category_targets').get()).toEqual({ n: 5 })
    backup.close()
    db.close()
  })

  it('已保存的三桶目标优先于旧目标；旧目标表照常删除', () => {
    const db = seedV5Db(join(tempDir(), 'porti.db'), {
      bucketTargets: [
        ['稳健', 0.4],
        ['权益', 0.4],
        ['黄金', 0.2]
      ],
      legacyTargets: [['纯债', 1]]
    })

    migrateDatabase(db, 5)

    expect(bucketTargetRatios(db)).toEqual({ 稳健: 0.4, 权益: 0.4, 黄金: 0.2 })
    expect(tableNames(db)).not.toContain('category_targets')
    expect(fundColumns(db)).not.toContain('category')
    db.close()
  })

  it('旧目标为空或只有流动性：不伪造三桶目标，但仍删除旧表与旧列', () => {
    const db = seedV5Db(join(tempDir(), 'porti.db'), {
      legacyTargets: [['流动性', 0.2]]
    })

    migrateDatabase(db, 5)

    expect(db.prepare('SELECT COUNT(*) AS n FROM bucket_targets').get()).toEqual({ n: 0 })
    expect(tableNames(db)).not.toContain('category_targets')
    expect(fundColumns(db)).not.toContain('category')
    db.close()
  })

  it('重复执行幂等：旧结构已清理时不再备份、不改变数据', () => {
    const dir = tempDir()
    const db = seedV5Db(join(dir, 'porti.db'), {
      legacyTargets: [['纯债', 1]]
    })

    migrateDatabase(db, 5)
    const first = db.prepare('SELECT bucket, target_ratio FROM bucket_targets ORDER BY bucket').all()
    migrateDatabase(db, 5)

    expect(db.prepare('SELECT bucket, target_ratio FROM bucket_targets ORDER BY bucket').all()).toEqual(first)
    expect(backupFiles(dir)).toHaveLength(1)
    db.close()
  })
})

describe('migrateDatabase — v4 → 当前版本（配置桶目标表 + 旧模型收缩）', () => {
  it('创建配置桶表，旧目标折算落库后删除旧表与旧分类列，迁移前备份', () => {
    const dir = tempDir()
    const db = seedV4Db(join(dir, 'porti.db'))

    migrateDatabase(db, 4)

    expect(tableNames(db)).toContain('bucket_targets')
    // 旧目标 25/45/20/5/5 剔除流动性后归一化再拆桶
    const targets = bucketTargetRatios(db)
    expect(targets['稳健']).toBeCloseTo(65 / 95, 9)
    expect(targets['权益']).toBeCloseTo(25 / 95, 9)
    expect(targets['黄金']).toBeCloseTo(5 / 95, 9)
    // 旧目标表与旧分类列已删除，基金数据保留
    expect(tableNames(db)).not.toContain('category_targets')
    expect(fundColumns(db)).not.toContain('category')
    expect(db.prepare('SELECT code FROM funds').get()).toEqual({ code: '002067' })
    expect(backupFiles(dir)).toHaveLength(1)
    db.close()
  })

  it('重复迁移幂等：已迁移的库不报错、不重复建表、不再备份', () => {
    const dir = tempDir()
    const db = seedV4Db(join(dir, 'porti.db'))

    migrateDatabase(db, 4)
    const first = db.prepare('SELECT bucket, target_ratio FROM bucket_targets').all()
    expect(() => migrateDatabase(db, 4)).not.toThrow()
    expect(db.prepare('SELECT bucket, target_ratio FROM bucket_targets').all()).toEqual(first)
    expect(backupFiles(dir)).toHaveLength(1)
    db.close()
  })
})
