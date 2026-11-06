#!/usr/bin/env node
// 概览卡片区两行版式 + 总收益端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch）
//
// 用法：node scripts/check-overview-total-return-card.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron -> CDP 断言
// 概览卡片区：第一行结果（总资产 / 总收益 / 累计收益率 / 年化收益率）、第二行分解
// （持仓盈亏 + 已实现盈亏 = 总收益）。断言口径见 .scratch/return-breakdown/spec.md 与
// issues/03-overview-total-return-card.md。
//
// 断言分三层：
//   1) 版式——两行、标签序列、加减号与「= 总收益」尾注肉眼可见地成等式；
//   2) 数值——DOM 显示值 vs window.api.overviewData().summary.held 的模型值
//      （默认口径为「在持基金」；防渲染串字段），并当场用显示值手算
//      「持仓盈亏 + 已实现盈亏 == 总收益」；
//   3) 着色——总资产不着色，其余三张按显示值正负着色（红涨绿跌不从实现取，从文本符号判）。
//
// 退出码：0 = 通过（含 SKIP：库中无数据，卡片区不渲染）；1 = RED。
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

/** 本卡片区两行版式的期望形态 */
const ROW1 = ['总资产', '总收益', '累计收益率', '年化收益率']
const ROW2 = ['持仓盈亏', '已实现盈亏']
/** 第一行里按正负着色的三张（总资产恒为正，不着色） */
const COLORED_ROW1 = ['总收益', '累计收益率', '年化收益率']

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

/** 显示值 -> 期望的着色类（独立于实现：只从文本符号判定；无值不着色） */
function expectedClass(value) {
  if (value === '—' || value === '') return null
  return value.startsWith('-') || value.startsWith('−') ? 'negative' : 'positive'
}

const actualClass = (classes) => classes.find((c) => c === 'positive' || c === 'negative') ?? null

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-total-return-check-'))
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (existsSync(join(realDbDir, 'porti.db'))) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，断言将 SKIP')
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

// ---- 4. CDP 连接 ----------------------------------------------------------
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

/** 页面内执行并等 Promise（读模型值用） */
const evalAsync = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return result.value
}

// 主进程启动时会自动抓取最新净值并写库（不阻塞启动）。若卡片先按旧数据渲染、
// 随后模型查询读到抓取后的新数据，DOM 与模型就会跨两次数据状态而产生假 RED；
// 等抓取落定（ok/failed 均为终态）后重新加载，让两者基于同一份库。
const navSettled = await waitFor(async () => {
  try {
    const status = await evalAsync('window.api.navFetchStatus()')
    return status !== null && status.state !== 'running' && status.state !== 'idle'
  } catch {
    return false
  }
}, 30000)
if (!navSettled) console.log('提示：等待启动净值抓取落定超时，继续断言')
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1500))

/** 读概览卡片区：行结构（标签 / 值 / 类名 / 运算符）+ 脚注 + 卡上 title */
const READ_CARD = `(() => {
  const card = document.querySelector('.summary-card')
  if (!card) return { error: 'no-card' }
  // 标签文本要剔掉悬停标记（.hint-mark 的 ⓘ 是装饰，不是标签的一部分）；
  // 同一段逻辑在 scripts/check-realized-pnl-labels.mjs 里也有一份（脚本自包含是仓库惯例）
  const labelText = (el) => {
    const clone = el.cloneNode(true)
    clone.querySelectorAll('.hint-mark').forEach((m) => m.remove())
    return clone.textContent.trim()
  }
  const stat = (s) => {
    const valueEl = s.querySelector('.stat-value')
    const labelEl = s.querySelector('.stat-label')
    return {
      label: labelEl ? labelText(labelEl) : '',
      hasHintMark: (labelEl?.querySelector('.hint-mark') ?? null) !== null,
      value: valueEl?.textContent?.trim() ?? '',
      classes: [...(valueEl?.classList ?? [])],
      title: s.getAttribute('title') ?? ''
    }
  }
  return {
    rows: [...card.querySelectorAll('.stat-row')].map((row) => ({
      stats: [...row.querySelectorAll('.stat')].map(stat),
      ops: [...row.querySelectorAll('.stat-op')].map((e) => e.textContent.trim())
    })),
    text: card.innerText
  }
})()`

const card = await evalJs(READ_CARD)

if (card.error) {
  console.log(`SKIP: 概览页无卡片区（${card.error}），库中无数据无法断言。`)
  cleanup()
  process.exit(0)
}

// ---- 5. 版式：两行 + 标签序列 + 加法关系 ------------------------------------
console.log('卡片区结构：')
for (const [i, row] of card.rows.entries()) {
  console.log(
    `  第 ${i + 1} 行: ${row.stats.map((s) => `${s.label}=${s.value}`).join('  ')}` +
      (row.ops.length > 0 ? `  [运算符 ${row.ops.join(' ')}]` : '')
  )
}

check(card.rows.length === 2, '卡片区分两行', `实为 ${card.rows.length} 行`)

const row1 = card.rows[0]?.stats ?? []
const row2 = card.rows[1]?.stats ?? []
const row1Labels = row1.map((s) => s.label)
const row2Labels = row2.map((s) => s.label)
check(
  JSON.stringify(row1Labels) === JSON.stringify(ROW1),
  `第一行（结果）= ${ROW1.join(' / ')}`,
  `实为 ${row1Labels.join(' / ')}`
)
check(
  JSON.stringify(row2Labels) === JSON.stringify(ROW2),
  `第二行（分解）= ${ROW2.join(' / ')}`,
  `实为 ${row2Labels.join(' / ')}`
)
check(card.rows[0]?.ops.length === 0, '第一行不带运算符（它是结果，不是算式）')

const ops = card.rows[1]?.ops ?? []
check(
  ops.length === 2 && ops[0] === '+' && ops[1].replace(/\s+/g, ' ') === '= 总收益',
  '第二行显式写出「+」与「= 总收益」，加法关系肉眼可见',
  `实为 [${ops.join(' | ')}]`
)

// ---- 6. 数值：DOM 显示值 vs 模型值、以及和自身的加法恒等 --------------------
const model = await evalAsync('window.api.overviewData()')
// 卡片默认「在持基金」口径；这里同步断言 held 口径（口径切换本身由
// scripts/check-summary-scope-toggle.mjs 覆盖）
const summary = model?.summary?.held ?? null
const totals = summary?.totals ?? null
check(totals !== null, 'window.api.overviewData().summary.held 拿得到汇总（DOM 有卡片就应有模型值）')

if (totals !== null) {
  const byLabel = (label) => [...row1, ...row2].find((s) => s.label === label)

  // 六张卡逐一对照模型字段（金额 2 位小数、比例 2 位百分数，容差半位）
  const expectations = [
    ['总资产', totals.totalAssets, 'money'],
    ['总收益', totals.totalReturn, 'money'],
    ['累计收益率', totals.totalReturnRate, 'percent'],
    ['年化收益率', summary?.annualized ?? null, 'percent'],
    ['持仓盈亏', totals.totalPnl, 'money'],
    ['已实现盈亏', totals.realizedIncome, 'money']
  ]
  const mismatched = []
  for (const [label, want, kind] of expectations) {
    const shownText = byLabel(label)?.value ?? ''
    const wantNum = want ?? null
    const wantText = wantNum === null ? '—' : kind === 'percent' ? `${(wantNum * 100).toFixed(2)}%` : wantNum.toFixed(2)
    const shown = num(shownText)
    const ok =
      wantNum === null ? shownText === '—' : Math.abs((shown ?? NaN) - (kind === 'percent' ? wantNum * 100 : wantNum)) <= 0.005
    if (!ok) mismatched.push(`${label}: 显示 ${shownText} vs 模型 ${wantText}`)
  }
  check(mismatched.length === 0, '六张卡显示的都是模型里的对应字段', mismatched.join('; '))

  // 加法恒等：用卡片上显示的三个数当场手算
  const pnl = num(byLabel('持仓盈亏')?.value ?? '')
  const realized = num(byLabel('已实现盈亏')?.value ?? '')
  const total = num(byLabel('总收益')?.value ?? '')
  check(
    pnl !== null && realized !== null && total !== null && Math.abs(total - (pnl + realized)) <= 0.01,
    '第二行两个数相加 = 第一行「总收益」（用显示值手算）',
    `${pnl} + ${realized} = ${pnl !== null && realized !== null ? (pnl + realized).toFixed(2) : '?'} vs 总收益 ${total}`
  )
}

// ---- 7. 着色：总资产恒不着色，其余按显示值正负 ------------------------------
for (const label of COLORED_ROW1) {
  const stat = row1.find((s) => s.label === label)
  const expected = expectedClass(stat?.value ?? '')
  const actual = actualClass(stat?.classes ?? [])
  check(
    expected === actual,
    `「${label}」按正负着色`,
    `${stat?.value} → ${actual ?? '无'}` + (expected !== actual ? `（期望 ${expected ?? '无'}）` : '')
  )
}
{
  const assetStat = row1.find((s) => s.label === '总资产')
  check(
    actualClass(assetStat?.classes ?? []) === null,
    '「总资产」不着色（恒为正，着色无意义）',
    `${assetStat?.value} → ${actualClass(assetStat?.classes ?? []) ?? '无'}`
  )
}
{
  const pnl = row2.find((s) => s.label === '持仓盈亏')
  const realized = row2.find((s) => s.label === '已实现盈亏')
  check(
    expectedClass(pnl?.value ?? '') === actualClass(pnl?.classes ?? []) &&
      expectedClass(realized?.value ?? '') === actualClass(realized?.classes ?? []),
    '第二行两个分解项也按正负着色（负数不被视觉淹没）',
    `持仓盈亏 ${pnl?.value}→${actualClass(pnl?.classes ?? []) ?? '无'} / 已实现盈亏 ${realized?.value}→${actualClass(realized?.classes ?? []) ?? '无'}`
  )
}

// ---- 8. 年化收益率的说明文案 ------------------------------------------------
{
  const annualStat = row1.find((s) => s.label === '年化收益率')
  const title = annualStat?.title ?? ''
  check(
    title.includes('买入日期') && title.includes('合并') && title.includes('偏低'),
    '「年化收益率」卡挂 tooltip，说明合并买入记录会使年化偏低',
    title || '（无 title）'
  )
  check(annualStat?.hasHintMark === true, '「年化收益率」标签带 ⓘ 标记（提示有说明可看）')
}

// ---- 9. 旧词回归：卡片区不得再出现「落袋」-----------------------------------
check(!card.text.includes('落袋'), '卡片区无旧词「落袋」')

// ---- 10. 截图与收尾 ---------------------------------------------------------
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(tmpdir(), 'porti-total-return-card.png') // 放 profile 外，cleanup 不删
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

for (const l of logs) console.error(`  console: ${l}`)

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  console.log(`截图: ${shotPath}`)
  cleanup()
  process.exit(1)
}
console.log(`GREEN: 概览卡片区两行版式与总收益全部断言通过（console 消息 ${logs.length} 条）`)
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
