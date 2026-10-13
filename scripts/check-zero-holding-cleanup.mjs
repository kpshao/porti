#!/usr/bin/env node
// 清仓收尾端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3）
//
// 用法：node scripts/check-zero-holding-cleanup.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron -> CDP 断言
// 概览页的清仓行为：已清仓基金默认不占行、开关能找回且仍在表尾单独一组、点得进基金详情；
// 已清空大类的「实际投入比例」记 0、「偏离」显示「—」。断言口径见
// .scratch/return-breakdown/spec.md 与 issues/02-zero-holding-cleanup.md。
//
// 独立事实来源：系统 sqlite3 直读库，算出「谁交易过、谁还有份额、哪个大类已清空」，
// DOM 只提供展示值——两者对不上就是 RED（照 scripts/check-overview-grouping.mjs 的模板）。
//
// 退出码：0 = 通过（含 SKIP：库中无已清仓基金，开关相关断言跳过）；1 = RED。
//
// 已知陷阱：本机 shell 可能导出 ELECTRON_RUN_AS_NODE=1，spawn 前必须 delete，
// 否则 Electron 退化为纯 Node（--remote-debugging-port 失效、页面永远起不来）。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9333'
const CDP = `http://127.0.0.1:${PORT}`

/** 与 src/engine/compute.ts 的 CLOSED_CATEGORY 保持一致 */
const CLOSED_GROUP = '已清仓'
/** 与 src/engine/validation.ts 的 CATEGORIES 保持一致 */
const CATEGORIES = ['固守+', '纯债', '权益', '黄金', '流动性']

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const failures = []
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 显示值 -> 数值（'—' / 空 -> null） */
function num(text) {
  const t = (text ?? '').trim()
  if (t === '' || t === '—') return null
  return Number(t.replace(/,/g, '').replace('%', ''))
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-zero-holding-check-'))
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

// 独立事实来源：每只基金的买卖金额（= 引擎的 invested − redeemed）与净份额
//（份额按库内约定存负值，直接累加；分红类流水的 amount 不计入买卖金额，与引擎 hasTraded 同判据）
const facts = new Map() // code -> { category, tradedAmount, shares }
if (existsSync(dbPath)) {
  const q = spawnSync('sqlite3', [
    dbPath,
    `SELECT f.code, f.category,
            (SELECT COALESCE(SUM(CASE WHEN t.type IN ('买入','卖出') THEN t.amount ELSE 0 END), 0)
               FROM transactions t WHERE t.fund_code = f.code),
            (SELECT COALESCE(SUM(t.shares), 0) FROM transactions t WHERE t.fund_code = f.code)
     FROM funds f`
  ])
  if (q.status !== 0) {
    console.error(`RED: sqlite3 读取失败：${q.stderr?.toString().trim()}`)
    cleanup()
    process.exit(1)
  }
  for (const line of q.stdout.toString().split('\n')) {
    const [code, category, tradedAmount, shares] = line.split('|')
    if (!code) continue
    facts.set(code.trim(), {
      category: (category ?? '').trim(),
      tradedAmount: Number(tradedAmount),
      shares: Number(shares)
    })
  }
}
/** 已清仓：交易过、现份额 ≤ 0（与引擎 groupClosedPositions 的判据一致） */
const closedFunds = [...facts.entries()]
  .filter(([, f]) => f.tradedAmount !== 0 && f.shares <= 0)
  .map(([c]) => c)
/** 从未建仓：没有买卖过、也没有份额（含只有分红类流水的异常数据）——两边都不该出现 */
const untradedFunds = [...facts.entries()]
  .filter(([, f]) => f.tradedAmount === 0 && f.shares <= 0)
  .map(([c]) => c)
/** 在持：份额 > 0 */
const heldFunds = [...facts.entries()].filter(([, f]) => f.shares > 0).map(([c]) => c)
/** 已清空的大类：该大类下交易过的基金全无在持份额，且至少有一只交易过 */
const tradedCategories = [...new Set([...closedFunds, ...heldFunds].map((c) => facts.get(c).category))]
const categoriesOf = (codes) => new Set(codes.map((c) => facts.get(c).category))
const heldCats = categoriesOf(heldFunds)
const clearedCats = [...categoriesOf([...closedFunds, ...heldFunds])].filter(
  (cat) => tradedCategories.includes(cat) && !heldCats.has(cat)
)

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

/** 读持仓明细表：分组 / 行（代码、份额、市值、名称）+ 开关状态 */
const READ_POSITIONS = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '持仓明细'
  )
  if (!card) return { error: 'no-card' }
  const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '显示已清仓')
  const table = card.querySelector('table.table')
  const groups = !table ? [] : [...table.querySelectorAll('tbody')].map((tb) => {
    const trs = [...tb.querySelectorAll('tr')]
    const first = trs[0] ?? null
    return {
      name: first?.children[0]?.textContent?.trim() ?? '',
      headMarketValue: first?.children[1]?.textContent?.trim() ?? '',
      rowSpan: Number(first?.children[0]?.getAttribute('rowspan') ?? 0),
      rows: trs.map((tr) => {
        const off = tr.children.length - 10 // 组内首行 12 格（两个合并列），其余 10 格
        return {
          code: tr.children[off]?.textContent?.trim() ?? '',
          name: tr.children[off + 1]?.querySelector('.fund-link')?.textContent?.trim() ?? '',
          shares: tr.children[off + 2]?.textContent?.trim() ?? '',
          marketValue: tr.children[off + 5]?.textContent?.trim() ?? ''
        }
      })
    }
  })
  return {
    toggleExists: btn !== undefined,
    toggleActive: btn?.className.includes('btn-primary') ?? false,
    headers: table ? [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : [],
    groups,
    emptyHint: !table ? card.querySelector('p.muted')?.textContent?.trim() ?? '' : ''
  }
})()`

/** 读大类配置对比表：大类 -> { 投入比例, 偏离 } */
const READ_COMPARISON = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '大类配置对比'
  )
  if (!card) return { error: 'no-card' }
  return {
    rows: [...card.querySelectorAll('tbody tr')].map((tr) => ({
      category: tr.children[0]?.textContent?.trim() ?? '',
      investedRatio: tr.children[2]?.textContent?.trim() ?? '',
      marketRatio: tr.children[3]?.textContent?.trim() ?? '',
      deviation: tr.children[4]?.textContent?.trim() ?? ''
    }))
  }
})()`

const before = await evalJs(READ_POSITIONS)
await send('Page.captureScreenshot', { format: 'png' }).then((shot) =>
  writeFileSync(join(tmpdir(), 'porti-zero-holding-before.png'), Buffer.from(shot.data, 'base64'))
)

if (before.error) {
  console.error(`RED: 未找到持仓明细表（${before.error}）`)
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}

const defaultCodes = before.groups.flatMap((g) => g.rows.map((r) => r.code))
if (defaultCodes.length === 0 && heldFunds.length === 0) {
  console.log('SKIP: 概览页无在持持仓行，无数据无法断言。')
  cleanup()
  process.exit(0)
}
console.log(
  `事实来源（sqlite3）：在持 ${heldFunds.length} 只 / 已清仓 ${closedFunds.length} 只 / 从未建仓 ${untradedFunds.length} 只；` +
    `已清空大类 [${clearedCats.join(', ') || '无'}]`
)

// ---- 5. 默认视图：零持仓基金不占行 ----------------------------------------
const leakedClosed = closedFunds.filter((c) => defaultCodes.includes(c))
check(leakedClosed.length === 0, '默认不显示已清仓基金行', leakedClosed.join(', '))

const leakedUntraded = untradedFunds.filter((c) => defaultCodes.includes(c))
check(leakedUntraded.length === 0, '从未建仓的基金也不占行（无流水 ≠ 已清仓）', leakedUntraded.join(', '))

check(
  defaultCodes.length === heldFunds.length,
  '默认行数 = 库中有份额的基金数',
  `表内 ${defaultCodes.length} 行 vs 库中 ${heldFunds.length} 只`
)

// ---- 6. 开关：存在、默认关、能找回 ----------------------------------------
if (closedFunds.length === 0) {
  check(!before.toggleExists, '库中无已清仓基金时不渲染开关')
} else {
  check(before.toggleExists, '「显示已清仓」开关存在（库中确已清仓基金）')
  check(!before.toggleActive, '开关默认关闭')

  const clicked = await evalJs(`(() => {
    const card = [...document.querySelectorAll('.card')].find(
      (c) => c.querySelector('h2')?.textContent === '持仓明细'
    )
    const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '显示已清仓')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check(clicked === true, '开关可点击')
  await new Promise((r) => setTimeout(r, 400))

  const after = await evalJs(READ_POSITIONS)
  const closedGroup = after.groups[after.groups.length - 1]
  check(
    closedGroup?.name === CLOSED_GROUP,
    `已清仓作为表尾单独一组（组名「${CLOSED_GROUP}」）`,
    `末组为「${closedGroup?.name}」`
  )
  check(after.groups.length > 1 && after.toggleActive, '开关打开后处于激活态')
  check(
    closedGroup?.headMarketValue === '—',
    '已清仓组头「大类市值」显示「—」（无在持份额即无市值口径）',
    `实为「${closedGroup?.headMarketValue}」`
  )

  const closedCodes = (closedGroup?.rows ?? []).map((r) => r.code)
  check(
    JSON.stringify(closedCodes) === JSON.stringify([...closedFunds].sort()),
    '组内正是库里已清仓的基金（按代码升序）',
    `表内 [${closedCodes.join(', ')}] vs 库中 [${[...closedFunds].sort().join(', ')}]`
  )
  check(
    (closedGroup?.rowSpan ?? 0) === closedCodes.length,
    '两个合并列 rowSpan 覆盖整组',
    `rowSpan ${closedGroup?.rowSpan} vs ${closedCodes.length} 行`
  )

  const afterCodes = after.groups.flatMap((g) => g.rows.map((r) => r.code))
  check(
    afterCodes.length === heldFunds.length + closedFunds.length,
    '开关打开后行数 = 在持 + 已清仓（没有凭空多出从未建仓的基金）',
    `${afterCodes.length} 行 vs ${heldFunds.length + closedFunds.length}`
  )
  // 份额 ≤ 0（0 = 清仓归零，负 = 超卖数据错误）都在此组，故断言上界而不是等号
  const positiveRows = (closedGroup?.rows ?? []).filter((r) => !(num(r.shares) <= 0))
  check(
    positiveRows.length === 0,
    '已清仓行份额 ≤ 0',
    positiveRows.map((r) => `${r.code}=${r.shares}`).join(', ')
  )

  // ---- 7. 已清仓行仍点得进基金详情 ----------------------------------------
  const opened = await evalJs(`(() => {
    const card = [...document.querySelectorAll('.card')].find(
      (c) => c.querySelector('h2')?.textContent === '持仓明细'
    )
    const last = card.querySelector('table.table tbody:last-child')
    const link = last?.querySelector('tr .fund-link')
    if (!link) return null
    const tr = link.closest('tr')
    const code = tr.children[tr.children.length - 10]?.textContent?.trim() ?? ''
    link.click()
    return code
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  const modalTitle = await evalJs(`document.querySelector('.modal-head h2')?.textContent?.trim() ?? ''`)
  check(
    modalTitle.includes(opened) && opened.length > 0,
    '已清仓行点基金名称可进基金详情',
    `详情标题「${modalTitle}」`
  )
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(tmpdir(), 'porti-zero-holding-detail.png'), Buffer.from(shot2.data, 'base64'))
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true`)
  await new Promise((r) => setTimeout(r, 300))
  const closedAfter = await evalJs(`document.querySelector('.modal-overlay') === null`)
  check(closedAfter === true, 'Esc 可关闭基金详情')
}

// ---- 8. 大类配置对比：清空的大类不再凭空占比例 -----------------------------
const comparison = await evalJs(READ_COMPARISON)
if (comparison.error) {
  check(false, '找得到大类配置对比表', comparison.error)
} else {
  const cmp = new Map(comparison.rows.map((r) => [r.category, r]))
  const badRatio = []
  const badDeviation = []
  for (const cat of clearedCats) {
    const row = cmp.get(cat)
    if (!row) {
      badRatio.push(`「${cat}」缺行`)
      continue
    }
    if (num(row.investedRatio) !== 0) badRatio.push(`「${cat}」实际投入比例 ${row.investedRatio}`)
    if (row.deviation !== '—') badDeviation.push(`「${cat}」偏离 ${row.deviation}`)
  }
  check(
    badRatio.length === 0,
    clearedCats.length > 0 ? '已清空大类的「实际投入比例」记 0' : '（无已清空大类，跳过）',
    badRatio.join('; ')
  )
  check(
    badDeviation.length === 0,
    clearedCats.length > 0 ? '已清空大类的「偏离」显示「—」' : '（无已清空大类，跳过）',
    badDeviation.join('; ')
  )
  const heldBad = comparison.rows
    .filter((r) => heldCats.has(r.category))
    .filter((r) => r.deviation === '—')
  check(heldBad.length === 0, '仍有市值的大类偏离仍是数字（不是「—」）', heldBad.map((r) => r.category).join(', '))

  // 交叉验证分母：已清空大类在表里记 0，且在持大类的投入比例总和为 100%
  const heldRatioSum = comparison.rows
    .filter((r) => heldCats.has(r.category))
    .reduce((s, r) => s + (num(r.investedRatio) ?? 0), 0)
  check(Math.abs(heldRatioSum - 100) < 0.05, '在持大类的投入比例合计 = 100%', `${heldRatioSum.toFixed(2)}%`)
  for (const r of comparison.rows) {
    console.log(
      `  「${r.category}」投入 ${r.investedRatio} / 市值 ${r.marketRatio} / 偏离 ${r.deviation}`
    )
  }
}

// ---- 9. 截图与收尾 ---------------------------------------------------------
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-zero-holding-cleanup.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

for (const l of logs) console.error(`  console: ${l}`)

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
console.log(`GREEN: 清仓收尾全部断言通过（console 消息 ${logs.length} 条）`)
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
