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

/** 每只基金的分类与权益穿透字段（schema v4 起必有） */
export interface FundClassification {
  ledgerCategory: LedgerCategory
  productForm: ProductForm
  equityRatio: number
  equityRatioSource: EquityRatioSource
  equityRatioAsOf: string | null // 系数数据日期（报告期或空）
}

/**
 * 旧大类 → 产品形态与兼容列写法。兼容列只存旧五类标准值，因此新拼写「固收+」
 * 回写为「固守+」，老页面按旧五类识别时不会把它归入「其他」。
 */
const LEGACY_CATEGORY_MAP: Record<string, { productForm: ProductForm; compatCategory: string }> = {
  '固守+': { productForm: '固收+', compatCategory: '固守+' },
  '固收+': { productForm: '固收+', compatCategory: '固守+' },
  纯债: { productForm: '纯债', compatCategory: '纯债' },
  权益: { productForm: '权益', compatCategory: '权益' },
  黄金: { productForm: '黄金', compatCategory: '黄金' },
  流动性: { productForm: '纯债', compatCategory: '流动性' }
}

/** 兼容映射的全部旧大类写法（迁移预检与回填共用） */
export const LEGACY_FUND_CATEGORIES = Object.keys(LEGACY_CATEGORY_MAP)

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
  const entry = LEGACY_CATEGORY_MAP[category]
  if (entry === undefined) return null
  return {
    compatCategory: entry.compatCategory,
    classification: {
      ledgerCategory: LEDGER_CATEGORY_BY_PRODUCT_FORM[entry.productForm],
      productForm: entry.productForm,
      equityRatio: DEFAULT_EQUITY_RATIO[entry.productForm],
      equityRatioSource: 'manual',
      equityRatioAsOf: null
    }
  }
}
