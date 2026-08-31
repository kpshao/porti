#!/usr/bin/env node
// 设置页端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch，无需 Playwright）
//
// 用法：node scripts/check-settings-page.mjs [--port 9334]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 带防节流旗标启动
// Electron -> CDP 进入设置页 -> 断言数据文件位置可见、备份/导出文案与按钮齐全、
// 无渲染异常。
//
// 退出码：0 = 通过；1 = RED。导出/更改位置涉及原生对话框，不在无头断言范围
// （导出内容一致性由 exportService 单元测试覆盖）。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9334'
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
const profileDir = mkdtempSync(join(tmpdir(), 'porti-settings-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (existsSync(join(realDbDir, 'porti.db'))) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，数据文件位置断言降级为「可见即可」')
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
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1500))
const { result: nav } = await send('Runtime.evaluate', {
  expression: `(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('设置'))
    if (!btn) return false
    btn.click()
    return true
  })()`,
  returnByValue: true
})
if (!nav.value) {
  console.error('RED: 未找到「设置」导航项')
  cleanup()
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 1500))

const { result: dom } = await send('Runtime.evaluate', {
  expression: `(() => {
    const text = document.body.innerText
    return {
      dbPath: document.querySelector('.mono')?.textContent ?? null,
      pageText: text,
      buttons: [...document.querySelectorAll('.btn')].map((b) => b.textContent),
      errorBanner: document.querySelector('.banner-error')?.textContent ?? null
    }
  })()`,
  returnByValue: true
})
const { dbPath, pageText, buttons, errorBanner } = dom.value

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-settings-check.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

const problems = []
if (errorBanner !== null) problems.push(`页面出现错误横幅：${errorBanner}`)
if (dbPath === null || dbPath.trim() === '') problems.push('数据文件位置未显示')
else console.log(`  数据文件位置：${dbPath}`)
if (!pageText.includes('拷贝该文件即完成备份')) problems.push('缺少「拷贝 SQLite 文件即备份」文案')
if (!buttons.some((b) => b.includes('更改数据文件位置'))) problems.push('缺少「更改数据文件位置」按钮')
if (!buttons.some((b) => b.includes('导出 Excel'))) problems.push('缺少「导出 Excel」按钮')
if (!buttons.some((b) => b.includes('导出 CSV'))) problems.push('缺少「导出 CSV」按钮')
const exceptions = logs.filter((l) => l.includes('Error') || l.includes('error'))
if (exceptions.length > 0) problems.push(`渲染异常 ${exceptions.length} 条：${exceptions[0]}`)

if (problems.length > 0) {
  console.error('RED:')
  for (const p of problems) console.error(`  - ${p}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
console.log(`GREEN: 设置页数据文件位置/备份文案/导出按钮齐全，无渲染异常（console 消息 ${logs.length} 条）`)
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
