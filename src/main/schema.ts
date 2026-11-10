// SQLite 数据模型。独立成模块以便测试用 :memory: 数据库复用同一 schema。

/** 当前 schema 版本（PRAGMA user_version）；版本间迁移见 schemaMigration.ts */
export const SCHEMA_VERSION = 3

/**
 * v3 新增：单线程 AI 对话消息表（纯新增，不改旧表）。
 * token 三列由供应商返回时写入，否则为 NULL；interrupted = 1 表示停止或出错时保留的部分回答。
 */
export const AI_MESSAGES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  prompt_tokens INTEGER,          -- 输入 token（供应商返回时）
  completion_tokens INTEGER,      -- 输出 token（供应商返回时）
  total_tokens INTEGER,           -- 总 token（供应商返回时）
  interrupted INTEGER NOT NULL DEFAULT 0, -- 1 = 已中断（保留部分内容）
  created_at TEXT NOT NULL
);
`

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS funds (
  code TEXT PRIMARY KEY,          -- 6 位基金代码，字符串存储防前导零丢失
  name TEXT NOT NULL,             -- 基金简称
  category TEXT NOT NULL,         -- 资产大类：固守+/纯债/权益/黄金/流动性
  fund_type TEXT,                 -- 基金类型：一级债基/二级债基/偏债混合/ETF/黄金/短债等
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
${AI_MESSAGES_TABLE_SQL}
`
