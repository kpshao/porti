// 界面数字格式约定（spec）：金额 2 位小数、净值 4 位、份额 2 位、比例百分比 2 位、
// HHI 3 位小数、有效持仓数 1 位小数

/** 是否可格式化：null / undefined / 非有限数（NaN、±Infinity）一律按「无定义」显示「—」 */
function isFormattable(n: number | null | undefined): n is number {
  return n !== null && n !== undefined && Number.isFinite(n)
}

export function formatMoney(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatNav(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return n.toFixed(4)
}

export function formatShares(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatPercent(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return `${(n * 100).toFixed(2)}%`
}

/** HHI：精度见文件头约定（无定义显示「—」） */
export function formatHhi(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return n.toFixed(3)
}

/** 有效持仓数（1 ÷ HHI）：精度见文件头约定（无定义显示「—」） */
export function formatEffectiveHoldings(n: number | null | undefined): string {
  if (!isFormattable(n)) return '—'
  return n.toFixed(1)
}
