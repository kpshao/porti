import { describe, expect, it } from 'vitest'
import { parseNavQuoteList } from './parse'

// golden 响应体取自真实接口（天天基金 FundMNFInfo 批量查询，2026-08-28 快照）
const VALID_BODY = `{"Datas":[{"FCODE":"519680","SHORTNAME":"交银增利债券A/B","PDATE":"2026-08-28","NAV":"1.0613","ACCNAV":"2.0033","NAVCHGRT":"-0.05","GSZ":null},{"FCODE":"000217","SHORTNAME":"华安黄金ETF联接C","PDATE":"2026-08-28","NAV":"3.3460","ACCNAV":"3.3460","NAVCHGRT":"0.20","GSZ":null}],"ErrCode":0,"Success":true,"ErrMsg":null,"Message":null,"TotalCount":2}`

describe('parseNavQuoteList — 批量净值接口响应解析', () => {
  it('解析成功响应：代码/名称/净值日期/净值与真实接口逐字段一致', () => {
    const quotes = parseNavQuoteList(VALID_BODY)
    expect(quotes).toHaveLength(2)
    expect(quotes[0]).toEqual({ fundCode: '519680', name: '交银增利债券A/B', date: '2026-08-28', nav: 1.0613 })
    expect(quotes[1]).toEqual({ fundCode: '000217', name: '华安黄金ETF联接C', date: '2026-08-28', nav: 3.346 })
  })

  it('净值缺失（空串/非数字）或日期非法的条目跳过，不阻塞其余基金', () => {
    const body = `{"Datas":[
      {"FCODE":"000001","SHORTNAME":"正常基金","PDATE":"2026-08-28","NAV":"1.5"},
      {"FCODE":"000002","SHORTNAME":"无净值","PDATE":"2026-08-28","NAV":""},
      {"FCODE":"000003","SHORTNAME":"坏日期","PDATE":"2026-13-40","NAV":"2"},
      {"FCODE":"000004","SHORTNAME":"负净值","PDATE":"2026-08-28","NAV":"-1"}
    ],"ErrCode":0,"Success":true,"TotalCount":4}`
    const quotes = parseNavQuoteList(body)
    expect(quotes).toHaveLength(1)
    expect(quotes[0].fundCode).toBe('000001')
  })

  it('ErrCode 非零（接口侧失败）抛中文错误', () => {
    const body = `{"Datas":[],"ErrCode":1002,"Success":false,"ErrMsg":"参数错误","TotalCount":0}`
    expect(() => parseNavQuoteList(body)).toThrow(/错误码 1002/)
  })

  it('接口返回非 JSON（如 404 HTML 页面）抛中文错误', () => {
    const html = '<!doctype html><html><head><title>页面未找到</title></head></html>'
    expect(() => parseNavQuoteList(html)).toThrow(/无法解析/)
  })

  it('JSON 合法但缺少 Datas 数组抛中文错误', () => {
    expect(() => parseNavQuoteList('{"foo":1}')).toThrow(/缺少数据列表/)
  })
})
