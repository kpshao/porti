// Excel 导入专用的类别/产品形态标签别名。
// 旧五类标签只在这里保留：导入器必须继续接受旧 Excel 的类别标签，其余运行时路径不再识别它们。

import type { ProductForm } from '../engine'

/** 旧 Excel 标签与新标签 → 产品形态；无法识别返回 null（不兜底）。 */
const LABEL_TO_PRODUCT_FORM: Record<string, ProductForm> = {
  '固守+': '固收+',
  '固收+': '固收+',
  纯债: '纯债',
  权益: '权益',
  黄金: '黄金',
  流动性: '纯债'
}

/** Excel 类别标签 → 产品形态；旧「流动性」归入纯债 */
export function resolveProductFormLabel(label: string): ProductForm | null {
  return LABEL_TO_PRODUCT_FORM[label.trim()] ?? null
}
