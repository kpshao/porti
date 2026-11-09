// 应用设置持久化：数据文件（SQLite）位置覆盖 + 首启迁移引导跳过标记 + AI 分析配置。
// 独立于 electron 以便测试（settingsDir 由调用方传入，生产环境为 app.getPath('userData')）。
// AI 配置的读写规则（密钥加密、掩码）在 aiConfigStore，本模块只负责落盘与形状校验。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'settings.json'

/** AI 分析配置（key 只以 safeStorage 加密后的 base64 形态落盘） */
export interface AiSettings {
  /** OpenAI 兼容端点 base URL（填到 /v1 一级）；空串 = 未配置 */
  baseUrl: string
  /** 模型名；空串 = 未配置 */
  model: string
  /** safeStorage.encryptString 的结果（base64）；null = 未保存 key */
  encryptedKey: string | null
  /** 首次发送说明是否已确认（确认后不再弹） */
  firstSendNoticeConfirmed: boolean
}

export interface AppSettings {
  /** 数据文件绝对路径；null = 未设置，使用默认位置 */
  dbPath: string | null
  /** 首启「导入迁移包」引导是否已被用户跳过（true = 不再弹） */
  migrationPromptDismissed: boolean
  ai: AiSettings
}

const DEFAULT_AI: AiSettings = {
  baseUrl: '',
  model: '',
  encryptedKey: null,
  firstSendNoticeConfirmed: false
}

const DEFAULTS: AppSettings = { dbPath: null, migrationPromptDismissed: false, ai: DEFAULT_AI }

/** 按默认值深拷贝（ai 是嵌套对象，避免调用方改到共享的默认值） */
function defaults(): AppSettings {
  return { ...DEFAULTS, ai: { ...DEFAULT_AI } }
}

/** 解析 ai 字段：任一子字段形状不对即按该项默认值处理，不阻塞启动。 */
function parseAiSettings(raw: unknown): AiSettings {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : '',
    model: typeof obj.model === 'string' ? obj.model.trim() : '',
    encryptedKey:
      typeof obj.encryptedKey === 'string' && obj.encryptedKey !== '' ? obj.encryptedKey : null,
    firstSendNoticeConfirmed: obj.firstSendNoticeConfirmed === true
  }
}

/** 读取设置。文件缺失或损坏（含字段形状不对）一律按默认处理，不阻塞启动。 */
export function loadSettings(settingsDir: string): AppSettings {
  try {
    const file = join(settingsDir, SETTINGS_FILE)
    if (!existsSync(file)) return defaults()
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const dbPath =
      typeof obj.dbPath === 'string' && obj.dbPath.trim() !== '' ? (obj.dbPath as string) : null
    const migrationPromptDismissed = obj.migrationPromptDismissed === true
    return { dbPath, migrationPromptDismissed, ai: parseAiSettings(obj.ai) }
  } catch {
    return defaults()
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
