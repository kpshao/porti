#!/usr/bin/env node
// 按笔已实现收益端到端检查（零依赖：Node >= 22 全局 WebSocket/fetch + 系统 sqlite3）
//
// 用法：node scripts/check-per-sale-realized.mjs [--port 9333]
//
// 流程：npm run build -> 复制真实 porti.db 到临时 profile -> 启动 Electron -> CDP 断言：
//   1. 流水表卖出行「本笔已实现」逐笔 = 独立重算值；非卖出行留空
//   2. Σ本笔已实现 + Σ分红现金 = 卡片「已实现盈亏」（CONTEXT.md 的恒等式，两处口径同源）
//      该恒等式是全部基金口径，读卡片前先切到「全部基金」
//   3. 新增一笔卖出：表单预览 = 独立重算值；保存后流水表该行 = 预览值；
//      卡片「已实现盈亏」的增量 = 预览值，概览页卡片同步（仍在全部基金口径下比较）
//
// 独立事实来源：系统 sqlite3 直读库，脚本内自己走一遍移动加权平均（不复用 src/engine，
// 避免同源同错）；DOM 只提供展示值——两者对不上就是 RED
//（照 scripts/check-zero-holding-cleanup.mjs 的模板）。新增的卖出只写进临时 profile 的库副本，
// 真实数据不受影响。
//
// 退出码：0 = 通过（含 SKIP：无真实库或无在持基金，相关断言跳过）；1 = RED。
//
// 已知陷阱：窗口遮挡时 rAF 被节流；另需剔除 ELECTRON_RUN_AS_NODE（否则 Electron 退化为纯 Node，
// 页面永远起不来）。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9333'
const CDP = `http://127.0.0.1:${PORT}`

/** 与 src/engine/compute.ts 的 CANDIDATE_ID 同义：候选流水尚未入库，占位主键保证同日排最后 */
const CANDIDATE_ID = Number.MAX_SAFE_INTEGER

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

/** 金额按界面精度（2 位小数）比较 */
const sameMoney = (a, b) => Math.abs(a - b) < 0.005

/** YYYY-MM-DD（本地时区） */
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 临时 profile：复制真实 DB（避免污染用户数据）----------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-per-sale-check-'))
const dbPath = join(profileDir, 'porti.db')
const realDbDir = join(homedir(), 'Library/Application Support/porti')
if (existsSync(join(realDbDir, 'porti.db'))) {
  for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm']) {
    const src = join(realDbDir, name)
    if (existsSync(src)) cpSync(src, join(profileDir, name))
  }
} else {
  console.log('提示：未找到真实数据库，断言将 SKIP')
}

// ---- 3. 独立事实来源：sqlite3 直读 + 自己走一遍移动加权平均 ----------------
/** 库内流水（已按 date, id 升序——与库内查询、界面默认排序同规则） */
const txRows = []
if (existsSync(dbPath)) {
  const q = spawnSync('sqlite3', [
    '-separator',
    '|',
    '-noheader',
    dbPath,
    "SELECT id, date, type, fund_code, amount, shares FROM transactions ORDER BY date, id"
  ])
  if (q.status !== 0) {
    console.error(`RED: sqlite3 读取失败：${q.stderr?.toString().trim()}`)
    cleanup()
    process.exit(1)
  }
  for (const line of q.stdout.toString().split('\n')) {
    if (line.trim() === '') continue
    const [id, date, type, fundCode, amount, shares] = line.split('|')
    txRows.push({
      id: Number(id),
      date: date.trim(),
      type: type.trim(),
      fundCode: fundCode.trim(),
      amount: Number(amount),
      shares: shares.trim() === '' ? null : Number(shares)
    })
  }
}

/** 独立重算：按 (date, id) 顺序走移动加权平均，返回每笔卖出的已实现收益（id -> 金额）
 *  与各基金期末状态。规则照 CONTEXT.md（买入加金额、卖出按比例消耗成本并对超卖钳制、
 *  份额归零时成本基础清零），但为独立实现——不复用 src/engine。 */
function walk(rows) {
  const states = new Map() // code -> { shares, basis, dividends }
  const sales = new Map() // id -> 已实现收益
  for (const t of rows) {
    const s = states.get(t.fundCode) ?? { shares: 0, basis: 0, dividends: 0 }
    if (t.type === '买入') {
      s.shares += t.shares ?? 0
      s.basis += t.amount
    } else if (t.type === '卖出') {
      const sold = -(t.shares ?? 0)
      const proceeds = -t.amount
      const consumed = s.shares > 0 ? Math.min((s.basis * sold) / s.shares, s.basis) : 0
      s.shares -= sold
      s.basis = s.shares <= 0 ? 0 : s.basis - consumed
      sales.set(t.id, proceeds - consumed)
    } else if (t.type === '分红再投入') {
      s.shares += t.shares ?? 0
    } else {
      s.dividends += t.amount
    }
    states.set(t.fundCode, s)
  }
  return { states, sales }
}

const before = walk(txRows)
const expectedSaleSum = [...before.sales.values()].reduce((s, v) => s + v, 0)
const expectedDividends = [...before.states.values()].reduce((s, st) => s + st.dividends, 0)
const sellCount = before.sales.size
/** 在持基金（份额 > 0），按代码升序——表单里挑一只来试录卖出 */
const heldFunds = [...before.states.entries()]
  .filter(([, s]) => s.shares > 0)
  .map(([code]) => code)
  .sort()

// ---- 4. 启动 Electron（剔除 ELECTRON_RUN_AS_NODE，防退化为纯 Node）-------
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

// ---- 5. CDP 会话 ----------------------------------------------------------
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
await new Promise((r) => setTimeout(r, 2000))

/** 页面内执行并返回值 */
const evalJs = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.value
}

const shot = async (tag) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(tmpdir(), `porti-per-sale-${tag}.png`) // 放 profile 外，cleanup 不删
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  return p
}

/** 按侧栏文案切页 */
const goto = async (label) => {
  const ok = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '${label}')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!ok) throw new Error(`侧栏未找到「${label}」`)
  await new Promise((r) => setTimeout(r, 1200))
}

/** 读卡片区某个指标：显示值 + 着色类名 */
const readStat = (label) =>
  evalJs(`(() => {
    const card = document.querySelector('.summary-card')
    if (!card) return null
    const stat = [...card.querySelectorAll('.stat')].find(
      (s) => s.querySelector('.stat-label')?.textContent?.trim() === ${JSON.stringify(label)}
    )
    if (!stat) return null
    const v = stat.querySelector('.stat-value')
    return { value: v?.textContent?.trim() ?? '', classes: [...(v?.classList ?? [])] }
  })()`)

/** 切到「全部基金」口径：本脚本的恒等式（Σ本笔已实现 + Σ分红现金 = 卡片值）
 *  在全部基金口径下成立；卡片默认「在持基金」会漏掉已清仓基金的历史已实现。 */
const selectAllScope = async (where) => {
  const ok = await waitFor(
    () =>
      evalJs(`(() => {
        const btn = [...document.querySelectorAll('.scope-switch-btn')].find(
          (b) => b.textContent.trim() === '全部基金'
        )
        if (!btn) return false
        if (btn.getAttribute('aria-pressed') === 'true') return true
        btn.click()
        return false
      })()`),
    5000
  )
  check(ok === true, `${where}已切到「全部基金」口径（脚本恒等式为全部基金口径）`)
  await new Promise((r) => setTimeout(r, 300))
}

/** 读流水表：表头 + 每行（日期/类型/基金/金额/本笔已实现及着色类名） */
const READ_TX_TABLE = `(() => {
  const table = [...document.querySelectorAll('table.table')].find(
    (t) => [...t.querySelectorAll('thead th')].some((th) => th.textContent.trim() === '本笔已实现')
  )
  if (!table) return { error: 'no-table' }
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
  const i = headers.indexOf('本笔已实现')
  return {
    headers,
    realizedIndex: i,
    rows: [...table.querySelectorAll('tbody tr')].map((tr) => {
      const cell = tr.children[i] ?? null
      return {
        date: tr.children[0]?.textContent?.trim() ?? '',
        type: tr.children[1]?.textContent?.trim() ?? '',
        fund: tr.children[2]?.textContent?.trim() ?? '',
        amount: tr.children[3]?.textContent?.trim() ?? '',
        realized: cell?.textContent?.trim() ?? '',
        realizedClasses: [...(cell?.classList ?? [])]
      }
    })
  }
})()`

/** 期望着色类（独立于实现：由文本符号判定；空值不着色） */
const expectedClass = (text) => {
  if (text === '' || text === '—') return null
  return text.startsWith('-') || text.startsWith('−') ? 'negative' : 'positive'
}

// ---- 6. 切到交易流水页，逐笔对账 -------------------------------------------
await goto('交易流水')
await selectAllScope('交易流水页')
const table = await evalJs(READ_TX_TABLE)
if (table.error) {
  console.error(`RED: 未找到带「本笔已实现」列的流水表（${table.error}）`)
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}

check(table.realizedIndex === 4, '流水表含「本笔已实现」列且在金额之后', `第 ${table.realizedIndex + 1} 列`)
check(
  table.rows.length === txRows.length,
  '表内行数 = 库中流水数（默认排序与库内 ORDER BY date, id 同规则）',
  `${table.rows.length} vs ${txRows.length}`
)

if (txRows.length === 0) {
  console.log('SKIP: 库中无流水，无数据无法断言。')
  cleanup()
  process.exit(0)
}

// 逐行对账：日期/类型/金额先校验行序对齐，再比对「本笔已实现」
const misaligned = []
const badRealized = []
const badBlank = []
const badColor = []
table.rows.forEach((row, i) => {
  const t = txRows[i]
  if (!t) {
    misaligned.push(`第 ${i + 1} 行：库里没有对应流水`)
    return
  }
  if (row.date !== t.date || row.type !== t.type || !row.fund.startsWith(t.fundCode) || !sameMoney(num(row.amount) ?? NaN, t.amount)) {
    misaligned.push(`第 ${i + 1} 行 ${row.date}/${row.type}/${row.fund} vs 库 ${t.date}/${t.type}/${t.fundCode}`)
    return
  }
  if (t.type === '卖出') {
    const expected = before.sales.get(t.id)
    if (!sameMoney(num(row.realized) ?? NaN, expected)) {
      badRealized.push(`${t.date} ${t.fundCode}：界面 ${row.realized} vs 独立重算 ${expected.toFixed(2)}`)
    }
    const actual = row.realizedClasses.find((c) => c === 'positive' || c === 'negative') ?? null
    const want = expectedClass(row.realized)
    if (actual !== want) {
      badColor.push(`${t.date} ${t.fundCode}：${row.realized} 着色 ${actual ?? '无'} ≠ ${want}`)
    }
  } else if (row.realized !== '') {
    badBlank.push(`${t.date} ${t.type}：${row.realized}`)
  }
})

check(misaligned.length === 0, '表内行序与库内 (date, id) 序一致（逐行校验日期/类型/基金/金额）', misaligned.slice(0, 3).join('; '))
check(
  badRealized.length === 0,
  `卖出行「本笔已实现」= 独立重算值（${sellCount} 笔）`,
  badRealized.join('; ')
)
check(badBlank.length === 0, '非卖出行留空', badBlank.slice(0, 3).join('; '))
check(badColor.length === 0, '卖出行按正负着色（红涨绿跌）', badColor.join('; '))

// 恒等式：Σ本笔已实现 + Σ分红现金 = 卡片「已实现盈亏」
const shownSum = table.rows.reduce((s, r) => s + (num(r.realized) ?? 0), 0)
check(
  sameMoney(shownSum, expectedSaleSum),
  'Σ本笔已实现 = 独立重算的卖出已实现合计',
  `${shownSum.toFixed(2)} vs ${expectedSaleSum.toFixed(2)}`
)

const cardBefore = await readStat('已实现盈亏')
if (cardBefore === null) {
  check(false, '交易流水页卡片区有「已实现盈亏」')
} else {
  const expectedCard = expectedSaleSum + expectedDividends
  check(
    sameMoney(num(cardBefore.value) ?? NaN, expectedCard),
    '卡片「已实现盈亏」= Σ本笔已实现 + Σ分红现金（CONTEXT.md 恒等式）',
    `${cardBefore.value} vs ${expectedCard.toFixed(2)}（分红 ${expectedDividends.toFixed(2)}）`
  )
}
/** 读表单预览：显示值 + 着色类名（未成形时是提示文案） */
const readPreview = () => evalJs(`(() => {
  const field = [...document.querySelectorAll('.form-card .form-field')].find(
    (f) => f.querySelector('span')?.textContent?.trim() === '本笔已实现'
  )
  const box = field?.querySelector('.form-preview')
  if (!box) return null
  return { value: box.textContent.trim(), classes: [...box.classList] }
})()`)

// ---- 6b. 编辑态：打开一笔已有卖出的编辑表单，预览应等于该行表列值（候选沿用它原主键的位次）
const sellRow = table.rows.find((r) => r.type === '卖出')
if (sellRow === undefined) {
  check(false, '表内找得到卖出行（编辑态预览断言的前提）')
} else {
  const editOpened = await evalJs(`(() => {
    const table = [...document.querySelectorAll('table.table')].find(
      (t) => [...t.querySelectorAll('thead th')].some((th) => th.textContent.trim() === '本笔已实现')
    )
    const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find(
      (tr) => tr.children[1]?.textContent?.trim() === '卖出'
    )
    const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '编辑')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check(editOpened === true, '卖出行的「编辑」按钮可点开表单')
  await new Promise((r) => setTimeout(r, 400))
  const editPreview = await readPreview()
  check(
    editPreview !== null && sameMoney(num(editPreview.value) ?? NaN, num(sellRow.realized) ?? NaN),
    '编辑态预览 = 该行「本笔已实现」列的值',
    `${editPreview?.value} vs ${sellRow.realized}`
  )
  // 关掉表单，回到干净状态再做新增流程
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.form-card .preview-actions button')].find(
      (b) => b.textContent.trim() === '取消'
    )
    btn?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 300))
}

// 截图对准卖出行（卖出通常落在表尾，滚进视野才看得见）
await evalJs(`(() => {
  const table = [...document.querySelectorAll('table.table')].find(
    (t) => [...t.querySelectorAll('thead th')].some((th) => th.textContent.trim() === '本笔已实现')
  )
  const row = [...(table?.querySelectorAll('tbody tr') ?? [])].reverse().find(
    (tr) => tr.children[1]?.textContent?.trim() === '卖出'
  )
  row?.scrollIntoView({ block: 'center' })
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))
const tableShot = await shot('table')
let formShot = null
let overviewShot = null

// ---- 7. 新增一笔卖出：表单预览 -> 保存 -> 表列 -> 卡片增量 -------------------
if (heldFunds.length === 0) {
  console.log('SKIP: 库中无在持基金，卖出表单预览断言跳过。')
  finish()
}

const fundCode = heldFunds[0]
const lastTxDate = txRows[txRows.length - 1].date
const today = fmtDate(new Date())
const candidateDate = today > lastTxDate ? today : lastTxDate
const candidateShares = 100
const candidateAmount = 1234.56
/** 独立重算：把候选追加到流水末尾（同日按 id 最大排最后），取其已实现收益 */
const candidate = {
  id: CANDIDATE_ID,
  date: candidateDate,
  type: '卖出',
  fundCode,
  amount: -candidateAmount, // 库内约定卖出存负值
  shares: -candidateShares
}
const expectedPreview = walk([...txRows, candidate]).sales.get(CANDIDATE_ID)

const opened = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.page-actions button')].find((b) => b.textContent.trim() === '新增流水')
  if (!btn) return false
  btn.click()
  return true
})()`)
check(opened === true, '「新增流水」按钮可点开表单')
await new Promise((r) => setTimeout(r, 400))

/** 按字段标签设置表单控件（React 受控组件：用原生 setter + input/change 事件） */
const setField = async (label, value) => {
  const ok = await evalJs(`(() => {
    const field = [...document.querySelectorAll('.form-card .form-field')].find(
      (f) => f.querySelector('span')?.textContent?.trim() === ${JSON.stringify(label)}
    )
    const el = field?.querySelector('input, select')
    if (!el) return false
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error(`表单字段「${label}」未找到`)
  await new Promise((r) => setTimeout(r, 150))
}

await setField('日期', candidateDate)
await setField('操作类型', '卖出')
await setField('基金', fundCode)
await setField('金额（元，含手续费）', candidateAmount)
await setField('份额', candidateShares)
await new Promise((r) => setTimeout(r, 300))

const preview = await readPreview()

check(preview !== null, '卖出表单出现「本笔已实现」预览')
if (preview !== null) {
  const shown = num(preview.value)
  check(
    shown !== null && sameMoney(shown, expectedPreview),
    '表单预览 = 独立重算的本笔已实现',
    `${preview.value} vs ${expectedPreview.toFixed(2)}`
  )
  const actual = preview.classes.find((c) => c === 'positive' || c === 'negative') ?? null
  check(actual === expectedClass(preview.value), '表单预览按正负着色', `${preview.value} -> ${actual ?? '无'}`)
}
formShot = await shot('form-preview')

const saved = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.form-card .preview-actions button')].find(
    (b) => b.textContent.trim() === '保存'
  )
  if (!btn) return false
  btn.click()
  return true
})()`)
check(saved === true, '保存按钮可点')
await new Promise((r) => setTimeout(r, 1500))

const afterTable = await evalJs(READ_TX_TABLE)
const addedRow = afterTable.rows?.find(
  (r) => r.date === candidateDate && r.type === '卖出' && r.fund.startsWith(fundCode) && sameMoney(num(r.amount) ?? NaN, -candidateAmount)
)
check(addedRow !== undefined, '新卖出已出现在流水表', addedRow ? `本笔已实现 ${addedRow.realized}` : '未找到该行')
if (addedRow) {
  check(
    sameMoney(num(addedRow.realized) ?? NaN, expectedPreview),
    '流水表「本笔已实现」= 保存前的表单预览值',
    `${addedRow.realized} vs ${expectedPreview.toFixed(2)}`
  )
}

const cardAfter = await readStat('已实现盈亏')
if (cardBefore !== null && cardAfter !== null) {
  const delta = (num(cardAfter.value) ?? 0) - (num(cardBefore.value) ?? 0)
  check(
    sameMoney(delta, expectedPreview),
    '卡片「已实现盈亏」的增量 = 这一笔的已实现',
    `Δ${delta.toFixed(2)} vs ${expectedPreview.toFixed(2)}`
  )
}

// ---- 8. 概览页的累计值与流水页同源 -----------------------------------------
await goto('概览')
await selectAllScope('概览页')
const overviewCard = await readStat('已实现盈亏')
check(
  overviewCard !== null && cardAfter !== null && sameMoney(num(overviewCard.value) ?? NaN, num(cardAfter.value) ?? NaN),
  '概览页「已实现盈亏」= 流水页卡片值（累计值同源）',
  `概览 ${overviewCard?.value} vs 流水 ${cardAfter?.value}`
)
overviewShot = await shot('overview')

finish()

function finish() {
  for (const l of logs) console.error(`  console: ${l}`)
  console.log(`截图: 流水表 ${tableShot}`)
  if (formShot !== null) console.log(`截图: 卖出表单预览 ${formShot}`)
  if (overviewShot !== null) console.log(`截图: 概览 ${overviewShot}`)
  if (failures.length > 0) {
    console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
    cleanup()
    process.exit(1)
  }
  console.log('GREEN: 按笔已实现收益全部断言通过')
  cleanup()
  process.exit(0)
}

function cleanup() {
  try {
    ws?.close()
  } catch {}
  try {
    electron.kill('SIGTERM')
  } catch {}
  electron.once('exit', () => rmSync(profileDir, { recursive: true, force: true }))
}
