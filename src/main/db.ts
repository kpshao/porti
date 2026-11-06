import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { SCHEMA, SCHEMA_VERSION } from './schema'
import { migrateDatabase } from './schemaMigration'
import { loadSettings } from './settingsStore'
import { seedDefaultCategoryTargets } from './targetService'
import { replaceDbFile } from './migrationService'

let db: Database.Database

export function initDatabase(): void {
  const userData = app.getPath('userData')
  // 设置页更改的数据文件位置在重启后生效；未设置时用默认位置
  const override = loadSettings(userData).dbPath
  const file = override ?? join(userData, 'porti.db')
  if (override !== null) mkdirSync(dirname(override), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < SCHEMA_VERSION) {
    if (version > 0) {
      try {
        migrateDatabase(db, version)
      } catch (e) {
        // 迁移失败（如备份盘满）：保留旧 schema，下次启动重试。代码不读被删列，旧库照常可用。
        console.error('数据库迁移失败，本次保持旧版本：', e)
        return
      }
    }
    db.exec(SCHEMA)
    seedDefaultCategoryTargets(db) // 新库种子默认大类目标（Excel 导入会用导入值覆盖）
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
}

export function getDb(): Database.Database {
  return db
}

/** 导入迁移包热替换：关闭当前连接 → 替换数据文件 → 重新打开（失败抛错，调用方回退重启） */
export function swapDatabase(bundlePath: string): void {
  replaceDbFile(db, bundlePath)
  initDatabase()
}

export function dbInfo(): { path: string; tables: string[]; schemaVersion: number } {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name)
  return {
    path: db.name,
    tables,
    schemaVersion: db.pragma('user_version', { simple: true }) as number
  }
}
