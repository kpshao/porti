// Excel 导入解析器：投资跟踪.xlsx → 领域数据 + 自动修复/可疑项清单 + 对账基准
// 纯函数层（I/O 接缝），读取真实 Excel 并按 spec 导入规则清洗

import * as XLSX from 'xlsx'
import type { CategoryTarget, Fund, OperationType, ReconstructedNav, Snapshot, Transaction } from '../engine'
import { daysBetween, normalizeFundCode, OPERATION_TYPES, reconstructNavPoints } from '../engine'
import type {
  ExcelExpectation,
  FixItem,
  FundExpectation,
  ParseResult,
  ParsedTransactionRow,
  SuspiciousItem,
  SuspiciousField,
  TotalsExpectation
} from './types'

const SHEETS = ['基金列表', '持仓概览', '收益明细', '收益汇总', '交易流水'] as const

/** 分红再投入净值与同期参考净值偏差超过该比例视为可疑 */
const NAV_DEVIATION_THRESHOLD = 0.1
/** 可疑判定的参考净值搜索窗口（天） */
const NAV_REFERENCE_WINDOW_DAYS = 45

/** 基金类型 → 资产大类回退映射（仅用于持仓概览未覆盖的基金） */
const TYPE_TO_CATEGORY: Record<string, string> = {
  一级债基: '纯债',
  纯债: '纯债',
  短债: '流动性',
  二级债基: '固守+',
  偏债混合: '固守+',
  红利ETF: '权益',
  宽基指数: '权益',
  黄金: '黄金'
}

/** Excel 日期序列号 → YYYY-MM-DD（以 UTC 计算避免时区偏移）。
 * 序列号 0 = 1899-12-30、1 = 1900-01-01；60 为 Excel 假想的 1900-02-29，
 * 该日期不存在，之后所有序列号比真实天数多 1（61 = 1900-03-01）。 */
export function excelSerialToDate(serial: number): string {
  const days = Math.floor(serial)
  const real = days <= 60 ? days + 1 : days
  const d = new Date(Date.UTC(1899, 11, 30) + real * 86400000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 日期单元格 → YYYY-MM-DD；无法解析返回 null */
export function cellToDate(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return excelSerialToDate(raw)
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  return null
}

/** 操作类型归一化；无法识别返回 null */
export function normalizeType(raw: unknown): OperationType | null {
  const s = String(raw ?? '').trim()
  return OPERATION_TYPES.includes(s as OperationType) ? (s as OperationType) : null
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

function readSheet(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][]
}

function isEmptyRow(row: unknown[], cols: number): boolean {
  return row.slice(0, cols).every((c) => c === null || c === undefined || c === '')
}

/** 原始值 → 字符串形式（补零修复对比用） */
function rawCodeString(raw: unknown): string {
  if (typeof raw === 'number') return String(Math.round(raw))
  return String(raw ?? '').trim()
}

export function parseExcelFile(filePath: string): ParseResult {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.readFile(filePath, { cellDates: false })
  } catch (e) {
    throw new Error(`无法读取 Excel 文件：${e instanceof Error ? e.message : String(e)}`)
  }
  for (const sheet of SHEETS) {
    if (!wb.Sheets[sheet]) throw new Error(`不是预期的投资跟踪.xlsx：缺少工作表「${sheet}」`)
  }
  return parseWorkbook(wb)
}

export function parseWorkbook(wb: XLSX.WorkBook): ParseResult {
  const fixes: FixItem[] = []
  const suspicious: SuspiciousItem[] = []

  // ---------- 基金列表 → 代码 → 名称/类型 ----------
  const fundMap = new Map<string, { name: string; fundType: string | null }>()
  for (const r of readSheet(wb, '基金列表').slice(1)) {
    if (isEmptyRow(r, 3)) continue
    const code = normalizeFundCode(r[0])
    if (code === null) continue
    const name = String(r[1] ?? '').trim()
    fundMap.set(code, { name: name || code, fundType: r[2] == null ? null : String(r[2]).trim() })
  }

  // ---------- 持仓概览 → 大类/目标金额/目标比例/当前净值/对账基准 ----------
  const categoryByCode = new Map<string, string>()
  const targetAmountByCode = new Map<string, number | null>()
  const currentNavByCode = new Map<string, number>()
  const categoryTargetMap = new Map<string, number>()
  const fundExpectations: FundExpectation[] = []
  let totalsExpectation: TotalsExpectation | null = null
  let currentCategory: string | null = null
  let currentTargetRatio: number | null = null

  for (const r of readSheet(wb, '持仓概览').slice(1)) {
    if (isEmptyRow(r, 18)) continue
    if (typeof r[0] === 'string' && r[0].trim() !== '') currentCategory = r[0].trim()
    const ratio = toNumber(r[1])
    if (ratio !== null) currentTargetRatio = ratio
    if (currentCategory !== null && currentTargetRatio !== null && !categoryTargetMap.has(currentCategory)) {
      categoryTargetMap.set(currentCategory, currentTargetRatio)
    }
    if (String(r[5] ?? '').trim() === '汇总') {
      totalsExpectation = {
        totalNetCost: toNumber(r[10]) ?? 0,
        totalAssets: toNumber(r[13]) ?? 0,
        totalPnl: toNumber(r[14]) ?? 0,
        totalReturnRate: toNumber(r[15]) ?? 0
      }
      continue
    }
    const code = normalizeFundCode(r[5])
    if (code === null) continue
    const fundType = fundMap.get(code)?.fundType ?? null
    categoryByCode.set(code, currentCategory ?? (fundType !== null ? TYPE_TO_CATEGORY[fundType] : undefined) ?? '权益')
    targetAmountByCode.set(code, toNumber(r[7]))
    const nav = toNumber(r[12])
    if (nav !== null) currentNavByCode.set(code, nav)
    fundExpectations.push({
      code,
      name: String(r[6] ?? '').trim(),
      invested: toNumber(r[8]) ?? 0,
      redeemed: toNumber(r[9]) ?? 0,
      netCost: toNumber(r[10]) ?? 0,
      shares: toNumber(r[11]) ?? 0,
      marketValue: toNumber(r[13]) ?? 0,
      pnl: toNumber(r[14]) ?? 0,
      pnlRatio: toNumber(r[15]) ?? 0
    })
  }
  const categoryTargets: CategoryTarget[] = [...categoryTargetMap].map(([category, targetRatio]) => ({
    category,
    targetRatio
  }))

  // ---------- 交易流水 ----------
  const transactionRows: ParsedTransactionRow[] = []
  const transactions: Transaction[] = []
  const codeFixRows: number[] = []
  const nameFixRows: number[] = []
  for (const [i, r] of readSheet(wb, '交易流水').slice(1).entries()) {
    const excelRow = i + 2
    if (isEmptyRow(r, 9)) continue
    const skipRow = (detail: string): void => {
      fixes.push({ kind: 'row-skipped', detail, count: 1, rows: [excelRow] })
    }
    const date = cellToDate(r[0])
    if (date === null) {
      skipRow('日期无法解析，已跳过')
      continue
    }
    const rawCode = r[2]
    const code = normalizeFundCode(rawCode)
    if (code === null) {
      skipRow(`基金代码无法识别（${rawCodeString(rawCode)}），已跳过`)
      continue
    }
    if (code !== rawCodeString(rawCode)) codeFixRows.push(excelRow)
    const fund = fundMap.get(code)
    if (fund === undefined) {
      skipRow(`基金代码 ${code} 不在基金列表中，已跳过`)
      continue
    }
    const type = normalizeType(r[1])
    if (type === null) {
      skipRow(`无法识别的操作类型「${String(r[1] ?? '').trim()}」，已跳过`)
      continue
    }
    let amount = toNumber(r[4])
    let shares = toNumber(r[5])
    const nav = toNumber(r[6])
    const fee = toNumber(r[7])
    const note = r[8] == null ? null : String(r[8]).trim() || null
    // 库内约定：卖出金额与份额均存负值（Excel 表格里已是负数，此处防御性归一化）
    if (type === '卖出' && (amount !== null && amount > 0 || shares !== null && shares > 0)) {
      fixes.push({
        kind: 'field-normalize',
        detail: '卖出金额/份额按库内约定取负值',
        count: 1,
        rows: [excelRow]
      })
    }
    if (type === '卖出') {
      amount = amount === null ? null : -Math.abs(amount)
      shares = shares === null ? null : -Math.abs(shares)
    }
    // 分红现金无份额；分红再投入金额为空按 0 计（只加份额、成本不变）
    if (type === '分红现金') shares = null
    if (type === '分红再投入' && amount === null) {
      fixes.push({
        kind: 'field-normalize',
        detail: '分红再投入金额为空按 0 计（只加份额、成本不变）',
        count: 1,
        rows: [excelRow]
      })
      amount = 0
    }

    const rowSuspicious: SuspiciousField[] = []
    if (amount === null && (type === '买入' || type === '分红现金')) {
      rowSuspicious.push({ field: 'amount', value: null })
    }
    if (shares !== null && (nav === null || nav <= 0)) {
      rowSuspicious.push({ field: 'nav', value: nav })
    }
    const tx: Transaction = { date, type, fundCode: code, amount: amount ?? 0, shares, nav, fee, note }
    if (r[3] != null && String(r[3]).trim() !== fund.name) nameFixRows.push(excelRow)
    transactions.push(tx)
    transactionRows.push({ rowId: `tx-${excelRow}`, excelRow, transaction: tx })
    if (rowSuspicious.length > 0) {
      suspicious.push({
        rowId: `tx-${excelRow}`,
        excelRow,
        fundCode: code,
        fundName: fund.name,
        date,
        type,
        detail: '字段缺失或取值异常，请在预览中修改',
        fields: rowSuspicious
      })
    }
  }

  // ---------- 收益明细 → 快照（NAV = 快照市值 ÷ 当日累计份额） ----------
  const snapshots: Snapshot[] = []
  const detailCodeFixRows: number[] = []
  const detailNameFixRows: number[] = []
  for (const [i, r] of readSheet(wb, '收益明细').slice(1).entries()) {
    const excelRow = i + 2
    if (isEmptyRow(r, 9)) continue
    const date = cellToDate(r[0])
    if (date === null) continue
    const rawCode = r[1]
    const code = normalizeFundCode(rawCode)
    if (code === null) continue
    if (code !== rawCodeString(rawCode)) detailCodeFixRows.push(excelRow)
    if (r[2] == null) detailNameFixRows.push(excelRow) // 名称列公式失效（#N/A）
    const marketValue = toNumber(r[5])
    if (marketValue === null) continue
    snapshots.push({ date, fundCode: code, marketValue })
  }

  // ---------- 收益汇总 → 各期总市值（对账基准） ----------
  const series: { date: string; totalMarketValue: number }[] = []
  for (const r of readSheet(wb, '收益汇总').slice(1)) {
    if (isEmptyRow(r, 9)) continue
    const date = cellToDate(r[0])
    const totalMarketValue = toNumber(r[3])
    if (date === null || totalMarketValue === null) continue
    series.push({ date, totalMarketValue })
  }

  // ---------- 快照重建 + 当前净值 ----------
  const { points: reconstructedNavs, skipped } = reconstructNavPoints(snapshots, transactions)
  const maxTxDate = transactions.reduce((m, t) => (t.date > m ? t.date : m), '')
  const currentNavPoints = [...currentNavByCode].map(([fundCode, nav]) => ({
    fundCode,
    date: maxTxDate,
    nav,
    source: 'import' as const
  }))

  // ---------- 可疑判定：分红再投入净值与同期参考净值偏差过大 ----------
  for (const row of transactionRows) {
    const tx = row.transaction
    if (tx.type !== '分红再投入' || tx.nav === null || tx.nav <= 0) continue
    const ref = nearestNav(reconstructedNavs, tx.fundCode, tx.date)
    if (ref === null) continue
    if (Math.abs(tx.nav - ref) / ref > NAV_DEVIATION_THRESHOLD) {
      suspicious.push({
        rowId: row.rowId,
        excelRow: row.excelRow,
        fundCode: tx.fundCode,
        fundName: fundMap.get(tx.fundCode)?.name ?? tx.fundCode,
        date: tx.date,
        type: tx.type,
        detail: `分红再投入净值 ${tx.nav} 与同期参考净值 ${ref.toFixed(4)} 偏差超过 ${Math.round(NAV_DEVIATION_THRESHOLD * 100)}%，请在预览中确认`,
        fields: [{ field: 'nav', value: tx.nav, suggested: Number(ref.toFixed(4)) }]
      })
    }
  }

  // ---------- 修复项清单 ----------
  if (codeFixRows.length > 0) {
    fixes.push({ kind: 'code-zero-pad', detail: '基金代码补前导零至 6 位', count: codeFixRows.length, rows: codeFixRows })
  }
  if (detailCodeFixRows.length > 0) {
    fixes.push({ kind: 'code-zero-pad', detail: '收益明细基金代码补前导零至 6 位', count: detailCodeFixRows.length, rows: detailCodeFixRows })
  }
  if (nameFixRows.length > 0) {
    fixes.push({ kind: 'name-requery', detail: '交易流水名称与基金列表不一致，已按代码重查', count: nameFixRows.length, rows: nameFixRows })
  }
  if (detailNameFixRows.length > 0) {
    fixes.push({ kind: 'name-requery', detail: '收益明细名称列公式失效（#N/A），已按代码重查为正确名称', count: detailNameFixRows.length, rows: detailNameFixRows })
  }
  fixes.push({
    kind: 'snapshot-reconstruct',
    detail: '收益快照重建为净值历史（NAV = 快照市值 ÷ 当日累计份额，来源 import）',
    count: reconstructedNavs.length
  })
  for (const s of skipped) {
    fixes.push({
      kind: 'row-skipped',
      detail: `${s.date} ${s.fundCode} 快照${s.reason}，跳过重建`,
      count: 1
    })
  }
  if (currentNavPoints.length > 0) {
    fixes.push({
      kind: 'current-nav-import',
      detail: `持仓概览最新净值作为当前净值导入（记录日期取流水最大日期 ${maxTxDate}）`,
      count: currentNavPoints.length
    })
  }

  const funds: Fund[] = [...fundMap].map(([code, f]) => ({
    code,
    name: f.name,
    category:
      categoryByCode.get(code) ??
      (f.fundType !== null ? TYPE_TO_CATEGORY[f.fundType] : undefined) ??
      '权益',
    fundType: f.fundType,
    targetAmount: targetAmountByCode.get(code) ?? null
  }))

  const expectation: ExcelExpectation = {
    totals: totalsExpectation ?? { totalNetCost: 0, totalAssets: 0, totalPnl: 0, totalReturnRate: 0 },
    funds: fundExpectations,
    series
  }

  return {
    funds,
    categoryTargets,
    transactionRows,
    snapshots,
    reconstructedNavs,
    skippedSnapshots: skipped,
    currentNavPoints,
    fixes,
    suspicious,
    expectation,
    summary: {
      fundCount: funds.length,
      transactionCount: transactions.length,
      snapshotPeriodCount: new Set(snapshots.map((s) => s.date)).size,
      snapshotRowCount: snapshots.length,
      currentNavCount: currentNavPoints.length
    }
  }
}

/** 距离流水日期最近的快照重建净值（搜索窗口内）；无则 null */
function nearestNav(reconstructed: ReconstructedNav[], fundCode: string, date: string): number | null {
  let best: number | null = null
  let bestDays = Infinity
  for (const p of reconstructed) {
    if (p.fundCode !== fundCode) continue
    const d = Math.abs(daysBetween(date, p.date))
    if (d <= NAV_REFERENCE_WINDOW_DAYS && d < bestDays) {
      bestDays = d
      best = p.nav
    }
  }
  return best
}
