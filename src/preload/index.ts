import { contextBridge, ipcRenderer } from 'electron'
import type { FundInput, FundSeriesRange, TransactionInput } from '../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../importer/types'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from '../main/navTypes'
import type { MigrationMeta } from '../main/migrationService'
import type { OverviewData } from '../main/overviewTypes'
import type { StatsData } from '../main/statsTypes'
import type { FundDetailData } from '../main/fundDetailTypes'
import type { AnalysisData } from '../main/analysisTypes'
import type {
  AiChatEvent,
  AiChatMessage,
  AiChatStatus,
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult,
  OpenExternalResult,
  SnapshotPreview
} from '../main/aiTypes'

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
  aiConfigGet: (): Promise<AiConfigView> => ipcRenderer.invoke('ai:config:get'),
  aiConfigSave: (input: AiConfigInput): Promise<AiConfigView> =>
    ipcRenderer.invoke('ai:config:save', input),
  aiConfigTest: (input: AiConfigInput): Promise<AiConnectionTestResult> =>
    ipcRenderer.invoke('ai:config:test', input),
  aiConfirmFirstSend: (): Promise<void> => ipcRenderer.invoke('ai:first-send-confirm'),
  aiSnapshotPreview: (): Promise<SnapshotPreview> => ipcRenderer.invoke('ai:snapshot-preview'),
  aiChatHistory: (): Promise<AiChatMessage[]> => ipcRenderer.invoke('ai:chat:history'),
  aiChatStatus: (): Promise<AiChatStatus> => ipcRenderer.invoke('ai:chat:status'),
  aiChatSend: (content: string): Promise<AiChatMessage> => ipcRenderer.invoke('ai:chat:send', content),
  aiChatRetry: (): Promise<AiChatMessage> => ipcRenderer.invoke('ai:chat:retry'),
  aiChatStop: (): Promise<void> => ipcRenderer.invoke('ai:chat:stop'),
  aiChatClear: (): Promise<void> => ipcRenderer.invoke('ai:chat:clear'),
  aiChatOnEvent: (callback: (event: AiChatEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AiChatEvent): void => callback(event)
    ipcRenderer.on('ai:chat:event', listener)
    return () => ipcRenderer.removeListener('ai:chat:event', listener)
  },
  aiOpenExternal: (url: string): Promise<OpenExternalResult> =>
    ipcRenderer.invoke('ai:open-external', url),
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
