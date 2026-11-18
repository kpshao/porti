// 领域校验与归一化规则：流水录入、新建基金、基金配置更新（主进程服务与界面共用同一份规则）

import {
  DEFAULT_EQUITY_RATIO,
  LEDGER_CATEGORIES,
  LEDGER_CATEGORY_BY_PRODUCT_FORM,
  PRODUCT_FORMS
} from './classification'
import type { LedgerCategory, ProductForm } from './classification'
import type { Fund, OperationType, Transaction } from './types'

/** 四种操作类型（spec 领域词汇的封闭集合） */
export const OPERATION_TYPES: OperationType[] = ['买入', '卖出', '分红现金', '分红再投入']

/** 流水录入输入（界面/服务入参；金额、份额、手续费可为空） */
export interface TransactionInput {
  date: string
  type: OperationType
  fundCode: string
  amount: number | null
  shares: number | null
  nav: number | null
  fee: number | null
  note: string | null
}

/** 新建基金输入（分类字段派生规则见 classification.ts） */
export interface FundInput {
  code: string
  name: string
  productForm: ProductForm
  fundType: string | null
}

/** 基金配置页更新输入：代码只作定位、不可修改（一致性规则见 classification.ts） */
export interface FundUpdateInput {
  code: string
  name: string
  productForm: ProductForm
  ledgerCategory: LedgerCategory
  equityRatio: number // 0–1（界面按百分比录入）
}

/** 归一化后的基金配置更新 */
export interface NormalizedFundUpdate {
  code: string
  name: string
  productForm: ProductForm
  ledgerCategory: LedgerCategory
  equityRatio: number
}

/** 基金代码归一化：6 位补零字符串；无法识别返回 null（importer 共用） */
export function normalizeFundCode(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  let s: string
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    s = String(Math.round(raw))
  } else {
    s = String(raw).trim()
  }
  return /^\d{1,6}$/.test(s) ? s.padStart(6, '0') : null
}

/** 是否为合法日期字符串 YYYY-MM-DD（含真实日历校验） */
export function isValidDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m === null) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function fail(...messages: string[]): never {
  throw new Error(messages.join('；'))
}

/** 权益系数值域 [0, 1]（配置更新与抓取确认共用） */
export function isValidEquityRatio(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/** 权益系数非法时的统一中文错误（服务与界面共用） */
export const EQUITY_RATIO_ERROR_TEXT = '权益系数需为 0 到 100% 之间的数字'

/** 校验并归一化流水录入。规则与 ticket 04 一致；卖出按库内约定取负。 */
export function normalizeTransactionInput(input: TransactionInput): Transaction {
  const errors: string[] = []

  if (!isValidDateString(input.date)) errors.push('日期需为合法 YYYY-MM-DD')
  const code = normalizeFundCode(input.fundCode)
  if (code === null) errors.push('基金代码需为 6 位数字')
  if (!OPERATION_TYPES.includes(input.type)) errors.push(`无法识别的操作类型「${String(input.type)}」`)
  if (input.nav !== null && (input.nav <= 0 || !Number.isFinite(input.nav))) errors.push('净值必须为正数')
  if (input.fee !== null && (input.fee < 0 || !Number.isFinite(input.fee))) errors.push('手续费不能为负')

  let amount = input.amount
  let shares = input.shares
  if (input.type === '买入') {
    if (amount === null || amount <= 0) errors.push('买入金额必须为正数')
    if (shares === null || shares <= 0) errors.push('买入份额必须为正数')
  } else if (input.type === '卖出') {
    if (amount === null || amount === 0) errors.push('卖出金额必须非零')
    if (shares === null || shares === 0) errors.push('卖出份额必须非零')
    // 库内约定：卖出金额与份额均存负值（界面录入正数，此处取负）
    amount = amount === null ? null : -Math.abs(amount)
    shares = shares === null ? null : -Math.abs(shares)
  } else if (input.type === '分红现金') {
    if (amount === null || amount <= 0) errors.push('分红现金金额必须为正数')
    shares = null // 分红现金无份额，强制置空
  } else {
    // 分红再投入：只加份额、成本不变（金额按 0 计）
    if (amount !== null && amount !== 0) errors.push('分红再投入金额应为空（只加份额、成本不变）')
    if (shares === null || shares <= 0) errors.push('分红再投入份额必须为正数')
    amount = 0
  }

  if (errors.length > 0) fail(...errors)

  return {
    date: input.date,
    type: input.type,
    fundCode: code!,
    amount: amount!,
    shares,
    nav: input.nav,
    fee: input.fee ?? 0,
    note: input.note === null || input.note.trim() === '' ? null : input.note.trim()
  }
}

/** 新建与更新共用的代码/名称校验：错误追加到 errors，返回归一化值供无错误时使用 */
function normalizeFundIdentity(
  input: { code: string; name: string },
  errors: string[]
): { code: string; name: string } {
  const code = normalizeFundCode(input.code)
  if (code === null) errors.push('基金代码需为 6 位数字')
  if (input.name.trim() === '') errors.push('基金名称不能为空')
  return { code: code!, name: input.name.trim() }
}

/** 校验并归一化新建基金输入（代码补零）。账本大类与默认权益系数由产品形态派生。 */
export function normalizeFundInput(input: FundInput): Fund {
  const errors: string[] = []
  const { code, name } = normalizeFundIdentity(input, errors)
  if (!(PRODUCT_FORMS as readonly string[]).includes(input.productForm)) {
    errors.push(`产品形态需为：${PRODUCT_FORMS.join('/')}`)
  }
  if (errors.length > 0) fail(...errors)

  const productForm = input.productForm
  return {
    code,
    name,
    fundType: input.fundType === null || input.fundType.trim() === '' ? null : input.fundType.trim(),
    ledgerCategory: LEDGER_CATEGORY_BY_PRODUCT_FORM[productForm],
    productForm,
    equityRatio: DEFAULT_EQUITY_RATIO[productForm],
    equityRatioSource: 'manual',
    equityRatioAsOf: null
  }
}

/**
 * 校验并归一化基金配置更新：代码只作定位（不参与写入），产品形态与账本大类必须符合固定映射，
 * 权益系数按 [0, 1] 校验（界面负责百分比换算）。
 */
export function normalizeFundUpdateInput(input: FundUpdateInput): NormalizedFundUpdate {
  const errors: string[] = []
  const { code, name } = normalizeFundIdentity(input, errors)
  const productFormValid = (PRODUCT_FORMS as readonly string[]).includes(input.productForm)
  if (!productFormValid) errors.push(`产品形态需为：${PRODUCT_FORMS.join('/')}`)
  const ledgerCategoryValid = (LEDGER_CATEGORIES as readonly string[]).includes(input.ledgerCategory)
  if (!ledgerCategoryValid) errors.push(`账本大类需为：${LEDGER_CATEGORIES.join('/')}`)
  if (!isValidEquityRatio(input.equityRatio)) {
    errors.push(EQUITY_RATIO_ERROR_TEXT)
  }
  if (productFormValid && ledgerCategoryValid) {
    const expected = LEDGER_CATEGORY_BY_PRODUCT_FORM[input.productForm]
    if (expected !== input.ledgerCategory) {
      errors.push(
        `产品形态「${input.productForm}」与账本大类「${input.ledgerCategory}」不一致，应为「${expected}」`
      )
    }
  }
  if (errors.length > 0) fail(...errors)

  return {
    code,
    name,
    productForm: input.productForm,
    ledgerCategory: input.ledgerCategory,
    equityRatio: input.equityRatio
  }
}
