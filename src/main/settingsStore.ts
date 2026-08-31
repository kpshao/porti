// 应用设置持久化：数据文件（SQLite）位置覆盖。
// 独立于 electron 以便测试（settingsDir 由调用方传入，生产环境为 app.getPath('userData')）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'settings.json'

export interface AppSettings {
  /** 数据文件绝对路径；null = 未设置，使用默认位置 */
  dbPath: string | null
}

/** 读取设置。文件缺失或损坏（含字段形状不对）一律按未设置处理，不阻塞启动。 */
export function loadSettings(settingsDir: string): AppSettings {
  try {
    const file = join(settingsDir, SETTINGS_FILE)
    if (!existsSync(file)) return { dbPath: null }
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const dbPath =
      raw !== null && typeof raw === 'object' && typeof (raw as { dbPath?: unknown }).dbPath === 'string'
        ? (raw as { dbPath: string }).dbPath
        : ''
    return { dbPath: dbPath.trim() === '' ? null : dbPath }
  } catch {
    return { dbPath: null }
  }
}

/** 保存数据文件位置（目录不存在时创建） */
export function saveDbPath(settingsDir: string, dbPath: string): void {
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, SETTINGS_FILE), JSON.stringify({ dbPath }, null, 2), 'utf8')
}
