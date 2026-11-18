#!/usr/bin/env node
// 基金配置页端到端检查（零依赖运行时：Node >= 22 全局 WebSocket/fetch；
// better-sqlite3 仅用于构造合成夹具与独立重算，不读取真实持仓）。
//
// 用法：node scripts/check-fund-config.mjs [--port 9337]
//
// 流程：npm run build → 合成 v6 库建临时 profile → 启动 Electron → CDP 断言。
//
// 断言：
//   1. 侧栏有「基金配置」页；表格列出全部基金（含已清仓），代码只读，页面无新建/删除入口；
//   2. 只改权益系数不弹确认，落库后来源记为 manual，概览配置对比立即按新系数重算；
//   3. 改产品形态/账本大类先弹历史重算确认；确认后落库，持仓明细立即按新分组重算；
//   4. 产品形态与账本大类不一致时被拒绝，库内字段不变；
//   5. 权益系数限制在 0–100%，越界被拒绝；
//   6. 新建基金表单使用产品形态（无旧「资产大类」），账本大类派生正确；
//      新建基金加一笔买入后出现在正确的持仓分组；
//   7. 手动抓取：单只失败保留原系数并逐行报错；刷新全部继续处理其余基金；
//      抓取候选值展示股票占净比（季报）、报告期与来源，确认前不写库；
//      未改值确认来源记为 fetch，改过值确认来源记为 manual，手工值不被静默覆盖。
//
// 合成夹具（9xxxxx 为不存在的代码，避免启动自动抓取改写净值）：
//   A 910001 债/固收+ 系数 20%，净投入 1000，市值 1200；
//   B 910002 债/纯债 系数 0，净投入 1000，市值 1000（稍后重分类为固收+）；
//   C 910003 权益/权益 系数 100%，净投入 1000，市值 1500（稍后把系数改为 50%）；
//   D 910004 黄金/黄金 系数 0，净投入 1000，市值 1000；
//   E 910005 已清仓（净投入残留 300，配置对比不统计）；
//   F 000001 真实基金代码、无流水，仅用于手动抓取候选值流程（需要联网）。
//
// 前置条件：抓取流程会访问东方财富公开数据；离线时该段断言会 RED。
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
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9337'
const CDP = `http://127.0.0.1:${PORT}`

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

const PRODUCT_FORMS = ['固收+', '纯债', '权益', '黄金']
const LEDGER_CATEGORIES = ['债', '权益', '黄金']
const BUCKETS = ['稳健', '权益', '黄金']
const HEADERS = [
  '代码',
  '名称',
  '产品形态',
  '账本大类',
  '权益系数（%）',
  '股票占净比（季报）',
  '操作'
]

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
  const n = num(shown)
  return n !== null && Number.isFinite(n) && Math.abs(n - expected) <= 0.005 + 1e-9
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 合成 v5 夹具 ------------------------------------------------------
const profileDir = mkdtempSync(join(tmpdir(), 'porti-fund-config-check-'))
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
    CREATE TABLE ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
  db.pragma('user_version = 6')
  const insertFund = db.prepare(
    `INSERT INTO funds (code, name, fund_type, ledger_category, product_form, equity_ratio, equity_ratio_source, equity_ratio_as_of, created_at)
     VALUES (?,?,?,?,?,?,'manual',NULL,'2026-01-01')`
  )
  insertFund.run('910001', '测试固收+', '二级债基', '债', '固收+', 0.2)
  insertFund.run('910002', '测试纯债', '一级债基', '债', '纯债', 0)
  insertFund.run('910003', '测试权益', '宽基指数', '权益', '权益', 1)
  insertFund.run('910004', '测试黄金', '黄金', '黄金', '黄金', 0)
  insertFund.run('910005', '测试已清仓', '一级债基', '债', '纯债', 0)
  // 真实代码 + 无流水：只验证抓取候选值流程，不影响配置对比
  insertFund.run('000001', '抓取测试基金', '宽基指数', '权益', '权益', 1)

  const insertTx = db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, fee, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,NULL,'2026-01-02','2026-01-02')`
  )
  insertTx.run('2026-01-02', '买入', '910001', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '910002', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '910003', 1000, 1000, 1)
  insertTx.run('2026-01-02', '买入', '910004', 1000, 1000, 1)
  // 已清仓：买入 500，卖出回款 200、份额归零 → 净投入残留 300
  insertTx.run('2026-01-02', '买入', '910005', 500, 500, 1)
  insertTx.run('2026-01-03', '卖出', '910005', -200, -500, 0.4)

  const insertNav = db.prepare(
    "INSERT INTO nav_history (fund_code, date, nav, source) VALUES (?,?,?,'manual')"
  )
  insertNav.run('910001', '2026-01-20', 1.2)
  insertNav.run('910002', '2026-01-20', 1)
  insertNav.run('910003', '2026-01-20', 1.5)
  insertNav.run('910004', '2026-01-20', 1)
  insertNav.run('910005', '2026-01-20', 0.4)

  db.prepare(
    "INSERT INTO bucket_targets (bucket, target_ratio) VALUES ('稳健', 0.4), ('权益', 0.4), ('黄金', 0.2)"
  ).run()
  db.close()
}

/** 独立事实来源：按库内数据重算三桶市值占比（只统计在持基金，缺净值市值按 0 计） */
function expectedMarketRatios() {
  const db = new Database(dbPath, { readonly: true })
  db.pragma('busy_timeout = 5000')
  const rows = db
    .prepare(
      `SELECT f.code, f.ledger_category, f.equity_ratio,
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
  const market = { 稳健: 0, 权益: 0, 黄金: 0 }
  let total = 0
  for (const f of rows.filter((r) => r.shares > 0)) {
    const m = (navs.get(f.code) ?? 0) * f.shares
    total += m
    const equity = m * f.equity_ratio
    if (f.ledger_category === '黄金') {
      market['权益'] += equity
      market['黄金'] += m - equity
    } else {
      market['稳健'] += m - equity
      market['权益'] += equity
    }
  }
  const pct = (v) => (total === 0 ? 0 : (v / total) * 100)
  return Object.fromEntries(BUCKETS.map((b) => [b, pct(market[b])]))
}

/** 读单个基金行（独立于界面，验证落库结果） */
function dbFund(code) {
  const db = new Database(dbPath, { readonly: true })
  db.pragma('busy_timeout = 5000')
  const row = db.prepare('SELECT * FROM funds WHERE code = ?').get(code)
  db.close()
  return row
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

// 全局拦截确认弹窗：记录文案并按 __confirmAnswer 返回（避免 CDP 原生对话框阻塞）
await evalJs(`(() => {
  window.__confirms = [];
  window.__confirmAnswer = true;
  window.confirm = (message) => {
    window.__confirms.push(String(message));
    return window.__confirmAnswer;
  };
  return true;
})()`)

const READ_FUND_CONFIG = `(() => {
  const table = document.querySelector('.table-fund-config')
  if (!table) return { missing: 'no-table' }
  return {
    sidebar: [...document.querySelectorAll('.nav-item')].map((b) => b.textContent.trim()),
    heading: document.querySelector('.page h1')?.textContent?.trim() ?? '',
    headers: [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()),
    rows: [...table.querySelectorAll('tbody tr')].map((tr) => ({
      code: tr.children[0]?.textContent?.trim() ?? '',
      codeHasInput: tr.children[0]?.querySelector('input,select,textarea') !== null,
      name: tr.children[1]?.querySelector('input')?.value ?? tr.children[1]?.textContent?.trim() ?? '',
      productForm: tr.children[2]?.querySelector('select')?.value ?? tr.children[2]?.textContent?.trim() ?? '',
      ledgerCategory: tr.children[3]?.querySelector('select')?.value ?? tr.children[3]?.textContent?.trim() ?? '',
      ratio:
        tr.children[4]?.querySelector('input')?.value ??
        tr.children[4]?.querySelector('.fund-config-ratio-value')?.textContent?.trim() ??
        '',
      ratioMeta: tr.children[4]?.querySelector('.fund-config-ratio-meta')?.textContent?.trim() ?? '',
      candidate: tr.children[5]?.textContent?.trim() ?? '',
      candidateRatio: tr.children[5]?.querySelector('.fund-config-candidate-ratio')?.value ?? null,
      candidateMeta: tr.children[5]?.querySelector('.fund-config-candidate-meta')?.textContent?.trim() ?? '',
      candidateError: tr.children[5]?.querySelector('.fund-config-candidate-error')?.textContent?.trim() ?? null,
      candidateButtons: [...(tr.children[5]?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
      actions: [...(tr.children[6]?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim())
    })),
    pageButtons: [...document.querySelectorAll('.page button')].map((b) => b.textContent.trim()),
    error: document.querySelector('.page > .banner-error')?.textContent?.trim() ?? null,
    message: document.querySelector('.page > .banner-success')?.textContent?.trim() ?? null,
    confirms: window.__confirms ?? []
  }
})()`

const READ_ALLOCATION = `(() => {
  const card = document.querySelector('.card-allocation')
  if (!card) return { error: 'no-card' }
  return {
    rows: [...card.querySelectorAll('tbody tr')].map((tr) => ({
      bucket: tr.children[0]?.textContent?.trim() ?? '',
      marketRatio: tr.children[3]?.textContent?.trim() ?? ''
    }))
  }
})()`

const READ_GROUPS = `(() => {
  const card = [...document.querySelectorAll('.card')].find(
    (c) => c.querySelector('h2')?.textContent === '持仓明细'
  )
  const table = card?.querySelector('table')
  if (!table) return { error: 'no-table' }
  return {
    groups: [...table.querySelectorAll('tbody')].map((tb) => {
      const trs = [...tb.querySelectorAll('tr')]
      return {
        name: trs[0]?.children[0]?.textContent?.trim() ?? '',
        codes: trs
          .map((tr) => tr.children[tr.children.length - 9]?.textContent?.trim() ?? '')
          .filter(Boolean)
      }
    })
  }
})()`

const navigate = (label) =>
  evalJs(
    `[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(), true`
  )

const waitHeading = (label) =>
  waitFor(
    () => evalJs(`document.querySelector('.page h1')?.textContent?.trim() === ${JSON.stringify(label)}`),
    15000
  )

/** 找到基金配置表格中指定代码的行 */
const rowExpr = (code) =>
  `[...document.querySelectorAll('.table-fund-config tbody tr')].find((tr) => tr.children[0]?.textContent.trim() === ${JSON.stringify(code)})`

const clickEdit = (code) =>
  evalJs(`(() => {
    const tr = ${rowExpr(code)}
    const btn = [...(tr?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '编辑')
    if (!btn) return false
    btn.click()
    return true
  })()`)

const clickRowButton = (code, label) =>
  evalJs(`(() => {
    const tr = ${rowExpr(code)}
    const btn = [...(tr?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!btn) return false
    btn.click()
    return true
  })()`)

/** 编辑态设置文本/数字输入（React 受控：走原生 value setter + input 事件） */
const setRowInput = (code, fieldSelector, value) =>
  evalJs(`(() => {
    const tr = ${rowExpr(code)}
    const input = tr?.querySelector(${JSON.stringify(fieldSelector)})
    if (!input) return false
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/** 编辑态设置下拉框（React 受控：原生 value setter + change 事件） */
const setRowSelect = (code, fieldSelector, value) =>
  evalJs(`(() => {
    const tr = ${rowExpr(code)}
    const select = tr?.querySelector(${JSON.stringify(fieldSelector)})
    if (!select) return false
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)

const resetConfirms = () => evalJs('window.__confirms = [], true')
const readConfig = async () => {
  const state = await evalJs(READ_FUND_CONFIG)
  return state.missing === undefined ? state : null
}

// ---- 5. 基金配置页：列表、只读代码、无新建/删除 -----------------------------
const appReady = await waitFor(
  () => evalJs(`document.querySelectorAll('.nav-item').length > 0`),
  20000
)
if (!appReady) {
  console.error('RED: 应用界面未渲染出侧栏')
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
console.log('基金配置页')
await navigate('基金配置')
const listed = await waitFor(readConfig, 20000)
check(listed !== null, '基金配置页渲染出基金表格')
if (listed === null) {
  for (const l of logs) console.error(`  console: ${l}`)
  cleanup()
  process.exit(1)
}
check(listed.sidebar.includes('基金配置'), '侧栏有「基金配置」入口', listed.sidebar.join('/'))
check(listed.heading === '基金配置', '页面标题为「基金配置」', listed.heading)
check(JSON.stringify(listed.headers) === JSON.stringify(HEADERS), '表头为 7 列', listed.headers.join('/'))

const codes = listed.rows.map((r) => r.code)
check(
  ['910001', '910002', '910003', '910004', '910005'].every((c) => codes.includes(c)),
  '列出全部基金（含已清仓 910005）',
  codes.join(', ')
)
check(
  listed.rows.every((r) => !r.codeHasInput),
  '基金代码只读（代码单元格无输入控件）'
)
check(
  listed.pageButtons.every((t) => !/新建|删除/.test(t)),
  '页面不提供新建或删除基金入口',
  listed.pageButtons.join('/')
)
check(listed.pageButtons.includes('刷新全部'), '页面提供「刷新全部」批量动作', listed.pageButtons.join('/'))
check(
  listed.rows.every((r) => JSON.stringify(r.actions) === JSON.stringify(['编辑', '抓取'])),
  '每行有「编辑」与「抓取」入口',
  listed.rows.map((r) => r.actions.join('+')).join(' / ')
)

// ---- 6. 只改权益系数：不弹确认，落库并立即反映到配置对比 ---------------------
console.log('权益系数编辑')
const beforeRatioEdit = expectedMarketRatios()
await resetConfirms()
check(await clickEdit('910003') === true, '进入 910003 行编辑')
check(await setRowInput('910003', 'input[type="number"]', '50') === true, '把 910003 权益系数改为 50%')
check(await clickRowButton('910003', '保存') === true, '保存 910003')
const savedRatio = await waitFor(async () => {
  const state = await readConfig()
  const fund = dbFund('910003')
  return state !== null && fund.equity_ratio === 0.5 && state.message !== null ? { state, fund } : null
}, 10000)
check(savedRatio !== null, '权益系数 50% 已落库')
if (savedRatio !== null) {
  check(
    savedRatio.fund.equity_ratio_source === 'manual',
    '手工修改后系数来源记为 manual',
    savedRatio.fund.equity_ratio_source
  )
  check(
    savedRatio.state.message.includes('只影响当前配置'),
    '保存提示说明系数只影响当前配置',
    savedRatio.state.message
  )
  check(savedRatio.state.confirms.length === 0, '改系数不弹确认', savedRatio.state.confirms.join(' / '))
}
check(beforeRatioEdit['权益'] !== expectedMarketRatios()['权益'], '独立重算显示权益桶市值占比已变化')

await navigate('概览')
const allocation = await waitFor(async () => {
  const state = await evalJs(READ_ALLOCATION)
  return state.error === undefined ? state : null
}, 15000)
check(allocation !== null, '概览配置对比表可读取')
if (allocation !== null) {
  const expected = expectedMarketRatios()
  const bad = allocation.rows.filter((r) => !samePercent(r.marketRatio, expected[r.bucket]))
  check(
    bad.length === 0,
    '编辑结果立即反映到配置对比（权益桶按新系数重算）',
    bad.map((r) => `${r.bucket} ${r.marketRatio} vs ${expected[r.bucket].toFixed(2)}%`).join('; ')
  )
  check(
    allocation.rows.map((r) => r.bucket).join('/') === BUCKETS.join('/'),
    '配置对比仍为三桶固定行',
    allocation.rows.map((r) => r.bucket).join('/')
  )
}

// ---- 7. 改产品形态：先确认，再重分类 ---------------------------------------
console.log('产品形态 / 账本大类编辑')
await navigate('基金配置')
await waitFor(readConfig, 15000)
await resetConfirms()
check(await clickEdit('910002') === true, '进入 910002 行编辑')
check(await setRowSelect('910002', 'select', '固收+') === true, '把 910002 产品形态改为 固收+')
const draftState = await readConfig()
const draftRow = draftState?.rows.find((r) => r.code === '910002')
check(
  draftRow?.ledgerCategory === '债',
  '产品形态变更后账本大类自动跟随固定映射',
  draftRow?.ledgerCategory ?? '缺行'
)

// 取消确认：不落库，仍停留在编辑态
await evalJs('window.__confirmAnswer = false, true')
check(await clickRowButton('910002', '保存') === true, '取消确认：点击保存')
await new Promise((r) => setTimeout(r, 500))
check(dbFund('910002').product_form === '纯债', '取消确认后分类不落库', dbFund('910002').product_form)
const afterCancel = await readConfig()
check(
  afterCancel?.confirms.length === 1 &&
    afterCancel.rows.find((r) => r.code === '910002')?.productForm === '固收+',
  '取消后仍停留在编辑态且保留草稿',
  afterCancel?.confirms.length ?? '缺页'
)
await evalJs('window.__confirmAnswer = true, true')

check(await clickRowButton('910002', '保存') === true, '保存 910002 分类变更')
const reclassified = await waitFor(async () => {
  const fund = dbFund('910002')
  const state = await readConfig()
  return fund.product_form === '固收+' && fund.ledger_category === '债' && state?.message !== null
    ? { fund, state }
    : null
}, 10000)
check(reclassified !== null, '确认后产品形态与账本大类已重分类落库')
if (reclassified !== null) {
  check(
    reclassified.state.confirms.length === 2 &&
      reclassified.state.confirms.every(
        (m) => m.includes('全部历史') && m.includes('没有生效日期')
      ),
    '改分类前弹出历史重算确认（说明全部历史与无生效日期）',
    reclassified.state.confirms.join(' / ')
  )
}

await navigate('概览')
const groups = await waitFor(async () => {
  const state = await evalJs(READ_GROUPS)
  return state.error === undefined ? state : null
}, 15000)
check(groups !== null, '概览持仓明细可读取')
if (groups !== null) {
  const groupOf = (code) => groups.groups.find((g) => g.codes.includes(code))?.name ?? null
  check(groupOf('910002') === '固收+', '重分类后 910002 立即出现在固收+分组', String(groupOf('910002')))
}

// ---- 8. 产品形态与账本大类不一致：拒绝且不改库 ------------------------------
console.log('一致性校验')
await navigate('基金配置')
await waitFor(readConfig, 15000)
const beforeMismatch = dbFund('910001')
await resetConfirms()
await clickEdit('910001')
await setRowSelect('910001', 'td:nth-child(3) select', '固收+')
check(await setRowSelect('910001', 'td:nth-child(4) select', '权益') === true, '把 910001 账本大类改为 权益（与固收+ 不一致）')
check(await clickRowButton('910001', '保存') === true, '保存不一致组合')
const mismatch = await waitFor(async () => {
  const state = await readConfig()
  return state?.error !== null ? state : null
}, 10000)
check(mismatch !== null, '不一致时显示错误 banner')
if (mismatch !== null) {
  check(mismatch.error.includes('不一致'), '错误说明产品形态与账本大类不一致', mismatch.error)
  const after = dbFund('910001')
  check(
    after.product_form === beforeMismatch.product_form &&
      after.ledger_category === beforeMismatch.ledger_category &&
      after.equity_ratio === beforeMismatch.equity_ratio,
    '被拒绝后库内字段不变'
  )
}

// ---- 9. 权益系数 0–100% 限制 ------------------------------------------------
await setRowSelect('910001', 'td:nth-child(4) select', '债')
check(await setRowInput('910001', 'input[type="number"]', '120') === true, '把 910001 权益系数改为 120%')
check(await clickRowButton('910001', '保存') === true, '保存越界系数')
const ratioRejected = await waitFor(async () => {
  const state = await readConfig()
  return state?.error?.includes('权益系数') ? state : null
}, 10000)
check(ratioRejected !== null, '权益系数越界被拒绝并提示 0–100%', ratioRejected?.error ?? '缺少错误')
check(dbFund('910001').equity_ratio === 0.2, '越界系数未写入库', String(dbFund('910001').equity_ratio))
await clickRowButton('910001', '取消')

// ---- 10. 新建基金表单使用产品形态，账本大类派生正确 ------------------------
console.log('新建基金表单')
await navigate('交易流水')
await waitFor(() => evalJs(`document.querySelector('.page h1')?.textContent?.trim() === '交易流水'`), 15000)
await evalJs(
  `[...document.querySelectorAll('.page-actions button')].find((b) => b.textContent.trim() === '新增流水')?.click(), true`
)
await waitFor(() => evalJs(`document.querySelector('.form-card') !== null`), 10000)
await evalJs(
  `[...document.querySelectorAll('.form-card .form-field button')].find((b) => b.textContent.includes('新建基金'))?.click(), true`
)
const fundForm = await waitFor(
  () =>
    evalJs(`(() => {
      const form = document.querySelector('.fund-form')
      if (!form) return null
      const labels = [...form.querySelectorAll('label.form-field')].map((l) => ({
        label: l.querySelector('span')?.textContent?.trim() ?? '',
        options: [...(l.querySelector('select')?.options ?? [])].map((o) => o.value)
      }))
      return labels
    })()`),
  10000
)
check(fundForm !== null, '新建基金表单可展开')
if (fundForm !== null) {
  const formLabels = fundForm.map((f) => f.label)
  check(formLabels.includes('产品形态'), '新表单使用「产品形态」', formLabels.join('/'))
  check(!formLabels.includes('资产大类'), '新表单不再出现旧「资产大类」', formLabels.join('/'))
  const productFormField = fundForm.find((f) => f.label === '产品形态')
  check(
    JSON.stringify(productFormField?.options) === JSON.stringify(PRODUCT_FORMS),
    '产品形态选项为四种闭集',
    productFormField?.options?.join('/') ?? '缺字段'
  )
}

/** 新建基金表单字段：按标签文字定位 */
const setFundFormField = (label, value, kind = 'input') =>
  evalJs(`(() => {
    const field = [...document.querySelectorAll('.fund-form label.form-field')].find(
      (l) => l.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)}
    )
    const el = field?.querySelector(${JSON.stringify(kind)})
    if (!el) return false
    const proto = ${kind === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
    el.dispatchEvent(new Event(${JSON.stringify(kind === 'select' ? 'change' : 'input')}, { bubbles: true }))
    return true
  })()`)

check(await setFundFormField('基金代码', '900099') === true, '填写新基金代码')
check(await setFundFormField('基金名称', '测试新建基金') === true, '填写新基金名称')
check(await setFundFormField('产品形态', '固收+', 'select') === true, '选择产品形态 固收+')
await evalJs(
  `[...document.querySelectorAll('.fund-form button')].find((b) => b.textContent.trim() === '创建基金')?.click(), true`
)
const created = await waitFor(() => dbFund('900099'), 10000)
check(created !== null, '新基金已创建')
if (created !== null) {
  check(
    created.product_form === '固收+' && created.ledger_category === '债',
    '新基金账本大类由产品形态派生',
    `${created.product_form}/${created.ledger_category}`
  )
  check(created.equity_ratio === 0.2 && created.equity_ratio_source === 'manual', '新基金默认权益系数 20%')
}

// 给新基金补一笔买入，验证它进入正确的持仓分组
await evalJs(`(() => {
  const set = (label, value) => {
    const field = [...document.querySelectorAll('.form-card .form-grid label.form-field')].find(
      (l) => l.querySelector('span')?.textContent.trim().startsWith(label)
    )
    const el = field?.querySelector('input,select')
    if (!el) return false
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value))
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    return true
  }
  set('日期', '2026-02-01')
  set('金额', '1000')
  set('份额', '1000')
  set('净值', '1')
  return true
})()`)
await evalJs(
  `[...document.querySelectorAll('.form-card .preview-actions button')].find((b) => b.textContent.trim() === '保存')?.click(), true`
)
const bought = await waitFor(() => {
  const db = new Database(dbPath, { readonly: true })
  db.pragma('busy_timeout = 5000')
  const n = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE fund_code = '900099'")
    .get().n
  db.close()
  return n === 1
}, 10000)
check(bought === true, '新基金买入流水已保存')

// 补一条净值（等价于用户在净值管理页录入），让新基金进入配置对比的市值口径
{
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  db.prepare(
    "INSERT OR REPLACE INTO nav_history (fund_code, date, nav, source) VALUES ('900099','2026-02-01',1,'manual')"
  ).run()
  db.close()
}

await navigate('概览')
const overviewGroups = await waitFor(async () => {
  const state = await evalJs(READ_GROUPS)
  return state.error === undefined ? state : null
}, 15000)
if (overviewGroups !== null) {
  const groupOf = (code) => overviewGroups.groups.find((g) => g.codes.includes(code))?.name ?? null
  check(groupOf('900099') === '固收+', '新建基金出现在正确的固收+分组', String(groupOf('900099')))
} else {
  check(false, '概览持仓明细可读取（新基金分组校验）')
}

// 新建基金按默认权益系数进入配置对比（市值口径参与三桶重算）
const finalAllocation = await waitFor(async () => {
  const state = await evalJs(READ_ALLOCATION)
  return state.error === undefined ? state : null
}, 15000)
check(finalAllocation !== null, '概览配置对比可读取（新基金桶占比校验）')
if (finalAllocation !== null) {
  const expected = expectedMarketRatios()
  const bad = finalAllocation.rows.filter((r) => !samePercent(r.marketRatio, expected[r.bucket]))
  check(
    bad.length === 0,
    '新建基金按默认权益系数进入配置对比',
    bad.map((r) => `${r.bucket} ${r.marketRatio} vs ${expected[r.bucket].toFixed(2)}%`).join('; ')
  )
}

// ---- 11. 手动抓取：失败保留旧值、批量继续、候选确认与来源 --------------------
console.log('手动抓取权益系数')
await navigate('基金配置')
await waitFor(readConfig, 15000)

const rowOf = async (code) => {
  const state = await readConfig()
  return state?.rows.find((r) => r.code === code) ?? null
}
const waitForRow = (code, predicate, ms = 30000) =>
  waitFor(async () => {
    const row = await rowOf(code)
    return row !== null && predicate(row) ? row : null
  }, ms)
const reportDateOf = (row) => {
  const match = /报告期 (\d{4}-\d{2}-\d{2})/.exec(row?.candidateMeta ?? '')
  return match === null ? null : match[1]
}
const clickPageAction = (label) =>
  evalJs(
    `[...document.querySelectorAll('.page-actions button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(), true`
  )

// 11.1 单只失败：假代码无公开数据；逐行报错且原系数/来源不变
const beforeFailedFetch = dbFund('910001')
check((await clickRowButton('910001', '抓取')) === true, '点击 910001 行「抓取」')
const failedRow = await waitForRow('910001', (row) => row.candidateError !== null)
check(failedRow !== null, '抓取失败逐行显示错误', failedRow?.candidateError ?? '缺少错误')
check(
  failedRow !== null && failedRow.candidateError.includes('抓取失败'),
  '错误说明抓取失败原因',
  failedRow?.candidateError ?? '缺少错误'
)
const afterFailedFetch = dbFund('910001')
check(
  afterFailedFetch.equity_ratio === beforeFailedFetch.equity_ratio &&
    afterFailedFetch.equity_ratio_source === beforeFailedFetch.equity_ratio_source,
  '抓取失败保留旧权益系数与来源',
  `${afterFailedFetch.equity_ratio}/${afterFailedFetch.equity_ratio_source}`
)
check(
  afterFailedFetch.equity_ratio_as_of === beforeFailedFetch.equity_ratio_as_of,
  '抓取失败保留原数据日期'
)

// 11.2 刷新全部：真实代码出现候选值，假代码逐行报错，批次继续
const beforeBatch = dbFund('000001')
check((await clickPageAction('刷新全部')) === true, '点击「刷新全部」')
const batchDone = await waitFor(async () => {
  const state = await readConfig()
  if (state === null) return null
  const real = state.rows.find((r) => r.code === '000001')
  const fake = state.rows.find((r) => r.code === '910001')
  const hasCandidate = typeof real?.candidateRatio === 'string' && real.candidateRatio !== ''
  if (hasCandidate && real.candidateMeta !== '' && fake?.candidateError !== null && state.message?.includes('刷新完成')) {
    return { state, real, fake }
  }
  return null
}, 60000)
check(batchDone !== null, '刷新全部完成：真实代码有候选值，假代码逐行报错且批次继续')
if (batchDone !== null) {
  check(
    JSON.stringify(batchDone.real.candidateButtons) === JSON.stringify(['确认写入', '忽略']),
    '候选值旁提供「确认写入」「忽略」',
    batchDone.real.candidateButtons.join('/')
  )
  check(
    batchDone.real.candidateMeta.includes('来源：东方财富') &&
      reportDateOf(batchDone.real) !== null,
    '候选值显示报告期与来源',
    batchDone.real.candidateMeta
  )
  check(
    dbFund('000001').equity_ratio === beforeBatch.equity_ratio &&
      dbFund('000001').equity_ratio_source === beforeBatch.equity_ratio_source,
    '用户确认前候选值不写库'
  )
}

// 11.3 未改值确认：来源记为抓取，数据日期为报告期
const candidatePercent = batchDone === null ? null : num(batchDone.real.candidateRatio)
const candidateReportDate = batchDone === null ? null : reportDateOf(batchDone.real)
check(
  candidatePercent !== null && candidateReportDate !== null,
  '能读取候选股票占净比与报告期',
  `${String(candidatePercent)}% / ${String(candidateReportDate)}`
)
check((await clickRowButton('000001', '确认写入')) === true, '未改值点击「确认写入」')
const savedAsFetch = await waitFor(() => {
  const fund = dbFund('000001')
  return fund.equity_ratio_source === 'fetch' && fund.equity_ratio_as_of === candidateReportDate
    ? fund
    : null
}, 10000)
check(savedAsFetch !== null, '未改值确认后来源记为抓取，数据日期为报告期')
if (savedAsFetch !== null && candidatePercent !== null) {
  check(
    Math.abs(savedAsFetch.equity_ratio - candidatePercent / 100) < 1e-6,
    '抓取系数按候选值原样写入',
    String(savedAsFetch.equity_ratio)
  )
  const stateAfterFetch = await readConfig()
  check(
    stateAfterFetch?.message?.includes('来源：抓取') === true,
    '确认提示说明来源为抓取',
    stateAfterFetch?.message ?? '缺少提示'
  )
}

// 11.4 改过值确认：来源记为手工，数据日期仍保留报告期
check((await clickRowButton('000001', '抓取')) === true, '手工值场景再次抓取 000001')
const secondCandidate = await waitForRow(
  '000001',
  (row) => typeof row.candidateRatio === 'string' && row.candidateRatio !== ''
)
check(secondCandidate !== null, '再次抓取出现候选值')
const secondPercent = secondCandidate === null ? null : num(secondCandidate.candidateRatio)
const secondReportDate = secondCandidate === null ? null : reportDateOf(secondCandidate)
const modifiedPercent =
  secondPercent === null ? 42 : Math.abs(secondPercent - 42) < 0.005 ? 43 : 42
check(
  (await setRowInput('000001', '.fund-config-candidate-ratio', String(modifiedPercent))) === true,
  '修改候选值为不同数值',
  `${modifiedPercent}%`
)
check((await clickRowButton('000001', '确认写入')) === true, '改值后点击「确认写入」')
const savedAsManual = await waitFor(() => {
  const fund = dbFund('000001')
  return fund.equity_ratio_source === 'manual' &&
    Math.abs(fund.equity_ratio - modifiedPercent / 100) < 1e-9
    ? fund
    : null
}, 10000)
check(savedAsManual !== null, '改过值确认后来源记为手工')
if (savedAsManual !== null) {
  check(
    savedAsManual.equity_ratio_as_of === secondReportDate,
    '改值确认仍保留报告期作为数据日期',
    String(savedAsManual.equity_ratio_as_of)
  )
  const stateAfterManual = await readConfig()
  check(
    stateAfterManual?.message?.includes('来源：手工') === true,
    '确认提示说明来源为手工',
    stateAfterManual?.message ?? '缺少提示'
  )
}

// 11.5 手工值不被静默覆盖：候选值出现期间库内手工值保持不变
check((await clickRowButton('000001', '抓取')) === true, '手工值场景第三次抓取')
const thirdCandidate = await waitForRow(
  '000001',
  (row) => typeof row.candidateRatio === 'string' && row.candidateRatio !== ''
)
check(thirdCandidate !== null, '候选值再次出现')
await new Promise((resolve) => setTimeout(resolve, 500))
const manualPreserved = dbFund('000001')
check(
  manualPreserved.equity_ratio_source === 'manual' &&
    Math.abs(manualPreserved.equity_ratio - modifiedPercent / 100) < 1e-9,
  '候选值未静默覆盖手工系数',
  `${manualPreserved.equity_ratio}/${manualPreserved.equity_ratio_source}`
)
check((await clickRowButton('000001', '忽略')) === true, '点击「忽略」丢弃候选值')
const ignored = await waitForRow('000001', (row) => row.candidateRatio === null, 5000)
check(ignored !== null, '忽略后候选值消失')
check(
  dbFund('000001').equity_ratio_source === 'manual',
  '忽略候选值后手工值仍在',
  dbFund('000001').equity_ratio_source
)

// ---- 12. 收尾 ---------------------------------------------------------------
for (const l of logs) console.error(`  console: ${l}`)
cleanup()

if (failures.length > 0) {
  console.error(`RED: ${failures.length} 项断言失败：${failures.join('；')}`)
  process.exit(1)
}
console.log(`GREEN: 基金配置页全部断言通过（console 消息 ${logs.length} 条）`)
process.exit(0)
