// AI 配置与密钥存储（主进程）。
// 注入 settingsDir 与加解密接缝（生产为 Electron safeStorage），便于用临时目录 + 假 cipher 单测。
// 安全边界：明文 key 只在主进程内存在；落盘只写密文，读配置只返回 hasKey 与掩码，
// safeStorage 不可用时拒绝保存 key（不降级明文）。

import { loadSettings, saveSettings } from './settingsStore'
import type { AiSettings } from './settingsStore'
import { maskApiKey, normalizeAiBaseUrl, normalizeAiModel } from './aiConfig'
import type { AiConfigInput, AiConfigView } from './aiTypes'

/** 与 Electron safeStorage 同形的加解密接缝（测试注入假实现） */
export interface KeyCipher {
  isAvailable(): boolean
  /** 明文 → 可落盘的密文（生产实现返回 base64） */
  encrypt(plain: string): string
  /** 密文 → 明文；密文损坏时抛错 */
  decrypt(encrypted: string): string
}

/** 主进程内部使用的明文 AI 配置（仅用于发起请求，绝不跨 IPC） */
export interface AiSecretConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 读取 AI 配置视图：解密失败或 safeStorage 不可用一律按「未配置 key」处理。 */
export function loadAiConfigView(settingsDir: string, cipher: KeyCipher): AiConfigView {
  const ai = loadSettings(settingsDir).ai
  const safeStorageAvailable = cipher.isAvailable()
  let hasKey = false
  let keyMask: string | null = null
  if (ai.encryptedKey !== null && safeStorageAvailable) {
    try {
      keyMask = maskApiKey(cipher.decrypt(ai.encryptedKey))
      hasKey = true
    } catch {
      // 解密失败（换机、系统凭据损坏）：按未配置处理，不阻塞设置页
    }
  }
  return {
    baseUrl: ai.baseUrl,
    model: ai.model,
    hasKey,
    keyMask,
    firstSendNoticeConfirmed: ai.firstSendNoticeConfirmed,
    safeStorageAvailable,
    configured: ai.baseUrl !== '' && ai.model !== '' && hasKey
  }
}

/** 保存 AI 配置。apiKey 为空表示保留已保存的 key；传入新 key 时要求 safeStorage 可用。 */
export function saveAiConfig(
  settingsDir: string,
  input: AiConfigInput,
  cipher: KeyCipher
): AiConfigView {
  const baseUrl = normalizeAiBaseUrl(input.baseUrl)
  const model = normalizeAiModel(input.model)
  const settings = loadSettings(settingsDir)
  const plainKey = input.apiKey === null ? '' : input.apiKey.trim()

  let encryptedKey = settings.ai.encryptedKey
  if (plainKey !== '') {
    if (!cipher.isAvailable()) {
      throw new Error('当前系统不支持安全存储（safeStorage），无法保存 API key')
    }
    encryptedKey = cipher.encrypt(plainKey)
  }

  const ai: AiSettings = { ...settings.ai, baseUrl, model, encryptedKey }
  saveSettings(settingsDir, { ...settings, ai })
  return loadAiConfigView(settingsDir, cipher)
}

/** 记录用户已确认首次发送说明（之后不再弹） */
export function confirmFirstSendNotice(settingsDir: string): void {
  const settings = loadSettings(settingsDir)
  saveSettings(settingsDir, {
    ...settings,
    ai: { ...settings.ai, firstSendNoticeConfirmed: true }
  })
}

/** 主进程内解析可用的明文配置；未配置、safeStorage 不可用或解密失败返回 null。 */
export function readAiSecretConfig(
  settingsDir: string,
  cipher: KeyCipher
): AiSecretConfig | null {
  const ai = loadSettings(settingsDir).ai
  if (ai.baseUrl === '' || ai.model === '' || ai.encryptedKey === null) return null
  if (!cipher.isAvailable()) return null
  try {
    return { baseUrl: ai.baseUrl, model: ai.model, apiKey: cipher.decrypt(ai.encryptedKey) }
  } catch {
    return null
  }
}
