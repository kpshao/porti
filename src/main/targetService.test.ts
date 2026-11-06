import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { computeCategoryComparison, computePositions } from '../engine'
import { SCHEMA } from './schema'
import { selectCategoryTargets, selectFunds, selectNavPoints, selectTransactions } from './repo'
import { seedDefaultCategoryTargets, updateCategoryTarget } from './targetService'
import { createFund } from './transactionService'

/** 测试辅助：从库内数据计算持仓（引擎输入） */
function computePositionsOf(db: Database.Database): ReturnType<typeof computePositions> {
  return computePositions(selectFunds(db), selectTransactions(db), selectNavPoints(db))
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function seedFund(db: Database.Database): void {
  createFund(db, { code: '000001', name: '基金甲', category: '权益', fundType: null })
}

describe('seedDefaultCategoryTargets — 默认目标种子（ticket 默认值）', () => {
  it('空库种子五个默认大类比例', () => {
    const db = freshDb()
    seedDefaultCategoryTargets(db)
    // 顺序不属于本函数的契约（消费方 computeCategoryComparison 负责按 CATEGORIES 排序），此处只校验集合
    expect(Object.fromEntries(selectCategoryTargets(db).map((t) => [t.category, t.targetRatio]))).toEqual({
      '固守+': 0.25,
      纯债: 0.45,
      权益: 0.2,
      黄金: 0.05,
      流动性: 0.05
    })
  })

  it('已有目标（如 Excel 导入值）不覆盖', () => {
    const db = freshDb()
    updateCategoryTarget(db, '纯债', 0.4) // 模拟导入写入的目标
    seedDefaultCategoryTargets(db)
    expect(selectCategoryTargets(db).find((t) => t.category === '纯债')?.targetRatio).toBe(0.4)
    // 未写入的大类被补齐
    expect(selectCategoryTargets(db).find((t) => t.category === '权益')?.targetRatio).toBe(0.2)
  })
})

describe('updateCategoryTarget — 大类目标比例编辑', () => {
  it('新建目标比例入库', () => {
    const db = freshDb()
    updateCategoryTarget(db, '固守+', 0.25)
    expect(selectCategoryTargets(db)).toEqual([{ category: '固守+', targetRatio: 0.25 }])
  })

  it('已有大类覆盖更新（ticket 默认值 25/45/20/5/5 中的两项）', () => {
    const db = freshDb()
    updateCategoryTarget(db, '纯债', 0.45)
    updateCategoryTarget(db, '纯债', 0.4)
    expect(selectCategoryTargets(db)).toEqual([{ category: '纯债', targetRatio: 0.4 }])
  })

  it('非法输入给出中文错误：大类不在五类、比例越界、非数字', () => {
    const db = freshDb()
    expect(() => updateCategoryTarget(db, '股票', 0.2)).toThrow(/固守\+\/纯债\/权益\/黄金\/流动性/)
    expect(() => updateCategoryTarget(db, '权益', 1.2)).toThrow(/0 到 1/)
    expect(() => updateCategoryTarget(db, '权益', -0.1)).toThrow(/0 到 1/)
    expect(() => updateCategoryTarget(db, '权益', Number.NaN)).toThrow(/0 到 1/)
  })

  it('更新后大类对比按新目标重算偏离', () => {
    const db = freshDb()
    seedFund(db)
    db.prepare('INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      '2026-01-15', '买入', '000001', 1000, 100, 10, 0, null, 'x', 'x'
    )
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-01-20', 10, 'manual'
    )

    updateCategoryTarget(db, '权益', 0.2)
    const before = computeCategoryComparison(
      computePositionsOf(db), selectCategoryTargets(db)
    )
    expect(before.find((r) => r.category === '权益')?.targetRatio).toBeCloseTo(0.2)

    updateCategoryTarget(db, '权益', 0.5)
    const after = computeCategoryComparison(
      computePositionsOf(db), selectCategoryTargets(db)
    )
    // 实际市值占比不变，偏离 = 占比 − 新目标
    expect(after.find((r) => r.category === '权益')?.targetRatio).toBeCloseTo(0.5)
    const marketRatio = after.find((r) => r.category === '权益')!.marketRatio!
    expect(after.find((r) => r.category === '权益')!.deviation).toBeCloseTo(marketRatio - 0.5, 9)
  })
})
