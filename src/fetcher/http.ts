// 默认 HTTP GET 实现（Node/Electron 全局 fetch + AbortController 超时）。
// 可选限制：响应最终域名（防重定向离开固定数据源）与响应体大小（响应按不可信数据处理）。

import type { HttpGet } from './types'

export interface HttpGetConfig {
  label: string // 错误文案前缀，如「净值接口」「基金公开数据接口」
  allowedHosts?: readonly string[] // 最终响应域名白名单；未设置时不检查
  maxResponseLength?: number // 响应体字符上限；未设置时不检查
}

export function createHttpGet(config: HttpGetConfig): HttpGet {
  return async (url, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Porti/0.1' }
      })
      if (!res.ok) throw new Error(`接口返回状态码 ${res.status}`)
      if (config.allowedHosts !== undefined) {
        const host = new URL(res.url).hostname
        if (!config.allowedHosts.includes(host)) {
          throw new Error(`接口重定向到非允许域名 ${host}，已终止请求`)
        }
      }
      const body = await res.text()
      if (config.maxResponseLength !== undefined && body.length > config.maxResponseLength) {
        throw new Error('接口响应过大，已终止处理')
      }
      return body
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (detail.toLowerCase().includes('abort')) throw new Error(`${config.label}请求超时，请稍后重试`)
      throw new Error(`${config.label}请求失败：${detail}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
