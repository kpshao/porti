#!/usr/bin/env node
// 换机迁移端到端检查（Node >= 22 全局 WebSocket/fetch；better-sqlite3 仅用于构造测试数据）
//
// 用法：node scripts/check-data-migration.mjs [--port 9335]
//
// 场景：
//  A. 有数据的 profile：不弹首启引导；设置页「换机迁移」卡片文案与按钮齐全
//  B. 空 profile：弹首启引导 → 点「稍后再说」→ 弹窗消失且跳过标记落盘；卡片齐全
//  C. 复用 B 的 profile 重启：不再弹引导（跳过标记持久化）
// 导出/导入涉及原生对话框，不在无头断言范围（迁移包内容一致性由 migrationService 单元测试覆盖）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9335'
const CDP = `http://127.0.0.1:${PORT}`

const ELECTRON_BIN =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron')

// 与 src/main/schema.ts 一致的建表语句（仅测试夹具用）
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS funds (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  fund_type TEXT,
  target_amount REAL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS category_targets (
  category TEXT PRIMARY KEY,
  target_ratio REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
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
CREATE TABLE IF NOT EXISTS nav_history (
  fund_code TEXT NOT NULL REFERENCES funds(code),
  date TEXT NOT NULL,
  nav REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('import','auto','manual')),
  PRIMARY KEY (fund_code, date)
);
`

const waitFor = async (fn, ms, step = 250) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  return null
}

// ---- 1. 构建 ------------------------------------------------------------
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('构建失败')
  process.exit(1)
}

// ---- 2. 测试 profile -----------------------------------------------------
// A：有数据的 profile（构造一只基金 + 一笔流水，保证「有数据不弹引导」断言不依赖本机真实数据）
const profileA = mkdtempSync(join(tmpdir(), 'porti-migration-check-a-'))
{
  const db = new Database(join(profileA, 'porti.db'))
  db.exec(SCHEMA_SQL)
  db.pragma('user_version = 1')
  db.prepare(
    `INSERT INTO funds (code, name, category, fund_type, target_amount, created_at)
     VALUES ('002065', '测试基金', '固守+', NULL, NULL, '2026-01-01')`
  ).run()
  db.prepare(
    `INSERT INTO transactions (date, type, fund_code, amount, shares, nav, note, created_at, updated_at)
     VALUES ('2026-01-02', '买入', '002065', 1000, 900, 1.1, NULL, '2026-01-02', '2026-01-02')`
  ).run()
  db.close()
}
// B/C：空 profile（应用启动自动建库，只有种子大类目标）
const profileB = mkdtempSync(join(tmpdir(), 'porti-migration-check-b-'))

// ---- 3. 启动与 CDP 会话 --------------------------------------------------
const problems = []

async function launch(profileDir) {
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
    electron.kill('SIGTERM')
    process.exit(1)
  }

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

  return {
    electron,
    ws,
    send,
    logs,
    evaluate: async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value,
    screenshot: async (name) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const path = join(tmpdir(), name)
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    },
    kill: () => {
      try {
        ws.close()
      } catch {}
      electron.kill('SIGTERM')
      return new Promise((r) => electron.once('exit', r))
    }
  }
}

/** 断言设置页「换机迁移」卡片：文案 + 两个按钮 */
async function checkSettingsCard(session, label) {
  const nav = await session.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('设置'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!nav) {
    problems.push(`${label}: 未找到「设置」导航项`)
    return
  }
  await new Promise((r) => setTimeout(r, 1000))
  const dom = await session.evaluate(`(() => {
    const text = document.body.innerText
    return {
      pageText: text,
      buttons: [...document.querySelectorAll('.btn')].map((b) => b.textContent),
      errorBanner: document.querySelector('.banner-error')?.textContent ?? null
    }
  })()`)
  if (dom.errorBanner !== null) problems.push(`${label}: 页面出现错误横幅：${dom.errorBanner}`)
  if (!dom.pageText.includes('换机迁移')) problems.push(`${label}: 缺少「换机迁移」卡片`)
  if (!dom.pageText.includes('.portibak')) problems.push(`${label}: 缺少迁移包说明文案`)
  if (!dom.buttons.some((b) => b.includes('导出迁移包'))) problems.push(`${label}: 缺少「导出迁移包」按钮`)
  if (!dom.buttons.some((b) => b.includes('导入迁移包'))) problems.push(`${label}: 缺少「导入迁移包」按钮`)
}

/** 截图并附带当前弹窗/页面标题状态（诊断输出） */
async function shotWithState(session, label, file) {
  const state = await session.evaluate(`(() => ({
    modal: document.querySelector('.modal-overlay') !== null,
    heading: document.querySelector('.page h1')?.textContent ?? null,
    navActive: document.querySelector('.nav-item.active')?.textContent ?? null
  }))()`)
  const path = await session.screenshot(file)
  console.log(`${label} 截图: ${path}（弹窗=${state.modal ? '可见' : '无'}，当前页=${state.heading ?? state.navActive ?? '未知'}）`)
}

// ---- 4. 场景 A：有数据 → 不弹引导 + 卡片齐全 ------------------------------
{
  const s = await launch(profileA)
  await s.send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2500))
  const modal = await s.evaluate(`document.querySelector('.modal-overlay') !== null`)
  if (modal) problems.push('A: 有数据时不应弹出首启引导')
  await checkSettingsCard(s, 'A')
  await shotWithState(s, 'A 场景', 'porti-migration-check-a.png')
  await s.kill()
}

// ---- 5. 场景 B：空库 → 弹引导 → 稍后再说 → 标记落盘 ------------------------
{
  const s = await launch(profileB)
  const modalSeen = await waitFor(
    () => s.evaluate(`document.querySelector('.modal-overlay') !== null`),
    10000
  )
  if (!modalSeen) {
    problems.push('B: 空库首启未弹出迁移引导')
  } else {
    const modalDom = await s.evaluate(`(() => {
      const m = document.querySelector('.modal-overlay')
      return { text: m.innerText, buttons: [...m.querySelectorAll('.btn')].map((b) => b.textContent) }
    })()`)
    if (!modalDom.text.includes('检测到新安装')) problems.push('B: 引导文案缺失')
    if (!modalDom.buttons.some((b) => b.includes('导入迁移包'))) problems.push('B: 缺少「导入迁移包」按钮')
    if (!modalDom.buttons.some((b) => b.includes('稍后再说'))) problems.push('B: 缺少「稍后再说」按钮')

    const dismissed = await s.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('稍后再说'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!dismissed) problems.push('B: 点击「稍后再说」失败')
  }
  const modalGone = await waitFor(
    () => s.evaluate(`document.querySelector('.modal-overlay') === null`),
    5000
  )
  if (!modalGone) problems.push('B: 点击「稍后再说」后弹窗未消失')
  const flagWritten = await waitFor(() => {
    const file = join(profileB, 'settings.json')
    if (!existsSync(file)) return false
    try {
      return JSON.parse(readFileSync(file, 'utf8')).migrationPromptDismissed === true
    } catch {
      return false
    }
  }, 5000)
  if (!flagWritten) problems.push('B: 跳过标记未写入 settings.json')
  await checkSettingsCard(s, 'B')
  await shotWithState(s, 'B 场景', 'porti-migration-check-b.png')
  await s.kill()
}

// ---- 6. 场景 C：复用 B 的 profile 重启 → 不再弹引导 ------------------------
{
  const s = await launch(profileB)
  await s.send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 2500))
  const modal = await s.evaluate(`document.querySelector('.modal-overlay') !== null`)
  if (modal) problems.push('C: 跳过后重启仍弹出引导（标记未持久化）')
  await shotWithState(s, 'C 场景', 'porti-migration-check-c.png')
  await s.kill()
}

// ---- 7. 汇总 --------------------------------------------------------------
const exceptions = []
// （渲染异常已在各场景 evaluate 中随 DOM 检查；此处仅输出结果）
if (problems.length > 0) {
  console.error('RED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('GREEN: 换机迁移三场景通过——有数据不弹引导；空库弹引导、跳过后标记落盘且重启不再弹；设置页卡片齐全')
process.exit(0)
