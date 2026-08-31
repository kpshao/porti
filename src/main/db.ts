import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

let db: Database.Database

// 与 .scratch/porti-v1/spec.md 中定义的数据模型保持一致
const SCHEMA = `
CREATE TABLE IF NOT EXISTS funds (
  code TEXT PRIMARY KEY,          -- 6 位基金代码，字符串存储防前导零丢失
  name TEXT NOT NULL,             -- 基金简称
  category TEXT NOT NULL,         -- 资产大类：固守+/纯债/权益/黄金/流动性
  fund_type TEXT,                 -- 基金类型：一级债基/二级债基/偏债混合/ETF/黄金/短债等
  target_amount REAL,             -- 单只基金目标金额（元），可空
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category_targets (
  category TEXT PRIMARY KEY,      -- 固守+ / 纯债 / 权益 / 黄金 / 流动性
  target_ratio REAL NOT NULL      -- 目标比例，如 0.25
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,             -- YYYY-MM-DD
  type TEXT NOT NULL CHECK (type IN ('买入','卖出','分红现金','分红再投入')),
  fund_code TEXT NOT NULL REFERENCES funds(code),
  amount REAL NOT NULL,           -- 金额（元）；买入/分红现金为正，卖出为负
  shares REAL,                    -- 份额；买入/分红再投入为正，卖出为负，分红现金为空
  nav REAL,                       -- 成交净值
  fee REAL DEFAULT 0,             -- 手续费（元）
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nav_history (
  fund_code TEXT NOT NULL REFERENCES funds(code),
  date TEXT NOT NULL,             -- YYYY-MM-DD
  nav REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('import','auto','manual')),
  PRIMARY KEY (fund_code, date)
);
`

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
