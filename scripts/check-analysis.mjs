#!/usr/bin/env node
// 分析页集中度指标端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3）
//
// 用法：node scripts/check-analysis.mjs [--port 9337]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron ->
//       等启动自动抓取净值结束 -> 库内独立重算 -> 刷新页面 -> CDP 点侧边栏进入「分析」-> 断言。
//
// 断言（口径见 spec #16「页面与指标」与工单 #17）：
//   1. 侧边栏存在「分析」导航项，且位于「收益统计」与「设置」之间；
//   2. 指标卡片四项齐全：前三大占比、最大单只占比、HHI、有效持仓数；
//   3. 四项指标 = 库内独立重算（按显示精度留容差：占比 2 位 / HHI 3 位 / 有效持仓数 1 位）；
//   4. 等权基准 1/N 的百分比与 N 和库内重算一致；
//   5. 有缺净值的在持基金时，页面提示其数量；无缺净值时不显示提示；
//   6. 没有任何可估值在持基金时显示空状态；控制台无异常。
//
// 独立事实来源：系统 sqlite3 直读库副本，脚本内按 spec 公式独立重算，不复用 src/engine。
// 隐私：公开仓库，脚本只打印计数与一致性，绝不回显真实金额、份额或基金名。
//
// 退出码：0 = 通过（含 SKIP：无真实库或无在持持仓）；1 = RED。
//
// 已知陷阱：本机 shell 可能导出 ELECTRON_RUN_AS_NODE=1，spawn 前必须 delete，
// 否则 Electron 退化为纯 Node（--remote-debugging-port 失效、页面永远起不来）；
// 窗口遮挡会节流 rAF，启动参数带三个 --disable-* 旗标。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9337'
const CDP = `http://127.0.0.1:${PORT}`

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const failures = []
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 数值显示 -> 数值（'—' / 空 -> null；容忍千分位与百分号） */
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

/** 小数按显示精度（digits 位）比较：半位容差 + 浮点尾差 */
const sameFixed = (shown, expected, digits) => {
  if (expected === null) return (shown ?? '').trim() === '—'
  const n = num(shown)
  const tolerance = 0.5 * Math.pow(10, -digits) + 1e-9
  return n !== null && Number.isFinite(n) && Math.abs(n - expected) <= tolerance
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
  console.log('SKIP: 未找到真实数据库，无法用库内独立重算交叉验证集中度指标。')
  process.exit(0)
}
const profileDir = mkdtempSync(join(tmpdir(), 'porti-analysis-check-'))
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

// 独立事实来源：库内基金 / 流水份额 / 最新净值 → 按 spec 公式重算集中度指标
let expected
try {
  const fundCodes = sqliteRows('SELECT code FROM funds').map((line) => line.trim())
  const sharesByFund = new Map()
  for (const line of sqliteRows('SELECT fund_code, shares FROM transactions')) {
    const [fundCode, shares] = line.split('|')
    const value = shares === undefined || shares === '' ? 0 : Number(shares)
    sharesByFund.set(fundCode, (sharesByFund.get(fundCode) ?? 0) + value)
  }
  const latestNav = new Map()
  for (const line of sqliteRows('SELECT fund_code, date, nav FROM nav_history')) {
    const [fundCode, date, nav] = line.split('|')
    const cur = latestNav.get(fundCode)
    if (cur === undefined || date > cur.date) latestNav.set(fundCode, { date, nav: Number(nav) })
  }
  // 在持 = 份额 > 0；可估值 = 在持且有最新净值（marketValue 非空）
  const held = fundCodes
    .map((fundCode) => ({ fundCode, shares: sharesByFund.get(fundCode) ?? 0 }))
    .filter((p) => p.shares > 0)
  const valued = held
    .filter((p) => latestNav.has(p.fundCode))
    .map((p) => ({ ...p, marketValue: p.shares * latestNav.get(p.fundCode).nav }))
  const missingNavCount = held.length - valued.length
  const total = valued.reduce((s, p) => s + p.marketValue, 0)
  const weights =
    valued.length === 0 || total <= 0
      ? []
      : valued
          .map((p) => ({ fundCode: p.fundCode, weight: p.marketValue / total }))
          .sort((a, b) => b.weight - a.weight || (a.fundCode < b.fundCode ? -1 : a.fundCode > b.fundCode ? 1 : 0))
  const hhi = weights.reduce((s, w) => s + w.weight * w.weight, 0)
  expected = {
    heldCount: held.length,
    // 可估值只数语义：即使市值合计异常为 0（weights 为空）仍计入
    valuedCount: valued.length,
    missingNavCount,
    maxWeight: weights.length > 0 ? weights[0].weight : null,
    top3Weight:
      weights.length > 0 ? weights.slice(0, 3).reduce((s, w) => s + w.weight, 0) : null,
    hhi,
    effectiveHoldings: hhi > 0 ? 1 / hhi : null
  }
} catch (e) {
  console.error(`RED: 读取库副本失败：${e.message}`)
  cleanup()
  process.exit(1)
}

// 刷新页面：确保 DOM 反映抓取结束后的库快照
await send('Page.reload', { ignoreCache: true })
await waitFor(() => evalJs(`document.querySelectorAll('.nav-item').length > 0`), 20000, 250)

// ---- 5. 进入「分析」页 ------------------------------------------------------
const navLabels = await evalJs(
  `[...document.querySelectorAll('.nav-item')].map((b) => b.textContent.trim())`
)
const statsIdx = navLabels.indexOf('收益统计')
const analysisIdx = navLabels.indexOf('分析')
const settingsIdx = navLabels.indexOf('设置')
check(analysisIdx !== -1, '侧边栏存在「分析」导航项', `导航 [${navLabels.join(' → ')}]`)
check(
  statsIdx !== -1 && settingsIdx !== -1 && statsIdx < analysisIdx && analysisIdx < settingsIdx,
  '「分析」位于「收益统计」与「设置」之间',
  `位置 收益统计=${statsIdx} / 分析=${analysisIdx} / 设置=${settingsIdx}`
)

const clicked = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === '分析')
  if (!btn) return false
  btn.click()
  return true
})()`)
check(clicked === true, '可点击进入「分析」页')

const READ_STATE = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent.trim() === '集中度指标'
  )
  if (!card) {
    const empty = document.querySelector('.page p.placeholder')
    return { hasCard: false, emptyText: empty?.textContent?.trim() ?? null }
  }
  const metrics = {}
  for (const stat of card.querySelectorAll('.stat')) {
    const label = stat.querySelector('.stat-label')?.textContent?.trim() ?? ''
    const value = stat.querySelector('.stat-value')?.textContent?.trim() ?? ''
    metrics[label] = value
  }
  return {
    hasCard: true,
    metricLabels: [...card.querySelectorAll('.stat-label')].map((el) => el.textContent.trim()),
    metrics,
    baseline: card.querySelector('.equal-weight-baseline')?.textContent?.trim() ?? null,
    missingNav: card.querySelector('.analysis-missing-nav')?.textContent?.trim() ?? null
  }
})()`

const rendered = await waitFor(
  () =>
    evalJs(`(() => {
      const card = [...document.querySelectorAll('.card')].find(
        (c) => c.querySelector('h2')?.textContent.trim() === '集中度指标'
      )
      if (card) return 'card'
      return document.querySelector('.page p.placeholder') ? 'placeholder' : null
    })()`),
  10000,
  250
)
if (rendered === null) {
  console.error('RED: 「分析」页未渲染指标卡片或空状态')
  cleanup()
  process.exit(1)
}

const state = await evalJs(READ_STATE)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-analysis.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

console.log(
  `库内重算：在持 ${expected.heldCount} 只 / 可估值 ${expected.valuedCount} 只 / 缺净值 ${expected.missingNavCount} 只`
)

if (expected.heldCount === 0) {
  console.log('SKIP: 库中无在持持仓，无数据无法断言集中度指标。')
  cleanup()
  process.exit(0)
}

// 空态条件 = 无可估值在持基金（expected.valuedCount 即 valued.length）；
// 可估值 > 0 但市值合计异常为 0 时仍落到卡片分支，与引擎同口径。
if (expected.valuedCount === 0) {
  // 有在持但全部缺最新净值：指标区应为空状态，缺净值数量明确提示
  check(state.hasCard === false, '无可估值在持基金时显示空状态（不渲染指标卡片）')
  check(state.emptyText !== null, '空状态有说明文案')
  if (expected.missingNavCount > 0) {
    check(
      state.emptyText !== null &&
        state.emptyText.includes(String(expected.missingNavCount)) &&
        state.emptyText.includes('缺最新净值'),
      '空状态说明缺净值的在持基金数量',
      `缺净值 ${expected.missingNavCount} 只`
    )
  }
} else {
  check(state.hasCard === true, '可估值在持基金存在时渲染「集中度指标」卡片')
  const EXPECTED_LABELS = ['前三大占比', '最大单只占比', 'HHI', '有效持仓数']
  check(
    JSON.stringify(state.metricLabels) === JSON.stringify(EXPECTED_LABELS),
    '指标卡片四项齐全且顺序固定',
    `实际 [${(state.metricLabels ?? []).join(',')}]`
  )

  const metricProblems = []
  if (!samePercent(state.metrics?.['前三大占比'], expected.top3Weight)) {
    metricProblems.push('前三大占比显示值与独立重算不一致')
  }
  if (!samePercent(state.metrics?.['最大单只占比'], expected.maxWeight)) {
    metricProblems.push('最大单只占比显示值与独立重算不一致')
  }
  if (!sameFixed(state.metrics?.['HHI'], expected.hhi, 3)) {
    metricProblems.push('HHI 显示值与独立重算不一致')
  }
  if (!sameFixed(state.metrics?.['有效持仓数'], expected.effectiveHoldings, 1)) {
    metricProblems.push('有效持仓数显示值与独立重算不一致')
  }
  check(
    metricProblems.length === 0,
    '四项指标 = 库内独立重算（按显示精度留容差）',
    metricProblems.join('; ')
  )

  // 等权基准 1/N：百分比（2 位小数）与 N 都要和库内重算一致
  const baseline = state.baseline ?? ''
  const match = /等权基准 1\/N = ([\d.]+)%（N = (\d+) 只可估值在持基金）/.exec(baseline)
  check(match !== null, '显示等权基准 1/N 与 N 的说明', match === null ? `文案「${baseline}」` : '')
  if (match !== null) {
    const shownN = Number(match[2])
    check(shownN === expected.valuedCount, '等权基准中的 N = 可估值在持基金数')
    check(
      Math.abs(Number(match[1]) - (100 / expected.valuedCount)) <= 0.005 + 1e-9,
      '等权基准 1/N 的百分比与库内重算一致'
    )
  }

  // 缺净值提示：有缺净值时必须出现且数量正确；无缺净值时不出现
  if (expected.missingNavCount > 0) {
    check(
      state.missingNav !== null && state.missingNav.includes(String(expected.missingNavCount)),
      '有缺净值在持基金时提示其数量',
      `缺净值 ${expected.missingNavCount} 只`
    )
  } else {
    check(state.missingNav === null, '无缺净值在持基金时不显示缺净值提示')
  }
}

// ---- 6. 控制台 ------------------------------------------------------------
check(exceptions.length === 0, '控制台无渲染异常', `异常 ${exceptions.length} 条`)
check(consoleErrors.length === 0, '控制台无 error 级日志', `error ${consoleErrors.length} 条`)

if (logs.length > 0) console.log(`  console 消息 ${logs.length} 条（按隐私约定不回显内容）`)

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
console.log('GREEN: 分析页集中度指标全部断言通过')
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
