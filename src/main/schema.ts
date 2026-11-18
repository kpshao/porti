// SQLite 数据模型。独立成模块以便测试用 :memory: 数据库复用同一 schema。

import {
  EQUITY_RATIO_SOURCES,
  LEDGER_CATEGORIES,
  PRODUCT_FORMS
} from '../engine/classification'
import { ALLOCATION_BUCKETS } from '../engine/types'

/** 当前 schema 版本（PRAGMA user_version）；版本间迁移见 schemaMigration.ts */
export const SCHEMA_VERSION = 5

/** SQL IN 列表；字段值域唯一来源是 engine（classification.ts 与 types.ts） */
const sqlIn = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(',')

/** 新模型字段的 CHECK 条件（新库建表与旧库 ALTER 共用，避免两处值域分叉） */
export const FUND_MODEL_CHECKS = {
  ledgerCategory: `ledger_category IN (${sqlIn(LEDGER_CATEGORIES)})`,
  productForm: `product_form IN (${sqlIn(PRODUCT_FORMS)})`,
  equityRatio: 'equity_ratio >= 0 AND equity_ratio <= 1',
  equityRatioSource: `equity_ratio_source IN (${sqlIn(EQUITY_RATIO_SOURCES)})`
} as const

/** v5 新增：配置桶目标表（稳健 / 权益 / 黄金）；初始化语义见 targetService.loadBucketTargets */
export const BUCKET_TARGETS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS bucket_targets (
  bucket TEXT PRIMARY KEY CHECK (bucket IN (${sqlIn(ALLOCATION_BUCKETS)})),
  target_ratio REAL NOT NULL CHECK (target_ratio >= 0 AND target_ratio <= 1)
);
`

/**
 * v3 新增：单线程 AI 对话消息表。
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
  category TEXT NOT NULL,         -- 旧五类兼容值：固守+/纯债/权益/黄金/流动性（过渡字段，见 classification.ts）
  fund_type TEXT,                 -- 基金类型：一级债基/二级债基/偏债混合/ETF/黄金/短债等
  ledger_category TEXT NOT NULL CHECK (${FUND_MODEL_CHECKS.ledgerCategory}), -- 账本大类
  product_form TEXT NOT NULL CHECK (${FUND_MODEL_CHECKS.productForm}), -- 产品形态
  equity_ratio REAL NOT NULL CHECK (${FUND_MODEL_CHECKS.equityRatio}), -- 权益系数 0–1
  equity_ratio_source TEXT NOT NULL CHECK (${FUND_MODEL_CHECKS.equityRatioSource}), -- 系数来源
  equity_ratio_as_of TEXT,        -- 系数数据日期（报告期或空）
  created_at TEXT NOT NULL
);

-- 旧五类目标表（过渡字段，见 classification.ts）
CREATE TABLE IF NOT EXISTS category_targets (
  category TEXT PRIMARY KEY,      -- 固守+ / 纯债 / 权益 / 黄金 / 流动性
  target_ratio REAL NOT NULL      -- 目标比例，如 0.25
);

${BUCKET_TARGETS_TABLE_SQL}

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
