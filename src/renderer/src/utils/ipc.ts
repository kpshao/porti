// IPC 错误消息清洗：去掉 ipcRenderer.invoke 拒绝时包裹的前缀（页面共用）
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
