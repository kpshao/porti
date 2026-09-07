// 首启迁移引导：新安装（空库）且未被跳过时弹窗，提供「导入迁移包 / 稍后再说」
import { useEffect, useState } from 'react'
import { ipcErrorMessage } from '../utils/ipc'

export default function FirstRunDialog(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api
      .migrationFirstRunCheck()
      .then((r) => setVisible(r.shouldPrompt))
      .catch(() => {}) // 检查失败静默，不打扰
  }, [])

  if (!visible) return null

  const doImport = (): void => {
    setBusy(true)
    setError(null)
    window.api
      .importMigrationBundle()
      .then(() => setVisible(false)) // 成功后主进程会刷新窗口；若未刷新也收起弹窗
      .catch((e) => {
        setError(ipcErrorMessage(e))
        setBusy(false)
      })
  }

  const dismiss = (): void => {
    void window.api.dismissMigrationPrompt()
    setVisible(false)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>欢迎使用 Porti</h2>
        <p>
          检测到新安装。如果之前在另一台电脑使用过 Porti，可以导入迁移包恢复全部数据（导出方法见旧电脑
          「设置 → 换机迁移」）。
        </p>
        {error !== null && <div className="banner banner-error">{error}</div>}
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={doImport} disabled={busy}>
            {busy ? '导入中…' : '导入迁移包…'}
          </button>
          <button className="btn" onClick={dismiss} disabled={busy}>
            稍后再说
          </button>
        </div>
      </div>
    </div>
  )
}
