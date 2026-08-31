import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { loadSettings, saveDbPath } from './settingsStore'

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
