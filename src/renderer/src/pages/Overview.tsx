import { useEffect, useState } from 'react'
import type { OverviewData } from '../../../main/overviewTypes'
import FundDetail from '../components/FundDetail'
import { formatMoney, formatNav, formatPercent, formatShares } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'
import { pnlClass } from '../utils/pnl'

/** 行内编辑暂存值：键为基金代码（目标金额）或大类名（目标比例） */
type Edits = Record<string, string>

/** 目标比例输入以百分比显示与录入（界面约定：比例保留 2 位） */
function ratioToPercentText(ratio: number): string {
  return (ratio * 100).toFixed(2)
}

/** 行内数字编辑框：失焦或回车提交（概览页目标金额/目标比例共用） */
function InlineNumberEdit(props: {
  value: string
  disabled: boolean
  step?: string
  min?: string
  max?: string
  onChange: (text: string) => void
  onCommit: () => void
}): React.JSX.Element {
  return (
    <input
      className="inline-edit"
      type="number"
      step={props.step}
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export default function Overview(): React.JSX.Element {
  const [data, setData] = useState<OverviewData | null>(null)
  const [amountEdits, setAmountEdits] = useState<Edits>({})
  const [ratioEdits, setRatioEdits] = useState<Edits>({})
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ code: string; name: string } | null>(null)

  const reload = (): void => {
    window.api.overviewData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
  }, [])

  const hasData = data !== null && data.funds.length > 0

  /** 提交目标金额：空 = 清空；非数字本地回退，范围校验由服务层把关（中文错误回显） */
  const commitTargetAmount = (code: string): void => {
    const raw = amountEdits[code]
    if (raw === undefined || data === null) return
    const original = data.funds.find((f) => f.code === code)?.targetAmount ?? null
    const revert = (): void =>
      setAmountEdits((prev) => ({ ...prev, [code]: original === null ? '' : String(original) }))
    const trimmed = raw.trim()
    let next: number | null
    if (trimmed === '') {
      next = null
    } else {
      const n = Number(trimmed)
      if (!Number.isFinite(n)) {
        setError('目标金额需为数字（留空表示清空）')
        revert()
        return
      }
      next = n
    }
    if (next === original) {
      revert()
      return
    }
    setBusy(true)
    window.api
      .fundUpdateTarget(code, next)
      .then(reload)
      .catch((e) => {
        setError(ipcErrorMessage(e))
        revert()
      })
      .finally(() => setBusy(false))
  }

  /** 提交目标比例（百分比录入）：非数字本地回退，范围校验由服务层把关 */
  const commitTargetRatio = (category: string): void => {
    const raw = ratioEdits[category]
    if (raw === undefined || data === null) return
    const original = data.comparison.find((r) => r.category === category)?.targetRatio ?? 0
    const revert = (): void => setRatioEdits((prev) => ({ ...prev, [category]: ratioToPercentText(original) }))
    const n = Number(raw.trim())
    if (!Number.isFinite(n)) {
      setError('目标比例需为百分比数字（0–100）')
      revert()
      return
    }
    const next = n / 100
    if (Math.abs(next - original) < 1e-9) {
      revert()
      return
    }
    setBusy(true)
    window.api
      .targetUpdateCategory(category, next)
      .then(reload)
      .catch((e) => {
        setError(ipcErrorMessage(e))
        revert()
      })
      .finally(() => setBusy(false))
  }

  return (
    <section className="page">
      <h1>概览</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {hasData && data.totals !== null && (
        <div className="card summary-card">
          <div className="stat">
            <div className="stat-label">总资产</div>
            <div className="stat-value">{formatMoney(data.totals.totalAssets)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">持仓盈亏</div>
            <div className={`stat-value ${pnlClass(data.totals.totalPnl)}`}>
              {formatMoney(data.totals.totalPnl)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">累计收益率</div>
            <div className={`stat-value ${pnlClass(data.totals.totalReturnRate)}`}>
              {formatPercent(data.totals.totalReturnRate)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">年化收益率</div>
            <div className={`stat-value ${pnlClass(data.annualized.total)}`}>
              {formatPercent(data.annualized.total)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">已实现盈亏</div>
            <div className={`stat-value ${pnlClass(data.totals.realizedIncome)}`}>
              {formatMoney(data.totals.realizedIncome)}
            </div>
          </div>
        </div>
      )}

      {hasData && (
        <div className="card">
          <h2>持仓明细</h2>
          <table className="table table-positions">
            <thead>
              <tr>
                <th>大类</th>
                <th>大类市值</th>
                <th>代码</th>
                <th>名称</th>
                <th>份额</th>
                <th>持仓成本</th>
                <th>最新净值</th>
                <th>市值</th>
                <th>持仓盈亏</th>
                <th>盈亏比例</th>
                <th>年化收益率</th>
                <th>目标金额（元）</th>
              </tr>
            </thead>
            {/* 每个大类一个 tbody：首两列（大类 / 大类市值）只在组内第一行渲染并 rowSpan 合并到整组 */}
            {data.positionGroups.map((group) => (
              <tbody key={group.category}>
                {group.positions.map((p, rowIndex) => {
                  const editValue = amountEdits[p.fundCode]
                  const inputValue =
                    editValue !== undefined ? editValue : p.targetAmount === null ? '' : String(p.targetAmount)
                  const annualized = data.annualized.perFund[p.fundCode]
                  return (
                    <tr key={p.fundCode}>
                      {rowIndex === 0 && (
                        <>
                          <td className="group-cell" rowSpan={group.positions.length}>
                            {group.category}
                          </td>
                          <td className="group-cell" rowSpan={group.positions.length}>
                            {formatMoney(group.marketValue)}
                          </td>
                        </>
                      )}
                      <td>{p.fundCode}</td>
                      <td>
                        <button
                          className="fund-link"
                          onClick={() => setDetail({ code: p.fundCode, name: p.name })}
                        >
                          {p.name}
                        </button>
                      </td>
                      <td>{formatShares(p.shares)}</td>
                      <td>{formatMoney(p.costBasis)}</td>
                      <td>{formatNav(p.latestNav)}</td>
                      <td>{formatMoney(p.marketValue)}</td>
                      <td className={pnlClass(p.pnl)}>{formatMoney(p.pnl)}</td>
                      <td className={pnlClass(p.pnlRatio)}>{formatPercent(p.pnlRatio)}</td>
                      <td className={pnlClass(annualized)}>{formatPercent(annualized)}</td>
                      <td>
                        <InlineNumberEdit
                          value={inputValue}
                          disabled={busy}
                          step="any"
                          min="0"
                          onChange={(text) =>
                            setAmountEdits((prev) => ({ ...prev, [p.fundCode]: text }))
                          }
                          onCommit={() => commitTargetAmount(p.fundCode)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>
          <p className="muted">
            目标金额可直接在行内修改（留空清空），失焦或回车后保存，配置对比实时更新；点击基金名称可查看基金详情与收益走势。
          </p>
        </div>
      )}

      {hasData && (
        <div className="card">
          <h2>大类配置对比</h2>
          <table className="table">
            <thead>
              <tr>
                <th>大类</th>
                <th>目标比例（%）</th>
                <th>实际投入比例</th>
                <th>实际市值占比</th>
                <th>偏离（市值占比 − 目标）</th>
              </tr>
            </thead>
            <tbody>
              {data.comparison.map((r) => {
                const editValue = ratioEdits[r.category]
                const inputValue = editValue !== undefined ? editValue : ratioToPercentText(r.targetRatio)
                const dev = r.deviation ?? 0
                const devClass = dev > 1e-9 ? 'positive' : dev < -1e-9 ? 'negative' : ''
                return (
                  <tr key={r.category}>
                    <td>{r.category}</td>
                    <td>
                      <InlineNumberEdit
                        value={inputValue}
                        disabled={busy}
                        step="0.01"
                        min="0"
                        max="100"
                        onChange={(text) =>
                          setRatioEdits((prev) => ({ ...prev, [r.category]: text }))
                        }
                        onCommit={() => commitTargetRatio(r.category)}
                      />
                    </td>
                    <td>{formatPercent(r.investedRatio)}</td>
                    <td>{formatPercent(r.marketRatio)}</td>
                    <td className={devClass}>
                      {formatPercent(r.deviation)}
                      {dev > 1e-9 ? ' ↑超配' : dev < -1e-9 ? ' ↓低配' : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="muted">
            目标比例可直接修改（百分比，0–100），失焦或回车后保存并实时重算偏离；红色表示超配、绿色表示低配。
          </p>
        </div>
      )}

      {!hasData && (
        <p className="placeholder">
          暂无数据。请先在「交易流水」页导入 Excel 或新增基金，概览将实时汇总持仓与配置对比。
        </p>
      )}

      {detail !== null && (
        <FundDetail fundCode={detail.code} fundName={detail.name} onClose={() => setDetail(null)} />
      )}
    </section>
  )
}
