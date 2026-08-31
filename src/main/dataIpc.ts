// 数据 IPC 处理器（主进程侧）：Excel 导入、流水/基金增删改、数据读取

import { dialog, ipcMain } from 'electron'
import { computePositions, computeTimeSeries, computeTotals } from '../engine'
import type { FundInput, TransactionInput } from '../engine'
import { reconcileAgainstExcel } from '../importer/reconcile'
import { parseExcelFile } from '../importer/parse'
import { importToDb } from '../importer/write'
import type { CommitPayload, ImportOutcome, TxData } from '../importer/types'
import { getDb } from './db'
import { hasAnyData, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { createFund, createTransaction, deleteTransaction, updateTransaction } from './transactionService'

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
}
