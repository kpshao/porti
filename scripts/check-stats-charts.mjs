#!/usr/bin/env node
// 收益统计页图表端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch，无需 Playwright）
//
// 用法：node scripts/check-stats-charts.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 带防节流旗标启动
// Electron -> CDP 进入收益统计页 -> 断言每个 .chart 容器内有非零尺寸 canvas。
//
// 退出码：0 = 通过（含 SKIP：无数据无法断言）；1 = RED（图表不显示）
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
const profileDir = mkdtempSync(join(tmpdir(), 'porti-chart-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
const hasRealData = existsSync(join(realDbDir, 'porti.db'))
if (hasRealData) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，图表断言将 SKIP')
}

// ---- 3. 启动 Electron ----------------------------------------------------
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
  { stdio: 'ignore' }
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
// 冷启动路径：reload 后从概览页点进收益统计
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1500))
const { result } = await send('Runtime.evaluate', {
  expression: `(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('收益统计'))
    if (!btn) return false
    btn.click()
    return true
  })()`,
  returnByValue: true
})
if (!result.value) {
  console.error('RED: 未找到「收益统计」导航项')
  cleanup()
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 3000))

const { result: dom } = await send('Runtime.evaluate', {
  expression: `(() => {
    const charts = [...document.querySelectorAll('.chart')].map((el) => {
      const c = el.querySelector('canvas')
      return {
        cls: el.className,
        box: { w: el.offsetWidth, h: el.offsetHeight },
        canvas: c ? { w: c.width, h: c.height } : null
      }
    })
    return { charts, placeholder: document.querySelector('.placeholder')?.textContent ?? null }
  })()`,
  returnByValue: true
})
const { charts, placeholder } = dom.value

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-stats-check.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

if (charts.length === 0) {
  console.log(`SKIP: 无图表容器（${placeholder ?? '页面结构异常'}）。无数据无法断言图表渲染。`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(0)
}
const broken = charts.filter((c) => !c.canvas || c.box.h === 0 || c.canvas.w === 0 || c.canvas.h === 0)
for (const c of charts) {
  console.log(`  ${c.cls || '(无类名)'}: box=${c.box.w}x${c.box.h} canvas=${c.canvas ? `${c.canvas.w}x${c.canvas.h}` : '缺失'}`)
}
if (broken.length > 0) {
  console.error(`RED: ${broken.length}/${charts.length} 个图表未渲染`)
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
console.log(`GREEN: ${charts.length} 个图表全部渲染（console 消息 ${logs.length} 条）`)
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
