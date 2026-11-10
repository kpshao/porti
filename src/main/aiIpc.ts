// AI 配置、快照与对话 IPC（主进程侧）：读取/保存配置、测试连接、首次发送说明确认、快照预览、
// 对话的开始/停止/重试/读取/清空与流式事件、回答内链接外开。
// 除「测试连接」与用户显式发送的对话请求外，本模块不发起任何网络请求。
// 密钥与联网边界见 ADR-0003；配置视图的构造在 aiConfigStore，对话状态机在 aiChatService。

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { normalizeAiBaseUrl, normalizeAiModel } from './aiConfig'
import { isSafeHttpUrl } from '../shared/url'
import {
  confirmFirstSendNotice,
  loadAiConfigView,
  readAiSecretConfig,
  saveAiConfig
} from './aiConfigStore'
import type { KeyCipher } from './aiConfigStore'
import { createAiChatService } from './aiChatService'
import { defaultAiHttpPost, streamChatCompletion, testAiConnection } from './aiProvider'
import { buildAnalysisSnapshot, serializeSnapshot } from './analysisSnapshot'
import { todayString } from './date'
import { getDb } from './db'
import { hasAnyData, selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import type {
  AiChatEvent,
  AiChatMessage,
  AiChatStatus,
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult,
  OpenExternalResult,
  SnapshotPreview
} from './aiTypes'

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

/** 当前数据的分析快照预览（发送前预览与对话请求共用；每次调用重建，不落库） */
function currentSnapshotPreview(): SnapshotPreview {
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
}

/** 流式事件广播到所有窗口（单窗口应用；销毁中的窗口跳过） */
function broadcastChatEvent(event: AiChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:chat:event', event)
  }
}

export function registerAiIpc(): void {
  const chatService = createAiChatService({
    getDb,
    readConfig: () => readAiSecretConfig(settingsDir(), electronCipher),
    buildSnapshotJson: () => currentSnapshotPreview().json,
    streamer: (request, onDelta) =>
      streamChatCompletion(request, defaultAiHttpPost, onDelta),
    emit: broadcastChatEvent
  })

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
  ipcMain.handle('ai:snapshot-preview', (): SnapshotPreview => currentSnapshotPreview())

  // ---- 对话：主进程持有状态并直接读写数据库，渲染进程只收发文本与增量 ----
  ipcMain.handle('ai:chat:history', (): AiChatMessage[] => chatService.history())
  ipcMain.handle('ai:chat:status', (): AiChatStatus => chatService.status())
  ipcMain.handle('ai:chat:send', (_event, content: string): AiChatMessage => chatService.send(content))
  ipcMain.handle('ai:chat:retry', (): AiChatMessage => chatService.retry())
  ipcMain.handle('ai:chat:stop', (): void => chatService.stop())
  ipcMain.handle('ai:chat:clear', (): void => chatService.clear())

  // 回答中的链接：主进程二次校验协议后交给系统浏览器，不在应用内导航
  ipcMain.handle('ai:open-external', async (_event, url: string): Promise<OpenExternalResult> => {
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) {
      return { ok: false, message: '仅支持打开 http/https 链接' }
    }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch {
      return { ok: false, message: '无法打开链接，请检查系统默认浏览器设置' }
    }
  })
}
