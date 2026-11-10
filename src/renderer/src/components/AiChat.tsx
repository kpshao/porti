// 分析页底部的 AI 对话区：单线程历史、流式输出、停止/重试/清空、token 用量、首次发送说明与快照预览。
// 渲染进程不接触 key 与网络：只收发文本/增量事件，所有请求由主进程发起（ADR-0003）。

import { useEffect, useRef, useState } from 'react'
import type { AiChatMessage, AiConfigView, SnapshotPreview } from '../../../main/aiTypes'
import { ipcErrorMessage } from '../utils/ipc'
import Markdown from './Markdown'

interface AiChatProps {
  /** 跳转到设置页（未配置 AI 时的引导） */
  onNavigateToSettings: () => void
  /** 是否有在持基金（无持仓时禁用发送） */
  hasHoldings: boolean
}

function mergeMessages(a: AiChatMessage[], b: AiChatMessage[]): AiChatMessage[] {
  const byId = new Map<number, AiChatMessage>()
  for (const message of [...a, ...b]) byId.set(message.id, message)
  return [...byId.values()].sort((x, y) => x.id - y.id)
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function UsageBadge({ message }: { message: AiChatMessage }): React.JSX.Element {
  if (message.usage === null) return <span className="chat-usage">tokens —</span>
  return (
    <span className="chat-usage">
      tokens {message.usage.totalTokens}（输入 {message.usage.promptTokens} / 输出{' '}
      {message.usage.completionTokens}）
    </span>
  )
}

function ChatMessageView({ message }: { message: AiChatMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="chat-message chat-message-user">
        <div className="chat-role">我</div>
        <div className="chat-user-text">{message.content}</div>
      </div>
    )
  }
  return (
    <div className="chat-message chat-message-assistant">
      <div className="chat-role">
        AI
        {message.interrupted && <span className="chat-interrupted">已中断</span>}
      </div>
      <Markdown source={message.content} />
      <UsageBadge message={message} />
    </div>
  )
}

export default function AiChat({ onNavigateToSettings, hasHoldings }: AiChatProps): React.JSX.Element {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<SnapshotPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 挂载：读取历史、配置与进行中状态（离开再进入时恢复流式草稿）
  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.aiChatHistory(), window.api.aiConfigGet(), window.api.aiChatStatus()])
      .then(([history, view, status]) => {
        if (cancelled) return
        setConfig(view)
        setMessages((prev) => mergeMessages(history, prev))
        setGenerating(status.generating)
        setStreamingText(status.partialText)
      })
      .catch((e) => setError(ipcErrorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])

  // 流式增量与终态事件（主进程推送，单线程）
  useEffect(() => {
    return window.api.aiChatOnEvent((event) => {
      if (event.type === 'delta') {
        setGenerating(true)
        setStreamingText((prev) => prev + event.text)
        return
      }
      setGenerating(false)
      setStreamingText('')
      const assistant = event.assistant
      if (assistant !== null) setMessages((prev) => mergeMessages(prev, [assistant]))
      if (event.type === 'error') {
        setError(event.error)
        setRetryable(true)
      }
    })
  }, [])

  // 新消息或增量到达时滚到底部
  useEffect(() => {
    const list = listRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [messages, streamingText])

  const canSend = config !== null && config.configured && hasHoldings
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  /** 切页/刷新后错误 banner 不保留：用数据库里的中断状态恢复「重试上一条」入口 */
  const canRetryStale =
    !generating &&
    error === null &&
    lastMessage !== null &&
    (lastMessage.role === 'user' || lastMessage.interrupted)

  const beginGeneration = (): void => {
    setError(null)
    setRetryable(false)
    setGenerating(true)
    setStreamingText('')
  }

  const fail = (e: unknown): void => {
    setGenerating(false)
    setStreamingText('')
    setError(ipcErrorMessage(e))
  }

  const startSend = async (content: string): Promise<void> => {
    if (generating || !canSend) return
    beginGeneration()
    try {
      const userMessage = await window.api.aiChatSend(content)
      setMessages((prev) => mergeMessages(prev, [userMessage]))
      setDraft('')
    } catch (e) {
      fail(e)
    }
  }

  const startRetry = async (): Promise<void> => {
    if (generating || !canSend) return
    beginGeneration()
    try {
      await window.api.aiChatRetry()
    } catch (e) {
      fail(e)
    }
  }

  const requestSend = (): void => {
    if (generating || !canSend) return
    const text = draft.trim()
    if (text === '') return
    if (config !== null && !config.firstSendNoticeConfirmed) {
      setPendingText(text)
      setNoticeOpen(true)
      return
    }
    void startSend(text)
  }

  const requestRetry = (): void => {
    void startRetry()
  }

  const confirmNotice = async (): Promise<void> => {
    const text = pendingText
    setNoticeOpen(false)
    setPendingText(null)
    try {
      await window.api.aiConfirmFirstSend()
      setConfig((prev) =>
        prev === null ? prev : { ...prev, firstSendNoticeConfirmed: true }
      )
    } catch {
      // 记录失败不阻止本次发送：下次进入仍会再次提示
    }
    if (text !== null) await startSend(text)
  }

  const stop = (): void => {
    void window.api.aiChatStop()
  }

  const clearChat = async (): Promise<void> => {
    try {
      await window.api.aiChatClear()
      setMessages([])
      setStreamingText('')
      setGenerating(false)
      setError(null)
      setRetryable(false)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  const openPreview = async (): Promise<void> => {
    setPreviewOpen(true)
    setPreviewError(null)
    try {
      setPreview(await window.api.aiSnapshotPreview())
    } catch (e) {
      setPreviewError(ipcErrorMessage(e))
    }
  }

  const unconfigured = config !== null && !config.configured
  const unconfiguredHint =
    config !== null && !config.hasKey
      ? '尚未保存 API key，对话暂不可用；指标仍可正常使用。'
      : '尚未配置 AI 端点地址或模型，对话暂不可用；指标仍可正常使用。'

  return (
    <div className="card chat-card">
      <div className="card-head">
        <h2>AI 对话</h2>
        {config !== null && config.configured && (
          <span className="muted chat-endpoint">发送到 {hostOf(config.baseUrl)}</span>
        )}
      </div>

      {unconfigured && (
        <div className="banner banner-info chat-config-hint">
          <span>{unconfiguredHint}</span>
          <button className="btn btn-small chat-settings-link" onClick={onNavigateToSettings}>
            前往设置
          </button>
        </div>
      )}

      {config !== null && config.configured && !hasHoldings && (
        <div className="banner banner-info">当前没有在持基金，暂时无法发起 AI 分析。</div>
      )}

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && !generating && (
          <p className="chat-empty muted">还没有对话。AI 会在每次发送时收到当前组合的最新分析快照。</p>
        )}
        {messages.map((message) => (
          <ChatMessageView key={message.id} message={message} />
        ))}
        {generating && (
          <div className="chat-message chat-message-assistant chat-streaming">
            <div className="chat-role">AI（生成中…）</div>
            {streamingText === '' ? (
              <p className="muted">正在等待回答…</p>
            ) : (
              <Markdown source={streamingText} />
            )}
          </div>
        )}
      </div>

      {error !== null && (
        <div className="banner banner-error chat-error">
          <span>{error}</span>
          {retryable && (
            <button className="btn btn-small chat-retry" onClick={requestRetry}>
              重试
            </button>
          )}
        </div>
      )}

      <div className="chat-compose">
        <textarea
          className="chat-input"
          rows={3}
          value={draft}
          disabled={!canSend || generating}
          placeholder={
            unconfigured
              ? '请先在设置页配置 AI 端点与 API key'
              : hasHoldings
                ? '就当前组合提问，例如：我的持仓集中吗？'
                : '当前没有在持基金'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              requestSend()
            }
          }}
        />
        <div className="chat-actions">
          {generating ? (
            <button className="btn btn-danger chat-stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button
              className="btn btn-primary chat-send"
              disabled={!canSend || draft.trim() === ''}
              onClick={requestSend}
            >
              发送
            </button>
          )}
          <button
            className="btn chat-clear"
            disabled={messages.length === 0 && !generating}
            onClick={() => void clearChat()}
          >
            清空对话
          </button>
          <button className="btn chat-preview-btn" onClick={() => void openPreview()}>
            查看将发送的数据
          </button>
          {canRetryStale && (
            <button className="btn chat-retry-stale" onClick={requestRetry}>
              重试上一条
            </button>
          )}
        </div>
      </div>

      <p className="muted">
        只有点击发送时才会把分析快照发往上述地址；发送前可先查看将发送的数据。
        回答由模型生成，可能不准确，请结合指标自行核对。
      </p>

      {noticeOpen && (
        <div className="modal-overlay">
          <div className="modal chat-notice">
            <h2>首次发送说明</h2>
            <p>
              点击「确认并发送」后，会把当前组合的<strong>分析快照</strong>发送到{' '}
              <span className="mono">{config === null ? '' : config.baseUrl}</span>。
            </p>
            <p className="muted">
              快照包含汇总、在持/已清仓基金明细、大类目标与偏离、集中度指标、全部流水、区间收益摘要与数据新鲜度；
              不包含 API key、数据文件路径与原始逐日净值序列。确认后不再弹出此说明。
            </p>
            <div className="settings-actions">
              <button className="btn btn-primary chat-notice-confirm" onClick={() => void confirmNotice()}>
                确认并发送
              </button>
              <button
                className="btn"
                onClick={() => {
                  setNoticeOpen(false)
                  setPendingText(null)
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-head">
              <h2>将发送的数据（分析快照）</h2>
              <button className="modal-close" onClick={() => setPreviewOpen(false)}>
                ×
              </button>
            </div>
            {previewError !== null && <div className="banner banner-error">{previewError}</div>}
            {preview !== null && (
              <>
                <p className="muted">
                  预计约 {preview.estimatedTokens.toLocaleString('zh-CN')} tokens（粗略估算，实际以供应商计费为准）。
                  {preview.exceedsEstimateLimit &&
                    ' 超过约 6 万 token，可能被模型截断；不会自动裁剪。'}
                </p>
                <pre className="snapshot-preview mono">{preview.json}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
