import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as XLSX from 'xlsx'
import { SCHEMA } from './schema'
import { buildCsvContent, buildExportData, writeExportCsvs, writeExportExcel } from './exportService'
import type { ExportSheet } from './exportService'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

/** 数字单元格构造（金额 z='0.00'、净值 z='0.0000'） */
function num(v: number, z: string): { v: number; z: string } {
  return { v, z }
}

function insertFund(db: Database.Database, code: string, name: string, category: string): void {
  db.prepare('INSERT INTO funds (code, name, category, created_at) VALUES (?,?,?,?)').run(
    code, name, category, '2026-01-01'
  )
}

function insertTx(db: Database.Database, date: string, type: string, code: string, amount: number, shares: number | null, nav: number | null, fee: number | null, note: string | null): void {
  db.prepare('INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    date, type, code, amount, shares, nav, fee, note, '2026-01-01', '2026-01-01'
  )
}

/** 种子库：两只基金（权益 + 固守+）、五笔流水（含卖出为 0 的边界外场景）、四条净值历史。
 *  手算基准（独立于实现）：
 *  - 000001：净投入 3400、份额 300、最新净值 12.5 → 市值 3750、盈亏 350、盈亏比例 10.2941…%
 *  - 002065：净投入 20000、份额 18500、最新净值 1.234567 → 市值 22839.4895、盈亏 2839.4895、盈亏比例 14.1974…%
 *  - 汇总：总资产 26589.4895、总盈亏 3189.4895、总收益率 13.6302…%、已实现盈亏 60、总收益 3249.4895
 */
function seedDb(db: Database.Database): Database.Database {
  insertFund(db, '000001', '测试权益', '权益')
  insertFund(db, '002065', '固收增强', '固守+')
  db.prepare('INSERT INTO category_targets (category, target_ratio) VALUES (?,?)').run('固守+', 0.25)
  db.prepare('INSERT INTO category_targets (category, target_ratio) VALUES (?,?)').run('权益', 0.20)
  insertTx(db, '2026-01-15', '买入', '000001', 1000, 100, 10, 2, null)
  insertTx(db, '2026-02-01', '买入', '000001', 2400, 200, 12, null, null)
  insertTx(db, '2026-03-01', '分红现金', '000001', 60, null, null, null, '落袋')
  insertTx(db, '2026-01-20', '买入', '002065', 20000, 18000, 1.1111, 10, '含,逗号')
  insertTx(db, '2026-04-10', '分红再投入', '002065', 0, 500, 1.053, null, null)
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('000001', '2026-01-20', 10, 'import')
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('000001', '2026-03-05', 12.5, 'manual')
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('002065', '2026-04-10', 1.053, 'import')
  db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('002065', '2026-08-28', 1.234567, 'auto')
  return db
}

function sheetByName(sheets: ExportSheet[], name: string): ExportSheet {
  const s = sheets.find((x) => x.name === name)
  expect(s, `缺少工作表「${name}」`).toBeDefined()
  return s!
}

describe('buildExportData — 净值表', () => {
  it('中文表头 + 按日期升序 + 净值 4 位精度 + 来源中文标签', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const nav = sheetByName(sheets, '净值')

    expect(nav.rows[0]).toEqual(['日期', '基金代码', '基金名称', '净值', '来源'])
    expect(nav.rows.slice(1)).toEqual([
      ['2026-01-20', '000001', '测试权益', num(10, '0.0000'), '导入'],
      ['2026-03-05', '000001', '测试权益', num(12.5, '0.0000'), '手动'],
      ['2026-04-10', '002065', '固收增强', num(1.053, '0.0000'), '导入'],
      ['2026-08-28', '002065', '固收增强', num(1.2346, '0.0000'), '自动']
    ])
  })
})

describe('buildExportData — 流水表', () => {
  it('中文表头 + 按日期/主键排序 + 金额 2 位/净值 4 位；空份额/净值/手续费/备注为空单元格', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const tx = sheetByName(sheets, '流水')

    expect(tx.rows[0]).toEqual(['日期', '操作类型', '基金代码', '基金名称', '金额（元）', '份额', '净值', '手续费', '备注'])
    expect(tx.rows.slice(1)).toEqual([
      ['2026-01-15', '买入', '000001', '测试权益', num(1000, '0.00'), num(100, '0.00'), num(10, '0.0000'), num(2, '0.00'), ''],
      ['2026-01-20', '买入', '002065', '固收增强', num(20000, '0.00'), num(18000, '0.00'), num(1.1111, '0.0000'), num(10, '0.00'), '含,逗号'],
      ['2026-02-01', '买入', '000001', '测试权益', num(2400, '0.00'), num(200, '0.00'), num(12, '0.0000'), '', ''],
      ['2026-03-01', '分红现金', '000001', '测试权益', num(60, '0.00'), '', '', '', '落袋'],
      ['2026-04-10', '分红再投入', '002065', '固收增强', num(0, '0.00'), num(500, '0.00'), num(1.053, '0.0000'), '', '']
    ])
  })
})

describe('buildExportData — 概览表', () => {
  it('汇总区数字与引擎口径一致（独立手算基准）；总收益率为百分比数字', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const ov = sheetByName(sheets, '概览')
    const summary = ov.rows.slice(1, 7)

    // 构建时已按显示位数舍入：单元格值即为软件内显示值（金额 2 位）
    expect(summary[0]).toEqual(['总资产', num(26589.49, '0.00')])
    expect(summary[1]).toEqual(['持仓盈亏', num(3189.49, '0.00')])
    // 总收益率 = 总收益/净投入成本 = 3249.49/23400（含分红现金 60 进分子）
    expect(summary[2]).toEqual(['总收益率(%)', num(13.89, '0.00')])
    expect(summary[3]).toEqual(['已实现盈亏', num(60, '0.00')])
    expect(summary[4]).toEqual(['总收益', num(3249.49, '0.00')])
    expect(summary[5]).toEqual(['净投入成本', num(23400, '0.00')])
  })

  it('持仓明细与手算一致：金额 2 位、净值 4 位、盈亏比例为百分比数字', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const ov = sheetByName(sheets, '概览')

    expect(ov.rows[8]).toEqual(['持仓明细'])
    expect(ov.rows[9]).toEqual([
      '基金代码', '基金名称', '大类', '份额', '持仓成本', '最新净值', '市值', '持仓盈亏', '盈亏比例(%)'
    ])

    const [a, b] = ov.rows.slice(10, 12)
    expect(a).toEqual([
      '000001', '测试权益', '权益', num(300, '0.00'), num(3400, '0.00'), num(12.5, '0.0000'), num(3750, '0.00'), num(350, '0.00'), num(10.29, '0.00')
    ])
    expect(b).toEqual([
      '002065', '固收增强', '固守+', num(18500, '0.00'), num(20000, '0.00'), num(1.2346, '0.0000'), num(22839.49, '0.00'), num(2839.49, '0.00'), num(14.2, '0.00')
    ])
  })

  it('持仓明细只列在持持仓：已清仓与超卖负份额都不列（与概览页同一口径）', () => {
    const db = seedDb(freshDb())
    // 000217：买入 1000 份后全部卖出 → 已清仓（份额归零，净值仍在）
    insertFund(db, '000217', '测试黄金', '黄金')
    insertTx(db, '2026-05-01', '买入', '000217', 5000, 1000, 5, null, null)
    insertTx(db, '2026-05-20', '卖出', '000217', -6000, -1000, 6, null, null)
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('000217', '2026-05-20', 6, 'manual')
    // 999999：卖出多于买入 → 超卖（份额为负，数据错误）
    insertFund(db, '999999', '测试超卖', '权益')
    insertTx(db, '2026-06-01', '买入', '999999', 1000, 100, 10, null, null)
    insertTx(db, '2026-06-02', '卖出', '999999', -2200, -200, 11, null, null)
    db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,?)').run('999999', '2026-06-02', 11, 'manual')

    const ov = sheetByName(buildExportData(db), '概览')
    expect(ov.rows.slice(10, 12).map((r) => r[0])).toEqual(['000001', '002065'])
    expect(ov.rows[12]).toEqual([]) // 明细段后紧跟空行 → 清仓与超卖都没混进来
  })

  it('大类配置对比：目标/投入/市值/偏离均为百分比数字（手算基准）', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const ov = sheetByName(sheets, '概览')

    expect(ov.rows[13]).toEqual(['大类配置对比'])
    expect(ov.rows[14]).toEqual(['大类', '目标比例(%)', '实际投入比例(%)', '实际市值占比(%)', '偏离(%)'])

    expect(ov.rows[15]).toEqual(['固守+', num(25, '0.00'), num(85.47, '0.00'), num(85.9, '0.00'), num(60.9, '0.00')])
    expect(ov.rows[16]).toEqual(['权益', num(20, '0.00'), num(14.53, '0.00'), num(14.1, '0.00'), num(-5.9, '0.00')])
  })
})

describe('buildExportData — 空库', () => {
  it('三张表仅有表头（汇总为 0，总收益率空），不抛错', () => {
    const sheets = buildExportData(freshDb())
    expect(sheets.map((s) => s.name)).toEqual(['概览', '流水', '净值'])

    const ov = sheetByName(sheets, '概览')
    expect(ov.rows[1]).toEqual(['总资产', num(0, '0.00')])
    expect(ov.rows[3]).toEqual(['总收益率(%)', ''])
    expect(ov.rows[9]).toEqual([
      '基金代码', '基金名称', '大类', '份额', '持仓成本', '最新净值', '市值', '持仓盈亏', '盈亏比例(%)'
    ])
    expect(sheetByName(sheets, '流水').rows).toHaveLength(1)
    expect(sheetByName(sheets, '净值').rows).toHaveLength(1)
  })
})

describe('buildCsvContent — CSV 与软件内显示一致', () => {
  it('UTF-8 BOM 开头；数字按显示格式四舍五入（金额 2 位/净值 4 位/比例 2 位百分比）', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const tx = sheetByName(sheets, '流水')
    const csv = buildCsvContent(tx.rows)

    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    // 表头行
    expect(lines[0]).toBe('日期,操作类型,基金代码,基金名称,金额（元）,份额,净值,手续费,备注')
    // 000001 分红现金行：空份额/净值/手续费为空单元格
    expect(lines[4]).toBe('2026-03-01,分红现金,000001,测试权益,60.00,,,,落袋')

    // 构建时已按显示位数舍入，CSV 输出与 Excel 单元格值逐位一致
    const ov = sheetByName(sheets, '概览')
    const ovLines = buildCsvContent(ov.rows).slice(1).split('\r\n')
    expect(ovLines[1]).toBe('总资产,26589.49')
    const quanyi = ovLines[ovLines.length - 1] // 权益行：偏离 −5.896683…% → -5.90
    expect(quanyi).toBe('权益,20.00,14.53,14.10,-5.90')
  })

  it('含逗号/引号的备注按 CSV 规范加引号转义', () => {
    const sheets = buildExportData(seedDb(freshDb()))
    const tx = sheetByName(sheets, '流水')
    const lines = buildCsvContent(tx.rows).slice(1).split('\r\n')
    // 002065 买入行备注「含,逗号」→ "含,逗号"
    expect(lines[2]).toBe('2026-01-20,买入,002065,固收增强,20000.00,18000.00,1.1111,10.00,"含,逗号"')
  })
})

describe('writeExportCsvs — 落盘与内容一致', () => {
  it('按表名写出三个 CSV 文件，内容与 buildCsvContent 完全相同', () => {
    const dir = mkdtempSync(join(tmpdir(), 'porti-csv-'))
    const sheets = buildExportData(seedDb(freshDb()))

    const files = writeExportCsvs(sheets, dir)
    expect(files).toEqual([join(dir, '概览.csv'), join(dir, '流水.csv'), join(dir, '净值.csv')])

    for (const [i, sheet] of sheets.entries()) {
      expect(existsSync(files[i])).toBe(true)
      expect(readFileSync(files[i], 'utf8')).toBe(buildCsvContent(sheet.rows))
    }
  })
})

describe('writeExportExcel — 往返读取', () => {
  it('三个 sheet 按概览/流水/净值顺序写出；表头与数值回读一致，基金代码前导零保留', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'porti-xlsx-')), '导出.xlsx')
    const sheets = buildExportData(seedDb(freshDb()))
    writeExportExcel(sheets, file)

    const wb = XLSX.readFile(file)
    expect(wb.SheetNames).toEqual(['概览', '流水', '净值'])

    // 概览：汇总区「总资产」单元格值即显示精度值（构建时已舍入），显示文本 2 位
    const ov = wb.Sheets['概览']
    expect(ov.A1.v).toBe('汇总')
    const assetsCell = ov.B2 as XLSX.CellObject
    expect(assetsCell.t).toBe('n')
    expect(assetsCell.v).toBe(26589.49)
    expect(assetsCell.w).toBe('26589.49') // 数字格式已写入文件（Excel 打开即按 2 位显示）

    // 净值：前导零基金代码保持 6 位文本；净值显示文本为 4 位
    const nav = wb.Sheets['净值']
    expect(nav.A1.v).toBe('日期')
    const codeCell = nav.B4 as XLSX.CellObject // 第 4 行 = 002065 的第一条（2026-04-10）
    expect(codeCell.t).toBe('s')
    expect(codeCell.v).toBe('002065')
    const navCell = nav.D4 as XLSX.CellObject
    expect(navCell.v).toBe(1.053)
    expect(navCell.w).toBe('1.0530')

    // 流水：备注含逗号文本原样保留
    const tx = wb.Sheets['流水']
    expect(tx.I3).toMatchObject({ v: '含,逗号' })
  })
})
