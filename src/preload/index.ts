import { contextBridge, ipcRenderer } from 'electron'
import type { FundInput, TransactionInput } from '../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../importer/types'

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
  fundCreate: (input: FundInput): Promise<void> => ipcRenderer.invoke('fund:create', input)
}

contextBridge.exposeInMainWorld('api', api)
