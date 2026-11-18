import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { HttpGet } from '../fetcher/types'
import { createEquityFetchService } from './equityFetchService'
import { SCHEMA } from './schema'
import { selectFunds } from './repo'
import { createFund } from './transactionService'

const PINGZHONG_000001 = `/*资产配置*/var Data_assetAllocation = {"series":[{"name":"股票占净比","type":null,"data":[78.21],"yAxis":0},{"name":"债券占净比","type":null,"data":[20.82],"yAxis":0},{"name":"现金占净比","type":null,"data":[0.45],"yAxis":0}],"categories":["2026-09-30"]};`

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function seedFunds(db: Database.Database): void {
  createFund(db, { code: '000001', name: '基金甲', productForm: '纯债', fundType: null })
  createFund(db, { code: '000002', name: '基金乙', productForm: '权益', fundType: null })
}

/** 000001 返回有效 pingzhongdata；其余代码两个数据源都失败 */
const okHttpGet: HttpGet = async (url) => {
  if (url.includes('000001')) return PINGZHONG_000001
  throw new Error('接口无数据')
}

describe('EquityFetchService.fetchAll — 抓取候选值不写库', () => {
  it('按库内全部基金顺序抓取；单只失败按行返回，手工系数保持不变', async () => {
    const db = freshDb()
    seedFunds(db)
    db.prepare(
      "UPDATE funds SET equity_ratio = 0.11, equity_ratio_source = 'manual', equity_ratio_as_of = NULL WHERE code = '000001'"
    ).run()
    const service = createEquityFetchService(okHttpGet)

    const results = await service.fetchAll(db, { sleep: async () => {} })

    expect(results.map((r) => r.ok)).toEqual([true, false])
    if (results[0].ok) {
      expect(results[0].candidate).toMatchObject({
        fundCode: '000001',
        stockRatio: 0.7821,
        reportDate: '2026-09-30'
      })
    }
    if (!results[1].ok) expect(results[1].fundCode).toBe('000002')

    // 抓取只是候选值：确认前不写库，原有手工系数与来源都不变
    expect(selectFunds(db).find((f) => f.code === '000001')).toMatchObject({
      equityRatio: 0.11,
      equityRatioSource: 'manual',
      equityRatioAsOf: null
    })
  })

  it('空库早退：不发请求', async () => {
    const db = freshDb()
    const httpGet = vi.fn<HttpGet>()
    const service = createEquityFetchService(httpGet)
    await expect(service.fetchAll(db)).resolves.toEqual([])
    expect(httpGet).not.toHaveBeenCalled()
  })
})

describe('EquityFetchService.confirm — 用户确认后写入', () => {
  it('未修改抓取值：来源记为 fetch，数据日期取自主进程持有的候选报告期', async () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)
    await service.fetchForFund('000001')

    const fund = service.confirm(db, { fundCode: '000001', confirmedRatio: 0.7821 })

    expect(fund).toMatchObject({
      code: '000001',
      equityRatio: 0.7821,
      equityRatioSource: 'fetch',
      equityRatioAsOf: '2026-09-30'
    })
    expect(selectFunds(db).find((f) => f.code === '000001')).toEqual(fund)
  })

  it('未改值的百分比回换算浮点尾差按抓取处理，并清理尾差后写库', async () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)
    await service.fetchForFund('000001')

    const fund = service.confirm(db, { fundCode: '000001', confirmedRatio: 78.21 / 100 })

    expect(fund.equityRatio).toBe(0.7821)
    expect(fund.equityRatioSource).toBe('fetch')
  })

  it('修改过抓取值：来源记为 manual，数据日期仍保留报告期', async () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)
    await service.fetchForFund('000001')

    const fund = service.confirm(db, { fundCode: '000001', confirmedRatio: 0.7 })

    expect(fund).toMatchObject({
      equityRatio: 0.7,
      equityRatioSource: 'manual',
      equityRatioAsOf: '2026-09-30'
    })
  })

  it('没有抓取候选值时拒绝确认（不允许渲染进程凭空指定报告期）', () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)

    expect(() => service.confirm(db, { fundCode: '000001', confirmedRatio: 0.5 })).toThrow(
      /请先抓取/
    )
    expect(selectFunds(db).find((f) => f.code === '000001')?.equityRatio).toBe(0)
  })

  it('抓取失败会清除旧候选值，之后不能确认；库内原值不变', async () => {
    const db = freshDb()
    seedFunds(db)
    let failing = false
    const flakyHttpGet: HttpGet = async () => {
      if (failing) throw new Error('接口失败')
      return PINGZHONG_000001
    }
    const service = createEquityFetchService(flakyHttpGet)

    await service.fetchForFund('000001')
    failing = true
    await service.fetchForFund('000001')

    expect(() => service.confirm(db, { fundCode: '000001', confirmedRatio: 0.7821 })).toThrow(
      /请先抓取/
    )
    expect(selectFunds(db).find((f) => f.code === '000001')?.equityRatio).toBe(0)
  })

  it('忽略后清除候选值', async () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)
    await service.fetchForFund('000001')

    service.discard('000001')

    expect(() => service.confirm(db, { fundCode: '000001', confirmedRatio: 0.7821 })).toThrow(
      /请先抓取/
    )
  })

  it('非法系数拒绝，且不写库', async () => {
    const db = freshDb()
    seedFunds(db)
    const service = createEquityFetchService(okHttpGet)
    await service.fetchForFund('000001')

    expect(() => service.confirm(db, { fundCode: '000001', confirmedRatio: 1.2 })).toThrow(
      /权益系数/
    )
    expect(selectFunds(db).find((f) => f.code === '000001')).toMatchObject({
      equityRatio: 0,
      equityRatioSource: 'manual',
      equityRatioAsOf: null
    })
  })

  it('基金不存在时拒绝', async () => {
    const db = freshDb()
    const service = createEquityFetchService(async () => PINGZHONG_000001)
    await service.fetchForFund('999999')

    expect(() => service.confirm(db, { fundCode: '999999', confirmedRatio: 0.5 })).toThrow(/不存在/)
  })
})
