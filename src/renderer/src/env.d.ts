/// <reference types="vite/client" />

import type { FundInput, TransactionInput } from '../../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../../importer/types'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from '../../main/navTypes'
import type { OverviewData } from '../../main/overviewTypes'

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
      navData: () => Promise<NavData>
      navFetch: () => Promise<NavFetchResult>
      navPut: (input: NavInput) => Promise<void>
      navFetchStatus: () => Promise<FetchStatus>
      overviewData: () => Promise<OverviewData>
      targetUpdateCategory: (category: string, targetRatio: number) => Promise<void>
      fundUpdateTarget: (code: string, targetAmount: number | null) => Promise<void>
    }
  }
}
