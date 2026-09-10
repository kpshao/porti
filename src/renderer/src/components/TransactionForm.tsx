import { useState } from 'react'
import type { Fund, OperationType, TransactionRow } from '../../../engine'
import { CATEGORIES, normalizeFundCode, normalizeTransactionInput, OPERATION_TYPES } from '../../../engine'
import type { FundInput, TransactionInput } from '../../../engine'

/** 字符串 → 数字；空/非法返回 null */
function numOrNull(s: string): number | null {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function toNumberString(n: number | null): string {
  return n === null ? '' : String(n)
}

interface TransactionFormProps {
  funds: Fund[]
  /** 编辑时传入原流水；null 表示新建 */
  initial: TransactionRow | null
  onSubmit: (input: TransactionInput) => Promise<void>
  onCancel: () => void
  /** 内联新建基金成功后通知父组件刷新基金列表 */
  onFundCreated: () => void
}

export default function TransactionForm({
  funds,
  initial,
  onSubmit,
  onCancel,
  onFundCreated
}: TransactionFormProps): React.JSX.Element {
  // 库内约定卖出存负值；表单一律按正数录入与显示
  const abs = (n: number | null): string => (n === null ? '' : String(Math.abs(n)))

  const [date, setDate] = useState(initial?.date ?? '')
  const [type, setType] = useState<OperationType>(initial?.type ?? '买入')
  const [fundCode, setFundCode] = useState(initial?.fundCode ?? '')
  const [amount, setAmount] = useState(initial ? abs(initial.amount) : '')
  const [shares, setShares] = useState(initial && initial.type !== '分红现金' ? abs(initial.shares) : '')
  const [nav, setNav] = useState(toNumberString(initial?.nav ?? null))
  const [fee, setFee] = useState(initial === null ? '0' : toNumberString(initial.fee))
  const [note, setNote] = useState(initial?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  // 内联新建基金
  const [fundFormOpen, setFundFormOpen] = useState(false)
  const [fundCodeInput, setFundCodeInput] = useState('')
  const [fundNameInput, setFundNameInput] = useState('')
  const [fundCategory, setFundCategory] = useState('固守+')
  const [fundTypeInput, setFundTypeInput] = useState('')
  const [fundError, setFundError] = useState<string | null>(null)
  const [fundBusy, setFundBusy] = useState(false)

  const save = async (): Promise<void> => {
    setError(null)
    const input: TransactionInput = {
      date,
      type,
      fundCode,
      amount: numOrNull(amount),
      shares: numOrNull(shares),
      nav: numOrNull(nav),
      fee: numOrNull(fee),
      note: note === '' ? null : note
    }
    try {
      normalizeTransactionInput(input) // 客户端先校验，与服务端同一规则
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    try {
      await onSubmit(input)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const createFund = async (): Promise<void> => {
    setFundError(null)
    const code = normalizeFundCode(fundCodeInput)
    if (code === null) {
      setFundError('基金代码需为 6 位数字')
      return
    }
    if (fundNameInput.trim() === '') {
      setFundError('基金名称不能为空')
      return
    }
    const input: FundInput = {
      code,
      name: fundNameInput.trim(),
      category: fundCategory,
      fundType: fundTypeInput.trim() === '' ? null : fundTypeInput.trim(),
      targetAmount: null
    }
    setFundBusy(true)
    try {
      await window.api.fundCreate(input)
      setFundCode(code)
      setFundFormOpen(false)
      onFundCreated()
    } catch (e) {
      setFundError(e instanceof Error ? e.message : String(e))
    } finally {
      setFundBusy(false)
    }
  }

  return (
    <div className="card form-card">
      <h2>{initial === null ? '新增流水' : `编辑流水 #${initial.id}`}</h2>
      <div className="form-grid">
        <label className="form-field">
          <span>日期</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="form-field">
          <span>操作类型</span>
          <select value={type} onChange={(e) => setType(e.target.value as OperationType)}>
            {OPERATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>基金</span>
          <select value={fundCode} onChange={(e) => setFundCode(e.target.value)}>
            <option value="">— 选择基金 —</option>
            {funds.map((f) => (
              <option key={f.code} value={f.code}>
                {f.code} {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>金额（元，含手续费）</span>
          <input
            type="number"
            step="any"
            value={amount}
            disabled={type === '分红再投入'}
            placeholder={type === '分红再投入' ? '空（只加份额）' : type === '卖出' ? '录入正数' : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span>份额</span>
          <input
            type="number"
            step="any"
            value={shares}
            disabled={type === '分红现金'}
            placeholder={type === '分红现金' ? '空' : type === '卖出' ? '录入正数' : undefined}
            onChange={(e) => setShares(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span>净值</span>
          <input type="number" step="any" value={nav} onChange={(e) => setNav(e.target.value)} />
        </label>
        <label className="form-field">
          <span>手续费（元）</span>
          <input type="number" step="any" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label className="form-field">
          <span>备注</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="form-field">
          <span />
          <button className="btn btn-small" onClick={() => setFundFormOpen(!fundFormOpen)}>
            {fundFormOpen ? '收起新建基金' : '＋ 列表中没有？新建基金'}
          </button>
        </div>
      </div>

      {fundFormOpen && (
        <div className="fund-form">
          <div className="form-grid">
            <label className="form-field">
              <span>基金代码</span>
              <input
                type="text"
                value={fundCodeInput}
                placeholder="6 位数字"
                onChange={(e) => setFundCodeInput(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span>基金名称</span>
              <input type="text" value={fundNameInput} onChange={(e) => setFundNameInput(e.target.value)} />
            </label>
            <label className="form-field">
              <span>资产大类</span>
              <select value={fundCategory} onChange={(e) => setFundCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>基金类型（可选）</span>
              <input type="text" value={fundTypeInput} onChange={(e) => setFundTypeInput(e.target.value)} />
            </label>
          </div>
          {fundError !== null && <div className="form-error">{fundError}</div>}
          <div className="preview-actions">
            <button className="btn btn-primary" onClick={createFund} disabled={fundBusy}>
              {fundBusy ? '创建中…' : '创建基金'}
            </button>
          </div>
        </div>
      )}

      {error !== null && <div className="form-error">{error}</div>}
      <div className="preview-actions">
        <button className="btn btn-primary" onClick={save}>
          保存
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <span className="muted">金额为含手续费的实付总额（成本按含手续费金额计）；卖出录入正数即可；手续费留空默认 0。</span>
      </div>
    </div>
  )
}
