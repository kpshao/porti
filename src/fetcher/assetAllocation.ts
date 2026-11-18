// 东方财富公开基金数据的资产配置解析（纯函数，响应按不可信数据处理，不执行脚本、不建 DOM）

import { isValidDateString } from '../engine'
import type { AssetAllocationQuarter } from './types'

/** 百分比数值 → 0–1 比例（公开数据保留 2 位小数，统一按 4 位小数归一化） */
function percentToRatio(percent: number): number {
  return Math.round(percent * 100) / 10000
}

/** 文本中的报告期（支持 2026-09-30 / 2026年9月30日） */
function normalizeReportDate(text: string): string | null {
  const m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text)
  if (m === null) return null
  const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return isValidDateString(date) ? date : null
}

/** 单元格百分比（容忍千分位；「---」等无数字文本返回 null） */
function parsePercentCell(text: string): number | null {
  const m = /-?\d+(?:,\d{3})*(?:\.\d+)?/.exec(text)
  if (m === null) return null
  const value = Number(m[0].replace(/,/g, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function finiteSeriesValue(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

/** 从 start 处的 `{` 提取配平的 JSON 对象字面量（字符串感知；不执行脚本） */
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

interface RawAllocationSeries {
  name?: unknown
  data?: unknown
}

interface RawAllocationData {
  series?: unknown
  categories?: unknown
}

/** 解析 pingzhongdata 脚本中的 Data_assetAllocation（股票/债券/现金占净比，近四个季度） */
export function parsePingzhongAssetAllocation(script: string): AssetAllocationQuarter[] {
  const marker = /\bData_assetAllocation\s*=\s*\{/.exec(script)
  if (marker === null) throw new Error('pingzhongdata 中未找到资产配置数据')
  const objectText = extractJsonObject(script, script.indexOf('{', marker.index))
  if (objectText === null) throw new Error('pingzhongdata 资产配置数据不完整')

  let parsed: unknown
  try {
    parsed = JSON.parse(objectText)
  } catch {
    throw new Error('pingzhongdata 资产配置数据格式异常')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('pingzhongdata 资产配置数据格式异常')
  const raw = parsed as RawAllocationData
  if (!Array.isArray(raw.series) || !Array.isArray(raw.categories)) {
    throw new Error('pingzhongdata 资产配置数据缺少 series 或 categories')
  }

  const series = raw.series.filter(
    (item): item is RawAllocationSeries => typeof item === 'object' && item !== null
  )
  const dataOf = (name: string): unknown[] => {
    const item = series.find((s) => s.name === name)
    return item !== undefined && Array.isArray(item.data) ? item.data : []
  }
  const stockData = dataOf('股票占净比')
  if (stockData.length === 0) throw new Error('pingzhongdata 中未找到「股票占净比」数据')
  const bondData = dataOf('债券占净比')
  const cashData = dataOf('现金占净比')

  const quarters: AssetAllocationQuarter[] = []
  for (let i = 0; i < raw.categories.length; i += 1) {
    const reportDate = normalizeReportDate(String(raw.categories[i] ?? ''))
    if (reportDate === null) continue
    const stockPercent = finiteSeriesValue(stockData[i])
    if (stockPercent === null || stockPercent > 100) continue
    const bondPercent = finiteSeriesValue(bondData[i])
    const cashPercent = finiteSeriesValue(cashData[i])
    quarters.push({
      reportDate,
      stockRatio: percentToRatio(stockPercent),
      bondRatio: bondPercent === null ? null : percentToRatio(bondPercent),
      cashRatio: cashPercent === null ? null : percentToRatio(cashPercent),
      includesDepositaryReceipts: false
    })
  }
  if (quarters.length === 0) throw new Error('pingzhongdata 资产配置数据中没有可用的股票占净比')
  return quarters.sort((a, b) => a.reportDate.localeCompare(b.reportDate))
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X'
      const value = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : whole
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** 单元格纯文本：去标签、解实体、压缩空白 */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = []
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(rowHtml)) !== null) cells.push(cellText(match[1]))
  return cells
}

/** 解析 F10 资产配置页 HTML 表格（按表头定位，兼容 QDII 的存托凭证列） */
export function parseF10AssetAllocation(html: string): AssetAllocationQuarter[] {
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  let tableMatch: RegExpExecArray | null
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    const rows: string[][] = []
    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) rows.push(extractCells(rowMatch[1]))

    const headerIndex = rows.findIndex(
      (cells) => cells.includes('报告期') && cells.includes('股票占净比')
    )
    if (headerIndex < 0) continue
    const header = rows[headerIndex]
    const dateIndex = header.indexOf('报告期')
    const stockIndex = header.indexOf('股票占净比')
    const bondIndex = header.indexOf('债券占净比')
    const cashIndex = header.indexOf('现金占净比')
    const depositaryIndex = header.indexOf('存托凭证占净比')

    const quarters: AssetAllocationQuarter[] = []
    for (const cells of rows.slice(headerIndex + 1)) {
      const reportDate = normalizeReportDate(cells[dateIndex] ?? '')
      if (reportDate === null) continue
      const stockPercent = parsePercentCell(cells[stockIndex] ?? '')
      const depositaryPercent =
        depositaryIndex >= 0 ? parsePercentCell(cells[depositaryIndex] ?? '') : null
      if (stockPercent === null && depositaryPercent === null) continue
      const equityPercent = (stockPercent ?? 0) + (depositaryPercent ?? 0)
      if (equityPercent > 100) continue
      const bondPercent = bondIndex >= 0 ? parsePercentCell(cells[bondIndex] ?? '') : null
      const cashPercent = cashIndex >= 0 ? parsePercentCell(cells[cashIndex] ?? '') : null
      quarters.push({
        reportDate,
        stockRatio: percentToRatio(equityPercent),
        bondRatio: bondPercent === null ? null : percentToRatio(bondPercent),
        cashRatio: cashPercent === null ? null : percentToRatio(cashPercent),
        includesDepositaryReceipts: depositaryPercent !== null && depositaryPercent > 0
      })
    }
    if (quarters.length > 0) return quarters.sort((a, b) => a.reportDate.localeCompare(b.reportDate))
  }
  throw new Error('F10 页面中未找到资产配置表格或有效数据')
}
