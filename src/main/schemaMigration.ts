// 数据库 schema 逐版本迁移（不依赖 Electron，便于用临时文件库单测）。
// 版本号由调用方 db.ts 在迁移成功后写入；本模块只负责结构变更，失败时抛错由调用方保留旧版本。

import { existsSync } from 'fs'
import type Database from 'better-sqlite3'
import { AI_MESSAGES_TABLE_SQL } from './schema'

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
}
