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
