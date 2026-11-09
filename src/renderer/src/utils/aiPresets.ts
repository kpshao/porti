// AI 供应商预设：只提供 base URL 模板与模型名示例，不内置任何 key，也不替用户选择模型。
// 选中预设只填入 base URL；模型名仍需用户确认（placeholder 仅作示例）。

export interface AiProviderPreset {
  label: string
  baseUrl: string
  /** 模型名示例（写入输入框的 placeholder，不自动填值） */
  modelHint: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  {
    label: '阿里云通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelHint: 'qwen-plus'
  },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', modelHint: 'moonshot-v1-8k' },
  {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelHint: 'glm-4-flash'
  },
  { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelHint: 'llama3.1' }
]
