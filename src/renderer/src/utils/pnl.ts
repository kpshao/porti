// 盈亏着色约定（渲染层共用）：null（无净值/无定义）不着色，正红负绿（中国习惯）。
// 类名定义见 styles.css 的 .positive / .negative，与图表色 POSITIVE_RED / NEGATIVE_GREEN 同值。

/** 盈亏值 → 着色类名；null 或 undefined 不着色 */
export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  return n >= 0 ? 'positive' : 'negative'
}
