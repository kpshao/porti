import { describe, expect, it } from 'vitest'
import { buildTargetsPayload } from './targets'

describe('buildTargetsPayload — 配置桶目标行内编辑', () => {
  it('只把编辑过的行换算成百分比，未编辑行原样沿用保存的原始目标值', () => {
    // 迁移折算后的目标（如 65/95）不是 2 位百分比能精确表示的；编辑「权益」不应改写另外两行
    const rows = [
      { bucket: '稳健' as const, targetRatio: 65 / 95 },
      { bucket: '权益' as const, targetRatio: 25 / 95 },
      { bucket: '黄金' as const, targetRatio: 5 / 95 }
    ]

    const payload = buildTargetsPayload(rows, { 权益: '30' })

    expect(payload).toEqual([
      { bucket: '稳健', targetRatio: 65 / 95 },
      { bucket: '权益', targetRatio: 0.3 },
      { bucket: '黄金', targetRatio: 5 / 95 }
    ])
  })

  it('未编辑任何行时原样返回三行目标值', () => {
    const rows = [
      { bucket: '稳健' as const, targetRatio: 0.4 },
      { bucket: '权益' as const, targetRatio: 0.35 },
      { bucket: '黄金' as const, targetRatio: 0.25 }
    ]

    expect(buildTargetsPayload(rows, {})).toEqual(rows)
  })

  it('编辑值不是数字时返回 null，交由调用方提示并回退', () => {
    const rows = [{ bucket: '稳健' as const, targetRatio: 0.5 }]

    expect(buildTargetsPayload(rows, { 稳健: 'abc' })).toBeNull()
    expect(buildTargetsPayload(rows, { 稳健: '' })).toEqual([{ bucket: '稳健', targetRatio: 0 }])
  })
})
