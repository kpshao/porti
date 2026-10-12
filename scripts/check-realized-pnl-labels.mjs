#!/usr/bin/env node
// 「已实现盈亏」改名与着色端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch，无需 Playwright）
//
// 用法：node scripts/check-realized-pnl-labels.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 带防节流旗标启动
// Electron -> CDP 逐页断言：概览 / 交易流水卡片区的标签序列为「已实现盈亏」且按
// 正负着色、收益统计图注同步、基金详情卡片着色与同屏「持仓盈亏」同口径；并断言
// 全应用渲染文本中不再出现旧词「落袋」。
//
// 退出码：0 = 通过（含 SKIP：库中无数据，卡片区不渲染）；1 = RED。
//
// 已知陷阱：窗口遮挡时 rAF 被节流，ECharts 不绘制 canvas，故必须带
// --disable-backgrounding-occluded-windows / --disable-renderer-backgrounding
// / --disable-background-timer-throttling 三个旗标；另需剔除
// ELECTRON_RUN_AS_NODE（否则 Electron 退化为纯 Node）。
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
const profileDir = mkdtempSync(join(tmpdir(), 'porti-pnl-label-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (existsSync(join(realDbDir, 'porti.db'))) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，卡片区不渲染，断言将 SKIP')
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
await new Promise((r) => setTimeout(r, 2500))

/** 页面内执行并返回值 */
const evalJs = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.value
}

const fail = async (msg) => {
  console.error(`RED: ${msg}`)
  for (const l of logs) console.error(`  console: ${l}`)
  await dumpScreenshot('failed')
  cleanup()
  process.exit(1)
}

const dumpScreenshot = async (tag) => {
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const p = join(tmpdir(), `porti-realized-pnl-${tag}.png`)
    writeFileSync(p, Buffer.from(shot.data, 'base64'))
    console.log(`截图: ${p}`)
  } catch {}
}

/** 按侧栏文案切页并等数据到达 */
const goto = async (label) => {
  const ok = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '${label}')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!ok) await fail(`侧栏未找到「${label}」`)
  await new Promise((r) => setTimeout(r, 1500))
}

/** 读一个卡片区（.summary-card）的标签/显示值/类名 + 该卡片区的渲染文本。
 *  只取卡片区文本：流水页整页文本含用户自己写的备注（用户习惯在备注里写「落袋」等
 *  中文），那是用户数据，不是界面文案。 */
const readCardArea = () =>
  evalJs(`(() => {
    const card = document.querySelector('.summary-card')
    if (!card) return null
    return {
      stats: [...card.querySelectorAll('.stat')].map((s) => {
        const valueEl = s.querySelector('.stat-value')
        return {
          label: s.querySelector('.stat-label')?.textContent?.trim() ?? '',
          value: valueEl?.textContent?.trim() ?? '',
          classes: [...(valueEl?.classList ?? [])]
        }
      }),
      text: card.innerText
    }
  })()`)

/** 显示值 → 期望着色类（独立于实现：从文本符号判定；空值为「—」不着色） */
const expectedClass = (value) => {
  if (value === '—' || value === '') return null
  return value.startsWith('-') || value.startsWith('−') ? 'negative' : 'positive'
}

const assertColored = (where, stat) => {
  const expected = expectedClass(stat.value)
  const actual = stat.classes.find((c) => c === 'positive' || c === 'negative') ?? null
  if (expected === null) {
    if (actual !== null) throw new Error(`${where}「${stat.label}」显示 ${stat.value} 却着成 ${actual}`)
    console.log(`  ${where}「${stat.label}」= ${stat.value}（无值不着色）✓`)
    return
  }
  if (actual !== expected) throw new Error(`${where}「${stat.label}」= ${stat.value} 着色 ${actual ?? '无'} ≠ 期望 ${expected}`)
  console.log(`  ${where}「${stat.label}」= ${stat.value} → ${actual} ✓`)
}

const LABELS = ['总资产', '持仓盈亏', '累计收益率', '年化收益率', '已实现盈亏']

const assertNoLegacyTerm = (where, text) => {
  if (text.includes('落袋')) {
    const hit = text.split('\n').find((l) => l.includes('落袋'))
    throw new Error(`${where}渲染文本仍含旧词「落袋」：${hit?.trim().slice(0, 80)}`)
  }
  console.log(`  ${where}无旧词「落袋」✓`)
}

let checked = 0
try {
  // ---- 概览页 ----
  const overview = await readCardArea()
  if (overview === null) {
    console.log('SKIP: 概览页无卡片区（库中无持仓数据），无法断言文案与着色。')
    cleanup()
    process.exit(0)
  }
  console.log('概览页：')
  const labels = overview.stats.map((s) => s.label)
  if (JSON.stringify(labels) !== JSON.stringify(LABELS)) {
    throw new Error(`卡片标签序列不符：${labels.join(' / ')}（期望 ${LABELS.join(' / ')}）`)
  }
  console.log(`  卡片标签序列: ${labels.join(' / ')} ✓`)
  assertColored('概览', overview.stats.find((s) => s.label === '已实现盈亏'))
  assertColored('概览', overview.stats.find((s) => s.label === '持仓盈亏'))
  assertNoLegacyTerm('概览页', overview.text)
  checked++

  // 全应用指标标签不得再出现旧词（.stat-label 是界面文案，非用户数据）
  const legacyLabels = await evalJs(
    `[...document.querySelectorAll('.stat-label')].map((e) => e.textContent.trim()).filter((t) => t.includes('落袋'))`
  )
  if (legacyLabels.length > 0) throw new Error(`界面仍有旧词标签：${legacyLabels.join(' / ')}`)
  console.log('  全应用 .stat-label 无旧词「落袋」✓')

  // ---- 交易流水页 ----
  await goto('交易流水')
  const tx = await readCardArea()
  if (tx !== null) {
    console.log('交易流水页：')
    const txLabels = tx.stats.map((s) => s.label)
    if (JSON.stringify(txLabels) !== JSON.stringify(LABELS)) {
      throw new Error(`卡片标签序列不符：${txLabels.join(' / ')}（期望 ${LABELS.join(' / ')}）`)
    }
    console.log(`  卡片标签序列: ${txLabels.join(' / ')} ✓`)
    assertColored('流水', tx.stats.find((s) => s.label === '已实现盈亏'))
    assertNoLegacyTerm('交易流水页', tx.text)
    checked++
  } else {
    console.log('SKIP: 交易流水页无卡片区')
  }

  // ---- 收益统计页（图注）----
  await goto('收益统计')
  const caption = await evalJs(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === '累计收益走势')
    return card?.querySelector('.muted')?.textContent?.trim() ?? null
  })()`)
  console.log('收益统计页：')
  if (caption === null) {
    console.log('  提示：累计收益走势卡片未渲染（无净值数据），图注无法断言')
  } else {
    if (caption.includes('落袋')) throw new Error(`累计收益图注仍含旧词「落袋」：${caption}`)
    if (!caption.includes('已实现盈亏')) throw new Error(`累计收益图注未用「已实现盈亏」：${caption}`)
    console.log(`  累计收益图注用「已实现盈亏」✓`)
  }
  checked++

  // ---- 基金详情覆盖层 ----
  await goto('概览')
  const opened = await evalJs(`(() => {
    const link = document.querySelector('.fund-link')
    if (!link) return false
    link.click()
    return true
  })()`)
  if (!opened) {
    console.log('SKIP: 概览页无持仓行（无 .fund-link），无法断言基金详情。')
  } else {
    await new Promise((r) => setTimeout(r, 2000))
    const detail = await evalJs(`(() => {
      const modal = document.querySelector('.modal-wide')
      if (!modal) return null
      return {
        stats: [...modal.querySelectorAll('.detail-stats .stat')].map((s) => {
          const valueEl = s.querySelector('.stat-value')
          return {
            label: s.querySelector('.stat-label')?.textContent?.trim() ?? '',
            value: valueEl?.textContent?.trim() ?? '',
            classes: [...(valueEl?.classList ?? [])]
          }
        }),
        text: modal.innerText
      }
    })()`)
    if (detail === null) await fail('点击基金名称后未出现基金详情覆盖层')
    console.log('基金详情：')
    const realized = detail.stats.find((s) => s.label === '已实现盈亏')
    if (realized === undefined) {
      throw new Error(`详情指标行无「已实现盈亏」卡（现为 ${detail.stats.map((s) => s.label).join(' / ')}）`)
    }
    assertColored('详情', realized)
    const held = detail.stats.find((s) => s.label === '持仓盈亏')
    // 同口径校验：两张卡用同一条着色规则（同样的判定方式各自通过即为一致）
    if (held !== undefined) assertColored('详情', held)
    assertNoLegacyTerm('基金详情', detail.text)
    checked++
  }

  await dumpScreenshot('green')
  console.log(`GREEN: 「已实现盈亏」文案与着色断言全部通过（${checked} 处；console 消息 ${logs.length} 条）`)
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e.message)
}

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
