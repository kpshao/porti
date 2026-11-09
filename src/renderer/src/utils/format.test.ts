import { describe, expect, it } from 'vitest'
import {
  formatEffectiveHoldings,
  formatHhi,
  formatMoney,
  formatNav,
  formatPercent,
  formatShares
} from './format'

describe('界面数字格式', () => {
  it('金额：2 位小数、千分位；空值显示「—」', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50')
    expect(formatMoney(null)).toBe('—')
  })

  it('净值：4 位小数；空值显示「—」', () => {
    expect(formatNav(1.23456)).toBe('1.2346')
    expect(formatNav(undefined)).toBe('—')
  })

  it('份额：2 位小数、千分位；空值显示「—」', () => {
    expect(formatShares(1234.5)).toBe('1,234.50')
    expect(formatShares(NaN)).toBe('—')
  })

  it('比例：按百分比 2 位小数；空值显示「—」', () => {
    expect(formatPercent(0.1234)).toBe('12.34%')
    expect(formatPercent(null)).toBe('—')
  })

  it('HHI：3 位小数；空值显示「—」', () => {
    expect(formatHhi(0.2952)).toBe('0.295')
    expect(formatHhi(Infinity)).toBe('—')
  })

  it('有效持仓数：1 位小数；空值显示「—」', () => {
    expect(formatEffectiveHoldings(1.6)).toBe('1.6')
    expect(formatEffectiveHoldings(null)).toBe('—')
  })
})
