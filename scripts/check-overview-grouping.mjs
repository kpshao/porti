#!/usr/bin/env node
// 概览持仓明细「按大类分组」端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3）
//
// 用法：node scripts/check-overview-grouping.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron -> CDP 断言
// 概览持仓明细表的分组。断言口径见 .scratch/overview-group-by-category/spec.md。
//
// 退出码：0 = 通过（含 SKIP：无持仓数据）；1 = RED。
//
// 已知陷阱：窗口遮挡时 rAF 被节流（本页无图表，仍带旗标保持一致）；
// 本机 shell 可能导出 ELECTRON_RUN_AS_NODE=1，spawn 前必须 delete，否则 Electron 退化为纯 Node。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9333'
const CDP = `http://127.0.0.1:${PORT}`

/** 与 src/engine/validation.ts 的 CATEGORIES 保持一致（消费方按此声明顺序排序） */
const CATEGORIES = ['固守+', '纯债', '权益', '黄金', '流动性']
/** 与 src/engine/compute.ts 的 OTHER_CATEGORY 保持一致 */
const OTHER = '其他'

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const failures = []
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 显示金额文本 -> 数值（'—' / 空 -> null） */
function money(text) {
  const t = (text ?? '').trim()
  if (t === '' || t === '—') return null
  return Number(t.replace(/,/g, ''))
}
/** 舍入容差：每个显示值最多偏 0.005，两端各留一份 */
const tol = (n) => 0.01 * n + 0.01

/** 库里的大类 -> 表格中的组名（闭集之外归入「其他」） */
const groupNameOf = (category) => (CATEGORIES.includes(category) ? category : OTHER)

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-group-check-'))
const dbPath = join(profileDir, 'porti.db')
const realDbDir = join(homedir(), 'Library/Application Support/porti')
const hasRealData = existsSync(join(realDbDir, 'porti.db'))
if (hasRealData) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，断言将 SKIP')
}

// 独立事实来源：直接从库读 Fund.code -> category，用于交叉验证行落在正确的组里
const fundCategory = new Map()
if (existsSync(dbPath)) {
  const q = spawnSync('sqlite3', [dbPath, 'SELECT code, category FROM funds'])
  if (q.status !== 0) {
    console.error(`RED: sqlite3 读取失败：${q.stderr?.toString().trim()}`)
    cleanup()
    process.exit(1)
  }
  for (const line of q.stdout.toString().split('\n')) {
    const [code, category] = line.split('|')
    if (code && category !== undefined) fundCategory.set(code.trim(), category.trim())
  }
}

// ---- 3. 启动 Electron（剔除 ELECTRON_RUN_AS_NODE，防退化为纯 Node）-------
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const electron = spawn(
  ELECTRON_BIN,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ROOT
  ],
  { stdio: 'ignore', env }
)

const waitFor = async (fn, ms, step = 250) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  return null
}

const pageTarget = await waitFor(
  () =>
    fetch(`${CDP}/json/list`)
      .then((r) => r.json())
      .then((ts) => ts.find((t) => t.type === 'page' && t.url.includes('index.html')))
      .catch(() => null),
  20000
)
if (!pageTarget) {
  console.error('RED: Electron 启动超时，未发现页面 target')
  cleanup()
  process.exit(1)
}

// ---- 4. CDP 检查 ----------------------------------------------------------
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
const pending = new Map()
const logs = []
let msgId = 0
function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP 超时: ${method}`))
    }, 15000)
  })
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown' || m.method === 'Runtime.consoleAPICalled') {
    const text =
      m.params.exceptionDetails?.exception?.description ??
      m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')
    logs.push(text.slice(0, 300))
  }
}
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
await send('Runtime.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1500))

/** 页面内执行并返回值 */
const evalJs = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.value
}

const state = await evalJs(`(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '持仓明细'
  )
  if (!card) return { error: 'no-card' }
  const table = card.querySelector('table.table')
  if (!table) return { error: 'no-table' }
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
  const readCell = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      text: el.textContent.trim(),
      rowSpan: el.getAttribute('rowspan'),
      bg: cs.backgroundColor,
      valign: cs.verticalAlign
    }
  }
  // 折行判定：用 Range 量文本实际高度，超过 1.8 倍字号即认为折了行
  const textHeight = (el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getBoundingClientRect().height
  }
  const isWrapped = (td) => textHeight(td) > parseFloat(getComputedStyle(td).fontSize) * 1.8
  const groups = [...table.querySelectorAll('tbody')].map((tb) => {
    const trs = [...tb.querySelectorAll('tr')]
    const first = trs[0] ?? null
    return {
      lead: first ? [readCell(first.children[0]), readCell(first.children[1])] : [null, null],
      firstRowCells: first ? first.children.length : 0,
      otherRowCells: trs.slice(1).map((tr) => tr.children.length),
      rows: trs.map((tr) => {
        // 组内首行 12 格（含两个合并列），其余行 10 格；差值即偏移
        const off = tr.children.length - 10
        return {
          code: tr.children[off]?.textContent?.trim() ?? '',
          marketValue: tr.children[off + 5]?.textContent?.trim() ?? '',
          wrapped: [...tr.children]
            .filter((td) => td.textContent.trim() !== '' && isWrapped(td))
            .map((td) => td.textContent.trim().slice(0, 14))
        }
      })
    }
  })
  const totalStat = [...document.querySelectorAll('.summary-card .stat')].find(
    (s) => s.querySelector('.stat-label')?.textContent === '总资产'
  )
  return {
    headers,
    groups,
    totalAssetsText: totalStat?.querySelector('.stat-value')?.textContent?.trim() ?? null,
    fundCount: document.querySelectorAll('.fund-link').length
  }
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-overview-grouping-check.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

if (state.error) {
  console.error(`RED: 未找到持仓明细表（${state.error}）`)
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
if (state.fundCount === 0) {
  console.log('SKIP: 概览页无持仓行（无 .fund-link），无数据无法断言分组。')
  cleanup()
  process.exit(0)
}

// ---- 5. 断言 --------------------------------------------------------------
const HEADERS = [
  '大类',
  '大类市值',
  '代码',
  '名称',
  '份额',
  '持仓成本',
  '最新净值',
  '市值',
  '持仓盈亏',
  '盈亏比例',
  '年化收益率',
  '目标金额（元）'
]
console.log(`持仓明细：${state.groups.length} 组 / ${state.groups.reduce((s, g) => s + g.rows.length, 0)} 行`)

check(
  JSON.stringify(state.headers) === JSON.stringify(HEADERS),
  '表头为 12 列且「大类 / 大类市值」在最前',
  `实际 ${state.headers.join('/')}`
)

const names = state.groups.map((g) => g.lead[0]?.text ?? null)
check(new Set(names).size === names.length, '组名无重复', names.filter(Boolean).join(' → '))
check(
  names.every((n) => n),
  '每组首行都有合并的「大类」单元格'
)

// 组序：CATEGORIES 声明顺序的子序列，「其他」若存在必在最后
const expectedOrder = names.filter((n) => n !== OTHER)
const idealOrder = CATEGORIES.filter((c) => expectedOrder.includes(c))
check(
  JSON.stringify(expectedOrder) === JSON.stringify(idealOrder),
  '组序为 CATEGORIES 声明顺序',
  `实际 ${names.join(' → ')}`
)
check(!names.includes(OTHER) || names[names.length - 1] === OTHER, '「其他」组置底')

check(
  state.groups.every((g) => g.rows.length > 0),
  '空大类不产生组（每组至少 1 行）'
)

// 合并单元格：rowSpan = 组内行数，且组内其余行不含这两列
let spanBad = []
for (const g of state.groups) {
  const label = `「${g.lead[0]?.text}」`
  const n = String(g.rows.length)
  if (g.lead[0]?.rowSpan !== n) spanBad.push(`${label}大类 rowspan=${g.lead[0]?.rowSpan} ≠ ${n}`)
  if (g.lead[1]?.rowSpan !== n) spanBad.push(`${label}大类市值 rowspan=${g.lead[1]?.rowSpan} ≠ ${n}`)
  if (g.firstRowCells !== 12) spanBad.push(`${label}首行 ${g.firstRowCells} 格 ≠ 12`)
  if (g.otherRowCells.some((c) => c !== 10)) {
    spanBad.push(`${label}非首行格数 ${g.otherRowCells.join(',')} ≠ 10`)
  }
}
check(spanBad.length === 0, '两个合并列 rowSpan = 组内行数；组内其余行不含这两列', spanBad.join('; '))

// 合并单元格样式：浅灰底 + 垂直居中（组色带）
let styleBad = []
for (const g of state.groups) {
  g.lead.forEach((c, i) => {
    const col = i === 0 ? '大类' : '大类市值'
    if (c?.bg !== 'rgb(242, 243, 245)') styleBad.push(`${col}底色 ${c?.bg}`)
    if (c?.valign !== 'middle') styleBad.push(`${col}垂直对齐 ${c?.valign}`)
  })
}
check(
  styleBad.length === 0,
  '合并单元格：浅灰底 #f2f3f5 + 垂直居中',
  [...new Set(styleBad)].join('; ')
)

// 无跨类穿插：每行的基金代码，其库内大类映射后必须等于所在组名
let misplaced = []
let unknownCode = 0
for (const g of state.groups) {
  for (const r of g.rows) {
    const cat = fundCategory.get(r.code)
    if (cat === undefined) {
      unknownCode++
      continue
    }
    if (groupNameOf(cat) !== g.lead[0]?.text) {
      misplaced.push(`${r.code}(${cat}) 落在「${g.lead[0]?.text}」`)
    }
  }
}
check(misplaced.length === 0, '同大类连续、无跨类穿插（逐行与库交叉验证）', misplaced.join('; '))
if (unknownCode > 0) console.log(`  提示：${unknownCode} 行代码不在 funds 表中，已跳过交叉验证`)

// 组内按基金代码升序
let orderBad = []
for (const g of state.groups) {
  const codes = g.rows.map((r) => r.code)
  if (JSON.stringify(codes) !== JSON.stringify([...codes].sort())) {
    orderBad.push(`「${g.lead[0]?.text}」${codes.join(' → ')}`)
  }
}
check(orderBad.length === 0, '组内按基金代码升序', orderBad.join('; '))

// 默认窗口宽度下不应有任何单元格折行（12 列曾把基金名称与「大类」挤断行）
const wrappedCells = []
for (const g of state.groups) {
  for (const r of g.rows) {
    if (r.wrapped.length > 0) wrappedCells.push(`「${g.lead[0]?.text}」${r.code}: ${r.wrapped.join(' / ')}`)
  }
}
check(wrappedCells.length === 0, '默认窗口宽度下无单元格折行', wrappedCells.join('; '))

// 大类市值 = Σ 组内明细市值（各显示值独立舍入，故留容差）
let groupMismatch = []
for (const g of state.groups) {
  const shown = money(g.lead[1]?.text)
  const sum = g.rows.reduce((s, r) => s + (money(r.marketValue) ?? 0), 0)
  if (shown === null) {
    if (g.rows.every((r) => money(r.marketValue) === null)) continue // 全无净值 → 「—」正确
    groupMismatch.push(`「${g.lead[0]?.text}」大类市值为「—」但组内有市值`)
    continue
  }
  if (Math.abs(shown - sum) > tol(g.rows.length)) {
    groupMismatch.push(`「${g.lead[0]?.text}」大类市值 ${shown} ≠ 行合计 ${sum.toFixed(2)}`)
  }
}
check(groupMismatch.length === 0, '大类市值 = Σ 组内明细市值', groupMismatch.join('; '))

// Σ 大类市值 == 顶部总资产卡
const sumGroups = state.groups.reduce((s, g) => s + (money(g.lead[1]?.text) ?? 0), 0)
const totalAssets = money(state.totalAssetsText)
const allRows = state.groups.reduce((s, g) => s + g.rows.length, 0)
check(
  totalAssets !== null && Math.abs(sumGroups - totalAssets) <= tol(state.groups.length + allRows),
  'Σ 大类市值 == 顶部总资产',
  `Σ大类市值 ${sumGroups.toFixed(2)} vs 总资产 ${state.totalAssetsText}`
)

for (const l of logs) console.error(`  console: ${l}`)

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
for (const g of state.groups) {
  console.log(`  「${g.lead[0]?.text}」${g.rows.length} 行，大类市值 ${g.lead[1]?.text}`)
}
console.log(`GREEN: 概览持仓明细按大类分组全部断言通过（console 消息 ${logs.length} 条）`)
console.log(`截图: ${shotPath}`)
cleanup()
process.exit(0)

function cleanup() {
  try {
    ws?.close()
  } catch {}
  try {
    electron.kill('SIGTERM')
  } catch {}
  electron.once('exit', () => rmSync(profileDir, { recursive: true, force: true }))
}
