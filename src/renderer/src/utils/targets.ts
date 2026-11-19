import type { AllocationBucket, BucketTarget } from '../../../engine'

/** 行内编辑暂存值：键为配置桶名（目标比例），值为用户输入的百分比文本 */
export type TargetEdits = Partial<Record<AllocationBucket, string>>

/** payload 构造所需的目标行字段（与配置对比行结构兼容） */
export interface TargetRow {
  bucket: AllocationBucket
  targetRatio: number
}

/**
 * 由配置对比行与编辑草稿构造保存 payload：编辑过的行按用户输入的百分比换算，
 * 未编辑行原样沿用 row.targetRatio——不经过 2 位显示精度往返，避免改写目标值。
 * 任一编辑值不是有限数字时返回 null（调用方负责提示并回退）。
 */
export function buildTargetsPayload(
  rows: readonly TargetRow[],
  edits: TargetEdits
): BucketTarget[] | null {
  const payload: BucketTarget[] = []
  for (const row of rows) {
    const edit = edits[row.bucket]
    if (edit === undefined) {
      payload.push({ bucket: row.bucket, targetRatio: row.targetRatio })
      continue
    }
    const n = Number(edit.trim())
    if (!Number.isFinite(n)) return null
    payload.push({ bucket: row.bucket, targetRatio: n / 100 })
  }
  return payload
}
