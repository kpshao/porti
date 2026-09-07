// 应用设置持久化：数据文件（SQLite）位置覆盖 + 首启迁移引导跳过标记。
// 独立于 electron 以便测试（settingsDir 由调用方传入，生产环境为 app.getPath('userData')）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'settings.json'

export interface AppSettings {
  /** 数据文件绝对路径；null = 未设置，使用默认位置 */
  dbPath: string | null
  /** 首启「导入迁移包」引导是否已被用户跳过（true = 不再弹） */
  migrationPromptDismissed: boolean
}

const DEFAULTS: AppSettings = { dbPath: null, migrationPromptDismissed: false }

/** 读取设置。文件缺失或损坏（含字段形状不对）一律按默认处理，不阻塞启动。 */
export function loadSettings(settingsDir: string): AppSettings {
  try {
    const file = join(settingsDir, SETTINGS_FILE)
    if (!existsSync(file)) return { ...DEFAULTS }
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const dbPath =
      typeof obj.dbPath === 'string' && obj.dbPath.trim() !== '' ? (obj.dbPath as string) : null
    const migrationPromptDismissed = obj.migrationPromptDismissed === true
    return { dbPath, migrationPromptDismissed }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 全量写设置（目录不存在时创建） */
export function saveSettings(settingsDir: string, settings: AppSettings): void {
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
}

/** 保存数据文件位置（保留其余设置项） */
export function saveDbPath(settingsDir: string, dbPath: string): void {
  saveSettings(settingsDir, { ...loadSettings(settingsDir), dbPath })
}

/** 记录用户已跳过首启迁移引导（之后不再弹） */
export function saveMigrationPromptDismissed(settingsDir: string): void {
  saveSettings(settingsDir, { ...loadSettings(settingsDir), migrationPromptDismissed: true })
}
