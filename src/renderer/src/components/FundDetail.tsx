import { useEffect, useMemo, useState } from 'react'
import type { FundSeriesPoint, FundSeriesRange, OperationType } from '../../../engine'
import type { FundDetailData, FundDetailEvent } from '../../../main/fundDetailTypes'
import { formatMoney, formatPercent } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'
import { pnlClass } from '../utils/pnl'
import { lineChartOption, useEChart } from './charts'

/** 流水事件标注配色：与流水表 tag 同色系 */
const EVENT_COLORS: Record<OperationType, string> = {
  买入: '#3370ff',
  卖出: '#00b42a',
  分红现金: '#f77234',
  分红再投入: '#722ed1'
}

const RANGE_OPTIONS: { value: FundSeriesRange; label: string }[] = [
  { value: '1m', label: '近1月' },
  { value: '3m', label: '近3月' },
  { value: '1y', label: '近1年' },
  { value: 'all', label: '全部' }
]

interface FundDetailProps {
  fundCode: string
  fundName: string
  onClose: () => void
}

/** 基金详情覆盖层：指标行 + 按日收益走势图（累计收益率/累计盈亏金额两种口径可切换） */
export default function FundDetail({ fundCode, fundName, onClose }: FundDetailProps): React.JSX.Element {
  const [data, setData] = useState<FundDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'rate' | 'amount'>('rate')
  const [range, setRange] = useState<FundSeriesRange>('all')

  // 打开与范围切换时取数（主进程一次算好该范围的完整序列）
  useEffect(() => {
    window.api
      .fundDetailData(fundCode, range)
      .then(setData)
      .catch((e) => setError(ipcErrorMessage(e)))
  }, [fundCode, range])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const series = useMemo(() => data?.series ?? [], [data])
  const dates = series.map((p) => p.date)
  const valueAt = useMemo(() => new Map(series.map((p) => [p.date, p])), [series])

  const option = useMemo(() => {
    if (series.length === 0) return null
    const isRate = mode === 'rate'
    const values = series.map((p) => (isRate ? p.totalReturnRate : p.totalReturn))
    // 事件标注：仅标注有净值记录的日期（其余事件的影响体现在下一个净值点）
    const marks = (data?.events ?? []).flatMap((e: FundDetailEvent): unknown[] => {
      const p = valueAt.get(e.date)
      if (p === undefined) return []
      const value = isRate ? p.totalReturnRate : p.totalReturn
      if (value === null) return []
      return [
        {
          coord: [e.date, value] as [string, number],
          itemStyle: { color: EVENT_COLORS[e.type] },
          tooltip: { formatter: `${e.type} · ${e.date}` }
        }
      ]
    })
    return lineChartOption(dates, values, isRate ? '累计收益率' : '累计盈亏', {
      zeroLine: true,
      connectNulls: false,
      yAxisFormat: isRate ? (v: number): string => `${(v * 100).toFixed(0)}%` : undefined,
      yInWan: !isRate,
      valueFormat: isRate ? (v: number): string => formatPercent(v) : undefined,
      tooltipFormatter: (params) => {
        const point = valueAt.get(String((params as { axisValue?: unknown }).axisValue))
        if (point === undefined) return ''
        return [
          point.date,
          `累计收益率：${formatPercent(point.totalReturnRate)}`,
          `累计盈亏：${formatMoney(point.totalReturn)}`,
          `市值：${formatMoney(point.marketValue)}`
        ].join('<br/>')
      },
      markPoint: { symbolSize: 7, data: marks }
    })
  }, [series, dates, valueAt, mode, data])

  const chartRef = useEChart(option ?? {})

  return (
    <div className="modal-overlay">
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>
            {fundName}（{fundCode}）
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {error !== null && <div className="banner banner-error">{error}</div>}

        {data !== null && data.position !== null && (
          <div className="detail-stats">
            <div className="stat">
              <div className="stat-label">持仓成本</div>
              <div className="stat-value">{formatMoney(data.position.costBasis)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">市值</div>
              <div className="stat-value">{formatMoney(data.position.marketValue)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">持仓盈亏</div>
              <div className={`stat-value ${pnlClass(data.position.pnl)}`}>{formatMoney(data.position.pnl)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">盈亏比例</div>
              <div className={`stat-value ${pnlClass(data.position.pnlRatio)}`}>
                {formatPercent(data.position.pnlRatio)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">已实现盈亏</div>
              <div className={`stat-value ${pnlClass(data.realizedIncome)}`}>
                {formatMoney(data.realizedIncome)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">年化收益率</div>
              <div className={`stat-value ${pnlClass(data.annualized)}`}>{formatPercent(data.annualized)}</div>
            </div>
          </div>
        )}

        <div className="detail-controls">
          <span className="muted">口径</span>
          <button
            className={mode === 'rate' ? 'btn btn-primary btn-compact' : 'btn btn-compact'}
            onClick={() => setMode('rate')}
          >
            收益率
          </button>
          <button
            className={mode === 'amount' ? 'btn btn-primary btn-compact' : 'btn btn-compact'}
            onClick={() => setMode('amount')}
          >
            金额
          </button>
          <span className="muted">范围</span>
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.value}
              className={range === r.value ? 'btn btn-primary btn-compact' : 'btn btn-compact'}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {option === null ? (
          <p className="muted">暂无净值数据。请在「净值管理」页补录或抓取该基金净值后查看走势。</p>
        ) : (
          <>
            <div ref={chartRef} className="chart chart-lg" />
            <p className="muted">
              累计收益率 = 累计盈亏 ÷ 当日持仓成本（清仓区间无定义，曲线断开）；累计盈亏 = 市值 − 持仓成本 +
              已实现盈亏。图上圆点为买入/卖出/分红事件。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
