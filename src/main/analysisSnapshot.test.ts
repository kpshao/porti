import { describe, expect, it } from 'vitest'
import type { BucketTarget, Fund, NavPoint, TransactionRow } from '../engine'
import { buildAnalysisSnapshot, serializeSnapshot } from './analysisSnapshot'

const FUNDS: Fund[] = [
  {
    code: '000001', name: '阿尔法', fundType: '股票型',
    ledgerCategory: '权益', productForm: '权益', equityRatio: 1, equityRatioSource: 'manual',
    equityRatioAsOf: null
  },
  {
    // 固收+ 的逐只覆盖：来源为抓取、带报告期，验证快照原样给出
    code: '000002', name: '贝塔', fundType: '混合型',
    ledgerCategory: '债', productForm: '固收+', equityRatio: 0.3, equityRatioSource: 'fetch',
    equityRatioAsOf: '2024-03-31'
  },
  {
    code: '000003', name: '伽马', fundType: '黄金',
    ledgerCategory: '黄金', productForm: '黄金', equityRatio: 0, equityRatioSource: 'manual',
    equityRatioAsOf: null
  },
  {
    code: '000004', name: '德尔塔', fundType: '混合型',
    ledgerCategory: '权益', productForm: '权益', equityRatio: 1, equityRatioSource: 'manual',
    equityRatioAsOf: null
  },
  {
    // 货基型的纯债基金
    code: '000005', name: '艾普西龙', fundType: '货币型',
    ledgerCategory: '债', productForm: '纯债', equityRatio: 0, equityRatioSource: 'manual',
    equityRatioAsOf: null
  }
]

// 故意乱序，验证快照内部按日期、同日按 id 稳定排序
const TRANSACTIONS: TransactionRow[] = [
  { id: 4, date: '2024-02-01', type: '卖出', fundCode: '000003', amount: -330, shares: -300, nav: 1.1, fee: 0, note: '清仓' },
  { id: 2, date: '2024-01-02', type: '买入', fundCode: '000002', amount: 500, shares: 500, nav: 1, fee: 0, note: null },
  { id: 9, date: '2024-03-03', type: '买入', fundCode: '000002', amount: 100, shares: 100, nav: 1, fee: 0, note: '同日第二笔' },
  { id: 1, date: '2024-01-01', type: '买入', fundCode: '000001', amount: 1000, shares: 100, nav: 10, fee: 0, note: null },
  { id: 8, date: '2024-03-03', type: '买入', fundCode: '000002', amount: 50, shares: 50, nav: 1, fee: 0, note: '同日第一笔' },
  { id: 3, date: '2024-01-03', type: '买入', fundCode: '000003', amount: 300, shares: 300, nav: 1, fee: 0, note: null },
  { id: 6, date: '2024-03-01', type: '分红现金', fundCode: '000001', amount: 10, shares: null, nav: null, fee: 0, note: null },
  { id: 5, date: '2024-02-02', type: '买入', fundCode: '000004', amount: 200, shares: 200, nav: 1, fee: 0, note: '缺净值' },
  { id: 7, date: '2024-03-02', type: '分红再投入', fundCode: '000001', amount: 0, shares: 1, nav: 2, fee: 0, note: null }
]

// 000001 的中间净值 9.9999 是「原始逐日序列不得出现」的探针
const NAV_POINTS: NavPoint[] = [
  { fundCode: '000001', date: '2024-01-31', nav: 1.1111, source: 'import' },
  { fundCode: '000001', date: '2024-04-01', nav: 9.9999, source: 'import' },
  { fundCode: '000001', date: '2024-06-01', nav: 2.2222, source: 'auto' },
  { fundCode: '000002', date: '2024-06-01', nav: 1.05, source: 'auto' },
  { fundCode: '000003', date: '2024-01-31', nav: 1, source: 'import' },
  { fundCode: '000003', date: '2024-06-01', nav: 1.1, source: 'auto' },
  { fundCode: '000005', date: '2024-06-01', nav: 3, source: 'auto' }
]

// 故意乱序，验证配置桶行按固定顺序输出；合计 90%，验证归一化标记
const TARGETS: BucketTarget[] = [
  { bucket: '权益', targetRatio: 0.3 },
  { bucket: '黄金', targetRatio: 0.1 },
  { bucket: '稳健', targetRatio: 0.5 }
]

const TODAY = '2024-06-30'

function build(): ReturnType<typeof buildAnalysisSnapshot> {
  return buildAnalysisSnapshot({
    funds: FUNDS,
    transactions: TRANSACTIONS,
    navPoints: NAV_POINTS,
    bucketTargets: TARGETS,
    today: TODAY
  })
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

describe('analysisSnapshot — 结构与字段白名单', () => {
  it('顶层字段固定且顺序稳定', () => {
    expect(Object.keys(build())).toEqual([
      'dataFreshness',
      'summary',
      'allocationComparison',
      'concentration',
      'holdings',
      'closedHoldings',
      'fundReturns',
      'transactions'
    ])
  })

  it('持仓行只含白名单字段，权重只给可估值在持基金', () => {
    const snapshot = build()
    const expectedHoldings = [
      'fundCode',
      'name',
      'productForm',
      'ledgerCategory',
      'equityRatio',
      'equityRatioSource',
      'equityRatioAsOf',
      'shares',
      'costBasis',
      'latestNav',
      'latestNavDate',
      'marketValue',
      'pnl',
      'pnlRatio',
      'weight',
      'realizedIncome'
    ]
    for (const row of [...snapshot.holdings, ...snapshot.closedHoldings]) {
      expect(Object.keys(row)).toEqual(expectedHoldings)
    }

    const byCode = new Map(snapshot.holdings.map((h) => [h.fundCode, h]))
    expect(byCode.get('000004')?.weight).toBeNull() // 缺净值，不参与权重
    expect(byCode.get('000001')?.weight).toBeCloseTo(224.4422 / (224.4422 + 682.5))
    expect(byCode.get('000002')?.weight).toBeCloseTo(682.5 / (224.4422 + 682.5))
    expect(snapshot.closedHoldings[0].weight).toBeNull()
  })

  it('持仓行带上产品形态、账本大类、权益系数、来源与数据日期', () => {
    const snapshot = build()
    const byCode = new Map(snapshot.holdings.map((h) => [h.fundCode, h]))

    // 逐只覆盖过的固收+：来源是抓取，并带报告期
    expect(byCode.get('000002')).toMatchObject({
      productForm: '固收+',
      ledgerCategory: '债',
      equityRatio: 0.3,
      equityRatioSource: '抓取',
      equityRatioAsOf: '2024-03-31'
    })
    // 默认系数与手工来源：数据日期为空
    expect(byCode.get('000001')).toMatchObject({
      productForm: '权益',
      ledgerCategory: '权益',
      equityRatio: 1,
      equityRatioSource: '手工',
      equityRatioAsOf: null
    })
    // 已清仓持仓同样带新模型字段
    expect(snapshot.closedHoldings[0]).toMatchObject({
      productForm: '黄金',
      ledgerCategory: '黄金',
      equityRatio: 0,
      equityRatioSource: '手工',
      equityRatioAsOf: null
    })
  })

  it('配置对比与流水字段白名单固定', () => {
    const snapshot = build()
    expect(Object.keys(snapshot.allocationComparison)).toEqual([
      'rows',
      'targetTotal',
      'targetNormalized'
    ])
    expect(Object.keys(snapshot.allocationComparison.rows[0])).toEqual([
      'bucket',
      'targetRatio',
      'marketRatio',
      'deviation'
    ])
    expect(Object.keys(snapshot.transactions[0])).toEqual([
      'date',
      'type',
      'fundCode',
      'fundName',
      'amount',
      'shares',
      'nav',
      'fee',
      'note',
      'realized'
    ])
    expect(Object.keys(snapshot.fundReturns[0])).toEqual([
      'fundCode',
      'name',
      'navStartDate',
      'navStart',
      'navEndDate',
      'latestNav',
      'navChangeRate',
      'cumulativeReturn',
      'cumulativeReturnRate',
      'annualized'
    ])
    expect(Object.keys(snapshot.summary.all)).toEqual(['totals', 'annualized'])
    expect(Object.keys(snapshot.dataFreshness)).toEqual(['today', 'latestNavDate'])
  })
})

describe('analysisSnapshot — 稳定排序', () => {
  it('基金按市值降序、缺净值排最后；已清仓单列', () => {
    const snapshot = build()
    expect(snapshot.holdings.map((h) => h.fundCode)).toEqual(['000002', '000001', '000004'])
    expect(snapshot.closedHoldings.map((h) => h.fundCode)).toEqual(['000003'])
  })

  it('流水按日期升序、同日按 id 升序', () => {
    const snapshot = build()
    expect(snapshot.transactions.map((t) => t.date)).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-02-01',
      '2024-02-02',
      '2024-03-01',
      '2024-03-02',
      '2024-03-03',
      '2024-03-03'
    ])
    expect(snapshot.transactions.slice(-2).map((t) => t.note)).toEqual([
      '同日第一笔',
      '同日第二笔'
    ])
  })

  it('配置桶按固定顺序，基金收益摘要按代码升序', () => {
    const snapshot = build()
    expect(snapshot.allocationComparison.rows.map((r) => r.bucket)).toEqual([
      '稳健',
      '权益',
      '黄金'
    ])
    expect(snapshot.fundReturns.map((f) => f.fundCode)).toEqual([
      '000001',
      '000002',
      '000003',
      '000004',
      '000005'
    ])
  })
})

describe('analysisSnapshot — 配置桶对比', () => {
  it('三桶按权益系数穿透，偏离按归一化目标计算', () => {
    const snapshot = build()
    const comparison = snapshot.allocationComparison
    expect(comparison.targetTotal).toBeCloseTo(0.9)
    expect(comparison.targetNormalized).toBe(true)

    const totalAssets = 224.4422 + 682.5
    const [steady, equity, gold] = comparison.rows
    // 固收+ 按逐只覆盖后的 0.3 穿透（口径见 CONTEXT.md「配置桶」）
    expect(steady.marketRatio).toBeCloseTo((682.5 * 0.7) / totalAssets)
    expect(equity.marketRatio).toBeCloseTo((224.4422 + 682.5 * 0.3) / totalAssets)
    expect(gold.marketRatio).toBeCloseTo(0)
    // 目标合计 90%，偏离按归一化目标计算
    expect(steady.deviation).toBeCloseTo((682.5 * 0.7) / totalAssets - 0.5 / 0.9)
    expect(equity.deviation).toBeCloseTo((224.4422 + 682.5 * 0.3) / totalAssets - 0.3 / 0.9)
    expect(gold.deviation).toBeCloseTo(0 - 0.1 / 0.9)
  })

  it('目标合计为 0 时视为未配置：三行仍在，偏离为空', () => {
    const snapshot = buildAnalysisSnapshot({
      funds: FUNDS,
      transactions: TRANSACTIONS,
      navPoints: NAV_POINTS,
      bucketTargets: [],
      today: TODAY
    })
    const comparison = snapshot.allocationComparison
    expect(comparison.rows.map((r) => r.bucket)).toEqual(['稳健', '权益', '黄金'])
    expect(comparison.rows.map((r) => r.targetRatio)).toEqual([0, 0, 0])
    expect(comparison.targetTotal).toBe(0)
    expect(comparison.targetNormalized).toBe(false)
    expect(comparison.rows.every((r) => r.deviation === null)).toBe(true)
  })
})

describe('analysisSnapshot — 口径与排除项', () => {
  it('已清仓基金在快照内但不进集中度指标', () => {
    const snapshot = build()
    expect(snapshot.closedHoldings.map((h) => h.fundCode)).toContain('000003')
    expect(snapshot.concentration.weights.map((w) => w.fundCode)).not.toContain('000003')
    expect(snapshot.concentration.weights.map((w) => w.fundCode)).toEqual(['000002', '000001'])
    expect(snapshot.concentration.valuedCount).toBe(2)
    expect(snapshot.concentration.missingNavCount).toBe(1)
    expect(snapshot.concentration.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1)
  })

  it('已清仓基金的已实现盈亏按基金记录', () => {
    const snapshot = build()
    expect(snapshot.closedHoldings[0].realizedIncome).toBe(30)
    expect(snapshot.fundReturns.find((f) => f.fundCode === '000003')?.cumulativeReturn).toBe(30)
  })

  it('流水附带本笔已实现（仅卖出）', () => {
    const snapshot = build()
    const sale = snapshot.transactions.find((t) => t.type === '卖出')
    expect(sale?.realized).toBe(30)
    expect(snapshot.transactions.filter((t) => t.type !== '卖出').every((t) => t.realized === null)).toBe(
      true
    )
  })

  it('数据新鲜度取最新净值日期', () => {
    expect(build().dataFreshness).toEqual({ today: TODAY, latestNavDate: '2024-06-01' })
  })

  it('不包含原始逐日净值序列、密钥、数据文件路径与内部字段', () => {
    const snapshot = build()
    const json = serializeSnapshot(snapshot).json
    expect(json).not.toContain('9.9999') // 中间净值只存在于原始序列
    // 白名单之外的内部字段不进入快照
    const keys = collectKeys(snapshot)
    for (const forbidden of [
      'apiKey',
      'encryptedKey',
      'dbPath',
      'dataFilePath',
      'navPoints',
      'navHistory',
      'category'
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })
})

describe('analysisSnapshot — 快照预览', () => {
  it('序列化为格式化 JSON 并给出 token 粗略估算', () => {
    const preview = serializeSnapshot(build())
    expect(preview.json.startsWith('{\n  "dataFreshness"')).toBe(true)
    expect(preview.estimatedTokens).toBeGreaterThan(0)
    expect(preview.exceedsEstimateLimit).toBe(false)
  })

  it('超过阈值时给出截断风险提示（不裁剪）', () => {
    const longNote = '长'.repeat(200000)
    const preview = serializeSnapshot(
      buildAnalysisSnapshot({
        funds: [FUNDS[0]],
        transactions: [
          {
            id: 1,
            date: '2024-01-01',
            type: '买入',
            fundCode: '000001',
            amount: 1000,
            shares: 100,
            nav: 10,
            fee: 0,
            note: longNote
          }
        ],
        navPoints: [NAV_POINTS[2]],
        bucketTargets: [],
        today: TODAY
      })
    )
    expect(preview.exceedsEstimateLimit).toBe(true)
    expect(preview.json).toContain(longNote) // 只提示，不自动裁剪
  })
})
