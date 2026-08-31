/// <reference types="vite/client" />

import type { FundInput, TransactionInput } from '../../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../../importer/types'

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
      txData: () => Promise<TxData>
      txCreate: (input: TransactionInput) => Promise<void>
      txUpdate: (id: number, input: TransactionInput) => Promise<void>
      txDelete: (id: number) => Promise<void>
      fundCreate: (input: FundInput) => Promise<void>
    }
  }
}
