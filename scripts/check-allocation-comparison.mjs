#!/usr/bin/env node
// 三桶配置对比端到端检查（零依赖运行时：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3；
// better-sqlite3 仅用于构造合成夹具，不读取真实持仓）。
//
// 用法：node scripts/check-allocation-comparison.mjs [--port 9336]
//
// 流程：npm run build → 用合成 v6 库（最终三层模型，三桶目标）建临时 profile → 启动 Electron → CDP 断言。
//
// 断言：
//   1. 配置对比只有 稳健 / 权益 / 黄金 三行，黄金行常驻；表头四列口径不变；
//   2. 实际投入比例 / 实际市值占比 / 偏离与库内独立重算一致，三桶市值占比合计 100%；
//   3. 已清仓基金的净投入残留不进分子分母；缺净值的在持基金投入计入、市值按 0 计并提示；
//   4. 表下小字给出「直接权益 + 债类穿透」构成；
//   5. 初始三桶目标与偏离正确（无旧目标折算提示）；
//   6. 逐行编辑：合计非 100% 时警告、偏离按归一化目标；三桶全 0 时偏离显示「—」。
//
// 合成夹具（基金代码为不存在的 9xxxxx，避免启动自动抓取改写净值）：
//   A 债/固收+ 系数 20%，净投入 1000，市值 1200；
//   B 债/纯债 系数 0，净投入 1000，市值 1000；
//   C 权益/权益 系数 100%，净投入 1000，市值 1500；
//   D 黄金/黄金 系数 0，净投入 1000，市值 1000；
//   E 债/纯债 已清仓，净投入残留 300（不得进入比例分母）；
//   F 债/纯债 在持但缺净值，净投入 1000（投入计入、市值按 0）。
//   三桶目标 50/30/20 → 稳健 50%、权益 30%、黄金 20%。
//
// 退出码：0 = 通过；1 = RED。
//
// 已知陷阱：本机 shell 可能导出 ELECTRON_RUN_AS_NODE=1，spawn 前必须 delete；
// 窗口遮挡会节流 rAF，启动参数带三个 --disable-* 旗标。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9336'
const CDP = `http://127.0.0.1:${PORT}`

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const BUCKETS = ['稳健', '权益', '黄金']
const HEADERS = ['配置桶', '目标比例（%）', '实际投入比例', '实际市值占比', '偏离（市值占比 − 目标）']

const failures = []
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 显示值 -> 数值（'—' / 空 -> null；容忍千分位与百分号） */
function num(text) {
  const t = (text ?? '').trim()
  if (t === '' || t === '—') return null
  return Number(t.replace(/,/g, '').replace('%', ''))
}

/** 展示百分比（2 位小数）比较：半位容差 */
function samePercent(shown, expected) {
  if (expected === null) return shown === '—'
  const n = num(shown)
  return n !== null && Number.isFinite(n) && Math.abs(n - expected) <= 0.005 + 1e-9
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 合成夹具（v6：最终三层模型，无旧分类列与旧目标表）----
const profileDir = mkdtempSync(join(tmpdir(), 'porti-allocation-check-'))
const dbPath = join(profileDir, 'porti.db')
{
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE funds (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fund_type TEXT,
      ledger_category TEXT NOT NULL,
      product_form TEXT NOT NULL,
      equity_ratio REAL NOT NULL,
      equity_ratio_source TEXT NOT NULL,
      equity_ratio_as_of TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bucket_targets (
      bucket TEXT PRIMARY KEY,
      target_ratio REAL NOT NULL
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('买入','卖出','分红现金','分红再投入')),
      fund_code TEXT NOT NULL REFERENCES funds(code),
      amount REAL NOT NULL,
      shares REAL,
      nav REAL,
      fee REAL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE nav_history (
      fund_code TEXT NOT NULL REFERENCES funds(code),
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('import','auto','manual')),
      PRIMARY KEY (fund_code, date)
    );
  `)
  db.pragma('user_version = 6')
  const insertFund = db.prepare(
    `INSERT INTO funds (code, name, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES (?,?,?,?,?,?,'manual',NULL,'2026-01-01')`
  )
  insertFund.run('900001', '测试固收+', '二级债基', '债', '固收+', 0.2)
  insertFund.run('900002', '测试纯债', '一级债基', '债', '纯债', 0)
  insertFund.run('900003', '测试权益', '宽基指数', '权益', '权益', 1)
  insertFund.run('900004', '测试黄金', '黄金', '黄金', '黄金', 0)
  insertFund.run('900005', '测试已清仓', '一级债基', '债', '纯债', 0)
  insertFund.run('900006', '测试缺净值', '一级债基', '债', '纯债', 0)

  const insertTx = db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,NULL,'2026-01-02','2026-01-02')`
  )
  insertTx.run('2026-01-02', '买入', '900001', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '900002', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '900003', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '900004', 1000, 1000, 1)
  // 已清仓：买入 500，卖出回款 200、份额归零 → 净投入残留 300
  insertTx.run('2026-01-02', '买入', '900005', 500, 500, 1)
  insertTx.run('2026-01-03', '卖出', '900005', -200, -500, 0.4)
  insertTx.run('2026-01-02', '买入', '900006', 1000, 1000, 1)

  const insertNav = db.prepare('INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,\'manual\')')
  insertNav.run('900001', '2026-01-20', 1.2)
  insertNav.run('900002', '2026-01-20', 1)
  insertNav.run('900003', '2026-01-20', 1.5)
  insertNav.run('900004', '2026-01-20', 1)
  insertNav.run('900005', '2026-01-20', 0.4)
  // 900006 故意不写净值

  db.prepare(
    "INSERT INTO bucket_targets (bucket, target_ratio) VALUES ('稳健', 0.5), ('权益', 0.3), ('黄金', 0.2)"
  ).run()
  db.close()
}

// 独立事实来源：库内三桶重算（只统计在持基金；缺净值市值按 0 计）
const bucketFacts = (() => {
  const db = new Database(dbPath, { readonly: true })
  const rows = db
    .prepare(
      `SELECT f.code, f.ledger_category, f.equity_ratio,
              (SELECT COALESCE(SUM(CASE WHEN t.type IN ('买入','卖出') THEN t.amount ELSE 0 END), 0)
                 FROM transactions t WHERE t.fund_code = f.code) AS net_cost,
              (SELECT COALESCE(SUM(t.shares), 0) FROM transactions t WHERE t.fund_code = f.code) AS shares
       FROM funds f`
    )
    .all()
  const navs = new Map(
    db
      .prepare(
        `SELECT h.fund_code, h.nav FROM nav_history h
         JOIN (SELECT fund_code, MAX(date) AS d FROM nav_history GROUP BY fund_code) m
           ON h.fund_code = m.fund_code AND h.date = m.d`
      )
      .all()
      .map((r) => [r.fund_code, r.nav])
  )
  db.close()
  return rows.map((r) => ({ ...r, latestNav: navs.get(r.code) ?? null }))
})()

function expectedRatios() {
  const held = bucketFacts.filter((f) => f.shares > 0)
  const invested = { 稳健: 0, 权益: 0, 黄金: 0 }
  const market = { 稳健: 0, 权益: 0, 黄金: 0 }
  let totalNetCost = 0
  let totalMarket = 0
  let direct = 0
  let passthrough = 0
  let missingNav = 0
  for (const f of held) {
    const m = f.latestNav === null ? 0 : f.shares * f.latestNav
    if (f.latestNav === null) missingNav++
    totalNetCost += f.net_cost
    totalMarket += m
    const equityCost = f.net_cost * f.equity_ratio
    const equityMarket = m * f.equity_ratio
    if (f.ledger_category === '黄金') {
      invested['权益'] += equityCost
      invested['黄金'] += f.net_cost - equityCost
      market['权益'] += equityMarket
      market['黄金'] += m - equityMarket
    } else {
      invested['稳健'] += f.net_cost - equityCost
      invested['权益'] += equityCost
      market['稳健'] += m - equityMarket
      market['权益'] += equityMarket
    }
    if (f.ledger_category === '权益') direct += equityMarket
    if (f.ledger_category === '债') passthrough += equityMarket
  }
  const pct = (v, total) => (total === 0 ? null : (v / total) * 100)
  return {
    invested: Object.fromEntries(BUCKETS.map((b) => [b, pct(invested[b], totalNetCost)])),
    market: Object.fromEntries(BUCKETS.map((b) => [b, pct(market[b], totalMarket)])),
    direct: pct(direct, totalMarket),
    passthrough: pct(passthrough, totalMarket),
    missingNav
  }
}
const expected = expectedRatios()

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

let ws = null
let finished = false
function cleanup() {
  finished = true
  try {
    ws?.close()
  } catch {}
  try {
    electron.kill('SIGTERM')
  } catch {}
  rmSync(profileDir, { recursive: true, force: true })
}

process.on('exit', () => {
  if (!finished) {
    try {
      electron.kill('SIGKILL')
    } catch {}
    rmSync(profileDir, { recursive: true, force: true })
  }
})

const waitFor = async (fn, ms, step = 200) => {
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

// ---- 4. CDP 会话 ----------------------------------------------------------
ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
const pending = new Map()
const logs = []
let msgId = 0
function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolve: resolvePromise, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP 超时: ${method}`))
    }, 15000)
  })
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve: resolvePromise, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolvePromise(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown' || m.method === 'Runtime.consoleAPICalled') {
    const text =
      m.params.exceptionDetails?.exception?.description ??
      m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')
    logs.push(String(text).slice(0, 300))
  }
}
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
await send('Runtime.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })

/** 页面内执行并返回值 */
const evalJs = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.value
}

const READ_ALLOCATION = `(() => {
  const card = document.querySelector('.card-allocation')
  if (!card) return { error: 'no-card' }
  const table = card.querySelector('table.table')
  const warning = card.querySelector('.allocation-target-warning')
  return {
    heading: card.querySelector('h2')?.textContent?.trim() ?? '',
    headers: table ? [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : [],
    rows: table
      ? [...table.querySelectorAll('tbody tr')].map((tr) => ({
          bucket: tr.children[0]?.textContent?.trim() ?? '',
          targetInput: tr.children[1]?.querySelector('input')?.value ?? '',
          investedRatio: tr.children[2]?.textContent?.trim() ?? '',
          marketRatio: tr.children[3]?.textContent?.trim() ?? '',
          deviation: tr.children[4]?.textContent?.trim() ?? ''
        }))
      : [],
    warningText: warning?.textContent?.trim() ?? null,
    footnote: card.querySelector('p.muted')?.textContent?.trim() ?? ''
  }
})()`

const ready = await waitFor(async () => {
  const state = await evalJs(READ_ALLOCATION)
  return state.error === undefined ? state : null
}, 20000)
if (ready === null) {
  console.error('RED: 配置对比卡片未渲染')
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}

// ---- 5. 首次出现：三行、四列、初始目标与独立重算的比例 ----------------------
console.log('配置对比（首次出现，三桶目标来自库内）')
check(ready.heading === '配置对比', '卡片标题为「配置对比」', ready.heading)
check(JSON.stringify(ready.headers) === JSON.stringify(HEADERS), '表头为四列口径', ready.headers.join('/'))
check(
  JSON.stringify(ready.rows.map((r) => r.bucket)) === JSON.stringify(BUCKETS),
  '固定三行：稳健 / 权益 / 黄金（黄金行常驻）',
  ready.rows.map((r) => r.bucket).join(' → ')
)

const initialTargets = { 稳健: 50, 权益: 30, 黄金: 20 }
for (const r of ready.rows) {
  check(
    Math.abs(Number(r.targetInput) - initialTargets[r.bucket]) <= 0.005,
    `「${r.bucket}」目标来自库内三桶目标`,
    `${r.targetInput}% vs ${initialTargets[r.bucket].toFixed(2)}%`
  )
}
check(ready.warningText === null, '初始目标合计 100% 时不显示归一化警告', ready.warningText ?? '')

for (const r of ready.rows) {
  check(
    samePercent(r.investedRatio, expected.invested[r.bucket]),
    `「${r.bucket}」实际投入比例与库内独立重算一致（已清仓不参与）`,
    `${r.investedRatio} vs ${expected.invested[r.bucket].toFixed(2)}%`
  )
  check(
    samePercent(r.marketRatio, expected.market[r.bucket]),
    `「${r.bucket}」实际市值占比与库内独立重算一致`,
    `${r.marketRatio} vs ${expected.market[r.bucket].toFixed(2)}%`
  )
  const wantDeviation = expected.market[r.bucket] - initialTargets[r.bucket]
  check(
    samePercent(r.deviation.replace(/[↑↓超配低]/g, '').trim(), wantDeviation),
    `「${r.bucket}」偏离 = 市值占比 − 目标`,
    `${r.deviation} vs ${wantDeviation.toFixed(2)}%`
  )
}
const marketSum = ready.rows.reduce((s, r) => s + (num(r.marketRatio) ?? 0), 0)
check(Math.abs(marketSum - 100) < 0.02, '三桶实际市值占比合计 = 100%', `${marketSum.toFixed(2)}%`)
const investedSum = ready.rows.reduce((s, r) => s + (num(r.investedRatio) ?? 0), 0)
check(Math.abs(investedSum - 100) < 0.02, '三桶实际投入比例合计 = 100%', `${investedSum.toFixed(2)}%`)
check(
  ready.footnote.includes(`直接权益 ${expected.direct.toFixed(2)}%`) &&
    ready.footnote.includes(`债类穿透 ${expected.passthrough.toFixed(2)}%`),
  '表下小字给出直接权益与债类穿透的构成',
  `期望 ${expected.direct.toFixed(2)}% + ${expected.passthrough.toFixed(2)}%`
)
check(
  ready.footnote.includes('1 只在持基金缺最新净值') && ready.footnote.includes('市值按 0 计入'),
  '缺净值的在持基金保留提示且市值按 0 计',
  ready.footnote
)

// 首次出现状态截图（合成数据，无隐私）
await evalJs(`document.querySelector('.card-allocation')?.scrollIntoView({ block: 'start' }), true`)
await new Promise((r) => setTimeout(r, 300))
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-allocation-comparison.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

// ---- 7. 逐行编辑：合计非 100% 警告 + 归一化偏离 -----------------------------
/** 设置某一桶目标（百分比文本），失焦触发保存 */
const setTarget = (bucket, value) =>
  evalJs(`(() => {
    const tr = [...document.querySelectorAll('.card-allocation tbody tr')].find(
      (row) => row.children[0]?.textContent.trim() === ${JSON.stringify(bucket)}
    )
    const input = tr?.querySelector('input')
    if (!input) return false
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    return true
  })()`)

// 等待保存并重新加载完成：输入框在 reload 后按数据渲染为两位小数（如 "30.00"），
// 而编辑中的暂存文本是 "30"——用精确文本等待，避免把「刚输入」误判成「已保存」。
const waitTargets = (values) =>
  waitFor(async () => {
    const state = await evalJs(READ_ALLOCATION)
    if (state.error !== undefined) return null
    const map = new Map(state.rows.map((r) => [r.bucket, r.targetInput]))
    return Object.entries(values).every(([b, v]) => map.get(b) === v.toFixed(2)) ? state : null
  }, 10000)

check((await setTarget('稳健', '30')) === true, '编辑稳健目标为 30%')
const normalized = await waitTargets({ 稳健: 30 })
check(normalized !== null, '目标保存后重新加载（稳健 30.00%）')
if (normalized !== null) {
  const total = 30 + initialTargets['权益'] + initialTargets['黄金']
  check(
    normalized.warningText !== null &&
      normalized.warningText.includes(`目标合计 ${total.toFixed(2)}%`) &&
      normalized.warningText.includes('归一化'),
    '合计不等于 100% 时显示警告并说明按归一化目标计算偏离',
    normalized.warningText ?? '缺少警告'
  )
  const currentTargets = { 稳健: 30, 权益: initialTargets['权益'], 黄金: initialTargets['黄金'] }
  const normalizedTarget = (bucket) => (currentTargets[bucket] / total) * 100
  const robust = normalized.rows.find((r) => r.bucket === '稳健')
  const equity = normalized.rows.find((r) => r.bucket === '权益')
  check(
    samePercent(robust.deviation.replace(/[↑↓超配低]/g, '').trim(), expected.market['稳健'] - normalizedTarget('稳健')),
    '稳健偏离按归一化目标计算',
    robust.deviation
  )
  check(
    samePercent(equity.deviation.replace(/[↑↓超配低]/g, '').trim(), expected.market['权益'] - normalizedTarget('权益')),
    '权益偏离按归一化目标计算',
    equity.deviation
  )
}

// ---- 8. 三桶目标全 0：不再警告，偏离显示「—」，黄金行仍在 -------------------
await setTarget('稳健', '0')
await waitTargets({ 稳健: 0 })
await setTarget('权益', '0')
await waitTargets({ 权益: 0 })
await setTarget('黄金', '0')
const zeroed = await waitTargets({ 黄金: 0 })
check(zeroed !== null, '三桶目标均可逐行编辑为 0')
if (zeroed !== null) {
  check(zeroed.warningText === null, '目标合计为 0 时不显示合计警告', zeroed.warningText ?? '')
  check(
    zeroed.rows.every((r) => r.deviation === '—'),
    '目标合计为 0 视为未配置：偏离显示「—」，不伪造低配',
    zeroed.rows.map((r) => r.deviation).join(' / ')
  )
  check(
    JSON.stringify(zeroed.rows.map((r) => r.bucket)) === JSON.stringify(BUCKETS),
    '三桶目标全 0 时黄金行仍常驻',
    zeroed.rows.map((r) => r.bucket).join(' → ')
  )
  const db = new Database(dbPath, { readonly: true })
  const saved = db.prepare('SELECT COUNT(*) AS n FROM bucket_targets').get().n
  db.close()
  check(saved === 3, '全 0 目标照常落库（不会被误当作未初始化）', `${saved} 行`)
}

// ---- 9. 黄金持仓也归零：黄金行仍常驻 ---------------------------------------
// 通过库内补一笔卖出把黄金仓位清零（等价于用户卖出），再刷新页面读取最新数据。
{
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES ('2026-01-04','卖出','900004',-1000,-1000,1,0,NULL,'2026-01-04','2026-01-04')`
  ).run()
  db.close()
}
await send('Page.reload', { ignoreCache: true })
const goldClosed = await waitFor(async () => {
  const state = await evalJs(READ_ALLOCATION)
  if (state.error !== undefined) return null
  const gold = state.rows.find((r) => r.bucket === '黄金')
  return state.rows.length === 3 && gold?.marketRatio === '0.00%' ? state : null
}, 15000)
check(goldClosed !== null, '黄金持仓与目标都为 0 时黄金行仍常驻')
if (goldClosed !== null) {
  const gold = goldClosed.rows.find((r) => r.bucket === '黄金')
  check(gold?.targetInput === '0.00', '黄金目标仍为 0.00%', gold?.targetInput ?? '缺行')
  check(gold?.deviation === '—', '目标合计为 0 时黄金偏离为「—」', gold?.deviation ?? '缺行')
}

// ---- 10. 收尾 ---------------------------------------------------------------

// ---- 9. 收尾 ---------------------------------------------------------------
for (const l of logs) console.error(`  console: ${l}`)
cleanup()

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  process.exit(1)
}
console.log(`GREEN: 三桶配置对比全部断言通过（console 消息 ${logs.length} 条）`)
console.log(`截图: ${shotPath}`)
process.exit(0)
