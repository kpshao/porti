// 配置目标服务：配置桶目标的读取与保存（目标只存在于配置桶层，见 ADR-0002 / ADR-0004）

import type Database from 'better-sqlite3'
import { ALLOCATION_BUCKETS } from '../engine'
import type { AllocationBucket, BucketTarget } from '../engine'
import { selectBucketTargets } from './repo'

/**
 * 读取配置桶目标：按固定顺序返回三行；尚未保存过的桶按 0 处理（合计为 0 = 未配置）。
 */
export function loadBucketTargets(db: Database.Database): BucketTarget[] {
  const savedMap = new Map(selectBucketTargets(db).map((t) => [t.bucket, t.targetRatio]))
  return ALLOCATION_BUCKETS.map((bucket) => ({
    bucket,
    targetRatio: savedMap.get(bucket) ?? 0
  }))
}

/**
 * 保存配置桶目标（逐行编辑）：必须包含三个配置桶各一行。
 * 全 0 也是合法的「未配置」状态，照常落库。
 */
export function saveBucketTargets(db: Database.Database, targets: BucketTarget[]): void {
  const ratios = new Map<AllocationBucket, number>()
  for (const target of targets) {
    if (!(ALLOCATION_BUCKETS as readonly string[]).includes(target.bucket)) {
      throw new Error(`配置桶需为：${ALLOCATION_BUCKETS.join('/')}`)
    }
    if (ratios.has(target.bucket)) throw new Error(`配置桶「${target.bucket}」重复`)
    if (!Number.isFinite(target.targetRatio) || target.targetRatio < 0 || target.targetRatio > 1) {
      throw new Error('目标比例需为 0 到 1 之间的数字')
    }
    ratios.set(target.bucket, target.targetRatio)
  }
  if (ALLOCATION_BUCKETS.some((bucket) => !ratios.has(bucket))) {
    throw new Error(`配置桶目标需包含：${ALLOCATION_BUCKETS.join('/')}`)
  }
  db.transaction(() => {
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO bucket_targets (bucket, target_ratio) VALUES (?,?)'
    )
    for (const bucket of ALLOCATION_BUCKETS) upsert.run(bucket, ratios.get(bucket))
  })()
}
