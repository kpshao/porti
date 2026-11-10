// 换机迁移：迁移包（.portibak）的生成、校验与替换。
// 独立于 electron 以便测试（路径与连接由调用方传入，生产环境由 dataIpc/db 组装）。

import { copyFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

/** 迁移包元信息（写入包内 migration_meta 表） */
export interface MigrationMeta {
  appVersion: string
  schemaVersion: number
  /** 导出时间（ISO 8601） */
  exportedAt: string
}

/** 迁移包内容概况（导入确认框展示用） */
export interface MigrationBundleInfo {
  meta: MigrationMeta
  funds: number
  transactions: number
  navPoints: number
}

export type MigrationValidation =
  | { ok: true; info: MigrationBundleInfo }
  | { ok: false; reason: string }

const META_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS migration_meta (
  id INTEGER PRIMARY KEY,
  app_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  exported_at TEXT NOT NULL
)
`

/** 生成迁移包：backup 出无损副本（含未落盘 WAL 内容），再往副本写元信息 */
export async function createMigrationBundle(
  source: Database.Database,
  targetPath: string,
  appVersion: string
): Promise<MigrationMeta> {
  // backup 写入已存在文件不会截断（可能残留旧内容），先移除再写
  rmSync(targetPath, { force: true })
  await source.backup(targetPath)
  const bundle = new Database(targetPath)
  try {
    bundle.exec(META_TABLE_SQL)
    const meta: MigrationMeta = {
      appVersion,
      schemaVersion: bundle.pragma('user_version', { simple: true }) as number,
      exportedAt: new Date().toISOString()
    }
    bundle
      .prepare(
        'INSERT OR REPLACE INTO migration_meta (id, app_version, schema_version, exported_at) VALUES (1, ?, ?, ?)'
      )
      .run(meta.appVersion, meta.schemaVersion, meta.exportedAt)
    return meta
  } finally {
    bundle.close()
  }
}

/** 读取迁移包元信息；打不开或不是迁移包（无 meta 表/无行）返回 null */
export function readMigrationMeta(bundlePath: string): MigrationMeta | null {
  let bundle: Database.Database
  try {
    bundle = new Database(bundlePath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const row = selectMetaRow(bundle)
    if (row === undefined) return null
    return { appVersion: row.app_version, schemaVersion: row.schema_version, exportedAt: row.exported_at }
  } finally {
    bundle.close()
  }
}

function selectMetaRow(
  bundle: Database.Database
): { app_version: string; schema_version: number; exported_at: string } | undefined {
  const table = bundle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_meta'")
    .get()
  if (table === undefined) return undefined
  return bundle
    .prepare('SELECT app_version, schema_version, exported_at FROM migration_meta WHERE id = 1')
    .get() as { app_version: string; schema_version: number; exported_at: string } | undefined
}

/** 校验迁移包：可打开、有元信息、完整性检查、schema 版本合法（低于当前走预留升级路径） */
export function validateMigrationBundle(
  bundlePath: string,
  currentSchemaVersion: number
): MigrationValidation {
  let bundle: Database.Database
  try {
    bundle = new Database(bundlePath, { readonly: true, fileMustExist: true })
  } catch {
    return { ok: false, reason: '无法打开迁移包：不是有效的数据库文件' }
  }
  try {
    const row = selectMetaRow(bundle)
    if (row === undefined) return { ok: false, reason: '不是有效的迁移包（缺少迁移元信息）' }
    const meta: MigrationMeta = {
      appVersion: row.app_version,
      schemaVersion: row.schema_version,
      exportedAt: row.exported_at
    }
    const integrity = bundle.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') return { ok: false, reason: `迁移包已损坏（完整性检查未通过：${integrity}）` }
    const schemaVersion = bundle.pragma('user_version', { simple: true }) as number
    if (schemaVersion < 1) return { ok: false, reason: '不是有效的迁移包（数据版本无效）' }
    if (schemaVersion > currentSchemaVersion) {
      return {
        ok: false,
        reason: `迁移包由更新版本导出（数据版本 ${schemaVersion}，当前支持 ${currentSchemaVersion}），请先升级软件再导入`
      }
    }
    // schemaVersion < currentSchemaVersion：导入后由 initDatabase 的逐版本迁移升级；
    // 此处只做合法性与完整性校验，不修改迁移包内容。
    const count = (table: string): number =>
      (bundle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return {
      ok: true,
      info: { meta, funds: count('funds'), transactions: count('transactions'), navPoints: count('nav_history') }
    }
  } catch {
    // 文件头合法但内容损坏（截断等）时，SQLite 在首次语句才报错
    return { ok: false, reason: '无法读取迁移包：文件可能已损坏（不是有效的数据库文件）' }
  } finally {
    bundle.close()
  }
}

/** 关闭当前连接后用迁移包替换数据文件（先清掉 WAL/SHM 伴随文件）；重开连接由调用方负责 */
export function replaceDbFile(db: Database.Database, bundlePath: string): void {
  const target = db.name
  db.close()
  for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
  copyFileSync(bundlePath, target)
}

/** 生成不冲突的自动备份文件名：porti-备份-YYYYMMDD-HHmmss.portibak，冲突时加 -2/-3 序号 */
export function uniqueBackupPath(dir: string, now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let candidate = join(dir, `porti-备份-${stamp}.portibak`)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `porti-备份-${stamp}-${n}.portibak`)
  return candidate
}
