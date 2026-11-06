// 配置目标编辑服务：大类目标比例（数据访问层 + 领域校验）

import type Database from 'better-sqlite3'
import { CATEGORIES } from '../engine'
import type { CategoryTarget } from '../engine'

/** 默认大类目标（ticket #06 验收值；Excel 导入会用导入值覆盖） */
export const DEFAULT_CATEGORY_TARGETS: CategoryTarget[] = [
  { category: '固守+', targetRatio: 0.25 },
  { category: '纯债', targetRatio: 0.45 },
  { category: '权益', targetRatio: 0.2 },
  { category: '黄金', targetRatio: 0.05 },
  { category: '流动性', targetRatio: 0.05 }
]

/** 新库种子默认目标；已有目标（如 Excel 导入值）不覆盖，仅补齐缺失大类 */
export function seedDefaultCategoryTargets(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO category_targets (category, target_ratio) VALUES (?,?)'
  )
  for (const t of DEFAULT_CATEGORY_TARGETS) insert.run(t.category, t.targetRatio)
}

/** 校验并 upsert 大类目标比例（比例 ∈ [0,1]，大类为五类封闭集合） */
export function updateCategoryTarget(db: Database.Database, category: string, targetRatio: number): void {
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`资产大类需为：${CATEGORIES.join('/')}`)
  }
  if (!Number.isFinite(targetRatio) || targetRatio < 0 || targetRatio > 1) {
    throw new Error('目标比例需为 0 到 1 之间的数字')
  }
  db.prepare('INSERT OR REPLACE INTO category_targets (category, target_ratio) VALUES (?,?)').run(
    category,
    targetRatio
  )
}
