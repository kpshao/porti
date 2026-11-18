import { describe, expect, it } from 'vitest'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { computeWeeklyReturn } from '../engine'
import { parseExcelFile, parseWorkbook } from './parse'

// 真实投资跟踪.xlsx 为 fixture（spec Testing Decisions 约定的 I/O 接缝）
const FIXTURE = join(process.cwd(), '投资跟踪.xlsx')

const result = parseExcelFile(FIXTURE)

describe('parseExcelFile — 真实投资跟踪.xlsx 黄金验收', () => {
  it('10 只基金全部导入，旧标签映射到产品形态', () => {
    expect(result.summary.fundCount).toBe(10)
    expect(result.funds).toHaveLength(10)
    const byCode = new Map(result.funds.map((f) => [f.code, f]))

    expect(byCode.get('519680')).toMatchObject({
      name: '交银增利债券A', category: '纯债', fundType: '一级债基', productForm: '纯债'
    })
    // 旧「流动性」归入 债 / 纯债
    expect(byCode.get('007824')).toMatchObject({
      name: '天弘弘择短债债券C', category: '纯债', fundType: '短债', productForm: '纯债'
    })
    expect(byCode.get('110017')).toMatchObject({
      name: '易方达增强回报债券A', category: '固守+', productForm: '固收+'
    })
    expect(byCode.get('000217')).toMatchObject({
      name: '华安黄金ETF联接C', category: '黄金', fundType: '黄金', productForm: '黄金'
    })
    // 未出现在持仓概览的基金：按基金类型推断产品形态
    expect(byCode.get('000385')).toMatchObject({
      name: '景顺长城景颐双利A', category: '固守+', fundType: '二级债基', productForm: '固收+'
    })
  })

  it('基金类型回退映射在预览中标记为推断', () => {
    const inferred = result.fixes.find((f) => f.kind === 'category-inferred')
    expect(inferred).toBeDefined()
    expect(inferred!.count).toBe(1)
    expect(inferred!.detail).toContain('000385')
    expect(inferred!.detail).toContain('二级债基')
    expect(inferred!.detail).toContain('固收+')
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
    // 分红再投入：金额 0（成本不变）、只加份额（净值已由用户修正为同期值 1.553）
    expect(byRow.get(7)).toMatchObject({
      date: '2026-04-16', type: '分红再投入', fundCode: '002009',
      amount: 0, shares: 77.56, nav: 1.553
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

  it('可疑项为空：1.0577 异常行已在 Excel 中修正为同期值，无触发阈值', () => {
    // 分红再投入 1.553 与同期参考净值偏差约 0.5% < 10%，不再判定为可疑
    expect(result.suspicious).toEqual([])
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

  it('周收益黄金值：真实数据手算抽查 2 个日期（08-11、07-31）', () => {
    const weekly = computeWeeklyReturn(result.expectation.series)
    expect(weekly[13]).toBeCloseTo(14256.58, 2) // 08-11 vs 07-31
    expect(weekly[12]).toBeCloseTo(13440.67, 2) // 07-31 vs 06-29
  })
})

// ---------- 合成工作簿：真实 Excel 已修正可疑行，可疑判定路径改用最小夹具覆盖 ----------

/** 最小五表工作簿：999001 买入 1000 份 + 分红再投入净值 1.0577，快照市值 1530（参考净值 ≈1.4571） */
function syntheticWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const put = (name: string, rows: unknown[][]): void => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  put('基金列表', [
    ['代码', '名称', '类型'],
    ['999001', '测试基金', '二级债基']
  ])
  put('持仓概览', [['纯债', 1]])
  put('交易流水', [
    ['日期', '操作类型', '基金代码', '基金名称', '金额', '份额', '净值', '手续费', '备注'],
    ['2026-01-02', '买入', '999001', '测试基金', 1000, 1000, 1, 0, ''],
    ['2026-04-16', '分红再投入', '999001', '测试基金', null, 50, 1.0577, 0, '']
  ])
  put('收益明细', [
    ['日期', '基金代码', '基金名称', '当日收益', '累计收益', '市值'],
    ['2026-04-16', '999001', '测试基金', null, null, 1530]
  ])
  put('收益汇总', [['日期', null, null, '总市值']])
  return wb
}

describe('parseWorkbook — 可疑判定（合成夹具）', () => {
  const synthetic = parseWorkbook(syntheticWorkbook())

  it('分红再投入净值偏离参考净值超过 10% 判定为可疑，给出参考净值建议', () => {
    expect(synthetic.suspicious).toHaveLength(1)
    const s = synthetic.suspicious[0]
    expect(s.excelRow).toBe(3)
    expect(s.fundCode).toBe('999001')
    expect(s.type).toBe('分红再投入')
    const navField = s.fields.find((f) => f.field === 'nav')!
    expect(navField.value).toBe(1.0577)
    // 参考净值 = 快照市值 ÷ 当日累计份额（1000 + 50）
    expect(navField.suggested).toBeCloseTo(1530 / 1050, 4)
    expect(s.detail).toContain('净值')
  })
})

// ---------- 合成工作簿：大类/产品形态标签映射与未知标签警告 ----------

/** 持仓概览行：第 1 列类别标签（null 表示继承上一段），第 6 列基金代码 */
function overviewRow(label: string | null, code: string, name = code): unknown[] {
  const row: unknown[] = [label, null, null, null, null, code, name]
  while (row.length < 18) row.push(null)
  return row
}

/** 最小五表工作簿：基金列表 + 持仓概览（段头 + 基金行），其余表只有表头 */
function classificationWorkbook(
  funds: [code: string, name: string, fundType: string | null][],
  overview: unknown[][]
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const put = (name: string, rows: unknown[][]): void => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  put('基金列表', [['代码', '名称', '类型'], ...funds])
  put('持仓概览', [
    ['类别', '目标', '比例', '总市值', '比例', '基金代码', '基金简称'],
    ...overview
  ])
  put('交易流水', [['日期', '操作类型', '基金代码', '基金名称', '金额', '份额', '净值', '手续费', '备注']])
  put('收益明细', [['日期', '基金代码', '基金名称', '当日收益', '累计收益', '市值']])
  put('收益汇总', [['日期', null, null, '总市值']])
  return wb
}

describe('parseWorkbook — 大类/产品形态标签映射（合成夹具）', () => {
  const cases: [label: string, productForm: string, category: string][] = [
    ['固守+', '固收+', '固守+'],
    ['固收+', '固收+', '固守+'],
    ['纯债', '纯债', '纯债'],
    ['权益', '权益', '权益'],
    ['黄金', '黄金', '黄金'],
    // 旧「流动性」归入 债 / 纯债
    ['流动性', '纯债', '纯债']
  ]
  const funds = cases.map((_, i): [string, string, string] => [`00000${i + 1}`, `基金${i + 1}`, '二级债基'])
  const overview = cases.map(([label], i) => overviewRow(label, `00000${i + 1}`, `基金${i + 1}`))
  const parsed = parseWorkbook(classificationWorkbook(funds, overview))

  it('旧五类与新标签都映射到正确的产品形态与兼容列', () => {
    cases.forEach(([label, productForm, category], i) => {
      const fund = parsed.funds.find((f) => f.code === `00000${i + 1}`)
      expect(fund).toBeDefined()
      expect(fund!.productForm).toBe(productForm)
      expect(fund!.category).toBe(category)
    })
    expect(parsed.warnings).toEqual([])
  })
})

describe('parseWorkbook — 未知标签警告（合成夹具）', () => {
  it('持仓概览出现未知标签：给出警告并列出具体值与基金代码，不静默兜底为权益', () => {
    const parsed = parseWorkbook(
      classificationWorkbook(
        [['000010', '未知标签基金', '二级债基']],
        [overviewRow('股票型', '000010', '未知标签基金')]
      )
    )
    const fund = parsed.funds.find((f) => f.code === '000010')!
    expect(fund.productForm).toBeUndefined()
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0].kind).toBe('unknown-category')
    expect(parsed.warnings[0].detail).toContain('股票型')
    expect(parsed.warnings[0].detail).toContain('000010')
  })

  it('未出现在持仓概览且基金类型无法识别：给出警告，不兜底为权益', () => {
    const parsed = parseWorkbook(
      classificationWorkbook([['000011', '未知类型基金', '另类投资']], [])
    )
    const fund = parsed.funds.find((f) => f.code === '000011')!
    expect(fund.productForm).toBeUndefined()
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0].kind).toBe('unknown-fund-type')
    expect(parsed.warnings[0].detail).toContain('另类投资')
    expect(parsed.warnings[0].detail).toContain('000011')
  })
})
