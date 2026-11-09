import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { loadSettings, saveDbPath, saveMigrationPromptDismissed } from './settingsStore'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'porti-settings-'))
}

describe('settingsStore — 数据文件位置持久化', () => {
  it('保存后可读回；未保存过返回 null（使用默认位置）', () => {
    const dir = tempDir()
    expect(loadSettings(dir).dbPath).toBeNull()

    saveDbPath(dir, '/some/dir/porti.db')
    expect(loadSettings(dir).dbPath).toBe('/some/dir/porti.db')
  })

  it('设置目录不存在时保存会先创建目录', () => {
    const dir = join(tempDir(), 'nested', 'settings')
    saveDbPath(dir, '/x/porti.db')
    expect(loadSettings(dir).dbPath).toBe('/x/porti.db')
  })

  it('配置文件损坏（非 JSON）时按未设置处理，不影响启动', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), '{ 损坏的 json', 'utf8')
    expect(loadSettings(dir).dbPath).toBeNull()
  })

  it('dbPath 字段缺失或不是非空字符串时按未设置处理', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ dbPath: 42 }), 'utf8')
    expect(loadSettings(dir).dbPath).toBeNull()

    writeFileSync(join(dir, 'settings.json'), JSON.stringify({}), 'utf8')
    expect(loadSettings(dir).dbPath).toBeNull()

    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ dbPath: '' }), 'utf8')
    expect(loadSettings(dir).dbPath).toBeNull()
  })
})

describe('settingsStore — AI 配置字段', () => {
  it('默认按未配置处理', () => {
    expect(loadSettings(tempDir()).ai).toEqual({
      baseUrl: '',
      model: '',
      encryptedKey: null,
      firstSendNoticeConfirmed: false
    })
  })

  it('读取合法 ai 字段；损坏的形状逐项回落默认值', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        ai: {
          baseUrl: ' https://api.example.com/v1 ',
          model: 'example-model',
          encryptedKey: 'cipher-text',
          firstSendNoticeConfirmed: true
        }
      }),
      'utf8'
    )
    expect(loadSettings(dir).ai).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      encryptedKey: 'cipher-text',
      firstSendNoticeConfirmed: true
    })

    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ai: { baseUrl: 1, model: null, encryptedKey: '', firstSendNoticeConfirmed: 'yes' } }),
      'utf8'
    )
    expect(loadSettings(dir).ai).toEqual({
      baseUrl: '',
      model: '',
      encryptedKey: null,
      firstSendNoticeConfirmed: false
    })
  })

  it('保存数据文件位置不会丢失 AI 配置', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ai: { baseUrl: 'https://api.example.com/v1', model: 'm' } }),
      'utf8'
    )
    saveDbPath(dir, '/x/porti.db')
    expect(loadSettings(dir).ai.baseUrl).toBe('https://api.example.com/v1')
    expect(loadSettings(dir).ai.model).toBe('m')
  })
})

describe('settingsStore — 首启迁移引导跳过标记', () => {
  it('默认未跳过；保存后可读回，且不影响 dbPath', () => {
    const dir = tempDir()
    expect(loadSettings(dir).migrationPromptDismissed).toBe(false)

    saveMigrationPromptDismissed(dir)
    const saved = loadSettings(dir)
    expect(saved.migrationPromptDismissed).toBe(true)
    expect(saved.dbPath).toBeNull()
  })

  it('保存数据文件位置不会丢失跳过标记（旧实现会整文件覆盖）', () => {
    const dir = tempDir()
    saveMigrationPromptDismissed(dir)
    saveDbPath(dir, '/x/porti.db')

    const saved = loadSettings(dir)
    expect(saved.dbPath).toBe('/x/porti.db')
    expect(saved.migrationPromptDismissed).toBe(true)
  })

  it('配置文件损坏时标记按未跳过处理', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), '{ 损坏的 json', 'utf8')
    expect(loadSettings(dir).migrationPromptDismissed).toBe(false)
  })
})
