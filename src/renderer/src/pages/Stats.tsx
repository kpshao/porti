import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import type { FundPosition } from '../../../engine'
import type { StatsData } from '../../../main/statsTypes'
import { formatMoney, formatPercent } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer])

// 图表配色沿用应用自身（styles.css）配色，白底卡片为图表表面：
const SERIES_BLUE = '#3370ff' // 曲线主色 = 应用主色（白底对比 4.28:1）
const POSITIVE_RED = '#e03c3c' // 正收益（中国习惯红涨；白底 4.30:1）
const NEGATIVE_GREEN = '#00b42a' // 负收益（白底 2.78:1——柱向/数值标签/持仓明细表三通道补偿，不依赖颜色单独表意）
const GRID_LINE = '#e1e0d9' // 发丝网格线
const AXIS_LINE = '#c3c2b7' // 轴线/零基线
const MUTED_INK = '#86909c' // 弱化文字
const PRIMARY_INK = '#1f2329' // 主文字

/** 挂载即建图表实例，option 变化时整体替换；卸载销毁并解绑窗口缩放。 */
function useEChart(option: EChartsCoreOption): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const chart = echarts.init(el)
    chartRef.current = chart
    const onResize = (): void => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return ref
}

/** 轴线/网格/提示的公共配置（日期类目轴 + 十字轴提示） */
function axisBase(dates: string[]): EChartsCoreOption {
  return {
    textStyle: { fontFamily: 'inherit', color: PRIMARY_INK },
    grid: { left: 8, right: 72, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: AXIS_LINE, width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: MUTED_INK, fontSize: 12, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: GRID_LINE, width: 1 } },
      axisLabel: { color: MUTED_INK, fontSize: 12 }
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      valueFormatter: (v: unknown): string => formatMoney(typeof v === 'number' ? v : Number(v)),
      axisPointer: { type: 'cross', label: { color: '#fff', backgroundColor: PRIMARY_INK, fontSize: 11 } }
    }
  }
}

/** 折线图：单序列 2px 曲线 + 10% 面积 + 末端数值直接标注（单序列无需图例，标题已说明） */
function lineChartOption(
  dates: string[],
  values: number[],
  seriesName: string,
  opts: { zeroLine?: boolean; yInWan?: boolean } = {}
): EChartsCoreOption {
  const base = axisBase(dates) as Record<string, unknown>
  const yAxis = base.yAxis as Record<string, unknown>
  if (opts.yInWan === true) {
    yAxis.axisLabel = {
      color: MUTED_INK,
      fontSize: 12,
      formatter: (v: number): string =>
        `${(v / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万`
    }
  }
  if (opts.zeroLine === true) {
    // 累计收益：纵轴始终包含 0，正负区间一目了然
    yAxis.min = (v: { min: number }): number => Math.min(0, v.min)
    yAxis.max = (v: { max: number }): number => Math.max(0, v.max)
  }
  return {
    ...base,
    series: [
      {
        name: seriesName,
        type: 'line',
        data: values,
        symbol: 'none',
        lineStyle: { width: 2, color: SERIES_BLUE },
        itemStyle: { color: SERIES_BLUE },
        areaStyle: { color: 'rgba(51, 112, 255, 0.10)' },
        endLabel: {
          show: true,
          distance: 8,
          color: PRIMARY_INK,
          fontSize: 12,
          formatter: (p: { value?: unknown }): string => formatMoney(Number(p.value))
        },
        markLine:
          opts.zeroLine === true
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: AXIS_LINE, width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }]
              }
            : undefined
      }
    ]
  }
}

/** 盈亏着色：null（无净值）不着色，正红负绿（中国习惯） */
function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  return n >= 0 ? 'positive' : 'negative'
}

export default function Stats(): React.JSX.Element {
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 切页即重挂载，进入本页自动取最新数据（与概览/流水页同模式：新增净值/流水后刷新即见）
  useEffect(() => {
    window.api.statsData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }, [])

  const hasData = data !== null && data.series.length > 0

  const dates = useMemo(() => (data?.series ?? []).map((p) => p.date), [data])
  const assetsValues = useMemo(() => (data?.series ?? []).map((p) => p.totalMarketValue), [data])
  const returnValues = useMemo(() => (data?.series ?? []).map((p) => p.totalReturn), [data])

  const assetsOption = useMemo(
    () => lineChartOption(dates, assetsValues, '总资产', { yInWan: true }),
    [dates, assetsValues]
  )
  const returnOption = useMemo(
    () => lineChartOption(dates, returnValues, '累计收益', { zeroLine: true }),
    [dates, returnValues]
  )
  const assetsRef = useEChart(assetsOption)
  const returnRef = useEChart(returnOption)

  // 单基金盈亏排序：有持仓且有净值者按盈亏升序（类目轴默认 data[0] 在下，最高盈亏自然置顶），柱向/数值标签随正负
  const rankRows = useMemo(() => {
    return (data?.positions ?? [])
      .filter((p) => p.shares !== 0 && p.pnl !== null)
      .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
  }, [data])

  const rankOption = useMemo<EChartsCoreOption>(() => {
    return {
      animation: false,
      textStyle: { fontFamily: 'inherit', color: PRIMARY_INK },
      grid: { left: 8, right: 96, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: AXIS_LINE, width: 1 } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: GRID_LINE, width: 1 } },
        axisLabel: {
          color: MUTED_INK,
          fontSize: 12,
          formatter: (v: number): string => v.toLocaleString('zh-CN')
        }
      },
      yAxis: {
        type: 'category',
        data: rankRows.map((p) => `${p.name} ${p.fundCode}`),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: PRIMARY_INK, fontSize: 12 }
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (params: unknown): string => {
          const p = rankRows[(params as { dataIndex?: number }).dataIndex ?? 0]
          return [
            `${p.name} ${p.fundCode}`,
            `持仓盈亏：${formatMoney(p.pnl)}（${formatPercent(p.pnlRatio)}）`,
            `市值：${formatMoney(p.marketValue)}`,
            `净投入成本：${formatMoney(p.netCost)}`
          ].join('<br/>')
        }
      },
      series: [
        {
          type: 'bar',
          barWidth: 16, // 细条（≤24px）
          data: rankRows.map((p) => {
            const positive = (p.pnl ?? 0) >= 0
            return {
              value: p.pnl,
              itemStyle: {
                color: positive ? POSITIVE_RED : NEGATIVE_GREEN,
                borderRadius: positive ? [0, 4, 4, 0] : [4, 0, 0, 4] // 数据端圆角、零基线端直角
              },
              label: {
                show: true,
                position: positive ? 'right' : 'left',
                distance: 6,
                color: PRIMARY_INK, // 文字用墨色而非数据色
                fontSize: 12,
                formatter: (lp: { value?: unknown }): string => formatMoney(Number(lp.value))
              }
            }
          })
        }
      ]
    }
  }, [rankRows])
  const rankRef = useEChart(rankOption)
  const rankHeight = Math.max(140, rankRows.length * 34 + 24)

  // 周收益列表：最新在前；不足 7 天历史无基准，显示「—」
  const weeklyRows = useMemo(() => [...(data?.series ?? [])].reverse(), [data])

  return (
    <section className="page">
      <h1>收益统计</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {hasData && (
        <>
          <div className="card">
            <h2>总资产走势</h2>
            <div ref={assetsRef} className="chart chart-lg" />
            <p className="muted">X 轴为有净值记录的日期（含导入的历史区间）；曲线随新增净值/流水自动重算。</p>
          </div>

          <div className="card">
            <h2>累计收益走势</h2>
            <div ref={returnRef} className="chart chart-lg" />
            <p className="muted">累计收益 = 总市值 − 净投入成本 + 落袋收益（分红现金），与概览页总收益同口径。</p>
          </div>

          <div className="card">
            <h2>周收益列表</h2>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>基准日期（≥7 天前最近记录日）</th>
                    <th>总市值（元）</th>
                    <th>周收益（元）</th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyRows.map((p) => (
                    <tr key={p.date}>
                      <td>{p.date}</td>
                      <td>{p.weeklyReturn?.baseDate ?? '—'}</td>
                      <td>{formatMoney(p.totalMarketValue)}</td>
                      <td className={pnlClass(p.weeklyReturn?.value)}>
                        {p.weeklyReturn === null ? '—' : formatMoney(p.weeklyReturn.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">周收益 = 当日总市值 − ≥7 天前最近记录日的总市值；无基准则为「—」。</p>
          </div>

          <div className="card">
            <h2>单基金盈亏排序</h2>
            {rankRows.length === 0 ? (
              <p className="muted">暂无有净值记录的持仓基金。</p>
            ) : (
              <div ref={rankRef} className="chart" style={{ height: rankHeight }} />
            )}
            <p className="muted">正收益红、负收益绿（柱向与数值标签辅助区分），与概览持仓明细同一口径。</p>
          </div>
        </>
      )}

      {!hasData && (
        <p className="placeholder">
          暂无净值数据。请先在「交易流水」页导入 Excel 或新增基金，净值抓取/补录后即可查看收益曲线与周收益。
        </p>
      )}
    </section>
  )
}
