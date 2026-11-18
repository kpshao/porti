import { useEffect, useState } from 'react'
import {
  EQUITY_RATIO_ERROR_TEXT,
  EQUITY_RATIO_SOURCE_LABEL,
  isValidEquityRatio,
  LEDGER_CATEGORIES,
  LEDGER_CATEGORY_BY_PRODUCT_FORM,
  normalizeFundUpdateInput,
  PRODUCT_FORMS
} from '../../../engine'
import type {
  Fund,
  LedgerCategory,
  NormalizedFundUpdate,
  ProductForm
} from '../../../engine'
import { EQUITY_FETCH_DATA_SOURCE_LABEL } from '../../../main/fundConfigTypes'
import type {
  EquityFetchEvent,
  EquityFetchResult,
  EquityRatioCandidate,
  EquityRatioConfirmInput,
  FundConfigData
} from '../../../main/fundConfigTypes'
import { formatPercent, ratioToPercentText } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

/** 行内编辑暂存值（只允许同时编辑一行） */
interface Draft {
  name: string
  productForm: ProductForm
  ledgerCategory: LedgerCategory
  equityRatioText: string // 百分比文本，保存时换算为 0–1
}

/** 单行抓取状态：进行中 / 逐行错误 / 待确认候选值 */
type FetchRowState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'candidate'
      candidate: EquityRatioCandidate
      ratioText: string // 候选值百分比文本，用户可改；改了则确认后来源记手工
      error: string | null
    }

function rowStateOf(result: EquityFetchResult): FetchRowState {
  if (result.ok) {
    return {
      status: 'candidate',
      candidate: result.candidate,
      ratioText: ratioToPercentText(result.candidate.stockRatio),
      error: null
    }
  }
  return { status: 'error', error: result.error }
}

function fundCodeOf(result: EquityFetchResult): string {
  return result.ok ? result.candidate.fundCode : result.fundCode
}

function draftOf(fund: Fund): Draft {
  return {
    name: fund.name,
    productForm: fund.productForm,
    ledgerCategory: fund.ledgerCategory,
    equityRatioText: ratioToPercentText(fund.equityRatio)
  }
}

export default function FundConfig(): React.JSX.Element {
  const [data, setData] = useState<FundConfigData | null>(null)
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [fetchStates, setFetchStates] = useState<Record<string, FetchRowState>>({})
  const [fetchMode, setFetchMode] = useState<'single' | 'batch' | null>(null)

  const reload = (): void => {
    window.api.fundConfigData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
  }, [])

  // 批量刷新时主进程逐行推送进展与结果：同一行先「抓取中」，再显示候选值或错误
  useEffect(() => {
    const unsubscribe = window.api.fundConfigOnEquityFetchEvent((event: EquityFetchEvent) => {
      if (event.type === 'started') {
        setFetchStates((prev) => ({ ...prev, [event.fundCode]: { status: 'loading' } }))
      } else {
        setFetchStates((prev) => ({ ...prev, [fundCodeOf(event.result)]: rowStateOf(event.result) }))
      }
    })
    return unsubscribe
  }, [])

  const clearFetchState = (code: string): void => {
    setFetchStates((prev) => {
      const next = { ...prev }
      delete next[code]
      return next
    })
  }

  const startEdit = (fund: Fund): void => {
    setError(null)
    setMessage(null)
    clearFetchState(fund.code)
    setEditingCode(fund.code)
    setDraft(draftOf(fund))
  }

  const cancelEdit = (): void => {
    setEditingCode(null)
    setDraft(null)
  }

  const actionsDisabled = busy || fetchMode !== null

  /** 抓取单只基金：只生成候选值，确认前不写库；失败保留原系数并逐行报错 */
  const fetchOne = async (fund: Fund): Promise<void> => {
    if (actionsDisabled || editingCode !== null) return
    setError(null)
    setMessage(null)
    setFetchMode('single')
    setFetchStates((prev) => ({ ...prev, [fund.code]: { status: 'loading' } }))
    try {
      const result = await window.api.fundConfigFetchEquity(fund.code)
      setFetchStates((prev) => ({ ...prev, [fund.code]: rowStateOf(result) }))
    } catch (e) {
      setFetchStates((prev) => ({
        ...prev,
        [fund.code]: { status: 'error', error: ipcErrorMessage(e) }
      }))
    } finally {
      setFetchMode(null)
    }
  }

  /** 刷新全部：主进程顺序抓取并控制频率；单只失败不影响其余基金 */
  const fetchAll = async (): Promise<void> => {
    const funds = data?.funds ?? []
    if (actionsDisabled || editingCode !== null || funds.length === 0) return
    setError(null)
    setMessage(null)
    setFetchMode('batch')
    setFetchStates({})
    try {
      const results = await window.api.fundConfigFetchEquityAll()
      // 逐行事件已实时更新；这里按最终结果再对齐一次，避免漏事件
      setFetchStates((prev) => {
        const next = { ...prev }
        for (const result of results) {
          next[fundCodeOf(result)] = rowStateOf(result)
        }
        return next
      })
      const failed = results.filter((result) => !result.ok).length
      setMessage(
        `刷新完成：${results.length - failed} 只成功，${failed} 只失败（失败行保留原系数，可逐行重试）。`
      )
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setFetchMode(null)
    }
  }

  /** 确认候选值并写入权益系数（来源与数据日期规则见 ADR-0006） */
  const confirmCandidate = async (fund: Fund): Promise<void> => {
    const row = fetchStates[fund.code]
    if (row === undefined || row.status !== 'candidate' || actionsDisabled) return
    setError(null)
    setMessage(null)

    const text = row.ratioText.trim()
    const ratio = text === '' ? Number.NaN : Number(text) / 100
    if (!isValidEquityRatio(ratio)) {
      setFetchStates((prev) => ({
        ...prev,
        [fund.code]: { ...row, error: EQUITY_RATIO_ERROR_TEXT }
      }))
      return
    }

    const input: EquityRatioConfirmInput = {
      fundCode: fund.code,
      confirmedRatio: ratio
    }
    setBusy(true)
    try {
      const updated = await window.api.fundConfigConfirmEquity(input)
      clearFetchState(fund.code)
      setMessage(
        `已写入 ${updated.code} 的权益系数 ${formatPercent(updated.equityRatio)}（来源：${EQUITY_RATIO_SOURCE_LABEL[updated.equityRatioSource]}；报告期 ${updated.equityRatioAsOf ?? '—'}）。`
      )
      reload()
    } catch (e) {
      setFetchStates((prev) => ({
        ...prev,
        [fund.code]: { ...row, error: ipcErrorMessage(e) }
      }))
    } finally {
      setBusy(false)
    }
  }

  /** 忽略候选值：同时清除主进程内存中的候选值 */
  const ignoreCandidate = (code: string): void => {
    void window.api.fundConfigDiscardEquity(code).catch(() => {})
    clearFetchState(code)
  }

  /** 保存一行：分类变更先确认（口径见 ADR-0004），改系数不弹确认；
   *  校验规则与主进程共用 normalizeFundUpdateInput。 */
  const save = async (fund: Fund): Promise<void> => {
    if (draft === null) return
    setError(null)
    setMessage(null)

    // 比例输入未改动时沿用原值，避免显示精度（2 位小数）截断库内原始系数；清空按非法值处理
    const ratioText = draft.equityRatioText.trim()
    const ratioUnchanged = ratioText === ratioToPercentText(fund.equityRatio)
    const equityRatio = ratioUnchanged ? fund.equityRatio : ratioText === '' ? Number.NaN : Number(ratioText) / 100

    let update: NormalizedFundUpdate
    try {
      update = normalizeFundUpdateInput({
        code: fund.code,
        name: draft.name,
        productForm: draft.productForm,
        ledgerCategory: draft.ledgerCategory,
        equityRatio
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }

    const classificationChanged =
      update.productForm !== fund.productForm || update.ledgerCategory !== fund.ledgerCategory
    if (classificationChanged) {
      const ok = window.confirm(
        `修改「${update.name}」的产品形态或账本大类后，该基金的全部历史会落到新分组并按新分类重算配置对比，且没有生效日期。确认修改？`
      )
      if (!ok) return
    }

    setBusy(true)
    try {
      await window.api.fundConfigUpdate(update)
      setEditingCode(null)
      setDraft(null)
      setMessage(
        classificationChanged
          ? `已保存：${fund.code} 的全部历史已按新分类重算。`
          : update.equityRatio !== fund.equityRatio
            ? '已保存：权益系数只影响当前配置，不重写历史。'
            : '已保存。'
      )
      reload()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const funds = data?.funds ?? []
  const hasData = data !== null

  return (
    <section className="page">
      <div className="page-head">
        <h1>基金配置</h1>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => void fetchAll()}
            disabled={actionsDisabled || editingCode !== null || funds.length === 0}
            title={
              funds.length === 0
                ? '暂无基金，请先在交易流水页新建基金或导入 Excel'
                : '顺序抓取全部基金的股票占净比（仅生成候选值）'
            }
          >
            {fetchMode === 'batch' ? '刷新中…' : '刷新全部'}
          </button>
        </div>
      </div>

      {error !== null && <div className="banner banner-error">{error}</div>}
      {message !== null && <div className="banner banner-success">{message}</div>}

      {hasData && funds.length === 0 && (
        <p className="placeholder">
          暂无基金。请先在「交易流水」页新建基金或导入 Excel；本页只维护已有基金。
        </p>
      )}

      {funds.length > 0 && (
        <div className="card card-fund-config">
          <table className="table table-fund-config">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>产品形态</th>
                <th>账本大类</th>
                <th>权益系数（%）</th>
                <th>股票占净比（季报）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((fund) => {
                const rowDraft = editingCode === fund.code ? draft : null
                const fetchRow = fetchStates[fund.code]
                return (
                  <tr key={fund.code}>
                    {/* 基金代码只读：净值历史与流水按代码关联，页面不提供修改入口 */}
                    <td className="fund-config-code">{fund.code}</td>
                    <td>
                      {rowDraft !== null ? (
                        <input
                          className="inline-edit fund-config-name"
                          type="text"
                          value={rowDraft.name}
                          disabled={busy}
                          onChange={(e) => setDraft({ ...rowDraft, name: e.target.value })}
                        />
                      ) : (
                        fund.name
                      )}
                    </td>
                    <td>
                      {rowDraft !== null ? (
                        <select
                          className="inline-edit"
                          value={rowDraft.productForm}
                          disabled={busy}
                          onChange={(e) => {
                            const productForm = e.target.value as ProductForm
                            // 账本大类按固定映射自动跟随；单独改账本大类仍由保存时校验兜底
                            setDraft({
                              ...rowDraft,
                              productForm,
                              ledgerCategory: LEDGER_CATEGORY_BY_PRODUCT_FORM[productForm]
                            })
                          }}
                        >
                          {PRODUCT_FORMS.map((form) => (
                            <option key={form} value={form}>
                              {form}
                            </option>
                          ))}
                        </select>
                      ) : (
                        fund.productForm
                      )}
                    </td>
                    <td>
                      {rowDraft !== null ? (
                        <select
                          className="inline-edit"
                          value={rowDraft.ledgerCategory}
                          disabled={busy}
                          onChange={(e) =>
                            setDraft({ ...rowDraft, ledgerCategory: e.target.value as LedgerCategory })
                          }
                        >
                          {LEDGER_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                      ) : (
                        fund.ledgerCategory
                      )}
                    </td>
                    <td>
                      {rowDraft !== null ? (
                        <input
                          className="inline-edit fund-config-ratio"
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={rowDraft.equityRatioText}
                          disabled={busy}
                          onChange={(e) => setDraft({ ...rowDraft, equityRatioText: e.target.value })}
                        />
                      ) : (
                        <>
                          <div className="fund-config-ratio-value">
                            {formatPercent(fund.equityRatio)}
                          </div>
                          <div className="fund-config-ratio-meta">
                            来源：{EQUITY_RATIO_SOURCE_LABEL[fund.equityRatioSource]} ·{' '}
                            {fund.equityRatioAsOf === null
                              ? '无报告期'
                              : `报告期 ${fund.equityRatioAsOf}`}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="fund-config-candidate">
                      {fetchRow === undefined ? (
                        <span className="muted">—</span>
                      ) : fetchRow.status === 'loading' ? (
                        <span className="muted">抓取中…</span>
                      ) : fetchRow.status === 'error' ? (
                        <span className="fund-config-candidate-error">{fetchRow.error}</span>
                      ) : (
                        <div className="fund-config-candidate-form">
                          <div className="fund-config-candidate-main">
                            <input
                              className="inline-edit fund-config-candidate-ratio"
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={fetchRow.ratioText}
                              disabled={busy || fetchMode !== null}
                              onChange={(e) =>
                                setFetchStates((prev) => ({
                                  ...prev,
                                  [fund.code]: {
                                    ...fetchRow,
                                    ratioText: e.target.value,
                                    error: null
                                  }
                                }))
                              }
                            />
                            <span>%</span>
                          </div>
                          <div className="fund-config-candidate-meta">
                            报告期 {fetchRow.candidate.reportDate} · 数据源：
                            {EQUITY_FETCH_DATA_SOURCE_LABEL[fetchRow.candidate.dataSource]}
                            {fetchRow.candidate.includesDepositaryReceipts ? '（含存托凭证）' : ''}
                          </div>
                          {fetchRow.error !== null && (
                            <div className="fund-config-candidate-error">{fetchRow.error}</div>
                          )}
                          <div className="fund-config-candidate-actions">
                            <button
                              className="btn btn-compact btn-primary"
                              onClick={() => void confirmCandidate(fund)}
                              disabled={busy || fetchMode !== null}
                            >
                              确认写入
                            </button>
                            <button
                              className="btn btn-compact"
                              onClick={() => ignoreCandidate(fund.code)}
                              disabled={busy || fetchMode !== null}
                            >
                              忽略
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="fund-config-actions">
                      {rowDraft !== null ? (
                        <>
                          <button
                            className="btn btn-compact btn-primary"
                            onClick={() => void save(fund)}
                            disabled={busy}
                          >
                            {busy ? '保存中…' : '保存'}
                          </button>
                          <button className="btn btn-compact" onClick={cancelEdit} disabled={busy}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn btn-compact"
                            onClick={() => startEdit(fund)}
                            disabled={actionsDisabled || editingCode !== null}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-compact"
                            onClick={() => void fetchOne(fund)}
                            disabled={actionsDisabled || editingCode !== null}
                          >
                            {fetchRow?.status === 'loading' ? '抓取中…' : '抓取'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="muted">
            基金代码只读（净值历史与流水按代码关联）；本页不提供新建或删除基金。产品形态与账本大类必须一致：固收+/纯债
            → 债，权益 → 权益，黄金 → 黄金。修改产品形态或账本大类后，该基金全部历史会按新分类重算且没有生效日期；修改权益系数只影响当前配置，不重写历史。目标比例仍在「概览」的配置对比表中编辑。
          </p>
          <p className="muted">
            「抓取」只读取东方财富公开季报数据，结果作为「股票占净比（季报）」候选值展示；点击「确认写入」后才更新权益系数——未改值来源记为抓取，改过值记为手工。抓取失败保留原系数，可逐行重试；本页不会后台、定时或启动时自动抓取。股票占净比不等于权益系数，可转债等股性部分请手工调整。
          </p>
        </div>
      )}
    </section>
  )
}
