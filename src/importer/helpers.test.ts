import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { normalizeFundCode } from '../engine'
import { cellToDate, excelSerialToDate, normalizeType, parseWorkbook } from './parse'

describe('excelSerialToDate — 序列号 → YYYY-MM-DD（对照 Excel 显示值）', () => {
  it.each([
    [1, '1900-01-01'],
    [59, '1900-02-28'],
    [60, '1900-03-01'], // 假想的 1900-02-29
    [61, '1900-03-01'],
    [45679, '2025-01-22'],
    [46084, '2026-03-03'],
    [46094, '2026-03-13'],
    [46258, '2026-08-24']
  ])('%s → %s', (serial, expected) => {
    expect(excelSerialToDate(serial)).toBe(expected)
  })
})

describe('cellToDate', () => {
  it('字符串日期多格式解析', () => {
    expect(cellToDate('2026-3-2')).toBe('2026-03-02')
    expect(cellToDate('2026/03/02')).toBe('2026-03-02')
    expect(cellToDate(' 2026-03-02 ')).toBe('2026-03-02')
  })

  it('无法解析返回 null', () => {
    expect(cellToDate('不是日期')).toBeNull()
    expect(cellToDate(null)).toBeNull()
    expect(cellToDate(NaN)).toBeNull()
  })
})

describe('normalizeFundCode', () => {
  it('补前导零至 6 位', () => {
    expect(normalizeFundCode(2065)).toBe('002065')
    expect(normalizeFundCode('2009')).toBe('002009')
    expect(normalizeFundCode(1)).toBe('000001')
  })

  it('数字/字符串 6 位代码原样', () => {
    expect(normalizeFundCode(519680)).toBe('519680')
    expect(normalizeFundCode('002009')).toBe('002009')
    expect(normalizeFundCode(' 563360 ')).toBe('563360')
  })

  it('非法输入返回 null', () => {
    expect(normalizeFundCode(null)).toBeNull()
    expect(normalizeFundCode('')).toBeNull()
    expect(normalizeFundCode('abc')).toBeNull()
    expect(normalizeFundCode(NaN)).toBeNull()
    expect(normalizeFundCode(1234567)).toBeNull() // 超过 6 位
  })
})

describe('normalizeType', () => {
  it('四类操作类型归一化', () => {
    expect(normalizeType('买入')).toBe('买入')
    expect(normalizeType(' 卖出 ')).toBe('卖出')
    expect(normalizeType('分红现金')).toBe('分红现金')
    expect(normalizeType('分红再投入')).toBe('分红再投入')
    expect(normalizeType('定投')).toBeNull()
    expect(normalizeType(null)).toBeNull()
  })
})

/** 构造最小可解析工作簿，交易流水按需注入 */
function makeWorkbook(
  txRows: unknown[][],
  detailRows: unknown[][] = []
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['基金代码', '基金简称', '资产大类'], ['000001', '测试基金', '纯债']]),
    '基金列表'
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['类别', '目标', '比例', '总市值', '比例', '基金代码', '基金简称', '目标金额(元)', '累计投入本金(元)', '累计赎回金额', '净投入成本', '当前份额', '最新净值', '当前市值(元)', '持仓盈亏', '盈亏比例', '备注', '类型'],
      ['纯债', 0.45, 1, 100, 1, '000001', '测试基金', null, 100, 0, 100, 100, 1, 100, 0, 0, null, '纯债']
    ]),
    '持仓概览'
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['记录日期', '基金代码', '基金简称', '累计投入', '累计赎回', '当前市值', '持仓收益', '收益率', '资产大类'],
      ...detailRows
    ]),
    '收益明细'
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['记录日期', '总投入', '总赎回', '总市值', '净投入成本', '总收益', '总收益率', '周收益', '周收益率']]),
    '收益汇总'
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['日期', '操作类型', '基金代码', '基金名称', '金额(元)', '份额', '净值', '手续费', '备注'],
      ...txRows
    ]),
    '交易流水'
  )
  return wb
}

describe('parseWorkbook — 边界行为（合成工作簿）', () => {
  it('卖出：金额与份额强制取负（库内约定），代码补零、名称重查', () => {
    const result = parseWorkbook(
      makeWorkbook([[46100, '卖出', 1, '错误名称', 1200, 500, 2.4, 0, null]])
    )
    expect(result.transactionRows).toHaveLength(1)
    expect(result.transactionRows[0].transaction).toMatchObject({
      date: '2026-03-19', type: '卖出', fundCode: '000001', amount: -1200, shares: -500
    })
    // 名称被重查为基金列表名称
    expect(result.transactionRows[0].transaction.fundCode).toBe('000001')
    expect(result.fixes).toContainEqual(
      expect.objectContaining({ kind: 'name-requery', count: 1 })
    )
    expect(result.fixes).toContainEqual(
      expect.objectContaining({ kind: 'code-zero-pad', count: 1 })
    )
  })

  it('分红再投入：金额为空按 0 计（只加份额、成本不变）', () => {
    const result = parseWorkbook(
      makeWorkbook([[46100, '分红再投入', '000001', '测试基金', null, 10, 1.5, 0, null]])
    )
    expect(result.transactionRows[0].transaction.amount).toBe(0)
    expect(result.transactionRows[0].transaction.shares).toBe(10)
  })

  it('无法识别的操作类型：跳过并列入修复清单', () => {
    const result = parseWorkbook(
      makeWorkbook([[46100, '定投', '000001', '测试基金', 100, 10, 1, 0, null]])
    )
    expect(result.transactionRows).toHaveLength(0)
    const skip = result.fixes.find((f) => f.kind === 'row-skipped')
    expect(skip).toBeDefined()
    expect(skip!.detail).toContain('定投')
  })

  it('日期无法解析：跳过并列入修复清单', () => {
    const result = parseWorkbook(
      makeWorkbook([['不是日期', '买入', '000001', '测试基金', 100, 10, 1, 0, null]])
    )
    expect(result.transactionRows).toHaveLength(0)
    expect(result.fixes).toContainEqual(
      expect.objectContaining({ kind: 'row-skipped', detail: expect.stringContaining('日期') })
    )
  })

  it('分红再投入净值与同期快照偏差过大：列入可疑项并给出建议值', () => {
    const result = parseWorkbook(
      makeWorkbook(
        [
          [46100, '买入', '000001', '测试基金', 100, 100, 1, 0, null],
          [46100, '分红再投入', '000001', '测试基金', null, 10, 1.5, 0, null]
        ],
        // 同日快照：市值 220 ÷ 份额 110 = 2.0
        [[46100, '000001', '测试基金', 100, 0, 220, 0, 0, '纯债']]
      )
    )
    expect(result.suspicious).toHaveLength(1)
    const s = result.suspicious[0]
    expect(s.fundCode).toBe('000001')
    const navField = s.fields.find((f) => f.field === 'nav')!
    expect(navField.value).toBe(1.5)
    expect(navField.suggested).toBeCloseTo(2, 4)
  })

  it('快照重建与当前净值同时产出', () => {
    const result = parseWorkbook(
      makeWorkbook(
        [[46100, '买入', '000001', '测试基金', 100, 100, 1, 0, null]],
        [[46100, '000001', '测试基金', 100, 0, 200, 0, 0, '纯债']]
      )
    )
    expect(result.reconstructedNavs).toEqual([
      { fundCode: '000001', date: '2026-03-19', nav: 2 }
    ])
    // 持仓概览最新净值 1 → 当前净值点，日期取流水最大日期
    expect(result.currentNavPoints).toEqual([
      { fundCode: '000001', date: '2026-03-19', nav: 1, source: 'import' }
    ])
  })
})
