// 数据 IPC 处理器（主进程侧）：Excel 导入、流水/基金增删改、数据读取、导出备份、数据位置

import { existsSync } from 'fs'
import { app, dialog, ipcMain } from 'electron'
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
import { buildExportData, writeExportCsvs, writeExportExcel } from './exportService'
import { hasAnyData, selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { saveDbPath } from './settingsStore'
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

  // ---------- 设置页：导出 Excel/CSV 备份 + 数据文件位置 + 重启 ----------

  // 导出 Excel：概览/流水/净值三张表，取消返回 null；写出失败抛出中文错误由界面回显
  ipcMain.handle('export:excel', async (): Promise<{ path: string } | null> => {
    const sheets = buildExportData(getDb())
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出 Excel 备份',
      defaultPath: `porti-导出-${todayString()}.xlsx`,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (canceled || filePath === undefined) return null
    writeExportExcel(sheets, filePath)
    return { path: filePath }
  })

  // 导出 CSV：选择目录后写出与 Excel 同内容的三个文件（概览/流水/净值）
  ipcMain.handle('export:csv', async (): Promise<{ dir: string; files: string[] } | null> => {
    const sheets = buildExportData(getDb())
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择 CSV 导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return null
    const files = writeExportCsvs(sheets, filePaths[0])
    return { dir: filePaths[0], files }
  })

  // 更改数据文件位置：把当前数据安全复制到新位置（含未落盘内容），重启后生效。
  // changed 由主进程单一判定（绝对路径比较），界面据此决定提示文案。
  ipcMain.handle('settings:set-db-path', async (): Promise<{ path: string; changed: boolean } | null> => {
    const current = getDb().name
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '选择数据文件新位置（更改后重启生效）',
      defaultPath: 'porti.db',
      filters: [{ name: 'SQLite 数据文件', extensions: ['db'] }]
    })
    if (canceled || filePath === undefined) return null
    if (filePath === current) return { path: current, changed: false }
    if (existsSync(filePath)) {
      throw new Error('目标位置已存在文件，请选择未占用的位置或删除该文件后重试')
    }
    await getDb().backup(filePath)
    saveDbPath(app.getPath('userData'), filePath)
    return { path: filePath, changed: true }
  })

  // 更改数据位置后立即重启（app.relaunch 会沿用相同启动参数）
  ipcMain.handle('app:relaunch', (): void => {
    app.relaunch()
    app.quit()
  })
}

/** 本地时区今日 YYYY-MM-DD（导出默认文件名用） */
function todayString(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
