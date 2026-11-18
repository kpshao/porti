// 配置目标服务：旧大类目标种子（过渡）与配置桶目标的读取/保存

import type Database from 'better-sqlite3'
import { ALLOCATION_BUCKETS, convertLegacyCategoryTargets } from '../engine'
import type { AllocationBucket, BucketTarget, CategoryTarget } from '../engine'
import { selectBucketTargets, selectCategoryTargets } from './repo'

/** 默认大类目标（ticket #06 验收值）。新库只种子旧目标；配置桶目标在首次读取时折算（见 loadBucketTargets）。 */
export const DEFAULT_CATEGORY_TARGETS: CategoryTarget[] = [
  { category: '固守+', targetRatio: 0.25 },
  { category: '纯债', targetRatio: 0.45 },
  { category: '权益', targetRatio: 0.2 },
  { category: '黄金', targetRatio: 0.05 },
  { category: '流动性', targetRatio: 0.05 }
]

/** 新库种子默认旧大类目标；已有目标（如 Excel 导入值）不覆盖，仅补齐缺失大类 */
export function seedDefaultCategoryTargets(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO category_targets (category, target_ratio) VALUES (?,?)'
  )
  for (const t of DEFAULT_CATEGORY_TARGETS) insert.run(t.category, t.targetRatio)
}

export interface BucketTargetsState {
  /** 顺序同 ALLOCATION_BUCKETS */
  targets: BucketTarget[]
  /** 目标表尚未初始化、当前值来自旧大类目标折算（界面展示一次性确认） */
  targetConversionPending: boolean
}

/**
 * 读取配置桶目标：
 * - 已保存过（哪怕三行都是 0）→ 直接返回，顺序固定；
 * - 尚未保存 → 从旧大类目标折算（不写库），可折算出非零目标时标记待确认。
 *   旧目标为 0 或只有流动性有值时视为未配置，不提示确认。
 */
export function loadBucketTargets(db: Database.Database): BucketTargetsState {
  const saved = selectBucketTargets(db)
  if (saved.length > 0) {
    const savedMap = new Map(saved.map((t) => [t.bucket, t.targetRatio]))
    return {
      targets: ALLOCATION_BUCKETS.map((bucket) => ({
        bucket,
        targetRatio: savedMap.get(bucket) ?? 0
      })),
      targetConversionPending: false
    }
  }
  const converted = convertLegacyCategoryTargets(selectCategoryTargets(db))
  return {
    targets: converted,
    targetConversionPending: converted.some((t) => t.targetRatio > 0)
  }
}

/**
 * 保存配置桶目标（逐行编辑与「接受折算结果」共用）：必须包含三个配置桶各一行。
 * 写入后目标表非空，折算确认提示随之消失；全 0 也是合法的「未配置」状态，照常落库。
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
