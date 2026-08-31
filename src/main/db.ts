import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA } from './schema'

let db: Database.Database

export function initDatabase(): void {
  const file = join(app.getPath('userData'), 'porti.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    db.exec(SCHEMA)
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
