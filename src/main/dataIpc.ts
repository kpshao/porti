// 数据 IPC 处理器（主进程侧）：Excel 导入、流水/基金增删改、数据读取

import { dialog, ipcMain } from 'electron'
import {
  computeCategoryComparison,
  computePositions,
  computeStatsSeries,
  computeTimeSeries,
  computeTotals
} from '../engine'
import type { FundInput, TransactionInput } from '../engine'
import { reconcileAgainstExcel } from '../importer/reconcile'
import { parseExcelFile } from '../importer/parse'
import { importToDb } from '../importer/write'
import type { CommitPayload, ImportOutcome, TxData } from '../importer/types'
import { getDb } from './db'
import { hasAnyData, selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { createFund, createTransaction, deleteTransaction, updateTransaction } from './transactionService'
import { getFetchStatus, runNavFetch, upsertManualNav } from './navService'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from './navTypes'
import { updateCategoryTarget, updateFundTargetAmount } from './targetService'
import type { OverviewData } from './overviewTypes'
import type { StatsData } from './statsTypes'

export function registerDataIpc(): void {
  // 选择 Excel 文件；取消返回 null
  ipcMain.handle('import:pick-file', async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择投资跟踪.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      properties: ['openFile']
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  // 解析并返回预览清单（自动修复项 + 可疑项 + 对账基准）
  ipcMain.handle('import:parse', (_event, filePath: string) => parseExcelFile(filePath))

  // 确认导入：写入数据库 → 回读 → 计算引擎 → 与 Excel 逐项对账
  ipcMain.handle('import:commit', (_event, payload: CommitPayload): ImportOutcome => {
    const db = getDb()
    const counts = importToDb(db, payload)
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const positions = computePositions(funds, transactions, navPoints)
    const totals = computeTotals(positions, transactions)
    const series = computeTimeSeries(funds, transactions, navPoints)
    const report = reconcileAgainstExcel(payload.expectation, positions, totals, series)
    return { counts, report }
  })

  // ---------- 交易流水页：列表数据 + 流水/基金增删改 ----------

  ipcMain.handle('tx:data', (): TxData => {
    const db = getDb()
    if (!hasAnyData(db)) return { funds: [], transactions: [], totals: null, positions: [] }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const positions = computePositions(funds, transactions, navPoints)
    return { funds, transactions, totals: computeTotals(positions, transactions), positions }
  })

  ipcMain.handle('tx:create', (_event, input: TransactionInput): void => {
    createTransaction(getDb(), input)
  })

  ipcMain.handle('tx:update', (_event, id: number, input: TransactionInput): void => {
    updateTransaction(getDb(), id, input)
  })

  ipcMain.handle('tx:delete', (_event, id: number): void => {
    deleteTransaction(getDb(), id)
  })

  ipcMain.handle('fund:create', (_event, input: FundInput) => createFund(getDb(), input))

  // ---------- 净值管理页：历史数据 + 一键抓取 + 手动补录 + 启动抓取状态 ----------

  ipcMain.handle('nav:data', (): NavData => {
    const db = getDb()
    if (!hasAnyData(db)) return { funds: [], navPoints: [] }
    return { funds: selectFunds(db), navPoints: selectNavPoints(db) }
  })

  // 一键抓取：网络错误抛出交由界面提示（状态同时记录供横幅展示）
  ipcMain.handle('nav:fetch', (): Promise<NavFetchResult> => runNavFetch(getDb()))

  ipcMain.handle('nav:put', (_event, input: NavInput): void => {
    upsertManualNav(getDb(), input)
  })

  // 启动自动抓取的最近状态（成功静默更新、失败不阻塞启动）
  ipcMain.handle('nav:fetch-status', (): FetchStatus => getFetchStatus())

  // ---------- 概览页：卡片/持仓明细/大类对比 + 目标编辑 ----------

  ipcMain.handle('overview:data', (): OverviewData => {
    const db = getDb()
    if (!hasAnyData(db)) return { funds: [], positions: [], totals: null, comparison: [] }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const positions = computePositions(funds, transactions, navPoints)
    const comparison = computeCategoryComparison(positions, selectCategoryTargets(db))
    return { funds, positions, totals: computeTotals(positions, transactions), comparison }
  })

  ipcMain.handle('target:update-category', (_event, category: string, targetRatio: number): void => {
    updateCategoryTarget(getDb(), category, targetRatio)
  })

  ipcMain.handle('fund:update-target', (_event, code: string, targetAmount: number | null): void => {
    updateFundTargetAmount(getDb(), code, targetAmount)
  })

  // ---------- 收益统计页：时间序列（总资产/累计收益/周收益）+ 单基金盈亏排序 ----------

  ipcMain.handle('stats:data', (): StatsData => {
    const db = getDb()
    if (!hasAnyData(db)) return { series: [], positions: [] }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    return {
      series: computeStatsSeries(funds, transactions, navPoints),
      positions: computePositions(funds, transactions, navPoints)
    }
  })
}
