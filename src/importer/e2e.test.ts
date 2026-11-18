// M1 端到端对账验收：真实投资跟踪.xlsx → 解析 → 导入 → 回读 → 计算引擎 → 与 Excel 逐项比对
// 期望值全部取自 Excel 持仓概览/收益汇总的独立数字（spec Testing Decisions）

import { describe, expect, it } from 'vitest'
import { join } from 'path'
import * as XLSX from 'xlsx'
import Database from 'better-sqlite3'
import { SCHEMA } from '../main/schema'
import {
  selectBucketTargets,
  selectFunds,
  selectNavPoints,
  selectTransactions
} from '../main/repo'
import {
  ALLOCATION_BUCKETS,
  computeAllocationComparison,
  computePositions,
  computeTimeSeries,
  computeTotals,
  groupPositionsByProductForm
} from '../engine'
import { parseExcelFile, parseWorkbook } from './parse'
import { importToDb } from './write'
import { reconcileAgainstExcel } from './reconcile'
import type { CommitPayload } from './types'

const FIXTURE = join(process.cwd(), '投资跟踪.xlsx')

function buildPlan(): CommitPayload {
  const parsed = parseExcelFile(FIXTURE)
  return {
    funds: parsed.funds,
    transactions: parsed.transactionRows.map((r) => r.transaction),
    snapshots: parsed.snapshots,
    currentNavs: parsed.currentNavPoints,
    expectation: parsed.expectation
  }
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

describe('M1 端到端对账 — 真实 Excel → 导入 → 计算 → 逐项比对', () => {
  const parsed = parseExcelFile(FIXTURE)
  const db = freshDb()
  const counts = importToDb(db, buildPlan())

  it('导入计数：10 只基金、69 笔流水、92 条快照重建 + 9 条当前净值', () => {
    expect(counts).toEqual({
      funds: 10,
      transactions: 69,
      reconstructedNavs: 92,
      currentNavs: 9,
      skippedSnapshots: 0
    })
  })

  it('数据库回读与导入一致', () => {
    expect(selectFunds(db)).toHaveLength(10)
    expect(selectTransactions(db)).toHaveLength(69)
    expect(selectNavPoints(db)).toHaveLength(92 + 9)
    // 净值来源全部为 import
    for (const p of selectNavPoints(db)) expect(p.source).toBe('import')
  })

  it('导入同时写入新模型字段：旧 Excel 标签映射到账本大类与产品形态', () => {
    const byCode = new Map(funds.map((f) => [f.code, f]))
    expect(byCode.get('519680')).toMatchObject({
      ledgerCategory: '债', productForm: '纯债', equityRatio: 0
    })
    // 旧「流动性」别名归入 债 / 纯债
    expect(byCode.get('007824')).toMatchObject({
      ledgerCategory: '债', productForm: '纯债', equityRatio: 0
    })
    expect(byCode.get('110017')).toMatchObject({
      ledgerCategory: '债', productForm: '固收+', equityRatio: 0.2
    })
    expect(byCode.get('563360')).toMatchObject({
      ledgerCategory: '权益', productForm: '权益', equityRatio: 1
    })
    expect(byCode.get('000217')).toMatchObject({
      ledgerCategory: '黄金', productForm: '黄金', equityRatio: 0
    })
    for (const f of funds) {
      expect(f.equityRatioSource).toBe('manual')
      expect(f.equityRatioAsOf).toBeNull()
    }
  })

  it('未出现在持仓概览的基金按基金类型推断产品形态，并在预览中标记', () => {
    expect(funds.find((f) => f.code === '000385')).toMatchObject({
      ledgerCategory: '债', productForm: '固收+', equityRatio: 0.2
    })
    const inferred = parsed.fixes.find((f) => f.kind === 'category-inferred')
    expect(inferred).toBeDefined()
    expect(inferred!.detail).toContain('000385')
  })

  const funds = selectFunds(db)
  const transactions = selectTransactions(db)
  const navPoints = selectNavPoints(db)
  const positions = computePositions(funds, transactions, navPoints)
  const totals = computeTotals(positions, transactions)
  const series = computeTimeSeries(funds, transactions, navPoints)
  const report = reconcileAgainstExcel(parsed.expectation, positions, totals, series)

  it('总资产 775,962.32、总盈亏 −8,351.48、总收益率 −1.06% 与 Excel 完全一致', () => {
    const check = (label: string): { excel: number; computed: number; match: boolean } => {
      const c = report.totals.checks.find((x) => x.label === label)!
      expect(c).toBeDefined()
      return c
    }
    const assets = check('总资产')
    expect(assets.excel).toBeCloseTo(775962.32, 2)
    expect(assets.computed).toBeCloseTo(775962.32, 2)
    expect(assets.match).toBe(true)

    const pnl = check('总盈亏')
    expect(pnl.computed).toBeCloseTo(-8351.48, 2)
    expect(pnl.match).toBe(true)

    const rate = check('总收益率')
    expect(rate.excel).toBeCloseTo(-0.010648138382876898, 9)
    expect(rate.computed).toBeCloseTo(-0.010648138382876898, 9)
    expect(rate.match).toBe(true)

    const netCost = check('净投入成本')
    expect(netCost.computed).toBeCloseTo(784313.8, 2)
    expect(netCost.match).toBe(true)
  })

  it('9 只基金逐项（份额/市值/盈亏）与 Excel 持仓概览一致', () => {
    expect(report.funds).toHaveLength(9)
    for (const f of report.funds) {
      expect(f.match).toBe(true)
    }
    // 抽样：563360 A500ETF华泰柏瑞
    const a500 = report.funds.find((f) => f.code === '563360')!
    const share = a500.checks.find((c) => c.label === '当前份额')!
    expect(share.computed).toBeCloseTo(64600, 2)
    const mv = a500.checks.find((c) => c.label === '当前市值')!
    expect(mv.computed).toBeCloseTo(83398.6, 2)
    const pnl = a500.checks.find((c) => c.label === '持仓盈亏')!
    expect(pnl.computed).toBeCloseTo(-4394.7, 2)
  })

  it('14 期收益汇总的总市值逐期一致', () => {
    expect(report.series).toHaveLength(14)
    for (const s of report.series) {
      expect(s.match).toBe(true)
    }
    expect(report.series[0].date).toBe('2026-03-13')
    expect(report.series[0].computed).toBeCloseTo(199788.954552, 2)
    expect(report.series[13].date).toBe('2026-08-11')
    expect(report.series[13].computed).toBeCloseTo(758627.24876, 2)
    // 额外当前净值点（2026-08-24）与总资产闭合：时间序列最后一个点 = 总资产
    expect(series).toHaveLength(15)
    expect(series[14].date).toBe('2026-08-24')
    expect(series[14].totalMarketValue).toBeCloseTo(totals.totalAssets, 2)
  })

  it('导入后的基金进入产品形态分组与三桶配置对比', () => {
    const groups = groupPositionsByProductForm(positions, transactions, '2026-08-24')
    expect(groups.map((g) => g.name)).toEqual(['固收+', '纯债', '权益', '黄金'])
    expect(groups.flatMap((g) => g.positions)).toHaveLength(9)

    const comparison = computeAllocationComparison(positions, funds, [
      { bucket: '稳健', targetRatio: 0.6 },
      { bucket: '权益', targetRatio: 0.35 },
      { bucket: '黄金', targetRatio: 0.05 }
    ])
    const marketRatio = (bucket: (typeof ALLOCATION_BUCKETS)[number]): number =>
      comparison.rows.find((r) => r.bucket === bucket)!.marketRatio!
    // 期望值来自 Excel 持仓概览市值与默认权益系数（固收+ 的 20% 穿透进权益桶）
    expect(marketRatio('稳健')).toBeCloseTo(0.7106, 4)
    expect(marketRatio('权益')).toBeCloseTo(0.2210, 4)
    expect(marketRatio('黄金')).toBeCloseTo(0.0683, 4)
    expect(marketRatio('稳健') + marketRatio('权益') + marketRatio('黄金')).toBeCloseTo(1, 9)
    expect(comparison.equityComposition.direct).toBeCloseTo(0.1692, 4)
    expect(comparison.equityComposition.debtPassthrough).toBeCloseTo(0.0519, 4)
  })

  it('整体对账通过', () => {
    expect(report.allMatch).toBe(true)
  })
})

/** 最小五表工作簿：一只基金 + 持仓概览单个类别段（标签可注入） */
function workbookWithCategory(label: string, fundType = '二级债基'): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const put = (name: string, rows: unknown[][]): void => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  const overviewRow: unknown[] = [label, 0.5, null, null, null, '000010', '测试基金']
  while (overviewRow.length < 18) overviewRow.push(null)
  put('基金列表', [['代码', '名称', '类型'], ['000010', '测试基金', fundType]])
  put('持仓概览', [
    ['类别', '目标', '比例', '总市值', '比例', '基金代码', '基金简称'],
    overviewRow
  ])
  put('交易流水', [['日期', '操作类型', '基金代码', '基金名称', '金额', '份额', '净值', '手续费', '备注']])
  put('收益明细', [['日期', '基金代码', '基金名称', '当日收益', '累计收益', '市值']])
  put('收益汇总', [['日期', null, null, '总市值']])
  return wb
}

describe('旧 Excel 标签别名与新标签端到端', () => {
  it.each([
    ['固守+', '固收+'],
    ['固收+', '固收+'],
    // 旧「流动性」别名归入 债 / 纯债
    ['流动性', '纯债']
  ])('「%s」导入为 债 / %s', (label, productForm) => {
    const parsed = parseWorkbook(workbookWithCategory(label))
    expect(parsed.warnings).toEqual([])

    const db = freshDb()
    importToDb(db, {
      funds: parsed.funds,
      transactions: parsed.transactionRows.map((r) => r.transaction),
      snapshots: parsed.snapshots,
      currentNavs: parsed.currentNavPoints,
      expectation: parsed.expectation
    })
    expect(selectFunds(db)[0]).toMatchObject({
      ledgerCategory: '债',
      productForm
    })
    db.close()
  })
})

describe('未知标签端到端', () => {
  it('预览阶段警告并列出具体值；写入阶段拒绝且不写入数据', () => {
    const parsed = parseWorkbook(workbookWithCategory('股票型'))
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0].kind).toBe('unknown-category')
    expect(parsed.warnings[0].detail).toContain('股票型')
    expect(parsed.warnings[0].detail).toContain('000010')
    expect(parsed.funds[0].productForm).toBeNull()

    const db = freshDb()
    expect(() =>
      importToDb(db, {
        funds: parsed.funds,
        transactions: parsed.transactionRows.map((r) => r.transaction),
        snapshots: parsed.snapshots,
        currentNavs: parsed.currentNavPoints,
        expectation: parsed.expectation
      })
    ).toThrow(/股票型.*000010/)
    expect(selectFunds(db)).toEqual([])
    db.close()
  })
})

describe('导入忽略目标列', () => {
  it('导入前后配置桶目标保持不变', () => {
    const db = freshDb()
    for (const [bucket, ratio] of [
      ['稳健', 0.6],
      ['权益', 0.3],
      ['黄金', 0.1]
    ] as const) {
      db.prepare('INSERT INTO bucket_targets (bucket, target_ratio) VALUES (?,?)').run(bucket, ratio)
    }

    const counts = importToDb(db, buildPlan())

    expect(counts.funds).toBe(10)
    expect(
      selectBucketTargets(db).sort(
        (a, b) => ALLOCATION_BUCKETS.indexOf(a.bucket) - ALLOCATION_BUCKETS.indexOf(b.bucket)
      )
    ).toEqual([
      { bucket: '稳健', targetRatio: 0.6 },
      { bucket: '权益', targetRatio: 0.3 },
      { bucket: '黄金', targetRatio: 0.1 }
    ])
    db.close()
  })
})

describe('重复导入防护', () => {
  it('已有数据时拒绝导入并给出明确提示', () => {
    const db = freshDb()
    importToDb(db, buildPlan())
    expect(() => importToDb(db, buildPlan())).toThrow(/重复导入/)
    // 数据未被二次写入
    expect(selectTransactions(db)).toHaveLength(69)
    expect(selectNavPoints(db)).toHaveLength(101)
  })
})
