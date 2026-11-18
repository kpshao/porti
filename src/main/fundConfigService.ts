// 基金配置服务：列出全部基金与更新元数据（名称、产品形态、账本大类、权益系数）。
// 更新口径（追溯重算、无生效日期）见 ADR-0004。

import type Database from 'better-sqlite3'
import { normalizeFundUpdateInput } from '../engine'
import type { Fund, FundUpdateInput } from '../engine'
import { selectFunds, updateFundRow } from './repo'

/** 基金配置页列表：全部基金（含已清仓与从未建仓的基金），按基金代码升序 */
export function listFundConfigs(db: Database.Database): Fund[] {
  return selectFunds(db)
}

/**
 * 更新基金的元数据。代码只作定位、不可修改。
 * 权益系数变化时来源记为手工，数据日期保持不变；只改其他字段时不动来源。
 */
export function updateFund(db: Database.Database, input: FundUpdateInput): Fund {
  const update = normalizeFundUpdateInput(input)
  const current = selectFunds(db).find((f) => f.code === update.code)
  if (current === undefined) throw new Error(`基金 ${update.code} 不存在`)

  const ratioChanged = update.equityRatio !== current.equityRatio
  updateFundRow(db, {
    ...update,
    equityRatioSource: ratioChanged ? 'manual' : current.equityRatioSource
  })

  return selectFunds(db).find((f) => f.code === update.code)!
}
