#!/usr/bin/env node
// 汇总卡片口径切换端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch）
//
// 用法：node scripts/check-summary-scope-toggle.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron -> CDP 断言
// 断言范围（spec #2「渲染层」与 ticket #5）：
//   1. 概览页与流水页都有 .scope-switch；首次启动（全新 profile）默认「在持基金」；
//   2. 点击与键盘 Enter / Space 都能切换；六张卡的显示值与
//      window.api.overviewData()/txData() 的 summary[scope] 逐值一致；
//   3. 第二行恒等式：持仓盈亏 + 已实现盈亏 = 总收益（用卡片显示值手算）；
//   4. 切页后口径保持（localStorage 键 porti.summaryScope），两页联动；
//   5. 切到「全部基金」后重启（同一临时 profile）选择仍在；切回「在持基金」再重启，
//      反向持久化也成立；
//   6. 全部基金口径的数字与 summary.all 一致（回归保护）。
//
// 隐私：本脚本只打印标签与「是否一致」，绝不回显真实持仓金额。
//
// 退出码：0 = 通过（含 SKIP：库中无数据，卡片区不渲染）；1 = RED。
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

/** 与 src/renderer/src/hooks/useSummaryScope.ts 的 STORAGE_KEY 保持一致 */
const STORAGE_KEY = 'porti.summaryScope'
/** 分段控件顺序与文案（与 SummaryCards 的 SCOPE_LABEL 一致） */
const SCOPE_LABELS = { all: '全部基金', held: '在持基金' }

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const failures = []
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 显示值 -> 数值（'—' / 空 / 含千分位 / 带 % 都能吃） */
function num(text) {
  const t = (text ?? '').trim()
  if (t === '' || t === '—') return null
  return Number(t.replace(/,/g, '').replace('%', ''))
}

/** 金额/百分比按界面精度（2 位小数）比较，容差半位 */
const sameShown = (shown, want, kind) => {
  const shownNum = num(shown)
  if (want === null || want === undefined) return shown === '—'
  if (shownNum === null || !Number.isFinite(shownNum)) return false
  return Math.abs(shownNum - (kind === 'percent' ? want * 100 : want)) <= 0.005
}

/** 口径化汇总是否逐值一致（两个数据入口对照用；不打印数值） */
function sameScopedSummary(a, b) {
  if (!a || !b) return false
  const keys = ['totalNetCost', 'totalAssets', 'totalPnl', 'totalReturnRate', 'realizedIncome', 'totalReturn']
  for (const k of keys) {
    if (!Object.is(a.totals[k], b.totals[k])) return false
  }
  return Object.is(a.annualized, b.annualized)
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-summary-scope-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (existsSync(join(realDbDir, 'porti.db'))) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，断言将 SKIP')
}

// ---- 3. 启动 / 重启 / CDP 会话 --------------------------------------------
let electron = null
let ws = null
let send = null
let evalJs = null
let evalAsync = null
let logs = []

const waitFor = async (fn, ms, step = 250) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  return null
}

async function launchAndConnect() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(
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

  const pageTarget = await waitFor(
    () =>
      fetch(`${CDP}/json/list`)
        .then((r) => r.json())
        .then((ts) => ts.find((t) => t.type === 'page' && t.url.includes('index.html')))
        .catch(() => null),
    20000
  )
  if (!pageTarget) throw new Error('Electron 启动超时，未发现页面 target')

  ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  const pending = new Map()
  let msgId = 0
  logs = []
  send = (method, params = {}) => {
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
      const { resolve: res, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : res(m.result)
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

  evalJs = async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
    return result.value
  }
  evalAsync = async (expression) => {
    const { result } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    return result.value
  }

  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 1200))

  // 主进程启动时会自动抓取最新净值并写库（autoFetchNavs，不阻塞启动）。
  // 若卡片先按旧数据渲染、随后模型查询读到抓取后的新数据，就会产生假 RED；
  // 先等抓取落定（ok/failed 都是终态），再重新加载，让卡片与模型基于同一份库。
  const settled = await waitFor(async () => {
    try {
      const status = await evalAsync('window.api.navFetchStatus()')
      return status !== null && status.state !== 'running' && status.state !== 'idle'
    } catch {
      return false
    }
  }, 30000)
  if (!settled) console.log('提示：等待启动净值抓取落定超时，继续断言')
  await send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 1200))

  // 等首屏数据到达（卡片区渲染的前提）
  const cardReady = await waitFor(() => evalJs(`document.querySelector('.summary-card') !== null`), 15000)
  return cardReady === true
}

async function killElectron() {
  if (electron === null) return
  const p = electron
  electron = null
  try {
    ws?.close()
  } catch {}
  ws = null
  send = null
  const exited = new Promise((res) => p.once('exit', res))
  try {
    p.kill('SIGTERM')
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
  if (p.exitCode === null) {
    try {
      p.kill('SIGKILL')
    } catch {}
    await exited
  }
}

// ---- 4. 页面读取小工具 ------------------------------------------------------

/** 读分段控件状态 + localStorage + 六张卡显示值（返回文本仅用于比对，不打印） */
const READ_SCOPE = `(() => {
  const card = document.querySelector('.summary-card')
  if (!card) return { error: 'no-card' }
  const labelText = (el) => {
    const clone = el.cloneNode(true)
    clone.querySelectorAll('.hint-mark').forEach((m) => m.remove())
    return clone.textContent.trim()
  }
  return {
    switchExists: card.querySelector('.scope-switch') !== null,
    buttons: [...card.querySelectorAll('.scope-switch-btn')].map((b) => ({
      label: b.textContent.trim(),
      pressed: b.getAttribute('aria-pressed')
    })),
    stored: (() => {
      try {
        return window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
      } catch {
        return 'ERR'
      }
    })(),
    stats: [...card.querySelectorAll('.stat')].map((s) => ({
      label: labelText(s.querySelector('.stat-label') ?? s),
      value: s.querySelector('.stat-value')?.textContent?.trim() ?? ''
    })),
    rows: [...card.querySelectorAll('.stat-row')].map((row) => ({
      stats: [...row.querySelectorAll('.stat')].map((s) => labelText(s.querySelector('.stat-label') ?? s)),
      ops: [...row.querySelectorAll('.stat-op')].map((e) => e.textContent.trim())
    }))
  }
})()`

const readScope = () => evalJs(READ_SCOPE)

/** 断言当前选中口径、localStorage 值；只打印口径名，不打印金额。
 *  storedExpected 缺省等于 expected；首次启动尚未写入时为 null（默认值来自代码）。 */
function checkScopeState(state, expected, where, storedExpected = expected) {
  if (!state || state.error) {
    check(false, `${where}存在汇总卡片`, state?.error ?? 'evaluate 返回空')
    return
  }
  const pressedOf = (label) => state.buttons.find((b) => b.label === label)?.pressed ?? null
  const heldPressed = pressedOf(SCOPE_LABELS.held)
  const allPressed = pressedOf(SCOPE_LABELS.all)
  const wantHeld = expected === 'held' ? 'true' : 'false'
  const wantAll = expected === 'all' ? 'true' : 'false'
  check(
    heldPressed === wantHeld && allPressed === wantAll,
    `${where}选中「${SCOPE_LABELS[expected]}」（aria-pressed）`,
    `实际 在持=${heldPressed} / 全部=${allPressed}`
  )
  check(
    state.stored === storedExpected,
    `${where} localStorage ${STORAGE_KEY} = ${storedExpected === null ? '（未写入）' : storedExpected}`,
    `实际 ${state.stored === null ? '（未写入）' : state.stored}`
  )
}

/** 六张卡的显示值 vs 指定口径的模型值（逐值；不再回显数值） */
function checkCardsAgainstModel(state, scoped, scope, where) {
  if (!scoped || !scoped.totals) {
    check(false, `${where}模型含 summary.${scope}`)
    return
  }
  const expectations = [
    ['总资产', scoped.totals.totalAssets, 'money'],
    ['总收益', scoped.totals.totalReturn, 'money'],
    ['累计收益率', scoped.totals.totalReturnRate, 'percent'],
    ['年化收益率', scoped.annualized, 'percent'],
    ['持仓盈亏', scoped.totals.totalPnl, 'money'],
    ['已实现盈亏', scoped.totals.realizedIncome, 'money']
  ]
  const mismatched = []
  for (const [label, want, kind] of expectations) {
    const stat = state.stats.find((s) => s.label === label)
    const ok = stat !== undefined && sameShown(stat.value, want ?? null, kind)
    check(
      ok,
      `${where}「${label}」显示值与 summary.${scope} 一致`,
      ok ? '' : '显示值与模型不一致（按隐私约定不回显数值）'
    )
    if (!ok) mismatched.push(label)
  }
  return mismatched
}

/** 第二行恒等式：持仓盈亏 + 已实现盈亏 = 总收益（用显示值手算） */
function checkIdentity(state, where) {
  const valueOf = (label) => num(state.stats.find((s) => s.label === label)?.value ?? '')
  const pnl = valueOf('持仓盈亏')
  const realized = valueOf('已实现盈亏')
  const total = valueOf('总收益')
  // 三个显示值各 ±0.005，最大舍入差 0.015；0.02 只放过舍入噪声
  check(
    pnl !== null && realized !== null && total !== null && Math.abs(total - (pnl + realized)) <= 0.02,
    `${where}第二行恒等式成立：持仓盈亏 + 已实现盈亏 = 总收益`,
    pnl === null || realized === null || total === null ? '存在「—」，无法手算' : '显示值手算通过'
  )
}

/** 按侧栏文案切页，等目标页标题与卡片区就绪 */
async function goto(label) {
  const clicked = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find(
      (b) => b.textContent.trim() === ${JSON.stringify(label)}
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) throw new Error(`侧栏未找到「${label}」`)
  const pageReady = await waitFor(
    () => evalJs(`document.querySelector('h1')?.textContent?.trim() === ${JSON.stringify(label)}`),
    10000
  )
  if (!pageReady) throw new Error(`切页后未出现「${label}」标题`)
  const cardReady = await waitFor(() => evalJs(`document.querySelector('.summary-card') !== null`), 10000)
  if (!cardReady) throw new Error(`「${label}」页未出现汇总卡片`)
  await new Promise((r) => setTimeout(r, 350))
}

/** 点击某个口径按钮并等 React 重渲染 */
async function clickScope(scope) {
  const clicked = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.scope-switch-btn')].find(
      (b) => b.textContent.trim() === ${JSON.stringify(SCOPE_LABELS[scope])}
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) throw new Error(`未找到口径按钮「${SCOPE_LABELS[scope]}」`)
  await new Promise((r) => setTimeout(r, 400))
}

/** 聚焦口径按钮并用 CDP 发送一次真实键盘按键（Enter / Space） */
async function pressScopeKey(scope, key) {
  const focused = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.scope-switch-btn')].find(
      (b) => b.textContent.trim() === ${JSON.stringify(SCOPE_LABELS[scope])}
    )
    if (!btn) return false
    btn.focus()
    return document.activeElement === btn
  })()`)
  if (!focused) throw new Error(`无法聚焦口径按钮「${SCOPE_LABELS[scope]}」`)
  const isSpace = key === ' '
  const params = {
    key: isSpace ? ' ' : 'Enter',
    code: isSpace ? 'Space' : 'Enter',
    text: isSpace ? ' ' : '\r',
    unmodifiedText: isSpace ? ' ' : '\r',
    windowsVirtualKeyCode: isSpace ? 32 : 13,
    nativeVirtualKeyCode: isSpace ? 32 : 13
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await new Promise((r) => setTimeout(r, 400))
}

const shot = async (tag) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(tmpdir(), `porti-summary-scope-${tag}.png`) // 放 profile 外，cleanup 不删
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  return p
}

// ---- 5. 首次启动：默认在持基金 ---------------------------------------------
let ready = false
try {
  ready = await launchAndConnect()
} catch (e) {
  console.error(`RED: ${e.message}`)
  await cleanup()
  process.exit(1)
}
if (!ready) {
  console.log('SKIP: 概览页无汇总卡片（库中无数据），无法断言口径切换。')
  await cleanup()
  process.exit(0)
}

console.log('— 首次启动（全新 profile）—')
{
  const state = await readScope()
  check(state?.switchExists === true, '概览页存在分段控件 .scope-switch')
  const labels = (state?.buttons ?? []).map((b) => b.label)
  check(
    JSON.stringify(labels) === JSON.stringify([SCOPE_LABELS.all, SCOPE_LABELS.held]),
    '分段控件为「全部基金 / 在持基金」两个按钮',
    `实际 ${labels.join(' / ')}`
  )
  // 首次启动：选中「在持基金」，但 localStorage 尚未写入（默认值来自代码而非残留）
  checkScopeState(state, 'held', '首次启动概览页', null)

  const overviewModel = await evalAsync('window.api.overviewData()')
  const txModel = await evalAsync('window.api.txData()')
  check(overviewModel?.summary?.held != null, 'overviewData() 返回 summary.held')
  check(overviewModel?.summary?.all != null, 'overviewData() 返回 summary.all')
  check(
    sameScopedSummary(overviewModel?.summary?.all, txModel?.summary?.all),
    '两个数据入口的 summary.all 逐值一致（回归保护）'
  )
  check(
    sameScopedSummary(overviewModel?.summary?.held, txModel?.summary?.held),
    '两个数据入口的 summary.held 逐值一致'
  )

  checkCardsAgainstModel(state, overviewModel?.summary?.held, 'held', '概览页·在持口径')
  checkIdentity(state, '概览页·在持口径')
}

// ---- 6. 点击切到全部基金：六卡与 summary.all 逐值一致 -----------------------
console.log('— 点击切换到「全部基金」—')
{
  await clickScope('all')
  const state = await readScope()
  checkScopeState(state, 'all', '概览页点击后')
  const model = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(state, model?.summary?.all, 'all', '概览页·全部基金口径')
  checkIdentity(state, '概览页·全部基金口径')
}

// ---- 7. 切到流水页：口径保持；键盘 Space 切回在持 ---------------------------
console.log('— 交易流水页：口径联动与键盘切换 —')
{
  await goto('交易流水')
  const linked = await readScope()
  check(linked?.switchExists === true, '交易流水页存在分段控件 .scope-switch')
  checkScopeState(linked, 'all', '切页后交易流水页')

  const txAll = await evalAsync('window.api.txData()')
  checkCardsAgainstModel(linked, txAll?.summary?.all, 'all', '流水页·全部基金口径')
  checkIdentity(linked, '流水页·全部基金口径')

  // 键盘 Space：切回「在持基金」
  await pressScopeKey('held', ' ')
  const afterSpace = await readScope()
  checkScopeState(afterSpace, 'held', '流水页 Space 键切换后')
  const txHeld = await evalAsync('window.api.txData()')
  checkCardsAgainstModel(afterSpace, txHeld?.summary?.held, 'held', '流水页·在持口径')
  checkIdentity(afterSpace, '流水页·在持口径')
}

// ---- 8. 切回概览：在持口径联动；键盘 Enter 切到全部 -------------------------
console.log('— 概览页：反向联动与 Enter 键切换 —')
{
  await goto('概览')
  const linked = await readScope()
  checkScopeState(linked, 'held', '切回概览页后')
  const overviewHeld = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(linked, overviewHeld?.summary?.held, 'held', '概览页·在持口径（联动）')
  checkIdentity(linked, '概览页·在持口径（联动）')

  await pressScopeKey('all', 'Enter')
  const afterEnter = await readScope()
  checkScopeState(afterEnter, 'all', '概览页 Enter 键切换后')
  const overviewAll = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(afterEnter, overviewAll?.summary?.all, 'all', '概览页·全部基金口径（Enter）')
  checkIdentity(afterEnter, '概览页·全部基金口径（Enter）')
  await shot('overview-all')
}

// ---- 9. 重启 #1：全部基金选择保留 ------------------------------------------
console.log('— 重启 #1：全部基金口径持久化 —')
try {
  await killElectron()
  const readyAgain = await launchAndConnect()
  if (!readyAgain) throw new Error('重启后汇总卡片未出现')
  const state = await readScope()
  checkScopeState(state, 'all', '重启 #1 后概览页')
  const model = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(state, model?.summary?.all, 'all', '重启 #1 后概览页·全部基金口径')
  checkIdentity(state, '重启 #1 后概览页·全部基金口径')

  // 切回在持，供下一次重启验证反向持久化
  await clickScope('held')
  const held = await readScope()
  checkScopeState(held, 'held', '重启 #1 后点击切回在持')
  const heldModel = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(held, heldModel?.summary?.held, 'held', '重启 #1 后概览页·在持口径')
  checkIdentity(held, '重启 #1 后概览页·在持口径')
} catch (e) {
  check(false, '重启 #1 流程完成', e.message)
}

// ---- 10. 重启 #2：在持基金选择保留（反向持久化）-----------------------------
console.log('— 重启 #2：在持基金口径持久化 —')
try {
  await killElectron()
  const readyAgain = await launchAndConnect()
  if (!readyAgain) throw new Error('重启后汇总卡片未出现')
  const state = await readScope()
  checkScopeState(state, 'held', '重启 #2 后概览页')
  const model = await evalAsync('window.api.overviewData()')
  checkCardsAgainstModel(state, model?.summary?.held, 'held', '重启 #2 后概览页·在持口径')
  checkIdentity(state, '重启 #2 后概览页·在持口径')
  await shot('overview-held-restart')
} catch (e) {
  check(false, '重启 #2 流程完成', e.message)
}

// ---- 11. 收尾 ---------------------------------------------------------------
// 渲染层 console 只报条数：避免任何日志意外带出真实金额
if (logs.length > 0) console.error(`  console 消息 ${logs.length} 条（按隐私约定不回显内容）`)
if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  await cleanup()
  process.exit(1)
}
console.log('GREEN: 汇总卡片口径切换全部断言通过（默认在持 / 点击与键盘切换 / 六卡逐值 / 恒等式 / 两页联动 / 重启持久化）')
await cleanup()
process.exit(0)

async function cleanup() {
  try {
    ws?.close()
  } catch {}
  await killElectron()
  rmSync(profileDir, { recursive: true, force: true })
}
