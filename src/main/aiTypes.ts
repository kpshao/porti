// AI 分析的 IPC 契约类型（主进程与界面共用，纯类型无运行时依赖）。安全边界见 ADR-0003。

/** 设置页读取的 AI 配置视图（不含明文 key） */
export interface AiConfigView {
  baseUrl: string
  model: string
  hasKey: boolean
  /** 已保存 key 的掩码（如 sk-…abcd）；未保存或解密失败时为 null */
  keyMask: string | null
  firstSendNoticeConfirmed: boolean
  safeStorageAvailable: boolean
  /** 地址、模型、key 三者齐备时才可发起分析请求 */
  configured: boolean
}

/** 设置页保存/测试连接的输入 */
export interface AiConfigInput {
  baseUrl: string
  model: string
  /** 新 API key；null 或空串表示保留已保存的 key（保存后不会回显） */
  apiKey: string | null
}

/** 主进程发起请求所需的连接凭据（含明文 key，绝不跨 IPC） */
export interface AiCredentials {
  baseUrl: string
  model: string
  apiKey: string
}

/** 「测试连接」结果：失败原因已按 401/403、404、429、网络、超时分类为中文提示 */
export interface AiConnectionTestResult {
  ok: boolean
  message: string
}

/** 分析快照预览：发送前展示的 JSON 与粗略 token 估算（不含任何密钥） */
export interface SnapshotPreview {
  json: string
  estimatedTokens: number
  /** 超过约 60k token，提示可能被模型截断（不自动裁剪） */
  exceedsEstimateLimit: boolean
}

/** 供应商返回的 token 用量（三字段由供应商成组返回；缺失时整块为 null） */
export interface AiTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 单条对话消息（界面视图；已落库，含 id 与中断标记） */
export interface AiChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** true = 停止或出错时保留的部分回答 */
  interrupted: boolean
  /** 供应商未返回用量时为 null（界面显示「—」） */
  usage: AiTokenUsage | null
  createdAt: string
}

/** 主进程 → 界面的流式对话事件（单线程，同一时刻只有一个进行中的请求） */
export type AiChatEvent =
  | { type: 'delta'; text: string }
  /** 正常完成或用户停止；assistant 为落库消息（无内容可落库时为 null） */
  | { type: 'finished'; assistant: AiChatMessage | null }
  /** 请求失败：error 为中文原因，assistant 为已保留的部分回答（无内容时为 null） */
  | { type: 'error'; error: string; assistant: AiChatMessage | null }

/** 对话进行状态（界面离开再进入时恢复流式草稿） */
export interface AiChatStatus {
  generating: boolean
  partialText: string
}

/** AI 回答中的外链经主进程校验后交给系统浏览器 */
export interface OpenExternalResult {
  ok: boolean
  message?: string
}
