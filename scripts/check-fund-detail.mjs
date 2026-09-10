#!/usr/bin/env node
// 基金详情（收益走势图）端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch，无需 Playwright）
//
// 用法：node scripts/check-fund-detail.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 带防节流旗标启动
// Electron -> CDP 概览页点第一个基金名称 -> 断言基金详情覆盖层（指标行/走势图
// canvas/口径与范围切换/Esc 关闭）。
//
// 退出码：0 = 通过（含 SKIP：无持仓数据或该基金无净值数据，无法断言）；1 = RED。
//
// 已知陷阱：窗口遮挡时 rAF 被节流，ECharts 不绘制 canvas，故必须带
// --disable-backgrounding-occluded-windows / --disable-renderer-backgrounding
// / --disable-background-timer-throttling 三个旗标，否则误判"图表空白"。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9333'
const CDP = `http://127.0.0.1:${PORT}`

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-detail-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
const hasRealData = existsSync(join(realDbDir, 'porti.db'))
if (hasRealData) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，详情断言将 SKIP')
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
    const text = m.params.exceptionDetails?.exception?.description ?? m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')
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

// 冷启动路径：概览页点第一个基金名称打开详情
const clicked = await evalJs(`(() => {
  const link = document.querySelector('.fund-link')
  if (!link) return false
  link.click()
  return true
})()`)
if (!clicked) {
  console.log('SKIP: 概览页无持仓行（无 .fund-link），无数据无法断言基金详情。')
  cleanup()
  process.exit(0)
}
await new Promise((r) => setTimeout(r, 2000))

const state = await evalJs(`(() => {
  const modal = document.querySelector('.modal-wide')
  const chart = modal?.querySelector('.chart')
  const canvas = chart?.querySelector('canvas')
  const empty = modal?.querySelector('.muted')?.textContent ?? null
  const stats = modal?.querySelectorAll('.detail-stats .stat').length ?? 0
  const buttons = [...(modal?.querySelectorAll('.detail-controls button') ?? [])].map((b) => b.textContent)
  return {
    modal: modal !== null,
    stats,
    buttons,
    chart: chart ? { box: { w: chart.offsetWidth, h: chart.offsetHeight }, canvas: canvas ? { w: canvas.width, h: canvas.height } : null } : null,
    empty
  }
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-fund-detail-check.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

if (!state.modal) {
  console.error('RED: 点击基金名称后未出现基金详情覆盖层')
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
console.log(`  覆盖层: 打开；指标卡 ${state.stats} 个；控制按钮: ${state.buttons.join(' / ')}`)
if (state.stats !== 6) {
  console.error(`RED: 指标卡数量 ${state.stats} ≠ 6`)
  cleanup()
  process.exit(1)
}

if (state.chart === null) {
  if (state.empty !== null && state.empty.includes('暂无净值数据')) {
    console.log('SKIP: 该基金无净值数据（空态提示正常显示），无法断言图表渲染。')
    console.log(`截图: ${shotPath}`)
    cleanup()
    process.exit(0)
  }
  console.error('RED: 详情内走势图容器缺失且无空态提示')
  cleanup()
  process.exit(1)
}
if (!state.chart.canvas || state.chart.box.h === 0 || state.chart.canvas.w === 0 || state.chart.canvas.h === 0) {
  console.error(`RED: 走势图未渲染 box=${state.chart.box.w}x${state.chart.box.h} canvas=${state.chart.canvas ? `${state.chart.canvas.w}x${state.chart.canvas.h}` : '缺失'}`)
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
console.log(`  走势图: box=${state.chart.box.w}x${state.chart.box.h} canvas=${state.chart.canvas.w}x${state.chart.canvas.h}`)

// 口径与范围切换后图表仍渲染
for (const label of ['金额', '近1月']) {
  const ok = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.modal-wide .detail-controls button')].find((b) => b.textContent === '${label}')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!ok) {
    console.error(`RED: 未找到「${label}」切换按钮`)
    cleanup()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 1200))
  const alive = await evalJs(`(() => {
    const c = document.querySelector('.modal-wide .chart canvas')
    return c !== null && c.width > 0 && c.height > 0
  })()`)
  if (!alive) {
    console.error(`RED: 切换到「${label}」后走势图未渲染`)
    cleanup()
    process.exit(1)
  }
  console.log(`  切换「${label}」: 图表正常`)
}

// Esc 关闭
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
await new Promise((r) => setTimeout(r, 500))
const closed = await evalJs(`document.querySelector('.modal-wide') === null`)
if (!closed) {
  console.error('RED: Esc 未关闭基金详情')
  cleanup()
  process.exit(1)
}
console.log('  Esc 关闭: 正常')

console.log(`GREEN: 基金详情覆盖层全部断言通过（console 消息 ${logs.length} 条）`)
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
  // 等进程退出后删临时 profile（异步，不阻塞退出）
  electron.once('exit', () => rmSync(profileDir, { recursive: true, force: true }))
}
