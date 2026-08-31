import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { parseExcelFile } from './parse'

// 真实投资跟踪.xlsx 为 fixture（spec Testing Decisions 约定的 I/O 接缝）
const FIXTURE = join(process.cwd(), '投资跟踪.xlsx')

const result = parseExcelFile(FIXTURE)

describe('parseExcelFile — 真实投资跟踪.xlsx 黄金验收', () => {
  it('10 只基金全部导入，类别/类型/目标金额正确', () => {
    expect(result.summary.fundCount).toBe(10)
    expect(result.funds).toHaveLength(10)
    const byCode = new Map(result.funds.map((f) => [f.code, f]))

    expect(byCode.get('519680')).toMatchObject({
      name: '交银增利债券A', category: '纯债', fundType: '一级债基', targetAmount: 180000
    })
    expect(byCode.get('007824')).toMatchObject({
      name: '天弘弘择短债债券C', category: '流动性', fundType: '短债', targetAmount: 40000
    })
    expect(byCode.get('000217')).toMatchObject({
      name: '华安黄金ETF联接C', category: '黄金', fundType: '黄金', targetAmount: 40000
    })
    // 未出现在持仓概览的基金：类型回退映射大类，目标金额为空
    expect(byCode.get('000385')).toMatchObject({
      name: '景顺长城景颐双利A', category: '固守+', fundType: '二级债基', targetAmount: null
    })
  })

  it('5 个大类目标比例导入', () => {
    expect(result.categoryTargets).toEqual([
      { category: '固守+', targetRatio: 0.25 },
      { category: '纯债', targetRatio: 0.45 },
      { category: '权益', targetRatio: 0.2 },
      { category: '黄金', targetRatio: 0.05 },
      { category: '流动性', targetRatio: 0.05 }
    ])
  })

  it('69 笔流水全部导入，操作类型与字段完整', () => {
    expect(result.summary.transactionCount).toBe(69)
    expect(result.transactionRows).toHaveLength(69)
    const types = new Set(result.transactionRows.map((r) => r.transaction.type))
    expect(types).toEqual(new Set(['买入', '分红再投入']))

    for (const row of result.transactionRows) {
      expect(row.transaction.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(row.transaction.fundCode).toMatch(/^\d{6}$/)
    }

    // 所有流水代码都落在基金列表中（无跳过行）
    const names = new Map(result.funds.map((f) => [f.code, f.name]))
    for (const row of result.transactionRows) {
      expect(names.has(row.transaction.fundCode)).toBe(true)
    }

    // 抽样核对关键行
    const byRow = new Map(result.transactionRows.map((r) => [r.excelRow, r.transaction]))
    expect(byRow.get(2)).toMatchObject({
      date: '2026-03-03', type: '买入', fundCode: '512890',
      amount: 39878.2, shares: 33200, nav: 1.201, fee: 0
    })
    // 分红再投入：金额 0（成本不变）、只加份额
    expect(byRow.get(7)).toMatchObject({
      date: '2026-04-16', type: '分红再投入', fundCode: '002009',
      amount: 0, shares: 77.56, nav: 1.0577
    })
    // 2025 年的历史买入（日期序列号 45679）
    expect(byRow.get(14)).toMatchObject({
      date: '2025-01-22', type: '买入', fundCode: '000217',
      amount: 59050, shares: 16032.86, nav: 3.6831
    })
    // 最后一笔：流水最大日期 2026-08-24
    expect(byRow.get(70)).toMatchObject({
      date: '2026-08-24', type: '买入', fundCode: '563360',
      amount: 12685, shares: 10000, nav: 1.268
    })
  })

  it('代码补前导零修复 14 处（2065→002065、2009→002009）', () => {
    const fix = result.fixes.find((f) => f.kind === 'code-zero-pad')
    expect(fix).toBeDefined()
    expect(fix!.count).toBe(14)
    expect(fix!.rows).toHaveLength(14)
  })

  it('收益明细 15 行名称公式失效（#N/A），按代码重查', () => {
    const fix = result.fixes.find((f) => f.kind === 'name-requery')
    expect(fix).toBeDefined()
    expect(fix!.count).toBe(15)
  })

  it('收益快照 14 期 92 行重建为净值历史，无跳过', () => {
    expect(result.summary.snapshotPeriodCount).toBe(14)
    expect(result.summary.snapshotRowCount).toBe(92)
    expect(result.reconstructedNavs).toHaveLength(92)
    expect(result.skippedSnapshots).toEqual([])

    const fix = result.fixes.find((f) => f.kind === 'snapshot-reconstruct')
    expect(fix).toBeDefined()
    expect(fix!.count).toBe(92)

    // 抽样：110017 @2026-03-13 = 69893.97872 ÷ 50067.32
    const p = result.reconstructedNavs.find(
      (n) => n.fundCode === '110017' && n.date === '2026-03-13'
    )
    expect(p!.nav).toBeCloseTo(69893.97872 / 50067.32, 6)
  })

  it('可疑项恰为 1.0577 分红再投入行，给出参考净值建议', () => {
    expect(result.suspicious).toHaveLength(1)
    const s = result.suspicious[0]
    expect(s.excelRow).toBe(7)
    expect(s.fundCode).toBe('002009')
    const navField = s.fields.find((f) => f.field === 'nav')!
    expect(navField.value).toBe(1.0577)
    // 参考净值 = 最近快照（2026-04-18）重建值 29941.326965 ÷ 19373.23 ≈ 1.5455
    expect(navField.suggested).toBeCloseTo(29941.326965 / 19373.23, 4)
    expect(s.detail).toContain('净值')
  })

  it('持仓概览最新净值作为当前净值导入，日期取流水最大日期', () => {
    expect(result.currentNavPoints).toHaveLength(9)
    for (const p of result.currentNavPoints) {
      expect(p.date).toBe('2026-08-24')
      expect(p.source).toBe('import')
    }
    const byCode = new Map(result.currentNavPoints.map((p) => [p.fundCode, p.nav]))
    expect(byCode.get('563360')).toBe(1.291)
    expect(byCode.get('110017')).toBe(1.41)
    const fix = result.fixes.find((f) => f.kind === 'current-nav-import')
    expect(fix).toBeDefined()
    expect(fix!.count).toBe(9)
  })

  it('对账基准与 Excel 持仓概览/收益汇总一致', () => {
    // 汇总行
    expect(result.expectation.totals.totalNetCost).toBeCloseTo(784313.8, 2)
    expect(result.expectation.totals.totalAssets).toBeCloseTo(775962.318122, 2)
    expect(result.expectation.totals.totalPnl).toBeCloseTo(-8351.481878, 2)
    expect(result.expectation.totals.totalReturnRate).toBeCloseTo(-0.010648138382876898, 9)

    // 9 只基金逐项
    expect(result.expectation.funds).toHaveLength(9)
    const a500 = result.expectation.funds.find((f) => f.code === '563360')!
    expect(a500.invested).toBeCloseTo(87793.3, 2)
    expect(a500.shares).toBeCloseTo(64600, 2)
    expect(a500.marketValue).toBeCloseTo(83398.6, 2)
    expect(a500.pnl).toBeCloseTo(-4394.7, 2)
    expect(a500.pnlRatio).toBeCloseTo(-0.05005735061787204, 9)

    // 收益汇总 14 期
    expect(result.expectation.series).toHaveLength(14)
    expect(result.expectation.series[0]).toEqual({
      date: '2026-03-13', totalMarketValue: 199788.954552
    })
    expect(result.expectation.series[13].date).toBe('2026-08-11')
    expect(result.expectation.series[13].totalMarketValue).toBeCloseTo(758627.24876, 2)
  })
})
