import { describe, expect, it } from 'vitest'
import { isValidDateString, normalizeFundCode, normalizeFundInput, normalizeTransactionInput } from './validation'
import type { FundInput, TransactionInput } from './validation'

const base: TransactionInput = {
  date: '2026-01-15',
  type: '买入',
  fundCode: '000001',
  amount: 1000,
  shares: 100,
  nav: 10,
  fee: null,
  note: null
}

describe('normalizeTransactionInput — 买入', () => {
  it('手续费为空默认 0，备注空白归一化为 null', () => {
    expect(normalizeTransactionInput({ ...base, note: '  ' })).toEqual({
      ...base, fee: 0, note: null
    })
  })

  it('金额/份额必须为正', () => {
    expect(() => normalizeTransactionInput({ ...base, amount: null })).toThrow(/金额/)
    expect(() => normalizeTransactionInput({ ...base, amount: 0 })).toThrow(/金额/)
    expect(() => normalizeTransactionInput({ ...base, shares: null })).toThrow(/份额/)
    expect(() => normalizeTransactionInput({ ...base, shares: -5 })).toThrow(/份额/)
  })
})

describe('normalizeTransactionInput — 卖出', () => {
  it('金额与份额强制取负（库内约定），界面录入正数', () => {
    const t = normalizeTransactionInput({ ...base, type: '卖出', amount: 1200, shares: 500 })
    expect(t.amount).toBe(-1200)
    expect(t.shares).toBe(-500)
  })

  it('份额缺失报错', () => {
    expect(() => normalizeTransactionInput({ ...base, type: '卖出', shares: null })).toThrow(/份额/)
  })
})

describe('normalizeTransactionInput — 分红现金', () => {
  it('金额正、份额强制置空（无论录入何值）', () => {
    const t = normalizeTransactionInput({ ...base, type: '分红现金', shares: 999 })
    expect(t.amount).toBe(1000)
    expect(t.shares).toBeNull()
  })

  it('金额必须为正', () => {
    expect(() => normalizeTransactionInput({ ...base, type: '分红现金', amount: -100 })).toThrow(/金额/)
  })
})

describe('normalizeTransactionInput — 分红再投入', () => {
  it('金额为空按 0 计（只加份额、成本不变），份额必须为正', () => {
    const t = normalizeTransactionInput({ ...base, type: '分红再投入', amount: null, shares: 50 })
    expect(t.amount).toBe(0)
    expect(t.shares).toBe(50)
  })

  it('金额非空非 0 报错；份额缺失报错', () => {
    expect(() => normalizeTransactionInput({ ...base, type: '分红再投入', amount: 100 })).toThrow(/金额/)
    expect(() => normalizeTransactionInput({ ...base, type: '分红再投入', shares: null })).toThrow(/份额/)
  })
})

describe('normalizeTransactionInput — 公共规则', () => {
  it('日期必须为合法 YYYY-MM-DD', () => {
    expect(() => normalizeTransactionInput({ ...base, date: '2026-1-5' })).toThrow(/日期/)
    expect(() => normalizeTransactionInput({ ...base, date: '2026-13-01' })).toThrow(/日期/)
  })

  it('基金代码必须为 6 位数字，支持补零', () => {
    expect(normalizeTransactionInput({ ...base, fundCode: '2065' }).fundCode).toBe('002065')
    expect(() => normalizeTransactionInput({ ...base, fundCode: 'abc' })).toThrow(/基金代码/)
  })

  it('净值可选但必须为正；手续费必须非负', () => {
    expect(normalizeTransactionInput({ ...base, nav: null }).nav).toBeNull()
    expect(() => normalizeTransactionInput({ ...base, nav: -1 })).toThrow(/净值/)
    expect(() => normalizeTransactionInput({ ...base, fee: -1 })).toThrow(/手续费/)
  })

  it('无法识别的操作类型报错', () => {
    expect(() => normalizeTransactionInput({ ...base, type: '定投' as never })).toThrow(/操作类型/)
  })
})

describe('isValidDateString', () => {
  it('合法日期', () => {
    expect(isValidDateString('2026-01-15')).toBe(true)
    expect(isValidDateString('2024-02-29')).toBe(true) // 闰年
    expect(isValidDateString('2026-02-29')).toBe(false)
  })

  it('非法格式', () => {
    expect(isValidDateString('2026-1-5')).toBe(false)
    expect(isValidDateString('abc')).toBe(false)
    expect(isValidDateString('')).toBe(false)
  })
})

describe('normalizeFundInput — 新建基金', () => {
  it('代码补前导零至 6 位', () => {
    const f = normalizeFundInput({ code: '2065', name: '测试基金', category: '固守+', fundType: null, targetAmount: null })
    expect(f.code).toBe('002065')
  })

  it('名称必填、大类须为封闭集合、目标金额非负', () => {
    const baseFund: FundInput = { code: '000001', name: '测试基金', category: '固守+', fundType: null, targetAmount: null }
    expect(() => normalizeFundInput({ ...baseFund, code: 'abc' })).toThrow(/基金代码/)
    expect(() => normalizeFundInput({ ...baseFund, name: '' })).toThrow(/名称/)
    expect(() => normalizeFundInput({ ...baseFund, category: '' })).toThrow(/资产大类/)
    expect(() => normalizeFundInput({ ...baseFund, category: '股票' })).toThrow(/资产大类/)
    expect(() => normalizeFundInput({ ...baseFund, targetAmount: -1 })).toThrow(/目标金额/)
    // 五个标准大类均通过
    for (const c of ['固守+', '纯债', '权益', '黄金', '流动性']) {
      expect(normalizeFundInput({ ...baseFund, category: c }).category).toBe(c)
    }
  })
})

describe('normalizeFundCode', () => {
  it('与 importer 共用同一规则', () => {
    expect(normalizeFundCode(2065)).toBe('002065')
    expect(normalizeFundCode('563360')).toBe('563360')
    expect(normalizeFundCode('abc')).toBeNull()
  })
})
