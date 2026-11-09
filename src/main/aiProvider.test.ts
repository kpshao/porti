import { describe, expect, it } from 'vitest'
import { AiProviderError, streamChatCompletion, testAiConnection } from './aiProvider'
import type { AiHttpPost, ProviderRequest, ProviderResponse } from './aiProvider'
import type { ChatMessage } from './aiProvider'

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: '我的持仓集中吗？' }
]

const BASE = {
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
  apiKey: 'sk-secret-1234567890',
  messages: MESSAGES
}

const DONE = 'data: [DONE]\n\n'

const SECRET_KEY = BASE.apiKey

function streamOf(...chunks: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function response(status: number, ...chunks: string[]): ProviderResponse {
  return { status, body: streamOf(...chunks) }
}

/** 记录请求并返回固定响应的 HTTP 接缝 */
function fakeHttp(
  result: ProviderResponse,
  captured: ProviderRequest[]
): AiHttpPost {
  return async (request) => {
    captured.push(request)
    return result
  }
}

/** 永不返回、只在 signal 中止时 reject 的接缝（模拟挂起的网络请求） */
const hangingHttp: AiHttpPost = (request) =>
  new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })

async function collectError(promise: Promise<unknown>): Promise<AiProviderError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(AiProviderError)
    return e as AiProviderError
  }
  throw new Error('预期请求失败，但成功返回')
}

describe('aiProvider — 流式拼接与 usage', () => {
  it('跨 chunk 拼接 SSE 增量，[DONE] 结束；无 usage 时为 null', async () => {
    const captured: ProviderRequest[] = []
    const deltas: string[] = []
    const result = await streamChatCompletion(
      BASE,
      fakeHttp(
        response(
          200,
          'data: {"choices":[{"delta":{"content":"你"}}]}\n',
          '\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'
        ),
        captured
      ),
      (d) => deltas.push(d)
    )

    expect(deltas).toEqual(['你', '好'])
    expect(result).toEqual({ content: '你好', usage: null })
  })

  it('解析供应商返回的 usage（可能出现在空 choices 的末块）', async () => {
    const result = await streamChatCompletion(
      BASE,
      fakeHttp(
        response(
          200,
          'data: {"choices":[{"delta":{"content":"答"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128}}\n\n',
          DONE
        ),
        []
      ),
      () => {}
    )
    expect(result).toEqual({
      content: '答',
      usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 }
    })
  })

  it('请求体固定 stream/temperature/max_tokens，key 只出现在 Authorization 头', async () => {
    const captured: ProviderRequest[] = []
    await streamChatCompletion(BASE, fakeHttp(response(200, DONE), captured), () => {})

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.url).toBe('https://api.example.com/v1/chat/completions')
    expect(req.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`)
    expect(req.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'example-model',
      messages: MESSAGES,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
      // 请求流末尾附带 usage（供应商可忽略）
      stream_options: { include_usage: true }
    })
    expect(req.body).not.toContain(SECRET_KEY)
  })

  it('非法 base URL 在发起请求前拒绝', async () => {
    const captured: ProviderRequest[] = []
    await expect(
      streamChatCompletion(
        { ...BASE, baseUrl: 'http://api.example.com/v1' },
        fakeHttp(response(200, DONE), captured),
        () => {}
      )
    ).rejects.toThrow(/https/)
    expect(captured).toHaveLength(0)
  })
})

describe('aiProvider — 错误分类', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not-found'],
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server']
  ] as const)('HTTP %i 归类为 %s，提示为中文且不含 key', async (status, kind) => {
    const error = await collectError(
      streamChatCompletion(BASE, fakeHttp(response(status), []), () => {})
    )
    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(error.message).not.toContain(SECRET_KEY)
    expect(error.message).toMatch(/[（(]HTTP /)
  })

  it('超时按超时分类', async () => {
    const error = await collectError(
      streamChatCompletion({ ...BASE, timeoutMs: 10 }, hangingHttp, () => {})
    )
    expect(error.kind).toBe('timeout')
    expect(error.message).toContain('超时')
  })

  it('外部 abort 按「已停止生成」分类，不与超时混淆', async () => {
    const controller = new AbortController()
    const promise = streamChatCompletion(
      { ...BASE, signal: controller.signal },
      hangingHttp,
      () => {}
    )
    setTimeout(() => controller.abort(), 5)
    const error = await collectError(promise)
    expect(error.kind).toBe('aborted')
    expect(error.message).toBe('已停止生成')
  })

  it('网络错误归类为 network，提示固定且不含 key', async () => {
    const error = await collectError(
      streamChatCompletion(
        BASE,
        async () => {
          throw new Error(`connect ECONNREFUSED ${SECRET_KEY}`)
        },
        () => {}
      )
    )
    expect(error.kind).toBe('network')
    expect(error.message).toBe('无法连接 AI 端点，请检查网络或 API 地址')
  })

  it('无法解析的数据块按 protocol 分类', async () => {
    const error = await collectError(
      streamChatCompletion(BASE, fakeHttp(response(200, 'data: {坏 JSON}\n\n', DONE), []), () => {})
    )
    expect(error.kind).toBe('protocol')
  })
})

describe('aiProvider — 测试连接', () => {
  it('发送非流式、max_tokens=1 的最小请求；成功返回连接成功', async () => {
    const captured: ProviderRequest[] = []
    const result = await testAiConnection(
      { baseUrl: BASE.baseUrl, model: BASE.model, apiKey: BASE.apiKey },
      fakeHttp(response(200, '{}'), captured)
    )

    expect(result).toEqual({ ok: true, message: '连接成功' })
    expect(captured).toHaveLength(1)
    const body = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(body).toMatchObject({ model: BASE.model, max_tokens: 1, stream: false })
    expect(captured[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(captured[0].body).not.toContain(SECRET_KEY)
  })

  it('401 转为中文原因；错误信息不含 key', async () => {
    const result = await testAiConnection(
      { baseUrl: BASE.baseUrl, model: BASE.model, apiKey: BASE.apiKey },
      fakeHttp(response(401), [])
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API key')
    expect(result.message).not.toContain(SECRET_KEY)
  })

  it('429、网络错误、超时与非法地址都转为失败原因', async () => {
    const limited = await testAiConnection(
      { baseUrl: BASE.baseUrl, model: BASE.model, apiKey: BASE.apiKey },
      fakeHttp(response(429), [])
    )
    expect(limited.ok).toBe(false)
    expect(limited.message).toContain('频繁')

    const offline = await testAiConnection(
      { baseUrl: BASE.baseUrl, model: BASE.model, apiKey: BASE.apiKey },
      async () => {
        throw new Error('offline')
      }
    )
    expect(offline.ok).toBe(false)
    expect(offline.message).toContain('无法连接')

    const timedOut = await testAiConnection(
      { baseUrl: BASE.baseUrl, model: BASE.model, apiKey: BASE.apiKey },
      hangingHttp,
      10
    )
    expect(timedOut.ok).toBe(false)
    expect(timedOut.message).toContain('超时')

    const invalid = await testAiConnection(
      { baseUrl: 'http://example.com/v1', model: BASE.model, apiKey: BASE.apiKey },
      fakeHttp(response(200, '{}'), [])
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.message).toContain('https')
  })
})
