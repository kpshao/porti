// 数据库 schema 逐版本迁移（不依赖 Electron，便于用临时文件库单测）。
// 版本号由调用方 db.ts 在迁移成功后写入；本模块只负责结构变更，失败时抛错由调用方保留旧版本。

import { existsSync } from 'fs'
import type Database from 'better-sqlite3'
import {
  DEFAULT_EQUITY_RATIO,
  LEDGER_CATEGORY_BY_PRODUCT_FORM
} from '../engine/classification'
import type { ProductForm } from '../engine/classification'
import type { AllocationBucket, BucketTarget } from '../engine/types'
import { ALLOCATION_BUCKETS } from '../engine/types'
import { AI_MESSAGES_TABLE_SQL, BUCKET_TARGETS_TABLE_SQL, FUND_MODEL_CHECKS } from './schema'

/**
 * 历史迁移专用的旧类别→产品形态映射（冻结副本）。
 * 运行时兼容层已删除；这里的映射只服务历史迁移（v3 → v4 回填、v5 → v6 旧目标折算），绝不参与新写入。
 */
const LEGACY_LABEL_TO_PRODUCT_FORM: Record<string, ProductForm> = {
  '固守+': '固收+',
  '固收+': '固收+',
  纯债: '纯债',
  权益: '权益',
  黄金: '黄金',
  流动性: '纯债'
}

/** 迁移前的一次性副本：VACUUM INTO 生成一致性快照（含未落盘 WAL 内容） */
function backupBeforeMigration(database: Database.Database): void {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const base = `${database.name}.bak-${stamp}`
  let target = base
  for (let n = 2; existsSync(target); n++) target = `${base}-${n}`
  // VACUUM INTO 的路径是 SQL 字符串字面量，需转义单引号
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

/** v4 新增的基金模型字段；以此判定迁移是否已执行（测试的 v3 夹具按此列表还原旧结构） */
export const V4_FUND_COLUMNS = [
  'ledger_category',
  'product_form',
  'equity_ratio',
  'equity_ratio_source',
  'equity_ratio_as_of'
]

/**
 * v3 → v4：为基金增加账本大类、产品形态、权益系数、来源与数据日期，并按旧五类回填。
 * 旧 category 值原样保留；遇到无法识别的旧大类时中止迁移并列出具体基金与值，不做静默兜底。
 * 注：ADD COLUMN 无法带 NOT NULL（无默认值时 SQLite 不允许），故迁移库的新列可空、
 * 由回填保证无 NULL；新库建表仍带 NOT NULL（见 schema.ts）。
 */
function migrateFundsToV4(database: Database.Database): void {
  const columns = (database.prepare('PRAGMA table_info(funds)').all() as { name: string }[]).map(
    (c) => c.name
  )
  const present = V4_FUND_COLUMNS.filter((c) => columns.includes(c))
  if (present.length === V4_FUND_COLUMNS.length) return // 幂等：已迁移
  if (present.length > 0) {
    throw new Error(`基金表的新模型字段不完整（已有：${present.join('、')}），迁移已中止`)
  }

  // 预检：未知旧大类必须中止，避免把脏值静默映射成错误的分类
  const legacyLabels = Object.keys(LEGACY_LABEL_TO_PRODUCT_FORM)
  const placeholders = legacyLabels.map(() => '?').join(',')
  const unknown = database
    .prepare(
      `SELECT code, category FROM funds WHERE category NOT IN (${placeholders}) ORDER BY code`
    )
    .all(...legacyLabels) as { code: string; category: string }[]
  if (unknown.length > 0) {
    const list = unknown.map((r) => `「${r.category}」（基金 ${r.code}）`).join('、')
    throw new Error(`无法识别的旧大类：${list}；迁移已中止，请先修正这些基金的大类`)
  }

  backupBeforeMigration(database)
  database.transaction(() => {
    database.exec(
      `ALTER TABLE funds ADD COLUMN ledger_category TEXT CHECK (${FUND_MODEL_CHECKS.ledgerCategory})`
    )
    database.exec(
      `ALTER TABLE funds ADD COLUMN product_form TEXT CHECK (${FUND_MODEL_CHECKS.productForm})`
    )
    database.exec(
      `ALTER TABLE funds ADD COLUMN equity_ratio REAL CHECK (${FUND_MODEL_CHECKS.equityRatio})`
    )
    database.exec(
      `ALTER TABLE funds ADD COLUMN equity_ratio_source TEXT CHECK (${FUND_MODEL_CHECKS.equityRatioSource})`
    )
    database.exec('ALTER TABLE funds ADD COLUMN equity_ratio_as_of TEXT')
    const update = database.prepare(
      `UPDATE funds
       SET ledger_category = ?, product_form = ?, equity_ratio = ?, equity_ratio_source = 'manual', equity_ratio_as_of = NULL
       WHERE category = ?`
    )
    for (const [legacy, productForm] of Object.entries(LEGACY_LABEL_TO_PRODUCT_FORM)) {
      update.run(
        LEDGER_CATEGORY_BY_PRODUCT_FORM[productForm],
        productForm,
        DEFAULT_EQUITY_RATIO[productForm],
        legacy
      )
    }
  })()
}

/** 旧五类目标 → 三桶目标：剔除流动性，其余归一化，固收+ 按默认权益系数拆进稳健/权益。 */
function convertLegacyTargets(
  rows: { category: string; target_ratio: number }[]
): BucketTarget[] | null {
  const retained = new Map<ProductForm, number>()
  for (const row of rows) {
    if (row.category === '流动性') continue
    const productForm = LEGACY_LABEL_TO_PRODUCT_FORM[row.category]
    if (productForm === undefined) continue
    retained.set(productForm, (retained.get(productForm) ?? 0) + row.target_ratio)
  }
  const total = [...retained.values()].reduce((sum, ratio) => sum + ratio, 0)
  if (total <= 0) return null
  const norm = (form: ProductForm): number => (retained.get(form) ?? 0) / total
  const debtEquityRatio = DEFAULT_EQUITY_RATIO['固收+']
  const ratios: Record<AllocationBucket, number> = {
    稳健: norm('固收+') * (1 - debtEquityRatio) + norm('纯债'),
    权益: norm('固收+') * debtEquityRatio + norm('权益'),
    黄金: norm('黄金')
  }
  return ALLOCATION_BUCKETS.map((bucket) => ({ bucket, targetRatio: ratios[bucket] }))
}

function tableExists(database: Database.Database, name: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  )
}

/**
 * v5 → v6：收缩旧五类模型。旧目标先折算并写入配置桶（仅当用户尚未保存三桶目标），
 * 再删除旧目标表与 funds.category；迁移前备份。旧结构已清理时直接返回（幂等）。
 */
function shrinkLegacyModel(database: Database.Database): void {
  const columns = (database.prepare('PRAGMA table_info(funds)').all() as { name: string }[]).map(
    (c) => c.name
  )
  const hasCategory = columns.includes('category')
  const hasLegacyTargets = tableExists(database, 'category_targets')
  if (!hasCategory && !hasLegacyTargets) return

  backupBeforeMigration(database)
  database.transaction(() => {
    database.exec(BUCKET_TARGETS_TABLE_SQL)
    if (hasLegacyTargets) {
      const saved = database.prepare('SELECT COUNT(*) AS n FROM bucket_targets').get() as { n: number }
      if (saved.n === 0) {
        const legacyRows = database
          .prepare('SELECT category, target_ratio FROM category_targets')
          .all() as { category: string; target_ratio: number }[]
        const converted = convertLegacyTargets(legacyRows)
        if (converted !== null) {
          const insert = database.prepare(
            'INSERT INTO bucket_targets (bucket, target_ratio) VALUES (?,?)'
          )
          for (const target of converted) insert.run(target.bucket, target.targetRatio)
        }
      }
      database.exec('DROP TABLE category_targets')
    }
    if (hasCategory) database.exec('ALTER TABLE funds DROP COLUMN category')
  })()
}

/** 从 from 版本逐级迁移到当前结构；失败抛错（调用方不升版本，下次启动重试） */
export function migrateDatabase(database: Database.Database, from: number): void {
  if (from < 2) {
    // 1 → 2：删除「单只基金目标金额」——配置目标只在大类层，见 ADR-0002
    const columns = database.prepare('PRAGMA table_info(funds)').all() as { name: string }[]
    if (columns.some((c) => c.name === 'target_amount')) {
      backupBeforeMigration(database)
      database.exec('ALTER TABLE funds DROP COLUMN target_amount')
    }
  }
  if (from < 3) {
    // 2 → 3：新增单线程 AI 对话表，纯新增、不改旧表，无需备份
    database.exec(AI_MESSAGES_TABLE_SQL)
  }
  if (from < 4) {
    // 3 → 4：基金新模型字段（账本大类/产品形态/权益系数），迁移前备份
    migrateFundsToV4(database)
  }
  if (from < 5) {
    // 4 → 5：新增配置桶目标表（纯新增，不备份，不写目标）
    database.exec(BUCKET_TARGETS_TABLE_SQL)
  }
  if (from < 6) {
    // 5 → 6：收缩旧五类模型——旧目标折算进配置桶，删除旧目标表与 funds.category
    shrinkLegacyModel(database)
  }
}
