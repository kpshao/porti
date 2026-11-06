#!/usr/bin/env node
// 持仓明细「大类汇总」组级指标端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3）
//
// 用法：node scripts/check-category-summary.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron ->
//       等启动自动抓取净值结束 -> 刷新页面 -> CDP 断言。断言口径见 spec #7。
//
// 断言：
//   1. 默认窗口下持仓明细表无横向滚动，表头第二列为「大类汇总」；
//   2. 每个在持大类组汇总格三行齐全（市值主行 + 「盈亏」+「年化」），子行不折行；
//   3. 组盈亏比例 = 库内独立重算的 Σ持仓盈亏 ÷ Σ持仓成本（按显示精度留容差）；
//   4. 组年化 = 库内独立重算的 XIRR（或两侧同为「—」）；
//   5. 打开「显示已清仓」后，表尾「已清仓」组汇总格只显示单个「—」，在持组数字不变；
//   6. 控制台无异常。
//
// 独立事实来源：系统 sqlite3 直读库副本，脚本内独立重算成本基础与 XIRR，不复用 src/engine。
// 隐私：公开仓库，脚本只打印组名、百分比一致性与计数，绝不回显真实持仓金额。
//
// 退出码：0 = 通过（含 SKIP：无在持持仓）；1 = RED。
//
// 已知陷阱：本机 shell 可能导出 ELECTRON_RUN_AS_NODE=1，spawn 前必须 delete，
// 否则 Electron 退化为纯 Node（--remote-debugging-port 失效、页面永远起不来）；
// 窗口遮挡会节流 rAF，启动参数带三个 --disable-* 旗标。
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
/** 与 src/engine/compute.ts 的 CLOSED_CATEGORY 保持一致 */
const CLOSED_GROUP = '已清仓'

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

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

/** 百分比按显示精度（2 位小数）比较：半位容差 + 浮点尾差 */
const samePercent = (shown, expected) => {
  if (expected === null) return (shown ?? '').trim() === '—'
  const n = num(shown)
  return n !== null && Number.isFinite(n) && Math.abs(n - expected * 100) <= 0.005 + 1e-9
}

/** 本地时区今日 YYYY-MM-DD（与主进程 todayString 同口径） */
function todayLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 两个 YYYY-MM-DD 日期的天数差（b − a） */
function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
  return (db - da) / 86400000
}

/** 组级 XIRR：现金流取组内基金全部流水、期末估值 = 组内当前市值。
 *  守卫与引擎一致：无流水、首笔流水不足 30 天、净投入 ≤ 0、无解 → null。 */
function xirrOfGroup(transactions, codes, terminalValue, today) {
  const scoped = transactions.filter((t) => codes.has(t.fundCode))
  if (scoped.length === 0) return null
  let firstTxDate = scoped[0].date
  for (const t of scoped) if (t.date < firstTxDate) firstTxDate = t.date
  if (daysBetween(firstTxDate, today) < 30) return null

  const flows = []
  let netCost = 0
  for (const t of scoped) {
    if (t.type === '买入' || t.type === '卖出') {
      flows.push({ date: t.date, amount: -t.amount })
      netCost += t.amount
    } else if (t.type === '分红现金') {
      flows.push({ date: t.date, amount: t.amount })
    }
  }
  if (netCost <= 0 || flows.length === 0) return null
  if (flows.every((f) => f.amount === 0) && terminalValue === 0) return null

  let firstDate = flows[0].date
  for (const f of flows) if (f.date < firstDate) firstDate = f.date
  if (daysBetween(firstDate, today) < 0) return null
  const npv = (r) => {
    let sum = 0
    for (const f of flows) sum += f.amount * Math.pow(1 + r, -daysBetween(firstDate, f.date) / 365)
    return sum + terminalValue * Math.pow(1 + r, -daysBetween(firstDate, today) / 365)
  }
  // 与引擎一致的扫描起点选择：跳过折现溢出的负利率端点
  const candidates = [-0.9999, -0.999, -0.99, -0.9, -0.5, -0.1]
  const startLo = candidates.find((r) => Number.isFinite(npv(r)))
  if (startLo === undefined) return null
  let lo = startLo
  let flo = npv(lo)
  if (flo === 0) return lo
  let hi = 1
  let fhi = npv(hi)
  while (fhi * flo > 0) {
    hi *= 2
    if (hi > 1e9) return null
    fhi = npv(hi)
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fmid = npv(mid)
    if (fmid === 0 || hi - lo < 1e-9) return mid
    if (flo * fmid < 0) {
      hi = mid
      fhi = fmid
    } else {
      lo = mid
      flo = fmid
    }
  }
  return (lo + hi) / 2
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (!existsSync(join(realDbDir, 'porti.db'))) {
  console.log('SKIP: 未找到真实数据库，无法用库内独立重算交叉验证组级指标。')
  process.exit(0)
}
const profileDir = mkdtempSync(join(tmpdir(), 'porti-category-summary-check-'))
const dbPath = join(profileDir, 'porti.db')
for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
  const src = join(realDbDir, name)
  if (existsSync(src)) cpSync(src, join(profileDir, name))
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
    const v = await fn().catch(() => null)
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
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
const pending = new Map()
const logs = []
const exceptions = []
const consoleErrors = []
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
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? 'unknown')
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ') ?? ''
    logs.push(text.slice(0, 300))
    if (m.params.type === 'error') consoleErrors.push(text.slice(0, 300))
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
/** 页面内执行 Promise 并等待结果 */
const evalAsync = async (expression) => {
  const { result } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  return result.value
}

/** 读持仓明细表：表头 / 每组汇总格（市值主行 + 两条子指标）/ 横向滚动状态 */
const READ_TABLE = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '持仓明细'
  )
  if (!card) return { error: 'no-card' }
  const table = card.querySelector('table.table')
  if (!table) return { error: 'no-table' }
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
  // 折行判定：用 Range 量单个文本行实际高度，超过 1.8 倍字号即认为折了行
  const textHeight = (el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getBoundingClientRect().height
  }
  const isWrapped = (el) => textHeight(el) > parseFloat(getComputedStyle(el).fontSize) * 1.8
  const groups = [...table.querySelectorAll('tbody')].map((tb) => {
    const first = tb.querySelector('tr')
    const summary = first?.children[1] ?? null
    const subs = summary ? [...summary.querySelectorAll('.group-summary-sub')] : []
    return {
      name: first?.children[0]?.textContent?.trim() ?? '',
      rowCount: tb.querySelectorAll('tr').length,
      mainText: summary?.querySelector('.group-summary-main')?.textContent?.trim() ?? null,
      summaryText: summary?.textContent?.trim() ?? '',
      subCount: subs.length,
      subs: subs.map((sub) => ({
        label: sub.querySelector('.group-summary-label')?.textContent?.trim() ?? '',
        value: sub.lastElementChild?.textContent?.trim() ?? '',
        wrapped: isWrapped(sub)
      }))
    }
  })
  const wrap = table.parentElement?.classList.contains('table-scroll-x') ? table.parentElement : null
  return {
    headers,
    groups,
    tableScroll:
      wrap === null
        ? null
        : { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth }
  }
})()`

const toggleClosed = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '持仓明细'
  )
  const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '显示已清仓')
  if (!btn) return false
  btn.click()
  return true
})()`

// 启动自动抓取净值会写库：等它结束再取库快照，随后刷新页面，保证 DOM 与快照同一份数据
const fetchSettled = await waitFor(async () => {
  const status = await evalAsync('window.api.navFetchStatus()')
  return status && status.state !== 'running' && status.state !== 'idle' ? status : null
}, 30000, 500)
if (fetchSettled === null) console.log('提示：启动自动抓取净值未在 30s 内结束，按当前库继续')

/** sqlite3 直读（重试以避开应用写库瞬间的锁） */
function sqliteRows(sql) {
  let lastErr = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const q = spawnSync('sqlite3', [dbPath, `PRAGMA busy_timeout=5000;\n${sql}`])
    if (q.status === 0) {
      return q.stdout.toString().split('\n').filter((line) => line !== '')
    }
    lastErr = q.stderr?.toString().trim() || '未知错误'
    spawnSync('sleep', ['0.3'])
  }
  throw new Error(lastErr)
}

// 独立事实来源：库内基金 / 流水 / 净值 → 成本基础、市值、组级盈亏比例与 XIRR
let expectedGroups
try {
  const funds = sqliteRows('SELECT code, category FROM funds').map((line) => {
    const [code, category] = line.split('|')
    return { code: code.trim(), category: (category ?? '').trim() }
  })
  const transactions = sqliteRows(
    'SELECT id, date, type, fund_code, amount, shares FROM transactions ORDER BY date, id'
  ).map((line) => {
    const [id, date, type, fundCode, amount, shares] = line.split('|')
    return {
      id: Number(id),
      date,
      type,
      fundCode,
      amount: Number(amount),
      shares: shares === undefined || shares === '' ? null : Number(shares)
    }
  })
  const navPoints = sqliteRows('SELECT fund_code, date, nav FROM nav_history').map((line) => {
    const [fundCode, date, nav] = line.split('|')
    return { fundCode, date, nav: Number(nav) }
  })

  // 每只基金的当前份额与持仓成本（移动加权平均，规则与引擎同口径）
  const states = new Map() // code -> { shares, costBasis }
  for (const t of transactions) {
    const st = states.get(t.fundCode) ?? { shares: 0, costBasis: 0 }
    if (t.type === '买入') {
      st.shares += t.shares ?? 0
      st.costBasis += t.amount
    } else if (t.type === '卖出') {
      const sold = -(t.shares ?? 0)
      const costConsumed = st.shares > 0 ? Math.min((st.costBasis * sold) / st.shares, st.costBasis) : 0
      st.shares -= sold
      st.costBasis = st.shares <= 0 ? 0 : st.costBasis - costConsumed
    } else if (t.type === '分红再投入') {
      st.shares += t.shares ?? 0
    }
    states.set(t.fundCode, st)
  }
  // 最新净值（引擎取全部净值记录里日期最大的一条）
  const latestNav = new Map()
  for (const p of navPoints) {
    const cur = latestNav.get(p.fundCode)
    if (cur === undefined || p.date > cur.date) latestNav.set(p.fundCode, p)
  }
  const positions = funds.map((f) => {
    const st = states.get(f.code) ?? { shares: 0, costBasis: 0 }
    const nav = latestNav.get(f.code) ?? null
    return {
      fundCode: f.code,
      category: f.category,
      shares: st.shares,
      costBasis: st.costBasis,
      marketValue: nav === null ? null : st.shares * nav.nav
    }
  })

  const today = todayLocal()
  const buckets = new Map()
  for (const p of positions) {
    if (!(p.shares > 0)) continue
    const name = CATEGORIES.includes(p.category) ? p.category : OTHER
    const bucket = buckets.get(name)
    if (bucket === undefined) buckets.set(name, [p])
    else bucket.push(p)
  }
  expectedGroups = []
  for (const name of [...CATEGORIES, OTHER]) {
    const rows = buckets.get(name)
    if (rows === undefined) continue
    rows.sort((a, b) => (a.fundCode < b.fundCode ? -1 : a.fundCode > b.fundCode ? 1 : 0))
    const allNavKnown = rows.every((p) => p.marketValue !== null)
    let pnlRatio = null
    if (allNavKnown) {
      let pnl = 0
      let costBasis = 0
      for (const p of rows) {
        pnl += (p.marketValue ?? 0) - p.costBasis
        costBasis += p.costBasis
      }
      pnlRatio = costBasis <= 0 ? null : pnl / costBasis
    }
    const annualized = allNavKnown
      ? xirrOfGroup(
          transactions,
          new Set(rows.map((p) => p.fundCode)),
          rows.reduce((sum, p) => sum + (p.marketValue ?? 0), 0),
          today
        )
      : null
    expectedGroups.push({ name, pnlRatio, annualized, rowCount: rows.length })
  }
} catch (e) {
  console.error(`RED: 读取库副本失败：${e.message}`)
  cleanup()
  process.exit(1)
}

// 刷新页面：确保 DOM 反映抓取结束后的库快照
await send('Page.reload', { ignoreCache: true })
const rendered = await waitFor(
  () =>
    evalJs(`(() => {
      const card = [...document.querySelectorAll('.card')].find(
        (c) => c.querySelector('h2')?.textContent === '持仓明细'
      )
      if (card?.querySelector('table.table')) return 'table'
      if (card) return 'empty-card'
      return document.querySelector('p.placeholder') ? 'no-data' : null
    })()`),
  20000,
  250
)
if (rendered === null) {
  console.error('RED: 刷新后概览页未渲染持仓明细或空数据占位')
  cleanup()
  process.exit(1)
}

const state = await evalJs(READ_TABLE)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-category-summary.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

if (expectedGroups.length === 0) {
  console.log('SKIP: 库中无在持持仓，无数据无法断言组级指标。')
  cleanup()
  process.exit(0)
}
if (state.error) {
  console.error(`RED: 未找到持仓明细表（${state.error}）`)
  cleanup()
  process.exit(1)
}

// ---- 5. 断言 --------------------------------------------------------------
console.log(
  `持仓明细：DOM ${state.groups.length} 组 / 库内重算 ${expectedGroups.length} 组（在持 ${expectedGroups.reduce((s, g) => s + g.rowCount, 0)} 只）`
)
console.log(
  `  库内重算：盈亏比例有值 ${expectedGroups.filter((g) => g.pnlRatio !== null).length} 组，` +
    `年化有值 ${expectedGroups.filter((g) => g.annualized !== null).length} 组（其余两侧应为「—」）`
)

check(
  state.headers.length === 11 && state.headers[1] === '大类汇总',
  '表头第二列为「大类汇总」',
  `实际 ${state.headers.join('/')}`
)

const scroll = state.tableScroll
check(scroll !== null, '持仓明细表有横向滚动容器', scroll === null ? '缺少 .table-scroll-x' : '')
check(
  scroll !== null && scroll.scrollWidth <= scroll.clientWidth + 1,
  '默认窗口下不产生横向滚动',
  scroll ? `${scroll.scrollWidth} vs ${scroll.clientWidth}` : ''
)

// 组集合与顺序：CATEGORIES 声明顺序，「其他」置底
const domNames = state.groups.map((g) => g.name)
const expectedNames = expectedGroups.map((g) => g.name)
check(
  JSON.stringify(domNames) === JSON.stringify(expectedNames),
  '组集合与顺序与库内重算一致',
  `DOM [${domNames.join(' → ')}] vs 库 [${expectedNames.join(' → ')}]`
)

const expectedByName = new Map(expectedGroups.map((g) => [g.name, g]))
const lineProblems = []
const metricProblems = []
const wrapProblems = []
for (const g of state.groups) {
  const want = expectedByName.get(g.name)
  if (want === undefined) continue // 组集合断言已覆盖
  if (g.mainText === null) lineProblems.push(`「${g.name}」缺市值主行`)
  if (g.subCount !== 2) lineProblems.push(`「${g.name}」子指标行 ${g.subCount} 条 ≠ 2`)
  const labels = g.subs.map((s) => s.label)
  if (JSON.stringify(labels) !== JSON.stringify(['盈亏', '年化'])) {
    lineProblems.push(`「${g.name}」子指标标签 [${labels.join(',')}] 应为 [盈亏,年化]`)
  }
  const [pnlSub, annualSub] = g.subs
  if (pnlSub === undefined || annualSub === undefined) {
    metricProblems.push(`「${g.name}」缺组级指标子行，无法比对`)
  }
  if (pnlSub && !samePercent(pnlSub.value, want.pnlRatio)) {
    metricProblems.push(
      `「${g.name}」盈亏比例显示 ${pnlSub.value} vs 库内重算 ${want.pnlRatio === null ? '—' : `${(want.pnlRatio * 100).toFixed(2)}%`}`
    )
  }
  if (annualSub && !samePercent(annualSub.value, want.annualized)) {
    metricProblems.push(
      `「${g.name}」年化显示 ${annualSub.value} vs 库内重算 ${want.annualized === null ? '—' : `${(want.annualized * 100).toFixed(2)}%`}`
    )
  }
  for (const sub of g.subs) {
    if (sub.wrapped) wrapProblems.push(`「${g.name}」${sub.label}行折行`)
  }
}
check(lineProblems.length === 0, '每个在持组汇总格三行齐全（市值 / 盈亏 / 年化）', lineProblems.join('; '))
check(wrapProblems.length === 0, '组汇总子行不折行', wrapProblems.join('; '))
check(
  metricProblems.length === 0,
  '组盈亏比例与组年化 = 库内独立重算（按显示精度留容差）',
  metricProblems.join('; ')
)

// ---- 6. 「显示已清仓」：表尾组只显示单个「—」，在持组数字不变 -----------------
const toggle = await evalJs(toggleClosed)
if (toggle !== true) {
  console.log('提示：库中无已清仓基金，跳过「显示已清仓」相关断言')
} else {
  await new Promise((r) => setTimeout(r, 500))
  const after = await evalJs(READ_TABLE)
  if (after.error) {
    check(false, '打开「显示已清仓」后仍能读表', after.error)
  } else {
    const closed = after.groups[after.groups.length - 1]
    check(
      closed?.name === CLOSED_GROUP,
      `已清仓作为表尾单独一组（组名「${CLOSED_GROUP}」）`,
      `末组为「${closed?.name}」`
    )
    check(
      closed?.summaryText === '—' && closed?.subCount === 0,
      '已清仓组汇总格只显示单个「—」（不渲染组级指标行）',
      `实为「${closed?.summaryText}」（子行 ${closed?.subCount} 条）`
    )
    // 已在持组的三行内容不因开关变化（已清仓基金不参与组级指标）
    const heldBefore = new Map(state.groups.map((g) => [g.name, g.summaryText]))
    const changed = after.groups
      .filter((g) => g.name !== CLOSED_GROUP)
      .filter((g) => heldBefore.get(g.name) !== g.summaryText)
      .map((g) => g.name)
    check(changed.length === 0, '打开「显示已清仓」后在持组汇总数字不变', changed.join(', '))
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(tmpdir(), 'porti-category-summary-closed.png'),
      Buffer.from(shot2.data, 'base64')
    )
  }
}

// ---- 7. 控制台 ------------------------------------------------------------
check(exceptions.length === 0, '控制台无渲染异常', `异常 ${exceptions.length} 条`)
check(consoleErrors.length === 0, '控制台无 error 级日志', `error ${consoleErrors.length} 条`)

if (logs.length > 0) console.log(`  console 消息 ${logs.length} 条（按隐私约定不回显内容）`)

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
for (const g of state.groups) {
  console.log(`  「${g.name}」${expectedByName.get(g.name)?.rowCount ?? '?'} 只：三行齐全，指标与库内重算一致`)
}
console.log('GREEN: 大类汇总组级指标全部断言通过')
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
