/// <reference types="vite/client" />

import type { CommitPayload, DataSummary, ImportOutcome, ParseResult } from '../../importer/types'

declare global {
  interface DbInfo {
    path: string
    tables: string[]
    schemaVersion: number
  }

  interface Window {
    api: {
      dbInfo: () => Promise<DbInfo>
      pickImportFile: () => Promise<string | null>
      parseImport: (filePath: string) => Promise<ParseResult>
      commitImport: (payload: CommitPayload) => Promise<ImportOutcome>
      dataSummary: () => Promise<DataSummary>
    }
  }
}
