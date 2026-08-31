import { contextBridge, ipcRenderer } from 'electron'
import type { CommitPayload, DataSummary, ImportOutcome, ParseResult } from '../importer/types'

// 渲染进程可用的最小 API 面，后续里程碑逐步扩展
const api = {
  dbInfo: (): Promise<{ path: string; tables: string[]; schemaVersion: number }> =>
    ipcRenderer.invoke('db:info'),
  pickImportFile: (): Promise<string | null> => ipcRenderer.invoke('import:pick-file'),
  parseImport: (filePath: string): Promise<ParseResult> => ipcRenderer.invoke('import:parse', filePath),
  commitImport: (payload: CommitPayload): Promise<ImportOutcome> =>
    ipcRenderer.invoke('import:commit', payload),
  dataSummary: (): Promise<DataSummary> => ipcRenderer.invoke('data:summary')
}

contextBridge.exposeInMainWorld('api', api)
