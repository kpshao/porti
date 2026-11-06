// 数据 IPC 处理器（主进程侧）：Excel 导入、流水/基金增删改、数据读取、导出备份、换机迁移、数据位置

import { existsSync } from 'fs'
import { dirname } from 'path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  computeAnnualizedReturns,
  computeCategoryComparison,
  computeFundSeries,
  computePositions,
  computeScopedSummary,
  computeStatsSeries,
  computeTimeSeries,
  computeTotals,
  costBasisStates,
  filterFundSeriesRange,
  groupClosedPositions,
  groupPositionsByCategory
} from '../engine'
import type {
  FundInput,
  FundPosition,
  FundSeriesRange,
  NavPoint,
  SummaryData,
  Transaction,
  TransactionInput
} from '../engine'
import { reconcileAgainstExcel } from '../importer/reconcile'
import { parseExcelFile } from '../importer/parse'
import { importToDb } from '../importer/write'
import type { CommitPayload, ImportOutcome, TxData } from '../importer/types'
import { getDb, swapDatabase } from './db'
import { buildExportData, writeExportCsvs, writeExportExcel } from './exportService'
import { createMigrationBundle, uniqueBackupPath, validateMigrationBundle } from './migrationService'
import type { MigrationMeta } from './migrationService'
import { hasAnyData, selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { SCHEMA_VERSION } from './schema'
import { loadSettings, saveDbPath, saveMigrationPromptDismissed } from './settingsStore'
import { createFund, createTransaction, deleteTransaction, updateTransaction } from './transactionService'
import { getFetchStatus, runNavFetch, upsertManualNav } from './navService'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from './navTypes'
import { updateCategoryTarget } from './targetService'
import type { OverviewData } from './overviewTypes'
import type { StatsData } from './statsTypes'
import type { FundDetailData } from './fundDetailTypes'

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
    if (!hasAnyData(db)) {
      return { funds: [], transactions: [], summary: null, positions: [] }
    }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const positions = computePositions(funds, transactions, navPoints)
    return {
      funds,
      transactions,
      summary: computeSummaryData(positions, transactions, navPoints),
      positions
    }
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
    if (!hasAnyData(db)) {
      return {
        funds: [],
        positionGroups: [],
        closedGroup: null,
        summary: null,
        comparison: []
      }
    }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const positions = computePositions(funds, transactions, navPoints)
    const comparison = computeCategoryComparison(positions, selectCategoryTargets(db))
    return {
      funds,
      positionGroups: groupPositionsByCategory(positions),
      closedGroup: groupClosedPositions(positions),
      summary: computeSummaryData(positions, transactions, navPoints),
      comparison
    }
  })

  ipcMain.handle('target:update-category', (_event, category: string, targetRatio: number): void => {
    updateCategoryTarget(getDb(), category, targetRatio)
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

  // ---------- 基金详情：指标行 + 单基金收益走势 ----------

  ipcMain.handle('fund-detail:data', (_event, fundCode: string, range: FundSeriesRange): FundDetailData => {
    const db = getDb()
    if (!hasAnyData(db)) return { position: null, annualized: null, realizedIncome: 0, series: [], events: [] }
    const funds = selectFunds(db)
    const transactions = selectTransactions(db)
    const navPoints = selectNavPoints(db)
    const today = todayString()
    const series = filterFundSeriesRange(
      computeFundSeries(fundCode, funds, transactions, navPoints),
      range,
      today
    )
    const basis = costBasisStates(transactions).get(fundCode)
    return {
      position: computePositions(funds, transactions, navPoints).find((p) => p.fundCode === fundCode) ?? null,
      annualized: computePerFundAnnualized(transactions, navPoints, today)[fundCode] ?? null,
      realizedIncome: basis === undefined ? 0 : basis.realizedGain + basis.cashDividends,
      series,
      events: transactions.filter((t) => t.fundCode === fundCode).map((t) => ({ date: t.date, type: t.type }))
    }
  })

  // ---------- 换机迁移：导出/导入迁移包 + 首启引导 ----------

  // 导出迁移包：无损数据库副本 + 元信息（.portibak），取消返回 null
  ipcMain.handle('migration:export', async (): Promise<{ path: string } | null> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出迁移包',
      defaultPath: `porti-迁移-${todayString()}.portibak`,
      filters: [{ name: 'Porti 迁移包', extensions: ['portibak'] }]
    })
    if (canceled || filePath === undefined) return null
    await createMigrationBundle(getDb(), filePath, app.getVersion())
    return { path: filePath }
  })

  // 导入迁移包：校验 → 确认（说明覆盖范围与自动备份）→ 备份现有数据 → 热替换 → 刷新窗口；取消返回 null
  ipcMain.handle(
    'migration:import',
    async (): Promise<{ backupPath: string | null; meta: MigrationMeta } | null> => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择迁移包',
        filters: [{ name: 'Porti 迁移包', extensions: ['portibak'] }],
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return null
      const bundlePath = filePaths[0]
      const validation = validateMigrationBundle(bundlePath, SCHEMA_VERSION)
      if (!validation.ok) throw new Error(validation.reason)

      const hasData = hasAnyData(getDb())
      const backupPath = hasData ? uniqueBackupPath(dirname(getDb().name)) : null
      const { meta, funds, transactions, navPoints } = validation.info
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: '确认导入迁移包',
        message: `导入后将替换当前全部数据。迁移包包含 ${funds} 只基金、${transactions} 笔流水、${navPoints} 条净值（${meta.exportedAt.slice(0, 10)} 导出）。`,
        detail: backupPath !== null ? `导入前会自动备份当前数据到：${backupPath}` : '当前电脑还没有数据，无需备份。',
        buttons: ['导入', '取消'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return null

      if (backupPath !== null) await createMigrationBundle(getDb(), backupPath, app.getVersion())
      try {
        swapDatabase(bundlePath)
      } catch {
        // 替换后重开失败：连接已断，只能重启回退
        app.relaunch()
        app.quit()
        return null
      }
      // 热替换后刷新渲染进程立即生效
      for (const win of BrowserWindow.getAllWindows()) void win.webContents.reload()
      return { backupPath, meta }
    }
  )

  // 首启引导检查：空库且未被跳过时提示导入迁移包
  ipcMain.handle('migration:first-run-check', (): { shouldPrompt: boolean } => {
    const settings = loadSettings(app.getPath('userData'))
    return { shouldPrompt: !settings.migrationPromptDismissed && !hasAnyData(getDb()) }
  })

  // 记录用户跳过首启迁移引导（之后不再弹）
  ipcMain.handle('settings:dismiss-migration-prompt', (): void => {
    saveMigrationPromptDismissed(app.getPath('userData'))
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

/** 本地时区今日 YYYY-MM-DD（导出默认文件名与年化期末估值日用） */
function todayString(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 汇总数据组装：同一组入参一次算好两种口径（all/held）与单基金年化映射。
 *  两页共用，切换口径只换展示字段、不重新取数。 */
function computeSummaryData(
  positions: FundPosition[],
  transactions: Transaction[],
  navPoints: NavPoint[]
): SummaryData {
  const today = todayString()
  return {
    all: computeScopedSummary('all', positions, transactions, navPoints, today),
    held: computeScopedSummary('held', positions, transactions, navPoints, today),
    perFundAnnualized: computePerFundAnnualized(transactions, navPoints, today)
  }
}

/** 单基金年化映射（持仓明细年化列与基金详情共用；「今天」显式入参以保证口径可测） */
function computePerFundAnnualized(
  transactions: Transaction[],
  navPoints: NavPoint[],
  today: string
): Record<string, number | null> {
  const perFundAnnualized: Record<string, number | null> = {}
  for (const [fundCode, value] of computeAnnualizedReturns(transactions, navPoints, today)) {
    perFundAnnualized[fundCode] = value
  }
  return perFundAnnualized
}
