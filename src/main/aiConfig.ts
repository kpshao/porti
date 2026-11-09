// AI 配置的纯函数规则：base URL 校验、模型名归一、密钥掩码与快照 token 粗略估算。
// 不依赖 Electron/网络，便于单测；密钥明文只在主进程内传递，掩码是唯一能回到渲染进程的形态。

/** 允许 http 的主机（本地代理与 CDP 验收脚本；其余地址必须 https） */
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost']

/** 校验并归一化 OpenAI 兼容端点的 base URL：填写到 /v1 一级，去掉尾部斜杠。 */
export function normalizeAiBaseUrl(raw: string): string {
  const input = raw.trim()
  if (input === '') throw new Error('请填写 API 地址')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('API 地址格式不正确，需以 https:// 开头')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('API 地址仅支持 https（本地 127.0.0.1 / localhost 可使用 http）')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('API 地址不能包含用户名或密码')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('API 地址不能包含查询参数或锚点')
  }
  if (url.protocol === 'http:' && !LOCAL_HTTP_HOSTS.includes(url.hostname)) {
    throw new Error('API 地址仅支持 https（本地 127.0.0.1 / localhost 可使用 http）')
  }
  return url.toString().replace(/\/+$/, '')
}

/** 由 base URL 拼接 chat completions 端点（客户端唯一拼接点） */
export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeAiBaseUrl(baseUrl)}/chat/completions`
}

/** 归一化模型名：去空白，空值拒绝 */
export function normalizeAiModel(raw: string): string {
  const model = raw.trim()
  if (model === '') throw new Error('请填写模型名')
  return model
}

/** 密钥掩码：前 3 位 + 省略号 + 后 4 位；过短的 key 完全隐藏，避免泄露 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

/** 快照可能被模型截断的粗略 token 阈值（估算值，仅提示、不自动裁剪） */
export const SNAPSHOT_TOKEN_WARN = 60000

/** 粗略 token 估算：按字符数 ÷ 3（中英混合的经验值），只用于发送前提示 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}
