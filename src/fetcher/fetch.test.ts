import { describe, expect, it, vi } from 'vitest'
import { buildBatchUrl, fetchNavQuotes } from './fetch'
import type { HttpGet } from './types'

const VALID_BODY = `{"Datas":[{"FCODE":"000001","SHORTNAME":"测试基金","PDATE":"2026-08-28","NAV":"1.5"}],"ErrCode":0,"Success":true,"TotalCount":1}`

describe('fetchNavQuotes — mock HTTP（不依赖真实网络）', () => {
  it('一次批量请求全部代码并解析为净值列表', async () => {
    const httpGet = vi.fn<HttpGet>().mockResolvedValue(VALID_BODY)
    const quotes = await fetchNavQuotes(['000001', '000002'], httpGet, 5000)

    expect(httpGet).toHaveBeenCalledTimes(1)
    const url = httpGet.mock.calls[0][0]
    expect(url).toContain('fundmobapi.eastmoney.com')
    expect(url).toContain('Fcodes=000001%2C000002') // 其余参数细节见 buildBatchUrl 用例
    expect(httpGet.mock.calls[0][1]).toBe(5000)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ fundCode: '000001', nav: 1.5 })
  })

  it('空代码列表短路：返回空数组且不发起请求', async () => {
    const httpGet = vi.fn<HttpGet>()
    const quotes = await fetchNavQuotes([], httpGet)
    expect(quotes).toEqual([])
    expect(httpGet).not.toHaveBeenCalled()
  })

  it('网络错误原样传播（超时/连接失败交由调用方处理）', async () => {
    const httpGet = vi.fn<HttpGet>().mockRejectedValue(new Error('净值接口请求超时，请稍后重试'))
    await expect(fetchNavQuotes(['000001'], httpGet)).rejects.toThrow(/超时/)
  })
})

describe('buildBatchUrl — 批量接口参数', () => {
  it('多代码以逗号拼接进 Fcodes', () => {
    const url = buildBatchUrl(['519680', '000217'])
    expect(url).toContain('Fcodes=519680%2C000217')
    expect(url).toContain('pageSize=100')
  })
})
