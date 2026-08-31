import { useEffect, useState } from 'react'
import { ipcErrorMessage } from '../utils/ipc'

export default function Settings(): React.JSX.Element {
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState<'excel' | 'csv' | 'path' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newPath, setNewPath] = useState<string | null>(null)

  useEffect(() => {
    window.api.dbInfo().then(setDbInfo).catch((e) => setError(ipcErrorMessage(e)))
  }, [])

  /** 异步操作的公共包装：清旧消息 → 忙态 → 错误回显 → 复位（三个按钮共用） */
  const run = async (busyKey: 'excel' | 'csv' | 'path', fn: () => Promise<void>): Promise<void> => {
    setError(null)
    setMessage(null)
    setBusy(busyKey)
    try {
      await fn()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

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
    </section>
  )
}
