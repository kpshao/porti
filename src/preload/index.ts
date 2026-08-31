import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程可用的最小 API 面，后续里程碑逐步扩展
const api = {
  dbInfo: (): Promise<{ path: string; tables: string[]; schemaVersion: number }> =>
    ipcRenderer.invoke('db:info')
}

contextBridge.exposeInMainWorld('api', api)
