import { useEffect, useState } from 'react'
import { CLOSED_CATEGORY } from '../../../engine'
import type { AllocationBucket, BucketTarget } from '../../../engine'
import type { OverviewData } from '../../../main/overviewTypes'
import FundDetail from '../components/FundDetail'
import SummaryCards from '../components/SummaryCards'
import { MERGED_BUY_HINT } from '../utils/annualized'
import { formatMoney, formatNav, formatPercent, formatShares } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'
import { pnlClass } from '../utils/pnl'

/** 行内编辑暂存值：键为配置桶名（目标比例） */
type Edits = Partial<Record<AllocationBucket, string>>

/** 目标比例输入以百分比显示与录入（界面约定：比例保留 2 位） */
function ratioToPercentText(ratio: number): string {
  return (ratio * 100).toFixed(2)
}

/** 行内数字编辑框：失焦或回车提交（概览页目标比例） */
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

/** 组汇总子指标行：短标签 + 百分比；null（无定义）显示「—」且不着色 */
function GroupMetricRow(props: { label: string; value: number | null }): React.JSX.Element {
  return (
    <div className="group-summary-sub">
      <span className="group-summary-label">{props.label}</span>
      <span className={pnlClass(props.value)}>{formatPercent(props.value)}</span>
    </div>
  )
}

export default function Overview(): React.JSX.Element {
  const [data, setData] = useState<OverviewData | null>(null)
  const [ratioEdits, setRatioEdits] = useState<Edits>({})
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ code: string; name: string } | null>(null)
  const [showClosed, setShowClosed] = useState<boolean>(false)

  const reload = (): void => {
    window.api.overviewData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }

  useEffect(() => {
    reload()
  }, [])

  const hasData = data !== null && data.funds.length > 0

  // 已清仓持仓默认不显示（它们是数据，不是仓位）：开关打开后作为表尾一组出现，仍可点进基金详情
  const closedGroup = data?.closedGroup ?? null
  const heldGroups = data?.positionGroups ?? []
  const groupsToShow = showClosed && closedGroup !== null ? [...heldGroups, closedGroup] : heldGroups

  /** 保存三桶目标（百分比录入）：非数字本地回退，范围与完整性由服务层把关。
   *  allowUnchanged = true 供「接受折算结果」使用——即使数值未改也要落库，让确认提示消失。 */
  const persistTargets = (allowUnchanged: boolean): void => {
    if (data === null) return
    const rows = data.comparison.rows
    const payload: BucketTarget[] = []
    for (const row of rows) {
      const raw = ratioEdits[row.bucket] ?? ratioToPercentText(row.targetRatio)
      const n = Number(raw.trim())
      if (!Number.isFinite(n)) {
        setError('目标比例需为百分比数字（0–100）')
        setRatioEdits({})
        return
      }
      payload.push({ bucket: row.bucket, targetRatio: n / 100 })
    }
    if (!allowUnchanged) {
      const changed = payload.some((t) => {
        const original = rows.find((r) => r.bucket === t.bucket)?.targetRatio ?? 0
        return Math.abs(t.targetRatio - original) >= 1e-9
      })
      if (!changed) {
        setRatioEdits({})
        return
      }
    }
    setBusy(true)
    window.api
      .targetSaveBuckets(payload)
      .then(() => {
        setRatioEdits({})
        reload()
      })
      .catch((e) => {
        setError(ipcErrorMessage(e))
        setRatioEdits({})
      })
      .finally(() => setBusy(false))
  }

  /** 行内编辑提交：数值没变就不写库 */
  const saveEditedTargets = (): void => persistTargets(false)
  /** 接受旧目标折算结果：目标表尚未初始化，数值「没变」也必须落库 */
  const acceptConvertedTargets = (): void => persistTargets(true)

  return (
    <section className="page">
      <h1>概览</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {hasData && data.summary !== null && <SummaryCards summary={data.summary} />}

      {hasData && (
        <div className="card card-positions">
          <div className="card-head">
            <h2>持仓明细</h2>
            {closedGroup !== null && (
              <button
                className={showClosed ? 'btn btn-compact btn-primary' : 'btn btn-compact'}
                onClick={() => setShowClosed((v) => !v)}
              >
                显示已清仓
              </button>
            )}
          </div>
          {groupsToShow.length === 0 ? (
            <p className="muted">
              当前无在持持仓
              {closedGroup !== null ? `（已清仓 ${closedGroup.positions.length} 只，可打开上方开关找回）` : ''}。
            </p>
          ) : (
            <div className="table-scroll-x">
              <table className="table table-positions">
                <thead>
                  <tr>
                    <th>大类</th>
                    <th>大类汇总</th>
                    <th>代码</th>
                    <th>名称</th>
                    <th>份额</th>
                    <th>持仓成本</th>
                    <th>最新净值</th>
                    <th>市值</th>
                    <th>持仓盈亏</th>
                    <th>盈亏比例</th>
                    <th>年化收益率</th>
                  </tr>
                </thead>
                {/* 每个大类一个 tbody：首两列（大类 / 大类汇总）只在组内第一行渲染并 rowSpan 合并到整组 */}
                {groupsToShow.map((group) => (
                  <tbody key={group.category}>
                    {group.positions.map((p, rowIndex) => {
                      const annualized = data.summary?.perFundAnnualized[p.fundCode] ?? null
                      return (
                        <tr key={p.fundCode}>
                          {rowIndex === 0 && (
                            <>
                              <td className="group-cell" rowSpan={group.positions.length}>
                                {group.category}
                              </td>
                              <td className="group-cell" rowSpan={group.positions.length}>
                                <div className="group-summary-main">{formatMoney(group.marketValue)}</div>
                                {/* 已清仓组不是资产大类：只显示一个「—」，不渲染两条大类指标 */}
                                {group.category !== CLOSED_CATEGORY && (
                                  <>
                                    <GroupMetricRow label="盈亏比例" value={group.pnlRatio} />
                                    <GroupMetricRow label="年化收益率" value={group.annualized} />
                                  </>
                                )}
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
                        </tr>
                      )
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          <p className="muted">
            点击基金名称可查看基金详情与收益走势。
            {`大类汇总：大类盈亏比例 = 组内持仓盈亏合计 ÷ 持仓成本合计（不含卖出/分红的已实现盈亏）；大类年化收益率 = 组内在持基金的 XIRR。${MERGED_BUY_HINT}，使大类年化收益率偏低。`}
            {closedGroup !== null &&
              '已清仓基金（交易过后份额归零）默认不显示——它们是数据不是仓位，需要回顾战绩时用上方开关找回。'}
          </p>
        </div>
      )}

      {hasData && (
        <div className="card card-allocation">
          <h2>配置对比</h2>
          {data.targetConversionPending && (
            <div className="banner banner-info allocation-conversion">
              <p>
                旧的大类目标已折算为三个配置桶：
                {data.comparison.rows
                  .map((r) => `${r.bucket} ${formatPercent(r.targetRatio)}`)
                  .join(' / ')}
                。确认后作为新的配置基准，也可以在下方逐行调整。
              </p>
              <button
                className="btn btn-compact btn-primary allocation-conversion-confirm"
                onClick={acceptConvertedTargets}
                disabled={busy}
              >
                接受折算结果
              </button>
            </div>
          )}
          {data.comparison.targetNormalized && (
            <div className="banner banner-info allocation-target-warning">
              {`目标合计 ${formatPercent(data.comparison.targetTotal)}，不等于 100%；偏离按归一化目标计算。`}
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>配置桶</th>
                <th>目标比例（%）</th>
                <th>实际投入比例</th>
                <th>实际市值占比</th>
                <th>偏离（市值占比 − 目标）</th>
              </tr>
            </thead>
            <tbody>
              {data.comparison.rows.map((r) => {
                const editValue = ratioEdits[r.bucket]
                const inputValue = editValue !== undefined ? editValue : ratioToPercentText(r.targetRatio)
                const dev = r.deviation ?? 0
                const devClass = dev > 1e-9 ? 'positive' : dev < -1e-9 ? 'negative' : ''
                return (
                  <tr key={r.bucket}>
                    <td>{r.bucket}</td>
                    <td>
                      <InlineNumberEdit
                        value={inputValue}
                        disabled={busy}
                        step="0.01"
                        min="0"
                        max="100"
                        onChange={(text) => setRatioEdits((prev) => ({ ...prev, [r.bucket]: text }))}
                        onCommit={saveEditedTargets}
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
            {`权益构成：直接权益 ${formatPercent(data.comparison.equityComposition.direct)} + 债类穿透 ${formatPercent(data.comparison.equityComposition.debtPassthrough)}（按每只基金的权益系数穿透）。`}
            {data.comparison.missingNavCount > 0
              ? `有 ${data.comparison.missingNavCount} 只在持基金缺最新净值，市值按 0 计入；请到「净值管理」补录。`
              : ''}
            <br />
            目标比例可直接修改（百分比，0–100），失焦或回车后保存并实时重算偏离；合计不等于 100% 时只警告，偏离按归一化目标计算；红色表示超配、绿色表示低配。
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
