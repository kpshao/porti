// 基金的最终三层分类模型：账本大类、产品形态、权益系数及其来源与数据日期。
// 旧五类兼容映射已随 schema v6 删除；仅导入器别名与历史迁移例外（见 importer/labels.ts、main/schemaMigration.ts）。

/** 账本大类：基金最终归属的资产账本 */
export const LEDGER_CATEGORIES = ['债', '权益', '黄金'] as const
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number]

/** 产品形态：用户可感知的基金类型；与账本大类有固定映射 */
export const PRODUCT_FORMS = ['固收+', '纯债', '权益', '黄金'] as const
export type ProductForm = (typeof PRODUCT_FORMS)[number]

/** 权益系数来源：手工录入 / 抓取（抓取功能见第二期） */
export const EQUITY_RATIO_SOURCES = ['manual', 'fetch'] as const
export type EquityRatioSource = (typeof EQUITY_RATIO_SOURCES)[number]

/** 系数来源中文标签（展示用） */
export const EQUITY_RATIO_SOURCE_LABEL = {
  manual: '手工',
  fetch: '抓取'
} as const

/** 系数来源的中文标签值（对外呈现：快照、导出等） */
export type EquityRatioSourceLabel = (typeof EQUITY_RATIO_SOURCE_LABEL)[EquityRatioSource]

/** 产品形态 → 账本大类（固定映射）。写入路径从产品形态派生账本大类，保证两者一致。 */
export const LEDGER_CATEGORY_BY_PRODUCT_FORM: Record<ProductForm, LedgerCategory> = {
  '固收+': '债',
  纯债: '债',
  权益: '权益',
  黄金: '黄金'
}

/** 各产品形态的默认权益系数；允许逐只覆盖（0–1） */
export const DEFAULT_EQUITY_RATIO: Record<ProductForm, number> = {
  '固收+': 0.2,
  纯债: 0,
  权益: 1,
  黄金: 0
}

/** 每只基金的分类与权益穿透字段（schema v6 起每只基金都有） */
export interface FundClassification {
  ledgerCategory: LedgerCategory
  productForm: ProductForm
  equityRatio: number
  equityRatioSource: EquityRatioSource
  equityRatioAsOf: string | null // 系数数据日期（报告期或空）
}
