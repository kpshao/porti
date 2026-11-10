/// <reference types="vite/client" />

import type { FundInput, FundSeriesRange, TransactionInput } from '../../engine'
import type { CommitPayload, ImportOutcome, ParseResult, TxData } from '../../importer/types'
import type { FetchStatus, NavData, NavFetchResult, NavInput } from '../../main/navTypes'
import type { MigrationMeta } from '../../main/migrationService'
import type { OverviewData } from '../../main/overviewTypes'
import type { StatsData } from '../../main/statsTypes'
import type { FundDetailData } from '../../main/fundDetailTypes'
import type { AnalysisData } from '../../main/analysisTypes'
import type {
  AiChatEvent,
  AiChatMessage,
  AiChatStatus,
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult,
  OpenExternalResult,
  SnapshotPreview
} from '../../main/aiTypes'

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
      statsData: () => Promise<StatsData>
      analysisData: () => Promise<AnalysisData>
      aiConfigGet: () => Promise<AiConfigView>
      aiConfigSave: (input: AiConfigInput) => Promise<AiConfigView>
      aiConfigTest: (input: AiConfigInput) => Promise<AiConnectionTestResult>
      aiConfirmFirstSend: () => Promise<void>
      aiSnapshotPreview: () => Promise<SnapshotPreview>
      aiChatHistory: () => Promise<AiChatMessage[]>
      aiChatStatus: () => Promise<AiChatStatus>
      aiChatSend: (content: string) => Promise<AiChatMessage>
      aiChatRetry: () => Promise<AiChatMessage>
      aiChatStop: () => Promise<void>
      aiChatClear: () => Promise<void>
      aiChatOnEvent: (callback: (event: AiChatEvent) => void) => () => void
      aiOpenExternal: (url: string) => Promise<OpenExternalResult>
      fundDetailData: (fundCode: string, range: FundSeriesRange) => Promise<FundDetailData>
      exportExcel: () => Promise<{ path: string } | null>
      exportCsv: () => Promise<{ dir: string; files: string[] } | null>
      setDbPath: () => Promise<{ path: string; changed: boolean } | null>
      relaunchApp: () => Promise<void>
      exportMigrationBundle: () => Promise<{ path: string } | null>
      importMigrationBundle: () => Promise<{ backupPath: string | null; meta: MigrationMeta } | null>
      migrationFirstRunCheck: () => Promise<{ shouldPrompt: boolean }>
      dismissMigrationPrompt: () => Promise<void>
    }
  }
}
