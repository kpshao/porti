// OpenAI 兼容 chat completions 客户端（流式）+ 测试连接。
// HTTP 走注入接缝（生产为全局 fetch），单测用假流测试 SSE 拼接、usage、错误分类与 abort/超时。
// 安全边界：key 只进 Authorization 头；错误信息固定为中文分类文案，不回显响应体，避免带出 key。

import { buildChatCompletionsUrl } from './aiConfig'
import type { AiConnectionTestResult } from './aiTypes'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 供应商返回的 token 用量（字段缺失时整块为 null） */
export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 注入式 HTTP 请求（与 fetcher 的 HttpGet 同型：网络细节由调用方注入） */
export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

/** 注入式 HTTP 响应：status 用于错误分类，body 为 SSE 原文文本流 */
export interface ProviderResponse {
  status: number
  body: AsyncIterable<string>
}

export type AiHttpPost = (request: ProviderRequest) => Promise<ProviderResponse>

/** 流式请求的默认超时（从发起到流结束的总上限） */
export const DEFAULT_STREAM_TIMEOUT_MS = 120000

/** 测试连接超时（spec：15 秒） */
export const TEST_TIMEOUT_MS = 15000

export type AiProviderErrorKind =
  | 'auth'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'protocol'

/** 分类后的 AI 请求错误；message 即界面可直接展示的中文原因（不含 key） */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind
  readonly status: number | null

  constructor(kind: AiProviderErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'AiProviderError'
    this.kind = kind
    this.status = status
  }
}

/** HTTP 状态码 → 分类错误（401/403、404、429、5xx 分别提示该改哪一项） */
function httpError(status: number): AiProviderError {
  if (status === 401 || status === 403) {
    return new AiProviderError('auth', `API key 无效或无权限（HTTP ${status}）`, status)
  }
  if (status === 404) {
    return new AiProviderError('not-found', `接口地址或模型不存在（HTTP ${status}）`, status)
  }
  if (status === 429) {
    return new AiProviderError('rate-limit', `请求过于频繁或额度不足（HTTP ${status}）`, status)
  }
  if (status >= 500) {
    return new AiProviderError('server', `AI 服务暂时不可用（HTTP ${status}）`, status)
  }
  return new AiProviderError('http', `AI 接口返回异常状态（HTTP ${status}）`, status)
}

/** 解析 SSE 的 data 行：支持 CRLF、跨 chunk 拼接与多行 data；忽略注释与其他字段。 */
async function* parseSseData(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  let dataLines: string[] = []
  const pushLine = (rawLine: string): string | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (dataLines.length === 0) return null
      const data = dataLines.join('\n')
      dataLines = []
      return data
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    return null
  }

  for await (const chunk of chunks) {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const data = pushLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (data !== null) yield data
      newline = buffer.indexOf('\n')
    }
  }
  // 流结束时最后一行可能没有换行符
  const tail = pushLine(buffer)
  if (tail !== null) yield tail
  if (dataLines.length > 0) yield dataLines.join('\n')
}

/** 供应商 usage 字段解析（snake_case；缺失或形状不对返回 null） */
function parseUsage(raw: unknown): ChatUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.prompt_tokens !== 'number' ||
    typeof obj.completion_tokens !== 'number' ||
    typeof obj.total_tokens !== 'number'
  ) {
    return null
  }
  return {
    promptTokens: obj.prompt_tokens,
    completionTokens: obj.completion_tokens,
    totalTokens: obj.total_tokens
  }
}

/**
 * 在超时与外部 abort 下执行一次请求。超时由内部 controller 触发，外部 abort 原样传达；
 * 两者在 catch 中区分开，其余异常统一归为网络错误（固定文案，不透传原始错误）。
 */
async function withRequestAbort<T>(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    return await task(controller.signal)
  } catch (e) {
    if (e instanceof AiProviderError) throw e
    if (timedOut) {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000))
      throw new AiProviderError('timeout', `AI 服务响应超时（${seconds} 秒）`)
    }
    if (externalSignal?.aborted === true) {
      throw new AiProviderError('aborted', '已停止生成')
    }
    throw new AiProviderError('network', '无法连接 AI 服务，请检查网络或 API 地址')
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${apiKey}`
  }
}

export interface StreamChatRequest {
  baseUrl: string
  model: string
  apiKey: string
  messages: ChatMessage[]
  /** 外部停止信号（用户在界面上点「停止」） */
  signal?: AbortSignal
  timeoutMs?: number
}

export interface StreamChatResult {
  content: string
  usage: ChatUsage | null
}

/**
 * 发起一次流式 chat completions 请求。增量经 onDelta 推送，返回完整内容与 usage。
 * `POST {baseUrl}/chat/completions`，固定 temperature 0.3、max_tokens 4096（spec）。
 */
export async function streamChatCompletion(
  request: StreamChatRequest,
  httpPost: AiHttpPost,
  onDelta: (text: string) => void
): Promise<StreamChatResult> {
  const url = buildChatCompletionsUrl(request.baseUrl)
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: 0.3,
    max_tokens: 4096,
    stream: true
  })

  return withRequestAbort(
    request.signal,
    request.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
    async (signal) => {
      const response = await httpPost({
        url,
        headers: requestHeaders(request.apiKey),
        body,
        signal
      })
      if (response.status < 200 || response.status >= 300) throw httpError(response.status)

      let content = ''
      let usage: ChatUsage | null = null
      for await (const data of parseSseData(response.body)) {
        if (data === '[DONE]') break
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          throw new AiProviderError('protocol', 'AI 返回的数据格式无法解析')
        }
        if (parsed === null || typeof parsed !== 'object') continue
        const obj = parsed as Record<string, unknown>
        const parsedUsage = parseUsage(obj.usage)
        if (parsedUsage !== null) usage = parsedUsage
        const choices = obj.choices
        if (!Array.isArray(choices) || choices.length === 0) continue
        const choice = choices[0] as Record<string, unknown>
        const delta = choice.delta
        if (delta === null || typeof delta !== 'object') continue
        const contentDelta = (delta as Record<string, unknown>).content
        if (typeof contentDelta === 'string' && contentDelta !== '') {
          content += contentDelta
          onDelta(contentDelta)
        }
      }
      return { content, usage }
    }
  )
}

export interface TestConnectionRequest {
  baseUrl: string
  model: string
  apiKey: string
}

/**
 * 测试连接：一次非流式、max_tokens=1 的最小请求；失败原因按 HTTP 状态/网络/超时分类。
 * 永不抛出，结果直接作为设置页的提示文案。
 */
export async function testAiConnection(
  request: TestConnectionRequest,
  httpPost: AiHttpPost,
  timeoutMs: number = TEST_TIMEOUT_MS
): Promise<AiConnectionTestResult> {
  try {
    const url = buildChatCompletionsUrl(request.baseUrl)
    const body = JSON.stringify({
      model: request.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
    await withRequestAbort(undefined, timeoutMs, async (signal) => {
      const response = await httpPost({
        url,
        headers: requestHeaders(request.apiKey),
        body,
        signal
      })
      if (response.status < 200 || response.status >= 300) throw httpError(response.status)
    })
    return { ok: true, message: '连接成功' }
  } catch (e) {
    if (e instanceof Error && e.message !== '') return { ok: false, message: e.message }
    return { ok: false, message: '测试连接失败，请检查配置' }
  }
}

/** 默认 HTTP 实现（Electron/Node 全局 fetch）：非 2xx 不读取响应体，避免把供应商报错文本带进界面。 */
export const defaultAiHttpPost: AiHttpPost = async ({ url, headers, body, signal }) => {
  const res = await fetch(url, { method: 'POST', headers, body, signal })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    return { status: res.status, body: emptyBody() }
  }
  return { status: res.status, body: res.body === null ? emptyBody() : readBodyStream(res.body) }
}

function emptyBody(): AsyncIterable<string> {
  return (async function* () {})()
}

async function* readBodyStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text !== '') yield text
    }
    const tail = decoder.decode()
    if (tail !== '') yield tail
  } finally {
    // 提前结束（[DONE] 或 abort）时主动关闭连接
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
