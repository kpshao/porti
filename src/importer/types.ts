// Excel 导入解析器的领域类型

import type {
  CategoryTarget,
  Fund,
  FundPosition,
  NavPoint,
  ReconstructedNav,
  SkippedSnapshot,
  Snapshot,
  Totals,
  Transaction
} from '../engine'
import type { ReconciliationReport } from './reconcile'

/** 自动修复项（无需用户决策，预览中逐条展示） */
export type FixKind =
  | 'code-zero-pad'
  | 'name-requery'
  | 'snapshot-reconstruct'
  | 'current-nav-import'
  | 'field-normalize'
  | 'row-skipped'

export interface FixItem {
  kind: FixKind
  detail: string // 中文描述
  count: number // 涉及行数
  rows?: number[] // 涉及的 Excel 行号（1-based）
}

/** 可疑字段：可在预览中修改后再导入 */
export interface SuspiciousField {
  field: 'nav' | 'shares' | 'amount' | 'date' | 'fee' | 'note'
  value: number | string | null
  suggested?: number | string | null
}

export interface SuspiciousItem {
  rowId: string
  excelRow: number
  fundCode: string
  fundName: string
  date: string
  type: string
  detail: string // 为什么可疑
  fields: SuspiciousField[] // 可编辑字段（含建议值）
}

/** 流水行：携带 Excel 行号，供预览编辑定位 */
export interface ParsedTransactionRow {
  rowId: string // `tx-<excelRow>`
  excelRow: number
  transaction: Transaction
}

/** 持仓概览单基金行（对账基准） */
export interface FundExpectation {
  code: string
  name: string
  invested: number // 累计投入本金
  redeemed: number // 累计赎回金额
  netCost: number // 净投入成本
  shares: number // 当前份额
  marketValue: number // 当前市值
  pnl: number // 持仓盈亏
  pnlRatio: number // 盈亏比例
}

export interface TotalsExpectation {
  totalNetCost: number
  totalAssets: number
  totalPnl: number
  totalReturnRate: number
}

export interface SeriesExpectation {
  date: string
  totalMarketValue: number
}

export interface ExcelExpectation {
  totals: TotalsExpectation
  funds: FundExpectation[]
  series: SeriesExpectation[]
}

export interface ParseSummary {
  fundCount: number
  transactionCount: number
  snapshotPeriodCount: number // 快照期数（去重日期）
  snapshotRowCount: number // 快照行数（基金×日期）
  currentNavCount: number // 持仓概览当前净值条数
}

export interface ParseResult {
  funds: Fund[]
  categoryTargets: CategoryTarget[]
  transactionRows: ParsedTransactionRow[]
  snapshots: Snapshot[]
  /** 预览用的重建结果；确认导入时以最终确认的流水重新计算 */
  reconstructedNavs: ReconstructedNav[]
  skippedSnapshots: SkippedSnapshot[]
  /** 持仓概览最新净值 → 当前净值点（日期取流水最大日期） */
  currentNavPoints: NavPoint[]
  fixes: FixItem[]
  suspicious: SuspiciousItem[]
  expectation: ExcelExpectation
  summary: ParseSummary
}

/** 确认导入载荷：用户已在预览中修改可疑行后的最终数据 */
export interface CommitPayload {
  funds: Fund[]
  categoryTargets: CategoryTarget[]
  transactions: Transaction[]
  snapshots: Snapshot[]
  /** 净值取自持仓概览；主进程按最大流水日期校正后写入 */
  currentNavs: NavPoint[]
  /** 对账基准（来自解析时的持仓概览/收益汇总） */
  expectation: ExcelExpectation
}

export interface ImportCounts {
  funds: number
  categoryTargets: number
  transactions: number
  reconstructedNavs: number // 快照重建的净值历史条数
  currentNavs: number // 持仓概览当前净值条数
  skippedSnapshots: number // 无有效份额跳过的快照数
}

export interface ImportOutcome {
  counts: ImportCounts
  report: ReconciliationReport
}

/** 当前库内数据摘要（交易流水页初始状态与导入后刷新用） */
export interface DataSummary {
  hasData: boolean
  totals: Totals | null
  positions: FundPosition[]
}
