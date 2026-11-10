import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AiProviderError } from './aiProvider'
import { createAiChatService } from './aiChatService'
import type { AiChatServiceDeps, ChatStreamer } from './aiChatService'
import { SCHEMA } from './schema'
import type { AiChatEvent } from './aiTypes'

const CONFIG = {
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
  apiKey: 'sk-test-secret-123456'
}

const USAGE = { promptTokens: 120, completionTokens: 8, totalTokens: 128 }

interface Harness {
  db: Database.Database
  service: ReturnType<typeof createAiChatService>
  events: AiChatEvent[]
  captured: Parameters<ChatStreamer>[0][]
  /** 等待下一条非 delta 事件（finished / error） */
  waitForFinal: () => Promise<AiChatEvent>
}

/** 内存库 + 可观察事件 + 捕获请求的测试装置 */
function setup(
  streamer: ChatStreamer,
  overrides: Partial<AiChatServiceDeps> = {}
): Harness {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  const events: AiChatEvent[] = []
  const captured: Parameters<ChatStreamer>[0][] = []
  const waiters: Array<() => void> = []
  let consumedFinals = 0
  const service = createAiChatService({
    getDb: () => db,
    readConfig: () => CONFIG,
    buildSnapshotJson: () => '{"marker":"snapshot"}',
    streamer: (request, onDelta) => {
      captured.push(request)
      return streamer(request, onDelta)
    },
    emit: (event) => {
      events.push(event)
      for (const wake of waiters.splice(0)) wake()
    },
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides
  })
  const waitForFinal = (): Promise<AiChatEvent> =>
    new Promise((resolve) => {
      const check = (): void => {
        const finals = events.filter((e) => e.type !== 'delta')
        if (finals.length > consumedFinals) {
          consumedFinals += 1
          resolve(finals[consumedFinals - 1])
        } else {
          waiters.push(check)
        }
      }
      check()
    })
  return { db, service, events, captured, waitForFinal }
}

/** 一次性成功流：逐段推送后返回完整内容 */
function answering(content: string, usage: typeof USAGE | null = USAGE): ChatStreamer {
  return async (_request, onDelta) => {
    for (const ch of content) onDelta(ch)
    return { content, usage }
  }
}

/** 挂起直到外部停止的流：先推送一部分内容，然后等待 abort */
function hangingAfter(partial: string): ChatStreamer {
  return (request, onDelta) => {
    onDelta(partial)
    const signal = request.signal
    if (signal === undefined) throw new Error('测试流需要中止信号')
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(new AiProviderError('aborted', '已停止生成'))
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  }
}

function seedMessages(db: Database.Database, count: number): void {
  const stmt = db.prepare('INSERT INTO ai_messages (role, content, created_at) VALUES (?,?,?)')
  for (let i = 1; i <= count; i++) {
    stmt.run(i % 2 === 1 ? 'user' : 'assistant', `m${i}`, '2026-01-01T00:00:00.000Z')
  }
}

describe('aiChatService — 落库与流式事件', () => {
  it('用户消息立即落库；完成后落库 assistant，并推送增量与 token 用量', async () => {
    const h = setup(answering('回答'))
    const user = h.service.send('问题')

    expect(user).toMatchObject({
      role: 'user',
      content: '问题',
      interrupted: false,
      usage: null
    })
    expect(h.service.history().map((m) => m.role)).toEqual(['user'])

    const final = await h.waitForFinal()
    expect(final).toMatchObject({
      type: 'finished',
      assistant: { role: 'assistant', content: '回答', interrupted: false, usage: USAGE }
    })
    expect(h.events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''))).toEqual([
      '回',
      '答'
    ])
    expect(h.service.history().map((m) => m.content)).toEqual(['问题', '回答'])
  })

  it('请求顺序：固定 system prompt → <snapshot> → 最近历史 → 当前用户消息', async () => {
    const h = setup(answering('回答'))
    h.service.send('  当前问题  ')
    await h.waitForFinal()

    const request = h.captured[0]
    expect(request.apiKey).toBe(CONFIG.apiKey)
    const messages = request.messages
    expect(messages[0].role).toBe('system')
    // system prompt 的四条约束：引用指标、标注不确定性、非投资建议、数据缺失明说（含数据截止时间）
    for (const keyword of ['指标', '不确定性', '非投资建议', '缺失', '截止时间']) {
      expect(messages[0].content).toContain(keyword)
    }
    expect(messages[1]).toEqual({
      role: 'system',
      content: '<snapshot>\n{"marker":"snapshot"}\n</snapshot>'
    })
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '当前问题' })
  })

  it('请求只带最近 20 条历史（不含当前消息）', async () => {
    const h = setup(answering('回答'))
    seedMessages(h.db, 25)

    h.service.send('现在')
    await h.waitForFinal()

    const messages = h.captured[0].messages
    expect(messages).toHaveLength(2 + 20 + 1)
    expect(messages.slice(2, -1).map((m) => m.content)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${i + 6}`)
    )
    expect(messages[messages.length - 1].content).toBe('现在')
  })

  it('历史超过 200 条时删除最旧消息', async () => {
    const h = setup(answering('回答'))
    seedMessages(h.db, 199)

    h.service.send('问题')
    await h.waitForFinal()

    const history = h.service.history()
    expect(history).toHaveLength(200)
    expect(history[0].content).toBe('m2')
    expect(history[history.length - 1].role).toBe('assistant')
  })
})

describe('aiChatService — 停止、中断与错误', () => {
  it('停止时保留已收到内容并标记已中断，不报错误 banner', async () => {
    const h = setup(hangingAfter('部分'))
    h.service.send('问题')
    h.service.stop()

    const final = await h.waitForFinal()
    expect(final.type).toBe('finished')
    if (final.type === 'finished') {
      expect(final.assistant).toMatchObject({ content: '部分', interrupted: true, usage: null })
    }
    expect(h.events.some((e) => e.type === 'error')).toBe(false)
    expect(h.service.history().map((m) => [m.role, m.content, m.interrupted])).toEqual([
      ['user', '问题', false],
      ['assistant', '部分', true]
    ])
  })

  it('请求出错时保留部分内容并标记中断，同时推送中文错误原因', async () => {
    const streamer: ChatStreamer = async (_request, onDelta) => {
      onDelta('部分')
      throw new AiProviderError('network', '无法连接 AI 端点，请检查网络或 API 地址')
    }
    const h = setup(streamer)
    h.service.send('问题')

    const final = await h.waitForFinal()
    expect(final).toMatchObject({
      type: 'error',
      error: '无法连接 AI 端点，请检查网络或 API 地址',
      assistant: { content: '部分', interrupted: true }
    })
    expect(h.service.history()[1]).toMatchObject({ role: 'assistant', interrupted: true })
  })

  it('出错且未收到任何内容时不落库空消息', async () => {
    const h = setup(async () => {
      throw new AiProviderError('auth', 'API key 无效或无权限（HTTP 401）', 401)
    })
    h.service.send('问题')

    const final = await h.waitForFinal()
    expect(final).toMatchObject({ type: 'error', assistant: null })
    expect(h.service.history().map((m) => m.role)).toEqual(['user'])
  })

  it('生成中再次发送被拒绝（单请求互斥），停止后可再次发送', async () => {
    const h = setup(hangingAfter('部分'))
    h.service.send('第一次')
    expect(() => h.service.send('第二次')).toThrow(/正在生成/)
    expect(() => h.service.retry()).toThrow(/正在生成/)

    h.service.stop()
    await h.waitForFinal()

    h.service.send('第二次')
    h.service.stop()
    await h.waitForFinal()
    const userMessages = h.service.history().filter((m) => m.role === 'user')
    expect(userMessages.map((m) => m.content)).toEqual(['第一次', '第二次'])
  })
})

describe('aiChatService — 配置、清空与重试', () => {
  it('未配置时拒绝发送且不落库', () => {
    const h = setup(answering('回答'), { readConfig: () => null })
    expect(() => h.service.send('问题')).toThrow(/设置页配置/)
    expect(h.service.history()).toEqual([])
  })

  it('空问题被拒绝', () => {
    const h = setup(answering('回答'))
    expect(() => h.service.send('   ')).toThrow(/输入问题/)
    expect(h.service.history()).toEqual([])
  })

  it('清空删除全部消息；生成中清空的在途回答不会回写', async () => {
    const h = setup(hangingAfter('部分'))
    h.service.send('问题')
    h.service.clear()
    h.service.stop()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.service.history()).toEqual([])
    expect(h.events.some((e) => e.type === 'finished' || e.type === 'error')).toBe(false)
  })

  it('重试复用最后一条用户消息，不重复落库用户消息', async () => {
    const h = setup(answering('新回答'))
    h.db
      .prepare("INSERT INTO ai_messages (role, content, created_at) VALUES ('user','q1','2026-01-01'), ('assistant','a1','2026-01-01'), ('user','q2','2026-01-01')")
      .run()

    const retried = h.service.retry()
    expect(retried.content).toBe('q2')
    await h.waitForFinal()

    expect(h.captured[0].messages.map((m) => m.content)).toEqual([
      expect.stringContaining('指标'),
      '<snapshot>\n{"marker":"snapshot"}\n</snapshot>',
      'q1',
      'a1',
      'q2'
    ])
    expect(h.service.history().map((m) => m.content)).toEqual(['q1', 'a1', 'q2', '新回答'])
  })

  it('没有用户消息时不可重试', () => {
    const h = setup(answering('回答'))
    expect(() => h.service.retry()).toThrow(/没有可重试/)
  })

  it('最后一条回答已成功完成时不可重试，避免重复生成', async () => {
    const h = setup(answering('回答'))
    h.service.send('问题')
    await h.waitForFinal()

    expect(() => h.service.retry()).toThrow(/已完成/)
    expect(h.service.history()).toHaveLength(2)
  })

  it('状态反映是否生成中与已收到的部分内容', async () => {
    const h = setup(hangingAfter('部分'))
    expect(h.service.status()).toEqual({ generating: false, partialText: '' })
    h.service.send('问题')
    expect(h.service.status()).toEqual({ generating: true, partialText: '部分' })
    h.service.stop()
    await h.waitForFinal()
    expect(h.service.status()).toEqual({ generating: false, partialText: '' })
  })
})

describe('aiChatService — 密钥边界', () => {
  it('请求对象含 key 但历史与快照消息不含 key', async () => {
    const h = setup(answering('回答'))
    h.service.send('问题')
    await h.waitForFinal()

    const request = h.captured[0]
    expect(request.apiKey).toBe(CONFIG.apiKey)
    expect(JSON.stringify(request.messages)).not.toContain(CONFIG.apiKey)
    expect(JSON.stringify(h.service.history())).not.toContain(CONFIG.apiKey)
  })
})
