import { useEffect, useState } from 'react'
import type { CommitPayload, ImportOutcome, ParseResult, SuspiciousField, TxData } from '../../../importer/types'
import type { Transaction, TransactionRow } from '../../../engine'
import type { TransactionInput } from '../../../engine'
import TransactionForm from '../components/TransactionForm'
import TransactionTable from '../components/TransactionTable'
import type { TxFilter, TxSort } from '../components/TransactionTable'
import { formatMoney, formatNav, formatPercent, formatShares } from '../utils/format'

/** 可疑行编辑值：键为 Excel 行号，值为用户修改后的字段 */
type Edits = Record<string, Partial<Transaction>>

type FormState = { mode: 'create' } | { mode: 'edit'; tx: TransactionRow } | null

const FIX_KIND_LABEL: Record<string, string> = {
  'code-zero-pad': '基金代码补前导零至 6 位',
  'name-requery': '名称按代码从基金列表重查',
  'snapshot-reconstruct': '收益快照重建为净值历史',
  'current-nav-import': '持仓概览最新净值导入',
  'field-normalize': '字段按库内约定归一化',
  'row-skipped': '跳过行'
}

const SUSPICIOUS_FIELD_LABEL: Record<SuspiciousField['field'], string> = {
  nav: '净值',
  shares: '份额',
  amount: '金额',
  date: '日期',
  fee: '手续费',
  note: '备注'
}

/** 对账表值格式：总收益率为百分比，其余为金额 */
function formatCheckValue(label: string, v: number): string {
  return label === '总收益率' ? formatPercent(v) : formatMoney(v)
}

/** 编辑值 → 数字；无效（空/非数字）返回 null */
function toNumberOrNull(value: string): number | null {
  if (value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export default function Transactions(): React.JSX.Element {
  const [txData, setTxData] = useState<TxData | null>(null)
  const [filter, setFilter] = useState<TxFilter>({ fundCode: 'all', type: 'all', from: '', to: '' })
  const [sort, setSort] = useState<TxSort>({ key: 'date', dir: 'asc' })
  const [formOpen, setFormOpen] = useState<FormState>(null)

  const [parse, setParse] = useState<ParseResult | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [edits, setEdits] = useState<Edits>({})
  const [busy, setBusy] = useState<'parsing' | 'committing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasData = txData !== null && (txData.transactions.length > 0 || txData.funds.length > 0)

  const reload = (): void => {
    window.api.txData().then(setTxData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
  }, [])

  const startImport = async (): Promise<void> => {
    setError(null)
    setBusy('parsing')
    try {
      const filePath = await window.api.pickImportFile()
      if (filePath === null) return
      const parsed = await window.api.parseImport(filePath)
      setOutcome(null)
      setEdits({})
      setParse(parsed)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const applySuggested = (
    rowId: string,
    field: SuspiciousField['field'],
    suggested: number | string | null | undefined
  ): void => {
    if (suggested === null || suggested === undefined) return
    setEdits((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [field]: suggested } }))
  }

  const editField = (rowId: string, field: SuspiciousField['field'], value: string): void => {
    setEdits((prev) => {
      const next = { ...prev[rowId] } as Record<string, unknown>
      const n = toNumberOrNull(value)
      // 数字字段：非法输入回退为原值；文本字段原样保留
      if (field === 'date' || field === 'note') {
        next[field] = value
      } else if (n !== null) {
        next[field] = n
      }
      return { ...prev, [rowId]: next as Partial<Transaction> }
    })
  }

  const commit = async (): Promise<void> => {
    if (parse === null) return
    setError(null)
    setBusy('committing')
    try {
      const transactions = parse.transactionRows.map((r) =>
        edits[r.rowId] ? { ...r.transaction, ...edits[r.rowId] } : r.transaction
      )
      const result = await window.api.commitImport({
        funds: parse.funds,
        categoryTargets: parse.categoryTargets,
        transactions,
        snapshots: parse.snapshots,
        currentNavs: parse.currentNavPoints,
        expectation: parse.expectation
      })
      setOutcome(result)
      setParse(null)
      reload()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const cancelPreview = (): void => {
    setParse(null)
    setEdits({})
    setOutcome(null)
    setError(null)
  }

  const submitForm = async (input: TransactionInput): Promise<void> => {
    if (formOpen === null) return
    if (formOpen.mode === 'create') {
      await window.api.txCreate(input)
    } else {
      await window.api.txUpdate(formOpen.tx.id, input)
    }
    setFormOpen(null)
    reload()
  }

  const deleteRow = async (row: TransactionRow): Promise<void> => {
    const fundName = txData?.funds.find((f) => f.code === row.fundCode)?.name ?? row.fundCode
    if (!window.confirm(`确认删除 ${row.date} ${row.type}「${fundName}」这笔流水？删除后汇总将重新计算。`)) return
    try {
      await window.api.txDelete(row.id)
      reload()
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>交易流水</h1>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setFormOpen({ mode: 'create' })}>
            新增流水
          </button>
          <button
            className="btn"
            onClick={startImport}
            disabled={busy !== null || hasData}
            title={hasData ? '已导入过数据，重复导入会重复计入（需先清空数据库）' : undefined}
          >
            {busy === 'parsing' ? '解析中…' : '导入 Excel'}
          </button>
        </div>
      </div>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {hasData && txData.totals !== null && (
        <div className="card summary-card">
          <div className="stat">
            <div className="stat-label">总资产</div>
            <div className="stat-value">{formatMoney(txData.totals.totalAssets)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">总盈亏</div>
            <div className={`stat-value ${txData.totals.totalPnl >= 0 ? 'positive' : 'negative'}`}>
              {formatMoney(txData.totals.totalPnl)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">总收益率</div>
            <div className={`stat-value ${(txData.totals.totalReturnRate ?? 0) >= 0 ? 'positive' : 'negative'}`}>
              {formatPercent(txData.totals.totalReturnRate)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">落袋收益</div>
            <div className="stat-value">{formatMoney(txData.totals.realizedIncome)}</div>
          </div>
        </div>
      )}

      {formOpen !== null && (
        <TransactionForm
          key={formOpen.mode === 'edit' ? formOpen.tx.id : 'new'}
          funds={txData?.funds ?? []}
          initial={formOpen.mode === 'edit' ? formOpen.tx : null}
          onSubmit={submitForm}
          onCancel={() => setFormOpen(null)}
          onFundCreated={reload}
        />
      )}

      {hasData && (
        <div className="card">
          <TransactionTable
            rows={txData?.transactions ?? []}
            funds={txData?.funds ?? []}
            filter={filter}
            onFilterChange={setFilter}
            sort={sort}
            onSortChange={setSort}
            onEdit={(tx) => setFormOpen({ mode: 'edit', tx })}
            onDelete={deleteRow}
          />
        </div>
      )}

      {parse !== null && (
        <div className="card import-preview">
          <h2>导入预览 — 投资跟踪.xlsx</h2>
          <p className="muted">
            预计导入 {parse.summary.fundCount} 只基金、{parse.summary.transactionCount} 笔流水、
            快照 {parse.summary.snapshotPeriodCount} 期 {parse.summary.snapshotRowCount} 行（重建净值历史）、
            当前净值 {parse.summary.currentNavCount} 条。
          </p>

          <h3>自动修复项（{parse.fixes.length}）</h3>
          <ul className="fix-list">
            {parse.fixes.map((f, i) => (
              <li key={i}>
                <span className="fix-tag">{f.kind === 'row-skipped' ? '跳过' : '修复'}</span>
                {FIX_KIND_LABEL[f.kind] ?? f.detail} — {f.count} 处
                <div className="muted fix-detail">{f.detail}</div>
              </li>
            ))}
          </ul>

          <h3>可疑项（{parse.suspicious.length}，可修改后导入）</h3>
          {parse.suspicious.length === 0 ? (
            <p className="muted">无可疑项。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>行号</th>
                  <th>日期</th>
                  <th>基金</th>
                  <th>操作</th>
                  <th>可疑字段</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {parse.suspicious.map((s) => (
                  <tr key={s.rowId}>
                    <td>第 {s.excelRow} 行</td>
                    <td>{s.date}</td>
                    <td>
                      {s.fundCode} {s.fundName}
                    </td>
                    <td>{s.type}</td>
                    <td>
                      <div className="field-edits">
                        {s.fields.map((f) => {
                          const current = edits[s.rowId]?.[f.field] ?? f.value
                          return (
                            <div key={f.field} className="field-edit">
                              <label>{SUSPICIOUS_FIELD_LABEL[f.field]}</label>
                              {f.field === 'date' || f.field === 'note' ? (
                                <input
                                  type="text"
                                  value={String(current ?? '')}
                                  onChange={(e) => editField(s.rowId, f.field, e.target.value)}
                                />
                              ) : (
                                <input
                                  type="number"
                                  step="any"
                                  value={current === null ? '' : Number(current)}
                                  onChange={(e) => editField(s.rowId, f.field, e.target.value)}
                                />
                              )}
                              {f.suggested !== null && f.suggested !== undefined && (
                                <button
                                  className="btn btn-small"
                                  onClick={() => applySuggested(s.rowId, f.field, f.suggested)}
                                >
                                  用建议值 {f.field === 'nav' ? formatNav(Number(f.suggested)) : f.suggested}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </td>
                    <td className="muted">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="preview-actions">
            <button className="btn btn-primary" onClick={commit} disabled={busy !== null}>
              {busy === 'committing' ? '导入中…' : '确认导入'}
            </button>
            <button className="btn" onClick={cancelPreview} disabled={busy !== null}>
              取消
            </button>
          </div>
        </div>
      )}

      {outcome !== null && (
        <div className="card import-result">
          <h2>导入完成</h2>
          <p className="muted">
            已导入 {outcome.counts.funds} 只基金、{outcome.counts.transactions} 笔流水、
            净值历史 {outcome.counts.reconstructedNavs + outcome.counts.currentNavs} 条
            （快照重建 {outcome.counts.reconstructedNavs} + 当前净值 {outcome.counts.currentNavs}）。
          </p>

          <h3>
            与 Excel 对账结果：
            {outcome.report.allMatch ? (
              <span className="match-ok">全部一致 ✓</span>
            ) : (
              <span className="match-bad">存在差异 ✗</span>
            )}
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>指标</th>
                <th>Excel</th>
                <th>Porti 计算</th>
                <th>差异</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {outcome.report.totals.checks.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td>{formatCheckValue(c.label, c.excel)}</td>
                  <td>{formatCheckValue(c.label, c.computed)}</td>
                  <td>{formatCheckValue(c.label, c.diff)}</td>
                  <td>{c.match ? '一致 ✓' : '不一致 ✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>持仓明细对账（{outcome.report.funds.length} 只基金）</h3>
          {txData !== null && txData.positions.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>基金代码</th>
                  <th>名称</th>
                  <th>当前份额</th>
                  <th>最新净值</th>
                  <th>当前市值</th>
                  <th>持仓盈亏</th>
                  <th>盈亏比例</th>
                  <th>对账</th>
                </tr>
              </thead>
              <tbody>
                {txData.positions
                  .filter((p) => p.shares !== 0)
                  .map((p) => {
                    const match = outcome.report.funds.find((f) => f.code === p.fundCode)?.match ?? false
                    return (
                      <tr key={p.fundCode}>
                        <td>{p.fundCode}</td>
                        <td>{p.name}</td>
                        <td>{formatShares(p.shares)}</td>
                        <td>{formatNav(p.latestNav)}</td>
                        <td>{formatMoney(p.marketValue)}</td>
                        <td className={(p.pnl ?? 0) >= 0 ? 'positive' : 'negative'}>
                          {formatMoney(p.pnl)}
                        </td>
                        <td>{formatPercent(p.pnlRatio)}</td>
                        <td>{match ? '一致 ✓' : '不一致 ✗'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          )}

          <p className="muted">
            收益汇总逐期比对：{outcome.report.series.length} 期
            {outcome.report.series.every((s) => s.match) ? '全部一致 ✓' : '存在不一致 ✗'}
          </p>
        </div>
      )}

      {!hasData && parse === null && outcome === null && (
        <p className="placeholder">
          暂无流水数据。可点击右上角「导入 Excel」一键迁移投资跟踪.xlsx（导入前会展示预览清单），
          或直接「新增流水」手动录入。
        </p>
      )}
    </section>
  )
}
