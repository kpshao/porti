import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from './schema'
import { selectNavPoints } from './repo'
import { createFund } from './transactionService'
import { autoFetchNavs, fetchAndSaveNavs, getFetchStatus, runNavFetch, upsertManualNav } from './navService'
import type { HttpGet } from '../fetcher/types'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function seedFunds(db: Database.Database): void {
  createFund(db, { code: '000001', name: '基金甲', category: '权益', fundType: null })
  createFund(db, { code: '000002', name: '基金乙', category: '纯债', fundType: null })
}

describe('upsertManualNav — 手动补录净值', () => {
  it('新记录以 manual 来源写入', () => {
    const db = freshDb()
    seedFunds(db)
    upsertManualNav(db, { fundCode: '000001', date: '2026-08-31', nav: 1.2345 })
    const [p] = selectNavPoints(db)
    expect(p).toMatchObject({ fundCode: '000001', date: '2026-08-31', nav: 1.2345, source: 'manual' })
  })

  it('同基金同日已有记录（导入来源）：覆盖为新净值且来源变为 manual', () => {
    const db = freshDb()
    seedFunds(db)
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-08-28', 1.1, 'import'
    )
    upsertManualNav(db, { fundCode: '000001', date: '2026-08-28', nav: 1.25 })
    const points = selectNavPoints(db)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ nav: 1.25, source: 'manual' })
  })

  it('非法输入给出中文错误：日期格式、净值非正、基金不存在', () => {
    const db = freshDb()
    seedFunds(db)
    expect(() => upsertManualNav(db, { fundCode: '000001', date: '2026-13-01', nav: 1 })).toThrow(/日期/)
    expect(() => upsertManualNav(db, { fundCode: '000001', date: '2026-08-31', nav: 0 })).toThrow(/净值/)
    expect(() => upsertManualNav(db, { fundCode: '999999', date: '2026-08-31', nav: 1 })).toThrow(/不存在/)
  })
})

describe('fetchAndSaveNavs — 一键抓取写入 auto 记录', () => {
  const okHttpGet: HttpGet = async () =>
    `{"Datas":[
      {"FCODE":"000001","SHORTNAME":"基金甲","PDATE":"2026-08-28","NAV":"1.5"},
      {"FCODE":"000002","SHORTNAME":"基金乙","PDATE":"2026-08-28","NAV":"2.5"}
    ],"ErrCode":0,"Success":true,"TotalCount":2}`

  it('库内全部基金（含未持仓）写入当日净值，来源 auto', async () => {
    const db = freshDb()
    seedFunds(db)
    const result = await fetchAndSaveNavs(db, okHttpGet)
    expect(result.inserted).toBe(2)
    expect(result.failedCodes).toEqual([])
    const points = selectNavPoints(db)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ fundCode: '000001', date: '2026-08-28', nav: 1.5, source: 'auto' })
    expect(points[1]).toMatchObject({ fundCode: '000002', date: '2026-08-28', nav: 2.5, source: 'auto' })
  })

  it('同基金同日已有记录时不覆盖，计入 skipped', async () => {
    const db = freshDb()
    seedFunds(db)
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run(
      '000001', '2026-08-28', 9.9, 'import'
    )
    const result = await fetchAndSaveNavs(db, okHttpGet)
    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(1)
    const kept = selectNavPoints(db).find((p) => p.fundCode === '000001')
    expect(kept).toMatchObject({ nav: 9.9, source: 'import' }) // 原值保留
  })

  it('个别基金接口无数据：计入 failedCodes，其余正常写入', async () => {
    const db = freshDb()
    seedFunds(db)
    const partial: HttpGet = async () =>
      `{"Datas":[{"FCODE":"000001","SHORTNAME":"基金甲","PDATE":"2026-08-28","NAV":"1.5"}],"ErrCode":0,"Success":true,"TotalCount":1}`
    const result = await fetchAndSaveNavs(db, partial)
    expect(result.inserted).toBe(1)
    expect(result.failedCodes).toEqual(['000002'])
    expect(result.message).toContain('000002')
  })

  it('空库早退：不发请求', async () => {
    const db = freshDb()
    const httpGet = vi.fn<HttpGet>()
    const result = await fetchAndSaveNavs(db, httpGet)
    expect(httpGet).not.toHaveBeenCalled()
    expect(result.message).toContain('暂无基金')
  })
})

describe('runNavFetch / autoFetchNavs — 启动自动抓取状态机', () => {
  it('成功：状态 ok 并记录汇总消息', async () => {
    const db = freshDb()
    seedFunds(db)
    const okHttpGet: HttpGet = async () =>
      `{"Datas":[{"FCODE":"000001","SHORTNAME":"基金甲","PDATE":"2026-08-28","NAV":"1.5"}],"ErrCode":0,"Success":true,"TotalCount":1}`
    const result = await runNavFetch(db, okHttpGet)
    expect(result.inserted).toBe(1)
    const status = getFetchStatus()
    expect(status.state).toBe('ok')
    expect(status.message).toContain('成功写入 1 条')
    expect(status.finishedAt).not.toBeNull()
  })

  it('网络失败：状态 failed 并抛出；autoFetchNavs 静默吞错不阻塞', async () => {
    const db = freshDb()
    seedFunds(db)
    const badHttpGet: HttpGet = async () => {
      throw new Error('净值接口请求超时，请稍后重试')
    }
    await expect(runNavFetch(db, badHttpGet)).rejects.toThrow(/超时/)
    expect(getFetchStatus().state).toBe('failed')
    expect(getFetchStatus().message).toContain('超时')

    await expect(autoFetchNavs(db, badHttpGet)).resolves.toBeUndefined() // 不抛出
    expect(getFetchStatus().state).toBe('failed')
  })
})
