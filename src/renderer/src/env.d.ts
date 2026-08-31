/// <reference types="vite/client" />

interface DbInfo {
  path: string
  tables: string[]
  schemaVersion: number
}

interface Window {
  api: {
    dbInfo: () => Promise<DbInfo>
  }
}
