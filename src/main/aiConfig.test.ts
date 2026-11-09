import { describe, expect, it } from 'vitest'
import {
  buildChatCompletionsUrl,
  maskApiKey,
  normalizeAiBaseUrl,
  normalizeAiModel
} from './aiConfig'

describe('aiConfig — base URL 校验', () => {
  it('https 地址保留路径，去掉尾部斜杠', () => {
    expect(normalizeAiBaseUrl('  https://api.openai.com/v1/  ')).toBe('https://api.openai.com/v1')
    expect(normalizeAiBaseUrl('https://api.openai.com/v1///')).toBe('https://api.openai.com/v1')
    expect(normalizeAiBaseUrl('https://api.openai.com')).toBe('https://api.openai.com')
  })

  it('仅 127.0.0.1 / localhost 放行 http（本地代理与验收脚本）', () => {
    expect(normalizeAiBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(normalizeAiBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
  })

  it('其余 http 与非法协议一律拒绝，提示仅支持 https', () => {
    expect(() => normalizeAiBaseUrl('http://api.example.com/v1')).toThrow(/https/)
    expect(() => normalizeAiBaseUrl('ftp://api.example.com/v1')).toThrow(/https/)
  })

  it('空值、非法 URL、查询参数与内嵌凭据被拒绝', () => {
    expect(() => normalizeAiBaseUrl('')).toThrow('请填写 API 地址')
    expect(() => normalizeAiBaseUrl('not-a-url')).toThrow('API 地址格式不正确')
    expect(() => normalizeAiBaseUrl('https://api.example.com/v1?key=abc')).toThrow('查询参数')
    expect(() => normalizeAiBaseUrl('https://user:pass@api.example.com/v1')).toThrow('用户名或密码')
  })

  it('拼接 chat completions 路径', () => {
    expect(buildChatCompletionsUrl('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
  })
})

describe('aiConfig — 模型名与密钥掩码', () => {
  it('模型名去空白，空值拒绝', () => {
    expect(normalizeAiModel('  gpt-4o-mini ')).toBe('gpt-4o-mini')
    expect(() => normalizeAiModel('   ')).toThrow('请填写模型名')
  })

  it('掩码只保留前 3 位与后 4 位，短 key 完全隐藏', () => {
    expect(maskApiKey('sk-1234567890abcd')).toBe('sk-…abcd')
    expect(maskApiKey('short')).toBe('••••')
    expect(maskApiKey('12345678')).toBe('••••')
  })
})
