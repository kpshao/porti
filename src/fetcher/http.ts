// 默认 HTTP GET 实现（Node/Electron 全局 fetch + AbortController 超时）。
// 可选限制：响应域名白名单（手动跟随重定向，离开白名单前即终止）与响应体字节上限（流式读取，超限即取消）。

import type { HttpGet } from './types'

export interface HttpGetConfig {
  label: string // 错误文案前缀，如「净值接口」「基金公开数据接口」
  allowedHosts?: readonly string[] // 响应域名白名单；未设置时不检查（沿用自动跟随重定向）
  maxResponseBytes?: number // 响应体字节上限；未设置时不检查
}

const MAX_REDIRECTS = 5

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function assertAllowedUrl(value: string, allowedHosts: readonly string[]): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) {
    throw new Error(`接口指向非允许地址 ${url.host}，已终止请求`)
  }
}

/** 读取响应体；有字节上限时按流读取，超限立即取消，不把完整响应留在内存里 */
async function readBody(response: Response, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return response.text()

  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('接口响应过大，已终止处理')
  }
  if (response.body === null) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error('接口响应过大，已终止处理')
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error('接口响应过大，已终止处理')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function createHttpGet(config: HttpGetConfig): HttpGet {
  return async (url, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let currentUrl = url
      let response: Response | null = null
      const allowedHosts = config.allowedHosts
      const manualRedirect = allowedHosts !== undefined

      for (let redirects = 0; response === null || isRedirect(response.status); redirects += 1) {
        if (allowedHosts !== undefined) assertAllowedUrl(currentUrl, allowedHosts)
        response = await fetch(currentUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Porti/0.1' },
          redirect: manualRedirect ? 'manual' : 'follow'
        })
        if (!manualRedirect || !isRedirect(response.status)) break
        if (redirects >= MAX_REDIRECTS) throw new Error('接口重定向次数过多，已终止请求')
        const location = response.headers.get('location')
        if (location === null) throw new Error('接口重定向缺少 Location，已终止请求')
        currentUrl = new URL(location, currentUrl).toString()
      }

      if (!response.ok) throw new Error(`接口返回状态码 ${response.status}`)
      if (allowedHosts !== undefined) assertAllowedUrl(response.url, allowedHosts)
      return await readBody(response, config.maxResponseBytes)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (detail.toLowerCase().includes('abort')) throw new Error(`${config.label}请求超时，请稍后重试`)
      throw new Error(`${config.label}请求失败：${detail}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
