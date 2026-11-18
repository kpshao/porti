// 基金的资产分类与权益系数字段：账本大类、产品形态、权益系数及其来源与数据日期。
// 旧五类兼容映射是过渡层（收缩票 #32 删除）：schema v4 起旧的 funds.category 与新字段并存，
// 尚未迁移的页面继续读旧值；新写入路径必须同时维护旧值与新字段。

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

/** 产品形态 → 旧五类兼容列写法（过渡层；兼容列只存旧值，「固收+」写回为「固守+」） */
export const COMPAT_CATEGORY_BY_PRODUCT_FORM: Record<ProductForm, string> = {
  '固收+': '固守+',
  纯债: '纯债',
  权益: '权益',
  黄金: '黄金'
}

/** 每只基金的分类与权益穿透字段（schema v4 起必有） */
export interface FundClassification {
  ledgerCategory: LedgerCategory
  productForm: ProductForm
  equityRatio: number
  equityRatioSource: EquityRatioSource
  equityRatioAsOf: string | null // 系数数据日期（报告期或空）
}

/**
 * 旧五类/新标签写法 → 产品形态。兼容列写法统一来自 COMPAT_CATEGORY_BY_PRODUCT_FORM，
 * 只有旧「流动性」保留原写法（它不属于任何产品形态）。新标签「固收+」是「固守+」的别名。
 */
const LEGACY_PRODUCT_FORM: Record<string, ProductForm> = {
  '固守+': '固收+',
  '固收+': '固收+',
  纯债: '纯债',
  权益: '权益',
  黄金: '黄金',
  流动性: '纯债'
}

/** 兼容映射的全部旧大类写法（迁移预检与回填共用） */
export const LEGACY_FUND_CATEGORIES = Object.keys(LEGACY_PRODUCT_FORM)

/**
 * 大类/产品形态标签（旧五类或新标签）→ 产品形态；无法识别返回 null。
 * 标签白名单只在本表维护，导入预览与写入共用。
 */
export function resolveProductFormLabel(label: string): ProductForm | null {
  return LEGACY_PRODUCT_FORM[label] ?? null
}

/** 基金的产品形态：新模型字段优先，缺失时由旧大类兼容映射派生；无法识别返回 null（不猜测）。 */
export function deriveProductForm(
  category: string,
  productForm?: ProductForm
): ProductForm | null {
  return productForm ?? resolveLegacyCategory(category)?.classification.productForm ?? null
}

export interface LegacyCategoryResolution {
  /** 写入兼容列 funds.category 的旧五类写法 */
  compatCategory: string
  classification: FundClassification
}

/**
 * 解析旧大类（含「固收+」别名）为新模型字段与兼容列写法；未知返回 null，
 * 由调用方决定报错方式（迁移中止 / 导入报错）。
 */
export function resolveLegacyCategory(category: string): LegacyCategoryResolution | null {
  const productForm = resolveProductFormLabel(category)
  if (productForm === null) return null
  return {
    compatCategory:
      category === '流动性' ? '流动性' : COMPAT_CATEGORY_BY_PRODUCT_FORM[productForm],
    classification: {
      ledgerCategory: LEDGER_CATEGORY_BY_PRODUCT_FORM[productForm],
      productForm,
      equityRatio: DEFAULT_EQUITY_RATIO[productForm],
      equityRatioSource: 'manual',
      equityRatioAsOf: null
    }
  }
}
