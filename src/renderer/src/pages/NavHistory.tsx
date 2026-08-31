import { useEffect, useState } from 'react'
import { NAV_SOURCE_LABEL } from '../../../engine'
import type { NavPoint } from '../../../engine'
import type { FetchStatus, NavData } from '../../../main/navTypes'
import { formatNav } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

const SOURCE_TAG_CLASS: Record<NavPoint['source'], string> = {
  import: 'tag tag-source-import',
  auto: 'tag tag-source-auto',
  manual: 'tag tag-source-manual'
}

/** 本地时区今日 YYYY-MM-DD（手动补录默认日期） */
function todayString(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function NavHistory(): React.JSX.Element {
  const [data, setData] = useState<NavData | null>(null)
  const [fundFilter, setFundFilter] = useState<string>('all')
  const [fetchStatus, setFetchStatus] = useState<FetchStatus | null>(null)
  const [busy, setBusy] = useState<'fetching' | 'saving' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ fundCode: string; date: string; nav: string }>({
    fundCode: '',
    date: todayString(),
    nav: ''
  })

  const reload = (): void => {
    window.api.navData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
    // 启动自动抓取仍在进行时轮询状态（3s × 6 次，覆盖 8s 超时），结束后刷新数据
    const pollStatus = (attemptsLeft: number): void => {
      window.api
        .navFetchStatus()
        .then((status) => {
          setFetchStatus(status)
          if (status.state === 'running' && attemptsLeft > 0) {
            setTimeout(() => pollStatus(attemptsLeft - 1), 3000)
          } else if (status.state !== 'running') {
            reload()
          }
        })
        .catch(() => {})
    }
    pollStatus(6)
  }, [])

  const doFetch = async (): Promise<void> => {
    setBusy('fetching')
    setError(null)
    setMessage(null)
    try {
      const result = await window.api.navFetch()
      setMessage(result.message)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setFetchStatus(await window.api.navFetchStatus())
      setBusy(null)
      reload()
    }
  }

  const submitManual = async (): Promise<void> => {
    // 仅做空值前置检查；日期格式与净值正数校验由服务层归一化统一把关（中文错误回显）
    const nav = Number(form.nav)
    if (form.fundCode === '' || form.date === '' || form.nav.trim() === '' || !Number.isFinite(nav)) {
      setError('请选择基金并填写日期与净值')
      return
    }
    // 同基金同日已有记录：明确处理方式 = 确认后覆盖为手动记录
    const existing = data?.navPoints.find((p) => p.fundCode === form.fundCode && p.date === form.date)
    if (existing !== undefined) {
      const fundName = data?.funds.find((f) => f.code === form.fundCode)?.name ?? form.fundCode
      const ok = window.confirm(
        `基金「${fundName}」${form.date} 已有净值记录（来源：${NAV_SOURCE_LABEL[existing.source]}，净值 ${formatNav(existing.nav)}）。确认覆盖为手动记录？`
      )
      if (!ok) return
    }
    setBusy('saving')
    setError(null)
    setMessage(null)
    try {
      await window.api.navPut({ fundCode: form.fundCode, date: form.date, nav })
      setMessage(`已补录 ${form.fundCode} ${form.date} 净值 ${formatNav(nav)}（来源：手动）`)
      setForm((prev) => ({ ...prev, nav: '' }))
      reload()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const funds = data?.funds ?? []
  const nameByCode = new Map(funds.map((f) => [f.code, f.name]))
  const rows = (data?.navPoints ?? [])
    .filter((p) => fundFilter === 'all' || p.fundCode === fundFilter)
    .sort((a, b) => (a.date < b.date ? 1 : -1))

  const selectedFund = form.fundCode === '' ? (funds[0]?.code ?? '') : form.fundCode

  return (
    <section className="page">
      <div className="page-head">
        <h1>净值管理</h1>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={doFetch}
            disabled={busy !== null || funds.length === 0}
            title={funds.length === 0 ? '暂无基金，请先在交易流水页导入或新建基金' : undefined}
          >
            {busy === 'fetching' ? '抓取中…' : '一键抓取最新净值'}
          </button>
        </div>
      </div>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {/* 启动自动抓取状态：成功静默更新（仅小字提示），失败给出横幅提示（不阻塞启动） */}
      {fetchStatus !== null && fetchStatus.state === 'failed' && (
        <div className="banner banner-error">
          启动自动抓取失败：{fetchStatus.message}。可点击「一键抓取」重试，或手动补录。
        </div>
      )}
      {fetchStatus !== null && fetchStatus.state === 'running' && (
        <div className="banner banner-info">正在自动抓取最新净值…</div>
      )}
      {message !== null && <div className="banner banner-success">{message}</div>}
      {fetchStatus !== null &&
        fetchStatus.state === 'ok' &&
        message === null &&
        !fetchStatus.message.includes('暂无基金') && (
          <p className="muted">{fetchStatus.message}</p>
        )}

      {funds.length > 0 && (
        <div className="card form-card">
          <h2>手动补录净值</h2>
          <div className="form-grid">
            <div className="form-field">
              <span>基金</span>
              <select
                value={selectedFund}
                onChange={(e) => setForm((prev) => ({ ...prev, fundCode: e.target.value }))}
              >
                {funds.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.code} {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <span>日期</span>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <span>净值</span>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="如 1.2345"
                value={form.nav}
                onChange={(e) => setForm((prev) => ({ ...prev, nav: e.target.value }))}
              />
            </div>
          </div>
          <p className="muted">同基金同日已有记录时，提交前会要求确认覆盖（来源变为手动）。</p>
          <button
            className="btn btn-primary"
            onClick={submitManual}
            disabled={busy !== null || funds.length === 0}
          >
            {busy === 'saving' ? '保存中…' : '补录'}
          </button>
        </div>
      )}

      {funds.length > 0 && (
        <div className="card">
          <div className="filter-bar">
            <label>基金</label>
            <select value={fundFilter} onChange={(e) => setFundFilter(e.target.value)}>
              <option value="all">全部基金</option>
              {funds.map((f) => (
                <option key={f.code} value={f.code}>
                  {f.code} {f.name}
                </option>
              ))}
            </select>
            <span className="filter-count muted">{rows.length} 条记录</span>
          </div>

          {rows.length === 0 ? (
            <p className="muted">该基金暂无净值记录。可点击「一键抓取最新净值」或手动补录。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>基金</th>
                  <th>净值</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={`${p.fundCode}-${p.date}`}>
                    <td>{p.date}</td>
                    <td>
                      {p.fundCode} {nameByCode.get(p.fundCode) ?? ''}
                    </td>
                    <td>{formatNav(p.nav)}</td>
                    <td>
                      <span className={SOURCE_TAG_CLASS[p.source]}>{NAV_SOURCE_LABEL[p.source]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {funds.length === 0 && (
        <p className="placeholder">
          暂无基金数据。请先在「交易流水」页导入 Excel 或新增基金；持仓基金的净值将自动抓取，也可在此手动补录。
        </p>
      )}
    </section>
  )
}
