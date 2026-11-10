// 单线程 AI 对话服务（主进程）：消息落库、流式事件、停止/重试、200 条上限、20 条上下文与单请求互斥。
// 依赖以接缝注入（数据库、明文配置、快照、provider 流、事件、时钟），单测用内存库与假流。
// 密钥只在请求对象里传给 provider，不进入消息、事件与快照；联网边界见 ADR-0003。

import type Database from 'better-sqlite3'
import type { AiSecretConfig } from './aiConfigStore'
import type { AiChatEvent, AiChatMessage, AiChatStatus, AiTokenUsage } from './aiTypes'
import { AiProviderError } from './aiProvider'
import type { ChatMessage, StreamChatRequest, StreamChatResult } from './aiProvider'

/** 请求上下文只带最近 20 条历史消息（不含当前用户消息），见 spec #16「AI 请求与对话」 */
export const CHAT_HISTORY_LIMIT = 20

/** 单线程对话永久保留，但超过 200 条时删除最旧消息 */
export const CHAT_STORE_LIMIT = 200

/** 固定 system prompt：角色与四条约束（引用指标、标注不确定性、注明非投资建议、数据缺失明说）。 */
export const AI_CHAT_SYSTEM_PROMPT = `你在 Porti 的「AI 对话」中帮助用户理解其当前的基金组合。回答必须遵守以下四条约束：

1. 引用指标：任何结论都要引用分析快照中的指标名与数值（例如 HHI、有效持仓数、前三大占比、最大单只占比、市值权重、持仓盈亏、大类目标与偏离等），不要只给结论。
2. 标注不确定性：说明你的假设、数据边界与判断的局限性，不把推测说成事实。
3. 注明观点属性：每条回答都必须注明「个人观点，非投资建议」；涉及买入、卖出或持有的倾向时，更要说明这只是个人观点。
4. 数据缺失明说：快照中没有的数据（如缺失的最新净值、区间收益）要直接说明无法判断，不得编造数据，也不得声称掌握实时行情；同时说明本次数据截止时间（见快照的 dataFreshness）。

分析快照是本次提问时点构建的固定字段 JSON，位于 <snapshot> 标签内。你只能引用快照与对话历史中的信息。回答使用中文，可用 Markdown 组织，但不要输出原始 HTML 或图片。`

/** 发起流式请求的注入接缝（生产为 streamChatCompletion） */
export type ChatStreamer = (
  request: StreamChatRequest,
  onDelta: (text: string) => void
) => Promise<StreamChatResult>

export interface AiChatServiceDeps {
  /** 每次操作时取当前连接（导入迁移包会热替换数据库） */
  getDb: () => Database.Database
  /** 主进程内解密的明文配置；未配置或解密失败返回 null */
  readConfig: () => AiSecretConfig | null
  /** 每次发送时重建的分析快照 JSON */
  buildSnapshotJson: () => string
  streamer: ChatStreamer
  emit: (event: AiChatEvent) => void
  /** 消息创建时间（测试注入固定时钟） */
  now?: () => string
}

export interface AiChatService {
  history(): AiChatMessage[]
  status(): AiChatStatus
  /** 立即落库用户消息并异步开始生成；返回已落库的用户消息 */
  send(content: string): AiChatMessage
  /** 用最后一条用户消息重新生成（不重复落库） */
  retry(): AiChatMessage
  /** 停止当前生成；已收到的内容会保留并标记中断 */
  stop(): void
  /** 清空全部消息；生成中的请求被取消且不会回写 */
  clear(): void
}

interface AiMessageRow {
  id: number
  role: 'user' | 'assistant'
  content: string
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  interrupted: number
  created_at: string
}

const MESSAGE_COLUMNS =
  'id, role, content, prompt_tokens, completion_tokens, total_tokens, interrupted, created_at'

function toUsage(row: AiMessageRow): AiTokenUsage | null {
  if (row.total_tokens === null) return null
  return {
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokens: row.total_tokens
  }
}

function toMessage(row: AiMessageRow): AiChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    interrupted: row.interrupted === 1,
    usage: toUsage(row),
    createdAt: row.created_at
  }
}

/** 请求消息顺序：固定 system prompt → 快照 system 消息 → 历史 → 当前用户消息 */
export function buildChatRequestMessages(
  snapshotJson: string,
  history: AiChatMessage[],
  userContent: string
): ChatMessage[] {
  return [
    { role: 'system', content: AI_CHAT_SYSTEM_PROMPT },
    { role: 'system', content: `<snapshot>\n${snapshotJson}\n</snapshot>` },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent }
  ]
}

interface ActiveRun {
  controller: AbortController
  /** 已从 provider 收到的增量（停止或出错时作为部分回答落库） */
  received: string
}

export function createAiChatService(deps: AiChatServiceDeps): AiChatService {
  const now = deps.now ?? ((): string => new Date().toISOString())
  let active: ActiveRun | null = null

  function assertIdle(): void {
    if (active !== null) throw new Error('正在生成回答，请先停止或等待完成')
  }

  function requireConfig(): AiSecretConfig {
    const config = deps.readConfig()
    if (config === null) throw new Error('请先在设置页配置 AI 端点与 API key')
    return config
  }

  function selectHistory(db: Database.Database): AiChatMessage[] {
    const rows = db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ai_messages ORDER BY id`)
      .all() as AiMessageRow[]
    return rows.map(toMessage)
  }

  function selectRecent(db: Database.Database, limit: number): AiChatMessage[] {
    const rows = db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ai_messages ORDER BY id DESC LIMIT ?`)
      .all(limit) as AiMessageRow[]
    return rows.reverse().map(toMessage)
  }

  function selectRecentBefore(
    db: Database.Database,
    beforeId: number,
    limit: number
  ): AiChatMessage[] {
    const rows = db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM ai_messages WHERE id < ? ORDER BY id DESC LIMIT ?`
      )
      .all(beforeId, limit) as AiMessageRow[]
    return rows.reverse().map(toMessage)
  }

  /** 删除超出上限的最旧消息（单线程对话全局保留最新 200 条） */
  function prune(db: Database.Database): void {
    db.prepare(
      `DELETE FROM ai_messages
       WHERE id NOT IN (SELECT id FROM ai_messages ORDER BY id DESC LIMIT ?)`
    ).run(CHAT_STORE_LIMIT)
  }

  function insertMessage(
    db: Database.Database,
    role: AiChatMessage['role'],
    content: string,
    usage: AiTokenUsage | null,
    interrupted: boolean
  ): AiChatMessage {
    const info = db
      .prepare(
        `INSERT INTO ai_messages
           (role, content, prompt_tokens, completion_tokens, total_tokens, interrupted, created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        role,
        content,
        usage === null ? null : usage.promptTokens,
        usage === null ? null : usage.completionTokens,
        usage === null ? null : usage.totalTokens,
        interrupted ? 1 : 0,
        now()
      )
    const row = db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ai_messages WHERE id = ?`)
      .get(info.lastInsertRowid) as AiMessageRow
    prune(db)
    return toMessage(row)
  }

  /** 启动一次生成：active 先占位（互斥），完成后释放 */
  function launch(config: AiSecretConfig, messages: ChatMessage[]): void {
    const run: ActiveRun = { controller: new AbortController(), received: '' }
    active = run
    const request: StreamChatRequest = {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      messages,
      signal: run.controller.signal
    }
    // execute 在发出终态事件后同步释放互斥；兜底 catch 防止后台任务出现未处理拒绝
    void execute(run, request).catch(() => {
      if (active === run) active = null
    })
  }

  function persistPartial(db: Database.Database, received: string): AiChatMessage | null {
    return received === '' ? null : insertMessage(db, 'assistant', received, null, true)
  }

  async function execute(run: ActiveRun, request: StreamChatRequest): Promise<void> {
    const db = deps.getDb()
    try {
      const result = await deps.streamer(request, (text) => {
        run.received += text
        if (active === run) deps.emit({ type: 'delta', text })
      })
      if (active !== run) return // 已被清空：不回写
      const content = result.content !== '' ? result.content : run.received
      const assistant = content === '' ? null : insertMessage(db, 'assistant', content, result.usage, false)
      deps.emit({ type: 'finished', assistant })
    } catch (e) {
      if (active !== run) return // 已被清空：不回写
      if (e instanceof AiProviderError && e.kind === 'aborted') {
        deps.emit({ type: 'finished', assistant: persistPartial(db, run.received) })
        return
      }
      const error = e instanceof AiProviderError ? e.message : 'AI 请求失败，请稍后重试'
      deps.emit({ type: 'error', error, assistant: persistPartial(db, run.received) })
    } finally {
      // 在终态事件发出后、控制权交回事件循环前释放互斥（界面收到 finished/error 即可再次发送）
      if (active === run) active = null
    }
  }

  return {
    history: () => selectHistory(deps.getDb()),

    status: () =>
      active === null
        ? { generating: false, partialText: '' }
        : { generating: true, partialText: active.received },

    send: (content) => {
      const text = content.trim()
      if (text === '') throw new Error('请先输入问题')
      assertIdle()
      const config = requireConfig()
      const db = deps.getDb()
      // 先构建快照历史（可能抛错，此时尚未落库用户消息）
      const snapshotJson = deps.buildSnapshotJson()
      const history = selectRecent(db, CHAT_HISTORY_LIMIT)
      const messages = buildChatRequestMessages(snapshotJson, history, text)
      const userMessage = insertMessage(db, 'user', text, null, false)
      launch(config, messages)
      return userMessage
    },

    retry: () => {
      assertIdle()
      const config = requireConfig()
      const db = deps.getDb()
      // 只有最后一条是待重试的用户消息，或停止/出错留下的中断回答时，才允许重试；
      // 已成功的回答不允许经 IPC 重复生成。
      const last = db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ai_messages ORDER BY id DESC LIMIT 1`)
        .get() as AiMessageRow | undefined
      if (last === undefined) throw new Error('没有可重试的问题')
      if (last.role === 'assistant' && last.interrupted === 0) {
        throw new Error('最后一条回答已完成，没有可重试的失败回答')
      }
      const userRow =
        last.role === 'user'
          ? last
          : (db
              .prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM ai_messages WHERE role = 'user' ORDER BY id DESC LIMIT 1`
              )
              .get() as AiMessageRow | undefined)
      if (userRow === undefined) throw new Error('没有可重试的问题')
      const userMessage = toMessage(userRow)
      const snapshotJson = deps.buildSnapshotJson()
      const history = selectRecentBefore(db, userMessage.id, CHAT_HISTORY_LIMIT)
      launch(config, buildChatRequestMessages(snapshotJson, history, userMessage.content))
      return userMessage
    },

    stop: () => {
      active?.controller.abort()
    },

    clear: () => {
      const run = active
      active = null // 先解除，执行中的 run 完成后不会回写
      run?.controller.abort()
      deps.getDb().prepare('DELETE FROM ai_messages').run()
    }
  }
}
