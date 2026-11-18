import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildF10Url,
  buildPingzhongDataUrl,
  defaultEquityHttpGet,
  fetchEquityCandidate,
  fetchEquityCandidateBatch
} from './equityFetch'
import type { EquityFetchResult } from './types'
import type { HttpGet } from './types'

const PINGZHONG_000001 = `/*资产配置*/var Data_assetAllocation = {"series":[{"name":"股票占净比","type":null,"data":[79.42,72.51,79.98,78.21],"yAxis":0},{"name":"债券占净比","type":null,"data":[20.58,20.63,20.19,20.82],"yAxis":0},{"name":"现金占净比","type":null,"data":[1.24,2.39,0.79,0.45],"yAxis":0},{"name":"净资产","type":"line","data":[29.3677,26.443,39.3821,29.1867],"yAxis":1}],"categories":["2025-12-31","2026-03-31","2026-06-30","2026-09-30"]};`

const PINGZHONG_000003 = `/*资产配置*/var Data_assetAllocation = {"series":[{"name":"股票占净比","type":null,"data":[0],"yAxis":0},{"name":"债券占净比","type":null,"data":[81.57],"yAxis":0},{"name":"现金占净比","type":null,"data":[0.46],"yAxis":0}],"categories":["2026-09-30"]};`

const F10_000001 = `<table class="w782 comm tzxq"><thead><tr><th class="first">报告期</th><th>股票占净比</th><th>债券占净比</th><th>现金占净比</th><th class="last">净资产（亿元）</th></tr></thead><tbody><tr><td>2026-09-30</td><td class="tor">78.21%</td><td class="tor">20.82%</td><td class="tor">0.45%</td><td class="tor">29.19</td></tr></tbody></table>`

describe('fetchEquityCandidate — 单只基金抓取', () => {
  it('优先解析 pingzhongdata，返回股票占净比候选值、报告期与数据源', async () => {
    const httpGet = vi.fn<HttpGet>().mockResolvedValue(PINGZHONG_000001)
    const result = await fetchEquityCandidate('000001', httpGet)

    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(httpGet.mock.calls[0][0]).toBe('https://fund.eastmoney.com/pingzhongdata/000001.js')
    expect(httpGet.mock.calls[0][1]).toBe(10000)
    expect(result).toEqual({
      ok: true,
      candidate: {
        fundCode: '000001',
        stockRatio: 0.7821,
        reportDate: '2026-09-30',
        dataSource: 'pingzhongdata',
        includesDepositaryReceipts: false
      }
    })
  })

  it('pingzhongdata 请求失败时回退 F10 HTML，来源标记为 f10', async () => {
    const httpGet = vi
      .fn<HttpGet>()
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(F10_000001)
    const result = await fetchEquityCandidate('000001', httpGet)

    expect(httpGet).toHaveBeenCalledTimes(2)
    expect(httpGet.mock.calls[1][0]).toBe('https://fundf10.eastmoney.com/zcpz_000001.html')
    expect(result).toEqual({
      ok: true,
      candidate: {
        fundCode: '000001',
        stockRatio: 0.7821,
        reportDate: '2026-09-30',
        dataSource: 'f10',
        includesDepositaryReceipts: false
      }
    })
  })

  it('pingzhongdata 解析失败时同样回退 F10', async () => {
    const httpGet = vi
      .fn<HttpGet>()
      .mockResolvedValueOnce('var Data_assetAllocation = {坏数据};')
      .mockResolvedValueOnce(F10_000001)
    const result = await fetchEquityCandidate('000001', httpGet)

    expect(result.ok).toBe(true)
    expect(httpGet).toHaveBeenCalledTimes(2)
  })

  it('两个数据源都失败时按行返回中文错误（包含两段原因）', async () => {
    const httpGet = vi
      .fn<HttpGet>()
      .mockRejectedValueOnce(new Error('pingzhong 网络失败'))
      .mockRejectedValueOnce(new Error('F10 网络失败'))
    const result = await fetchEquityCandidate('000001', httpGet)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fundCode).toBe('000001')
      expect(result.error).toContain('pingzhong 网络失败')
      expect(result.error).toContain('F10 网络失败')
    }
  })

  it('基金代码非法时直接报错，不发起请求', async () => {
    const httpGet = vi.fn<HttpGet>()
    const result = await fetchEquityCandidate('abc', httpGet)

    expect(httpGet).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, fundCode: 'abc', error: '基金代码需为 6 位数字' })
  })

  it('代码归一化为 6 位补零', async () => {
    const httpGet = vi.fn<HttpGet>().mockResolvedValue(PINGZHONG_000001)
    await fetchEquityCandidate('1', httpGet)
    expect(httpGet.mock.calls[0][0]).toBe('https://fund.eastmoney.com/pingzhongdata/000001.js')
  })
})

describe('fetchEquityCandidateBatch — 顺序批量抓取', () => {
  it('顺序执行、逐行回调、单只失败后继续，请求之间按间隔等待', async () => {
    const httpGet = vi.fn<HttpGet>(async (url) => {
      if (url.includes('000001')) return PINGZHONG_000001
      if (url.includes('000002')) throw new Error('接口失败')
      return PINGZHONG_000003
    })
    const sleep = vi.fn(async (_ms: number) => {})
    const starts: string[] = []
    const results: EquityFetchResult[] = []

    const batch = await fetchEquityCandidateBatch(['000001', '000002', '000003'], httpGet, {
      intervalMs: 250,
      sleep,
      onStart: (code) => starts.push(code),
      onResult: (result) => results.push(result)
    })

    expect(batch.map((r) => r.ok)).toEqual([true, false, true])
    expect(starts).toEqual(['000001', '000002', '000003'])
    expect(results).toHaveLength(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(250)
    expect(httpGet.mock.calls.map((c) => c[0])).toEqual([
      'https://fund.eastmoney.com/pingzhongdata/000001.js',
      'https://fund.eastmoney.com/pingzhongdata/000002.js',
      'https://fundf10.eastmoney.com/zcpz_000002.html',
      'https://fund.eastmoney.com/pingzhongdata/000003.js'
    ])
  })

  it('空代码列表不发请求也不等待', async () => {
    const httpGet = vi.fn<HttpGet>()
    const sleep = vi.fn(async (_ms: number) => {})
    await expect(fetchEquityCandidateBatch([], httpGet, { sleep })).resolves.toEqual([])
    expect(httpGet).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('buildPingzhongDataUrl / buildF10Url — 固定域名', () => {
  it('只拼接固定域名与 6 位代码', () => {
    expect(buildPingzhongDataUrl('000001')).toBe(
      'https://fund.eastmoney.com/pingzhongdata/000001.js'
    )
    expect(buildF10Url('000041')).toBe('https://fundf10.eastmoney.com/zcpz_000041.html')
  })
})

describe('defaultEquityHttpGet — 默认 HTTP 实现（stub fetch，不联网）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('返回响应体文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://fund.eastmoney.com/pingzhongdata/000001.js',
        text: async () => 'body'
      })
    )
    await expect(defaultEquityHttpGet(buildPingzhongDataUrl('000001'), 1000)).resolves.toBe('body')
  })

  it('重定向到非允许域名时拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://evil.example.com/fund.js',
        text: async () => 'body'
      })
    )
    await expect(defaultEquityHttpGet(buildPingzhongDataUrl('000001'), 1000)).rejects.toThrow(
      /非允许域名/
    )
  })

  it('响应超过大小上限时拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://fund.eastmoney.com/pingzhongdata/000001.js',
        text: async () => 'a'.repeat(2_000_001)
      })
    )
    await expect(defaultEquityHttpGet(buildPingzhongDataUrl('000001'), 1000)).rejects.toThrow(
      /响应过大/
    )
  })

  it('超时以中文错误表达', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
          })
      )
    )
    await expect(defaultEquityHttpGet(buildPingzhongDataUrl('000001'), 5)).rejects.toThrow(/超时/)
  })
})
