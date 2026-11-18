import { describe, expect, it } from 'vitest'
import { parseF10AssetAllocation, parsePingzhongAssetAllocation } from './assetAllocation'

// golden 取自真实公开数据的截取（2026-11-18 快照，仅为格式样本，不联网）
const PINGZHONG_000001 = `/*2026-11-18 15:21:10*/var fS_name = "华夏成长混合";var fS_code = "000001";
/*资产配置*/var Data_assetAllocation = {"series":[{"name":"股票占净比","type":null,"data":[79.42,72.51,79.98,78.21],"yAxis":0},{"name":"债券占净比","type":null,"data":[20.58,20.63,20.19,20.82],"yAxis":0},{"name":"现金占净比","type":null,"data":[1.24,2.39,0.79,0.45],"yAxis":0},{"name":"净资产","type":"line","data":[29.3677,26.443,39.3821,29.1867],"yAxis":1}],"categories":["2025-12-31","2026-03-31","2026-06-30","2026-09-30"]};/*内部持有比例*/var Data_assetAllocationCurrency = {"categories":["09-30"],"series":[]};`

const F10_000001 = `<html><body>
<table class="w782 comm tzxq"><thead><tr><th class="first">报告期</th><th>股票占净比</th><th>债券占净比</th><th>现金占净比</th><th class="last">净资产（亿元）</th></tr></thead><tbody><tr><td>2026-09-30</td><td class="tor">78.21%</td><td class="tor">20.82%</td><td class="tor">0.45%</td><td class="tor">29.19</td></tr><tr><td>2026-06-30</td><td class="tor">79.98%</td><td class="tor">20.19%</td><td class="tor">0.79%</td><td class="tor">39.38</td></tr><tr><td>2026-03-31</td><td class="tor">72.51%</td><td class="tor">20.63%</td><td class="tor">2.39%</td><td class="tor">26.44</td></tr><tr><td>2025-12-31</td><td class="tor">79.42%</td><td class="tor">20.58%</td><td class="tor">1.24%</td><td class="tor">29.37</td></tr></tbody></table>
</body></html>`

const F10_000041_QDII = `<html><body>
<table class="w782 comm tzxq"><thead><tr><th class="first">报告期</th><th>股票占净比</th><th>债券占净比</th><th>现金占净比</th><th>存托凭证占净比</th><th class="last">净资产（亿元）</th></tr></thead><tbody><tr><td>2026-09-30</td><td class="tor">82.52%</td><td class="tor">---</td><td class="tor">6.28%</td><td class="tor">6.92%</td><td class="tor">28.66</td></tr><tr><td>2026-06-30</td><td class="tor">83.41%</td><td class="tor">---</td><td class="tor">6.22%</td><td class="tor">5.73%</td><td class="tor">30.27</td></tr></tbody></table>
</body></html>`

describe('parsePingzhongAssetAllocation — pingzhongdata 资产配置', () => {
  it('解析近四个季度；最新报告期的股票占净比换算为 0–1', () => {
    const quarters = parsePingzhongAssetAllocation(PINGZHONG_000001)

    expect(quarters).toHaveLength(4)
    expect(quarters[3]).toEqual({
      reportDate: '2026-09-30',
      stockRatio: 0.7821,
      bondRatio: 0.2082,
      cashRatio: 0.0045,
      includesDepositaryReceipts: false
    })
    expect(quarters[0].reportDate).toBe('2025-12-31')
  })

  it('只有 Data_assetAllocationCurrency 或坏 JSON 时给出中文错误（触发 F10 回退）', () => {
    expect(() => parsePingzhongAssetAllocation('var Data_assetAllocationCurrency = {};')).toThrow(
      /未找到资产配置数据/
    )
    expect(() => parsePingzhongAssetAllocation('var Data_assetAllocation = {oops};')).toThrow(
      /格式异常/
    )
    expect(() =>
      parsePingzhongAssetAllocation(
        'var Data_assetAllocation = {"series":[],"categories":["2026-09-30"]};'
      )
    ).toThrow(/未找到「股票占净比」/)
  })

  it('股票占净比为 null 的季度跳过，选取最近的有效报告期', () => {
    const script =
      'var Data_assetAllocation = {"series":[{"name":"股票占净比","data":[65.5,null]}],"categories":["2026-06-30","2026-09-30"]};'
    expect(parsePingzhongAssetAllocation(script)).toEqual([
      {
        reportDate: '2026-06-30',
        stockRatio: 0.655,
        bondRatio: null,
        cashRatio: null,
        includesDepositaryReceipts: false
      }
    ])
  })
})

describe('parseF10AssetAllocation — F10 资产配置页', () => {
  it('按表头解析，最新报告期的股票占净比与 pingzhongdata 一致', () => {
    const quarters = parseF10AssetAllocation(F10_000001)

    expect(quarters).toHaveLength(4)
    expect(quarters[3]).toEqual({
      reportDate: '2026-09-30',
      stockRatio: 0.7821,
      bondRatio: 0.2082,
      cashRatio: 0.0045,
      includesDepositaryReceipts: false
    })
  })

  it('QDII 的存托凭证列计入股票占净比，缺失的债券列记 null', () => {
    const quarters = parseF10AssetAllocation(F10_000041_QDII)

    expect(quarters[1]).toEqual({
      reportDate: '2026-09-30',
      stockRatio: 0.8944, // 82.52% 股票 + 6.92% 存托凭证
      bondRatio: null,
      cashRatio: 0.0628,
      includesDepositaryReceipts: true
    })
  })

  it('无资产配置表格、表头不完整或数据为空时给出中文错误', () => {
    expect(() => parseF10AssetAllocation('<html><body><p>页面未找到</p></body></html>')).toThrow(
      /未找到资产配置表格/
    )
    expect(() =>
      parseF10AssetAllocation('<table><tr><th>报告期</th></tr><tr><td>2026-09-30</td></tr></table>')
    ).toThrow(/未找到资产配置表格/)
    expect(() =>
      parseF10AssetAllocation(
        '<table><tr><th>报告期</th><th>股票占净比</th></tr><tr><td>2026-09-30</td><td>---</td></tr></table>'
      )
    ).toThrow(/未找到资产配置表格/)
  })
})
