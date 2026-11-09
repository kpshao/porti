import { contextBridge, ipcRenderer } from 'electron'
import type { FundInput, FundSeriesRange, TransactionInput } from '../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../importer/types'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from '../main/navTypes'
import type { MigrationMeta } from '../main/migrationService'
import type { OverviewData } from '../main/overviewTypes'
import type { StatsData } from '../main/statsTypes'
import type { FundDetailData } from '../main/fundDetailTypes'
import type { AnalysisData } from '../main/analysisTypes'

// 渲染进程可用的最小 API 面，后续里程碑逐步扩展
const api = {
  dbInfo: (): Promise<{ path: string; tables: string[]; schemaVersion: number }> =>
    ipcRenderer.invoke('db:info'),
  pickImportFile: (): Promise<string | null> => ipcRenderer.invoke('import:pick-file'),
  parseImport: (filePath: string): Promise<ParseResult> => ipcRenderer.invoke('import:parse', filePath),
  commitImport: (payload: CommitPayload): Promise<ImportOutcome> =>
    ipcRenderer.invoke('import:commit', payload),
  txData: (): Promise<TxData> => ipcRenderer.invoke('tx:data'),
  txCreate: (input: TransactionInput): Promise<void> => ipcRenderer.invoke('tx:create', input),
  txUpdate: (id: number, input: TransactionInput): Promise<void> =>
    ipcRenderer.invoke('tx:update', id, input),
  txDelete: (id: number): Promise<void> => ipcRenderer.invoke('tx:delete', id),
  fundCreate: (input: FundInput): Promise<void> => ipcRenderer.invoke('fund:create', input),
  navData: (): Promise<NavData> => ipcRenderer.invoke('nav:data'),
  navFetch: (): Promise<NavFetchResult> => ipcRenderer.invoke('nav:fetch'),
  navPut: (input: NavInput): Promise<void> => ipcRenderer.invoke('nav:put', input),
  navFetchStatus: (): Promise<FetchStatus> => ipcRenderer.invoke('nav:fetch-status'),
  overviewData: (): Promise<OverviewData> => ipcRenderer.invoke('overview:data'),
  targetUpdateCategory: (category: string, targetRatio: number): Promise<void> =>
    ipcRenderer.invoke('target:update-category', category, targetRatio),
  statsData: (): Promise<StatsData> => ipcRenderer.invoke('stats:data'),
  analysisData: (): Promise<AnalysisData> => ipcRenderer.invoke('analysis:data'),
  fundDetailData: (fundCode: string, range: FundSeriesRange): Promise<FundDetailData> =>
    ipcRenderer.invoke('fund-detail:data', fundCode, range),
  exportExcel: (): Promise<{ path: string } | null> => ipcRenderer.invoke('export:excel'),
  exportCsv: (): Promise<{ dir: string; files: string[] } | null> => ipcRenderer.invoke('export:csv'),
  setDbPath: (): Promise<{ path: string; changed: boolean } | null> =>
    ipcRenderer.invoke('settings:set-db-path'),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  exportMigrationBundle: (): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('migration:export'),
  importMigrationBundle: (): Promise<{ backupPath: string | null; meta: MigrationMeta } | null> =>
    ipcRenderer.invoke('migration:import'),
  migrationFirstRunCheck: (): Promise<{ shouldPrompt: boolean }> =>
    ipcRenderer.invoke('migration:first-run-check'),
  dismissMigrationPrompt: (): Promise<void> => ipcRenderer.invoke('settings:dismiss-migration-prompt')
}

contextBridge.exposeInMainWorld('api', api)
