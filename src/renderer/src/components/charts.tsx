import { useCallback, useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { formatMoney } from '../utils/format'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, MarkPointComponent, CanvasRenderer])

// 图表配色沿用应用自身（styles.css）配色，白底卡片为图表表面：
export const SERIES_BLUE = '#3370ff' // 曲线主色 = 应用主色（白底对比 4.28:1）
export const POSITIVE_RED = '#e03c3c' // 正收益（中国习惯红涨；白底 4.30:1）
export const NEGATIVE_GREEN = '#00b42a' // 负收益（白底 2.78:1——柱向/数值标签/持仓明细表三通道补偿，不依赖颜色单独表意）
export const GRID_LINE = '#e1e0d9' // 发丝网格线
export const AXIS_LINE = '#c3c2b7' // 轴线/零基线
export const MUTED_INK = '#86909c' // 弱化文字
export const PRIMARY_INK = '#1f2329' // 主文字

/** 元素挂载即建图表实例，option 变化时整体替换；卸载销毁并解绑窗口缩放。
 *  图表 div 在异步数据到达后才渲染（排序图还按行数条件渲染），
 *  故用 callback ref 跟踪元素而非挂载时读 ref：init effect 依赖元素本身，
 *  避免空依赖 effect 在 div 尚未挂载时早退、之后永不重跑。 */
export function useEChart(option: EChartsCoreOption): React.RefCallback<HTMLDivElement | null> {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
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
  }, [el])

  // 依赖 el：数据到达（option 变）与元素挂载（el 变）可能分属两次提交，
  // 若只依赖 option，init 之后的那次提交不会再应用 option（useMemo 对象稳定），图表将永不绘制。
  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option, el])

  return useCallback((node: HTMLDivElement | null): void => setEl(node), [])
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

/** 折线图：单序列 2px 曲线 + 10% 面积 + 末端数值直接标注（单序列无需图例，标题已说明）。
 *  可选：零基线（zeroLine）、金额万单位（yInWan）、自定义轴/值格式化（yAxisFormat/valueFormat，
 *  valueFormat 同时作用于 tooltip 与末端标注）、自定义 tooltip（tooltipFormatter）、
 *  null 值断开（connectNulls: false）、事件标注点（markPoint）。 */
export function lineChartOption(
  dates: string[],
  values: (number | null)[],
  seriesName: string,
  opts: {
    zeroLine?: boolean
    yInWan?: boolean
    yAxisFormat?: (v: number) => string
    valueFormat?: (v: number) => string
    tooltipFormatter?: (params: unknown) => string
    connectNulls?: boolean
    markPoint?: Record<string, unknown>
  } = {}
): EChartsCoreOption {
  const base = axisBase(dates) as Record<string, unknown>
  const tooltip = base.tooltip as Record<string, unknown>
  if (opts.valueFormat !== undefined) {
    const formatValue = opts.valueFormat
    tooltip.valueFormatter = (v: unknown): string => formatValue(typeof v === 'number' ? v : Number(v))
  }
  if (opts.tooltipFormatter !== undefined) tooltip.formatter = opts.tooltipFormatter
  const yAxis = base.yAxis as Record<string, unknown>
  if (opts.yAxisFormat !== undefined) {
    const formatAxis = opts.yAxisFormat
    yAxis.axisLabel = { color: MUTED_INK, fontSize: 12, formatter: (v: number): string => formatAxis(v) }
  } else if (opts.yInWan === true) {
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
  const formatValue = opts.valueFormat ?? formatMoney
  const series: Record<string, unknown> = {
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
      formatter: (p: { value?: unknown }): string => formatValue(Number(p.value))
    }
  }
  if (opts.connectNulls === false) series.connectNulls = false
  if (opts.zeroLine === true) {
    series.markLine = {
      silent: true,
      symbol: 'none',
      lineStyle: { color: AXIS_LINE, width: 1 },
      label: { show: false },
      data: [{ yAxis: 0 }]
    }
  }
  if (opts.markPoint !== undefined) series.markPoint = opts.markPoint
  return { ...base, series: [series] }
}
