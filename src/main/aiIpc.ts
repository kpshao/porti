// AI 配置与快照 IPC（主进程侧）：读取/保存配置、测试连接、首次发送说明确认、快照预览。
// 对话的流式 IPC 由后续工单实现；本模块不发起除「测试连接」外的任何网络请求。
// 安全边界：明文 key 只在主进程解密；本模块返回给渲染进程的配置视图只有 hasKey 与掩码。

import { app, ipcMain, safeStorage } from 'electron'
import { normalizeAiBaseUrl, normalizeAiModel } from './aiConfig'
import {
  confirmFirstSendNotice,
  loadAiConfigView,
  readAiSecretConfig,
  saveAiConfig
} from './aiConfigStore'
import type { KeyCipher } from './aiConfigStore'
import { defaultAiHttpPost, testAiConnection } from './aiProvider'
import { buildAnalysisSnapshot, serializeSnapshot } from './analysisSnapshot'
import { todayString } from './date'
import { getDb } from './db'
import { hasAnyData, selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import type { AiConfigInput, AiConfigView, AiConnectionTestResult, SnapshotPreview } from './aiTypes'

/** Electron safeStorage 适配器（生产环境唯一持有明文 key 的地方） */
const electronCipher: KeyCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

function settingsDir(): string {
  return app.getPath('userData')
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败，请重试'
}

export function registerAiIpc(): void {
  // 读取 AI 配置（不含明文 key）
  ipcMain.handle('ai:config:get', (): AiConfigView => loadAiConfigView(settingsDir(), electronCipher))

  // 保存 AI 配置：key 留空表示不更改；safeStorage 不可用时拒绝保存 key（不降级明文）
  ipcMain.handle('ai:config:save', (_event, input: AiConfigInput): AiConfigView =>
    saveAiConfig(settingsDir(), input, electronCipher)
  )

  // 测试连接：校验表单地址/模型，key 优先用本次输入，否则用已保存的；结果按原因分类
  ipcMain.handle(
    'ai:config:test',
    async (_event, input: AiConfigInput): Promise<AiConnectionTestResult> => {
      let baseUrl: string
      let model: string
      try {
        baseUrl = normalizeAiBaseUrl(input.baseUrl)
        model = normalizeAiModel(input.model)
      } catch (e) {
        return { ok: false, message: errorMessage(e) }
      }
      const typedKey = input.apiKey === null ? '' : input.apiKey.trim()
      const apiKey =
        typedKey !== '' ? typedKey : (readAiSecretConfig(settingsDir(), electronCipher)?.apiKey ?? null)
      if (apiKey === null) return { ok: false, message: '请先填写 API key' }
      return testAiConnection({ baseUrl, model, apiKey }, defaultAiHttpPost)
    }
  )

  // 首次发送说明确认：之后不再弹窗
  ipcMain.handle('ai:first-send-confirm', (): void => {
    confirmFirstSendNotice(settingsDir())
  })

  // 生成分析快照预览（每次请求重建；只读、不落库、不联网）
  ipcMain.handle('ai:snapshot-preview', (): SnapshotPreview => {
    const db = getDb()
    const data = hasAnyData(db)
      ? {
          funds: selectFunds(db),
          transactions: selectTransactions(db),
          navPoints: selectNavPoints(db),
          categoryTargets: selectCategoryTargets(db)
        }
      : { funds: [], transactions: [], navPoints: [], categoryTargets: [] }
    return serializeSnapshot(buildAnalysisSnapshot({ ...data, today: todayString() }))
  })
}
