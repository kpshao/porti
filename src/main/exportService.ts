// 导出备份：概览/流水/净值三张表 → Excel（xlsx）与 CSV。
// 数字与软件内完全一致：走与各页面相同的 repo 读取 + 计算引擎，并在构建时
// 按界面显示位数（金额 2 位、净值 4 位、份额 2 位、比例百分比 2 位）舍入——
// 保证 Excel 单元格值、CSV 字符串、软件内显示三处数字完全相同。
// 数字单元格另带 z 格式（补尾零），Excel 与 CSV 显示逐位一致。

import { writeFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import * as XLSX from 'xlsx'
import { NAV_SOURCE_LABEL, computeCategoryComparison, computePositions, computeTotals } from '../engine'
import { selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'

export type ExportCell = string | null | { v: number; z: string }
export interface ExportSheet {
  name: string
  rows: ExportCell[][]
}

const Z_MONEY = '0.00'
const Z_NAV = '0.0000'
const Z_SHARES = '0.00'
const Z_PERCENT = '0.00'

/** 按界面显示位数四舍五入（与 renderer utils/format.ts 的显示约定一致） */
function roundTo(n: number, digits: number): number {
  return Number(n.toFixed(digits))
}

function num(v: number, z: string): ExportCell {
  return { v, z }
}

/** 金额/份额/比例（百分比数字）为空 → 空单元格，与界面「—」对应 */
function money(v: number | null): ExportCell {
  return v === null ? '' : num(roundTo(v, 2), Z_MONEY)
}
function nav4(v: number | null): ExportCell {
  return v === null ? '' : num(roundTo(v, 4), Z_NAV)
}
function shares2(v: number | null): ExportCell {
  return v === null ? '' : num(roundTo(v, 2), Z_SHARES)
}
function percent(v: number | null): ExportCell {
  return v === null ? '' : num(roundTo(v * 100, 2), Z_PERCENT)
}

export function buildExportData(db: Database.Database): ExportSheet[] {
  const funds = selectFunds(db)
  const transactions = selectTransactions(db)
  const navPoints = selectNavPoints(db)
  const nameByCode = new Map(funds.map((f) => [f.code, f.name]))

  const positions = computePositions(funds, transactions, navPoints)
  const totals = computeTotals(positions, transactions)
  const comparison = computeCategoryComparison(positions, selectCategoryTargets(db))

  return [overviewSheet(positions, totals, comparison), transactionsSheet(transactions, nameByCode), navSheet(navPoints, nameByCode)]
}

function overviewSheet(
  positions: ReturnType<typeof computePositions>,
  totals: ReturnType<typeof computeTotals>,
  comparison: ReturnType<typeof computeCategoryComparison>
): ExportSheet {
  return {
    name: '概览',
    rows: [
      ['汇总'],
      ['总资产', money(totals.totalAssets)],
      ['持仓盈亏', money(totals.totalPnl)],
      ['总收益率(%)', percent(totals.totalReturnRate)],
      ['已实现盈亏', money(totals.realizedIncome)],
      ['总收益', money(totals.totalReturn)],
      ['净投入成本', money(totals.totalNetCost)],
      [],
      ['持仓明细'],
      ['基金代码', '基金名称', '大类', '份额', '持仓成本', '最新净值', '市值', '持仓盈亏', '盈亏比例(%)', '目标金额'],
      // 与概览页持仓明细同一口径：只列仍有份额的持仓
      ...positions
        .filter((p) => p.shares !== 0)
        .map((p) => [
          p.fundCode,
          p.name,
          p.category,
          shares2(p.shares),
          money(p.costBasis),
          nav4(p.latestNav),
          money(p.marketValue),
          money(p.pnl),
          percent(p.pnlRatio),
          money(p.targetAmount)
        ]),
      [],
      ['大类配置对比'],
      ['大类', '目标比例(%)', '实际投入比例(%)', '实际市值占比(%)', '偏离(%)'],
      ...comparison.map((r) => [
        r.category,
        percent(r.targetRatio),
        percent(r.investedRatio),
        percent(r.marketRatio),
        percent(r.deviation)
      ])
    ]
  }
}

function transactionsSheet(
  transactions: ReturnType<typeof selectTransactions>,
  nameByCode: Map<string, string>
): ExportSheet {
  return {
    name: '流水',
    rows: [
      ['日期', '操作类型', '基金代码', '基金名称', '金额（元）', '份额', '净值', '手续费', '备注'],
      ...transactions.map((t) => [
        t.date,
        t.type,
        t.fundCode,
        nameByCode.get(t.fundCode) ?? '',
        money(t.amount),
        shares2(t.shares),
        nav4(t.nav),
        money(t.fee),
        t.note ?? ''
      ])
    ]
  }
}

function navSheet(navPoints: ReturnType<typeof selectNavPoints>, nameByCode: Map<string, string>): ExportSheet {
  return {
    name: '净值',
    rows: [
      ['日期', '基金代码', '基金名称', '净值', '来源'],
      ...navPoints.map((p) => [p.date, p.fundCode, nameByCode.get(p.fundCode) ?? '', nav4(p.nav), NAV_SOURCE_LABEL[p.source]])
    ]
  }
}

// ---------- 文件写出 ----------

/** 数字单元格按 z 格式（'0.00'/'0.0000'）四舍五入为字符串，与 Excel 展示及软件内显示一致 */
function cellToCsvText(cell: ExportCell): string {
  if (cell === null) return ''
  if (typeof cell === 'string') return cell
  const digits = cell.z.split('.')[1]?.length ?? 0
  return cell.v.toFixed(digits)
}

function escapeCsvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 一张表 → CSV 文本（UTF-8 BOM 开头，Excel 直接打开中文不乱码；行为 \r\n） */
export function buildCsvContent(rows: ExportCell[][]): string {
  return '﻿' + rows.map((row) => row.map((c) => escapeCsvCell(cellToCsvText(c))).join(',')).join('\r\n')
}

/** 三张表按表名写出 CSV 文件，返回文件路径列表 */
export function writeExportCsvs(sheets: ExportSheet[], dirPath: string): string[] {
  return sheets.map((s) => {
    const file = join(dirPath, `${s.name}.csv`)
    writeFileSync(file, buildCsvContent(s.rows), 'utf8')
    return file
  })
}

/** 数字单元格 → xlsx 单元格对象：保留全精度值，z 格式控制显示（与软件内显示位数一致） */
function toXlsxCell(cell: ExportCell): string | null | XLSX.CellObject {
  if (typeof cell === 'string' || cell === null) return cell
  return { t: 'n', v: cell.v, z: cell.z }
}

/** 三张表写出为 Excel 工作簿（每张表一个 sheet，中文表头） */
export function writeExportExcel(sheets: ExportSheet[], filePath: string): void {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows.map((row) => row.map(toXlsxCell)))
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  XLSX.writeFile(wb, filePath)
}
