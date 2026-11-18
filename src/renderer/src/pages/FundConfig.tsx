import { useEffect, useState } from 'react'
import {
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
import type { FundConfigData } from '../../../main/fundConfigTypes'
import { formatPercent, ratioToPercentText } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

/** 行内编辑暂存值（只允许同时编辑一行） */
interface Draft {
  name: string
  productForm: ProductForm
  ledgerCategory: LedgerCategory
  equityRatioText: string // 百分比文本，保存时换算为 0–1
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

  const reload = (): void => {
    window.api.fundConfigData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
  }, [])

  const startEdit = (fund: Fund): void => {
    setError(null)
    setMessage(null)
    setEditingCode(fund.code)
    setDraft(draftOf(fund))
  }

  const cancelEdit = (): void => {
    setEditingCode(null)
    setDraft(null)
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
      <h1>基金配置</h1>

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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((fund) => {
                const rowDraft = editingCode === fund.code ? draft : null
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
                        formatPercent(fund.equityRatio)
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
                        <button
                          className="btn btn-compact"
                          onClick={() => startEdit(fund)}
                          disabled={editingCode !== null}
                        >
                          编辑
                        </button>
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
        </div>
      )}
    </section>
  )
}
