import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  confirmFirstSendNotice,
  loadAiConfigView,
  readAiSecretConfig,
  resolveApiKey,
  saveAiConfig
} from './aiConfigStore'
import type { KeyCipher } from './aiConfigStore'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'porti-ai-settings-'))
}

/** 测试替身：与 safeStorage 同形的加解密接缝（加密串带 enc: 前缀便于断言） */
function fakeCipher(options: { available?: boolean; failDecrypt?: boolean } = {}): KeyCipher {
  const available = options.available ?? true
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8').toString('base64'),
    decrypt: (encrypted) => {
      if (options.failDecrypt === true) throw new Error('decrypt failed')
      const raw = Buffer.from(encrypted, 'base64').toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext')
      return raw.slice(4)
    }
  }
}

const INPUT = {
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
  apiKey: 'sk-1234567890abcd'
}

describe('aiConfigStore — 密钥加密、掩码与不回显', () => {
  it('保存后只返回掩码；settings.json 不含明文 key', () => {
    const dir = tempDir()
    const view = saveAiConfig(dir, INPUT, fakeCipher())

    expect(view).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      hasKey: true,
      keyMask: 'sk-…abcd',
      configured: true,
      safeStorageAvailable: true
    })
    expect(JSON.stringify(view)).not.toContain(INPUT.apiKey)

    const file = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(file).not.toContain(INPUT.apiKey)
    expect(file).toContain('encryptedKey')
  })

  it('读取配置不解密回传：明文只存在于主进程的 readAiSecretConfig', () => {
    const dir = tempDir()
    saveAiConfig(dir, INPUT, fakeCipher())

    const view = loadAiConfigView(dir, fakeCipher())
    expect(JSON.stringify(view)).not.toContain(INPUT.apiKey)

    expect(readAiSecretConfig(dir, fakeCipher())).toEqual({
      baseUrl: INPUT.baseUrl,
      model: INPUT.model,
      apiKey: INPUT.apiKey
    })
  })

  it('保存时 key 留空表示不更改已保存的 key', () => {
    const dir = tempDir()
    saveAiConfig(dir, INPUT, fakeCipher())

    const view = saveAiConfig(
      dir,
      { baseUrl: 'https://api.example.com/v2', model: 'another-model', apiKey: null },
      fakeCipher()
    )
    expect(view.hasKey).toBe(true)
    expect(view.keyMask).toBe('sk-…abcd')
    expect(readAiSecretConfig(dir, fakeCipher())?.apiKey).toBe(INPUT.apiKey)
  })
})

describe('aiConfigStore — safeStorage 不可用时的拒绝降级', () => {
  it('拒绝保存 key，不写入明文；错误信息不含 key', () => {
    const dir = tempDir()
    let message = ''
    try {
      saveAiConfig(dir, INPUT, fakeCipher({ available: false }))
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('安全存储')
    expect(message).not.toContain(INPUT.apiKey)

    const view = loadAiConfigView(dir, fakeCipher({ available: false }))
    expect(view.hasKey).toBe(false)
    expect(view.configured).toBe(false)
    expect(view.safeStorageAvailable).toBe(false)
  })

  it('不填 key 时仍可保存地址与模型', () => {
    const dir = tempDir()
    const view = saveAiConfig(
      dir,
      { baseUrl: INPUT.baseUrl, model: INPUT.model, apiKey: null },
      fakeCipher({ available: false })
    )
    expect(view.baseUrl).toBe(INPUT.baseUrl)
    expect(view.model).toBe(INPUT.model)
    expect(view.hasKey).toBe(false)
  })
})

describe('aiConfigStore — 解密失败与配置损坏按未配置处理', () => {
  it('解密失败时 hasKey=false、configured=false', () => {
    const dir = tempDir()
    saveAiConfig(dir, INPUT, fakeCipher())

    const view = loadAiConfigView(dir, fakeCipher({ failDecrypt: true }))
    expect(view.hasKey).toBe(false)
    expect(view.keyMask).toBeNull()
    expect(view.configured).toBe(false)
    expect(readAiSecretConfig(dir, fakeCipher({ failDecrypt: true }))).toBeNull()
  })

  it('settings.json 损坏或 ai 字段形状不对时按未配置处理', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), '{ 损坏的 json', 'utf8')
    expect(loadAiConfigView(dir, fakeCipher())).toMatchObject({
      baseUrl: '',
      model: '',
      hasKey: false,
      configured: false
    })

    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ai: { baseUrl: 42, model: true, encryptedKey: 7 } }),
      'utf8'
    )
    expect(loadAiConfigView(dir, fakeCipher())).toMatchObject({
      baseUrl: '',
      model: '',
      hasKey: false
    })
  })
})

describe('aiConfigStore — 测试连接选用 key（resolveApiKey）', () => {
  it('本次输入优先：trim 后返回输入的 key，即使已保存另一把', () => {
    const dir = tempDir()
    saveAiConfig(dir, INPUT, fakeCipher())

    expect(resolveApiKey(dir, '  sk-typed-key  ', fakeCipher())).toBe('sk-typed-key')
  })

  it('输入为 null 或空白时回退已保存的 key', () => {
    const dir = tempDir()
    saveAiConfig(dir, INPUT, fakeCipher())

    expect(resolveApiKey(dir, null, fakeCipher())).toBe(INPUT.apiKey)
    expect(resolveApiKey(dir, '   ', fakeCipher())).toBe(INPUT.apiKey)
  })

  it('既没有本次输入也没有已保存的 key 时返回 null', () => {
    const dir = tempDir()

    expect(resolveApiKey(dir, null, fakeCipher())).toBeNull()
    expect(resolveApiKey(dir, '', fakeCipher())).toBeNull()
  })
})

describe('aiConfigStore — 首次发送说明标记', () => {
  it('默认未确认；确认后持久化，且保存配置不会清除它', () => {
    const dir = tempDir()
    expect(loadAiConfigView(dir, fakeCipher()).firstSendNoticeConfirmed).toBe(false)

    confirmFirstSendNotice(dir)
    expect(loadAiConfigView(dir, fakeCipher()).firstSendNoticeConfirmed).toBe(true)

    saveAiConfig(dir, INPUT, fakeCipher())
    expect(loadAiConfigView(dir, fakeCipher()).firstSendNoticeConfirmed).toBe(true)
  })
})

describe('aiConfigStore — 保存前校验', () => {
  it('非法 base URL 或空模型名拒绝保存', () => {
    const dir = tempDir()
    expect(() => saveAiConfig(dir, { ...INPUT, baseUrl: 'http://example.com/v1' }, fakeCipher())).toThrow(
      /https/
    )
    expect(() => saveAiConfig(dir, { ...INPUT, model: '   ' }, fakeCipher())).toThrow('请填写模型名')
  })
})
