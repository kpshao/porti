import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { SCHEMA } from './schema'
import { loadSettings } from './settingsStore'
import { seedDefaultCategoryTargets } from './targetService'

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
  if (version < 1) {
    db.exec(SCHEMA)
    seedDefaultCategoryTargets(db) // 新库种子默认大类目标（Excel 导入会用导入值覆盖）
    db.pragma('user_version = 1')
  }
}

export function getDb(): Database.Database {
  return db
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
