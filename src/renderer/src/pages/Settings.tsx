import { useEffect, useState } from 'react'
import type { AiConfigView } from '../../../main/aiTypes'
import { AI_PROVIDER_PRESETS } from '../utils/aiPresets'
import { ipcErrorMessage } from '../utils/ipc'

export default function Settings(): React.JSX.Element {
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState<'excel' | 'csv' | 'path' | 'migrate-out' | 'migrate-in' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newPath, setNewPath] = useState<string | null>(null)

  // AI 分析配置：读取只拿掩码；key 输入框留空表示不更改已保存的 key
  const [aiConfig, setAiConfig] = useState<AiConfigView | null>(null)
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [aiPreset, setAiPreset] = useState('')
  const [aiBusy, setAiBusy] = useState<'save' | 'test' | null>(null)
  const [aiMessage, setAiMessage] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    window.api.dbInfo().then(setDbInfo).catch((e) => setError(ipcErrorMessage(e)))
  }, [])

  useEffect(() => {
    window.api
      .aiConfigGet()
      .then((view) => {
        setAiConfig(view)
        setAiBaseUrl(view.baseUrl)
        setAiModel(view.model)
      })
      .catch((e) => setAiError(ipcErrorMessage(e)))
  }, [])

  const aiPresetModelHint =
    AI_PROVIDER_PRESETS.find((p) => p.label === aiPreset)?.modelHint ?? '例如 gpt-4o-mini'

  /** 异步操作的公共包装：清旧消息 → 忙态 → 错误回显 → 复位（数据备份与 AI 按钮共用） */
  const runAction = async <T extends string>(
    setBusyState: (value: T | null) => void,
    busyKey: T,
    clearMessages: () => void,
    fail: (message: string) => void,
    fn: () => Promise<void>
  ): Promise<void> => {
    clearMessages()
    setBusyState(busyKey)
    try {
      await fn()
    } catch (e) {
      fail(ipcErrorMessage(e))
    } finally {
      setBusyState(null)
    }
  }

  /** AI 卡片自己的消息区：与数据备份操作互不覆盖 */
  const runAi = (busyKey: 'save' | 'test', fn: () => Promise<void>): Promise<void> =>
    runAction(
      setAiBusy,
      busyKey,
      () => {
        setAiError(null)
        setAiMessage(null)
      },
      setAiError,
      fn
    )

  const selectAiPreset = (label: string): void => {
    setAiPreset(label)
    const preset = AI_PROVIDER_PRESETS.find((p) => p.label === label)
    if (preset !== undefined) setAiBaseUrl(preset.baseUrl)
  }

  const aiInput = (): { baseUrl: string; model: string; apiKey: string | null } => ({
    baseUrl: aiBaseUrl,
    model: aiModel,
    apiKey: aiKey.trim() === '' ? null : aiKey.trim()
  })

  const saveAiConfig = (): void => {
    void runAi('save', async () => {
      const view = await window.api.aiConfigSave(aiInput())
      setAiConfig(view)
      setAiBaseUrl(view.baseUrl)
      setAiModel(view.model)
      setAiKey('')
      setAiMessage(
        view.hasKey
          ? `AI 配置已保存，API key 已加密保存（${view.keyMask}）`
          : 'AI 配置已保存（尚未设置 API key，分析对话暂不可用）'
      )
    })
  }

  const testAiConfig = (): void => {
    void runAi('test', async () => {
      const result = await window.api.aiConfigTest(aiInput())
      if (result.ok) setAiMessage(result.message)
      else setAiError(result.message)
    })
  }

  const run = (
    busyKey: 'excel' | 'csv' | 'path' | 'migrate-out' | 'migrate-in',
    fn: () => Promise<void>
  ): Promise<void> =>
    runAction(
      setBusy,
      busyKey,
      () => {
        setError(null)
        setMessage(null)
      },
      setError,
      fn
    )

  const doExportExcel = (): void => {
    void run('excel', async () => {
      const result = await window.api.exportExcel()
      if (result === null) return
      setMessage(`已导出 Excel 备份：${result.path}`)
    })
  }

  const doExportCsv = (): void => {
    void run('csv', async () => {
      const result = await window.api.exportCsv()
      if (result === null) return
      setMessage(`已导出 CSV 备份到 ${result.dir}（概览/流水/净值 三个文件，内容与 Excel 一致）`)
    })
  }

  const changeDbPath = (): void => {
    void run('path', async () => {
      const result = await window.api.setDbPath()
      if (result === null) return
      if (!result.changed) {
        setMessage('选择了当前位置，数据文件未更改。')
        return
      }
      setNewPath(result.path)
      setMessage(`数据文件已复制到新位置：${result.path}。重启软件后生效。`)
    })
  }

  const doExportBundle = (): void => {
    void run('migrate-out', async () => {
      const result = await window.api.exportMigrationBundle()
      if (result === null) return
      setMessage(`已导出迁移包：${result.path}（换电脑时在新电脑上导入它即可）`)
    })
  }

  const doImportBundle = (): void => {
    void run('migrate-in', async () => {
      const result = await window.api.importMigrationBundle()
      if (result === null) return
      setMessage(
        result.backupPath !== null
          ? `导入成功，原数据已自动备份到：${result.backupPath}`
          : '导入成功。'
      )
    })
  }

  return (
    <section className="page">
      <h1>设置</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}
      {message !== null && <div className="banner banner-success">{message}</div>}

      <div className="card">
        <h2>数据文件与备份</h2>
        {dbInfo !== null && (
          <>
            <p>
              数据文件位置：<span className="mono">{dbInfo.path}</span>
            </p>
            <p className="muted">
              全部数据保存在单一 SQLite 文件中——拷贝该文件即完成备份。更改位置时会把当前数据复制到新位置，
              重启软件后生效；恢复备份：关闭软件后把备份文件放回上述位置，再启动软件即可。
            </p>
            <p className="muted">
              Schema 版本：{dbInfo.schemaVersion} · 数据表：{dbInfo.tables.join('、')}
            </p>
            <div className="settings-actions">
              <button className="btn" onClick={changeDbPath} disabled={busy !== null}>
                {busy === 'path' ? '复制中…' : '更改数据文件位置…'}
              </button>
              {newPath !== null && (
                <button className="btn btn-primary" onClick={() => window.api.relaunchApp()}>
                  立即重启
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>导出备份</h2>
        <p className="muted">
          一键导出与软件内完全一致的数据（金额 2 位、净值 4 位、份额 2 位、比例百分比 2 位），
          中文表头，三张表分别为概览（汇总/持仓明细/大类配置对比）、流水、净值。
        </p>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={doExportExcel} disabled={busy !== null}>
            {busy === 'excel' ? '导出中…' : '导出 Excel'}
          </button>
          <button className="btn" onClick={doExportCsv} disabled={busy !== null}>
            {busy === 'csv' ? '导出中…' : '导出 CSV'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>换机迁移</h2>
        <p className="muted">
          在旧电脑上「导出迁移包」得到单个 .portibak 文件（全部数据 + 版本信息）；在新电脑上「导入迁移包」
          即可完整恢复，导入前会自动备份现有数据。
        </p>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={doExportBundle} disabled={busy !== null}>
            {busy === 'migrate-out' ? '导出中…' : '导出迁移包'}
          </button>
          <button className="btn" onClick={doImportBundle} disabled={busy !== null}>
            {busy === 'migrate-in' ? '导入中…' : '导入迁移包…'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>AI 分析</h2>
        <p className="muted">
          配置 OpenAI 兼容的 chat completions 端点后，可在「分析」页就当前持仓向 AI 提问。
          这是除净值抓取外唯一的联网能力：只有你点击发送时才会请求，数据只发往下面填写的地址。
        </p>

        {aiError !== null && <div className="banner banner-error">{aiError}</div>}
        {aiMessage !== null && <div className="banner banner-success">{aiMessage}</div>}
        {aiConfig !== null && !aiConfig.safeStorageAvailable && (
          <div className="banner banner-info">
            当前系统不支持安全存储（safeStorage），无法保存 API key（不会降级为明文）；地址与模型仍可保存。
          </div>
        )}

        <div className="form-grid">
          <label className="form-field">
            <span>供应商预设（只填地址，不自动选模型）</span>
            <select value={aiPreset} onChange={(e) => selectAiPreset(e.target.value)}>
              <option value="">自定义</option>
              {AI_PROVIDER_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.label}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>API 地址（base URL，填到 /v1 一级）</span>
            <input
              value={aiBaseUrl}
              onChange={(e) => {
                setAiBaseUrl(e.target.value)
                // 手改地址后不再代表所选预设，避免预设标签与地址不一致
                setAiPreset('')
              }}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="form-field">
            <span>模型名</span>
            <input
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              placeholder={aiPresetModelHint}
            />
          </label>
          <label className="form-field">
            <span>
              API key
              {aiConfig !== null && aiConfig.hasKey ? `（已保存：${aiConfig.keyMask}）` : ''}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={aiConfig !== null && aiConfig.hasKey ? '留空表示不更改' : 'sk-...'}
            />
          </label>
        </div>

        <p className="muted">
          API key 使用系统安全存储加密后保存在本机；保存后只显示掩码，不会再回显明文，也不会写入日志或分析快照。
        </p>

        <div className="settings-actions">
          <button className="btn" onClick={testAiConfig} disabled={aiBusy !== null}>
            {aiBusy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button className="btn btn-primary" onClick={saveAiConfig} disabled={aiBusy !== null}>
            {aiBusy === 'save' ? '保存中…' : '保存 AI 配置'}
          </button>
        </div>
      </div>
    </section>
  )
}
