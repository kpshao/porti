#!/usr/bin/env node
// 打包安装冒烟验证（Node >= 22 全局 WebSocket/fetch + 系统 osascript/hdiutil；
// 回读断言复用项目运行时依赖 xlsx 与 better-sqlite3，无新增依赖）
//
// 用法：node scripts/check-packaged-app.mjs [--dmg <path>] [--port 9336] [--manual-dialogs]
//
// 流程：挂载 dmg → 安装到 /Applications → 启动安装版 Porti（带防节流旗标）→
// CDP 驱动一轮「导入 Excel → 概览查看 → 改流水（改备注并还原）→ 导出 Excel」→
// 回读导出文件与数据库断言。原生文件对话框由 AppleScript 键入驱动
// （Cmd+Shift+G 路径跳转），运行前需在「系统设置 → 隐私与安全性 → 辅助功能」
// 中授权本终端，否则对话框环节会失败。
//
// 退出码：0 = GREEN；1 = RED。安装版保留在 /Applications（冒烟数据即首次导入
// 的真实数据，可继续使用）。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DMG = process.argv.includes('--dmg')
  ? resolve(process.argv[process.argv.indexOf('--dmg') + 1])
  : join(ROOT, 'release', 'Porti-0.1.0-arm64.dmg')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9336'
// --manual-dialogs：不用 AppleScript 驱动原生对话框（免辅助功能授权），
// 对话框弹出时打印操作提示，由用户手动完成后脚本轮询状态继续。
const MANUAL = process.argv.includes('--manual-dialogs')
const DIALOG_TIMEOUT = MANUAL ? 900000 : 20000
const CDP = `http://127.0.0.1:${PORT}`
const APP_PATH = '/Applications/Porti.app'
const APP_BIN = join(APP_PATH, 'Contents/MacOS/Porti')
const XLSX = join(ROOT, '投资跟踪.xlsx')
const USER_DATA = join(process.env.HOME, 'Library/Application Support/Porti')
const EXPORT_DIR = mkdtempSync(join(tmpdir(), 'porti-smoke-export-'))
const SHOTS = mkdtempSync(join(tmpdir(), 'porti-smoke-shots-'))
let mountPoint = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 0. 前置检查 -----------------------------------------------------------
if (process.platform !== 'darwin') fail('本脚本仅支持 macOS（依赖 osascript/hdiutil 与 /Applications）')
if (!existsSync(DMG)) fail(`未找到 dmg：${DMG}（先 npm run package:mac）`)
if (!existsSync(XLSX)) fail(`未找到导入 fixture：${XLSX}`)

// 冒烟断言基准（投资跟踪.xlsx 的对账 golden 值，与 spec 验收一致）
const GOLDEN = {
  totalAssets: 775962.32,
  totalPnl: -8351.48,
  totalReturnRate: '-1.06%',
  fundCount: 10,
  transactionCount: 69
}

// 备份并移除首次安装前的旧数据，保证「全新安装首次导入」起点。
// 注意 macOS 文件系统大小写不敏感：「Porti」与「porti」是同一目录，
// 开发版与安装版共享本目录，因此必须先移除旧库，否则会重复导入导致断言失真。
// 备份后缀带小时：同日多次跑冒烟（如手动模式失败重跑）不会覆盖上一轮的备份
const backupSuffix = `.bak-${new Date().toISOString().slice(0, 13)}`
for (const name of ['porti.db', 'porti.db-wal', 'porti.db-shm', 'settings.json']) {
  const f = join(USER_DATA, name)
  if (existsSync(f)) {
    cpSync(f, `${f}${backupSuffix}`, { force: true })
    rmSync(f)
  }
}

// 退出可能残留的安装版实例
spawnSync('pkill', ['-f', '/Applications/Porti.app/Contents/MacOS/Porti'], { timeout: 10000 })

// ---- 1. 挂载 dmg 并安装 ------------------------------------------------------
const mount = spawnSync('hdiutil', ['attach', DMG, '-nobrowse', '-readonly', '-plist'], {
  encoding: 'utf8'
})
if (mount.status !== 0) fail(`dmg 挂载失败：${mount.stderr}`)
mountPoint = mount.stdout.split('<key>mount-point</key>')[1]?.split('<string>')[1]?.split('</string>')[0]
if (!mountPoint) fail('未解析到 dmg 挂载点')
rmSync(APP_PATH, { recursive: true, force: true })
// 用 ditto 拷贝（与 Finder 拖拽一致的 bundle 保真复制）。不能用 Node 的 cpSync：
// 它会把 framework 内部的相对符号链接改写成指向 dmg 挂载点的绝对路径，
// 卸载 dmg 后安装版即损坏（dyld 无法加载 Electron Framework）。
const copy = spawnSync('ditto', [join(mountPoint, 'Porti.app'), APP_PATH], { timeout: 120000 })
if (copy.status !== 0) fail(`ditto 拷贝失败：${copy.stderr}`)
console.log(`已安装：dmg 挂载点 ${mountPoint} → ${APP_PATH}`)

// ---- 2. 启动安装版 -----------------------------------------------------------
const app = spawn(
  APP_BIN,
  [
    `--remote-debugging-port=${PORT}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=OptimizationGuideModelDownloading'
  ],
  { stdio: 'ignore' }
)

const waitFor = async (fn, ms, step = 300) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

const pageTarget = await waitFor(
  () =>
    fetch(`${CDP}/json/list`)
      .then((r) => r.json())
      .then((ts) => ts.find((t) => t.type === 'page' && t.url.includes('index.html')))
      .catch(() => null),
  30000
)
if (!pageTarget) fail('安装版启动超时：未发现页面 target')

// ---- 3. CDP 通道 ------------------------------------------------------------
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
const pending = new Map()
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
    const { resolve: res, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : res(m.result)
  }
}
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 2000))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`页面表达式异常：${r.exceptionDetails.text}`)
  return r.result.value
}

async function clickNav(label) {
  // 安装版首次启动较慢（asar 解包/冷启动），轮询等待导航渲染完成
  const ok = await waitFor(
    () =>
      evaluate(`(() => {
        const btn = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
        if (!btn) return false
        btn.click()
        return true
      })()`).catch(() => false),
    30000
  )
  if (!ok) fail(`未找到导航项「${label}」`)
  await sleep(1200)
}

async function clickButtonByText(text) {
  return evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 切到「全部基金」口径：等分段控件渲染后点击，15s 内未成功即 fail。
 *  GOLDEN 是改动前的全部基金口径（含已清仓基金），卡片默认「在持基金」需先切换。 */
async function selectAllScope(where) {
  const ok = await waitFor(
    () =>
      evaluate(`(() => {
        const btn = [...document.querySelectorAll('.scope-switch-btn')].find((b) => b.textContent.trim() === '全部基金')
        if (!btn) return false
        if (btn.getAttribute('aria-pressed') === 'true') return true
        btn.click()
        return false
      })()`).catch(() => false),
    15000
  )
  if (!ok) fail(`${where}未能切到「全部基金」口径（GOLDEN 为全部基金口径）`)
}

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(SHOTS, name)
  writeFileSync(p, Buffer.from(s.data, 'base64'))
  return p
}

// ---- AppleScript 对话框驱动 ---------------------------------------------------
function runAppleScriptChecked(script) {
  const r = spawnSync('osascript', ['-e', script], { timeout: 20000, encoding: 'utf8' })
  if (r.status !== 0) {
    if (/不允许发送按键|not allowed to send keystrokes/.test(r.stderr)) {
      fail(
        'AppleScript 键盘控制被拒：请在「系统设置 → 隐私与安全性 → 辅助功能」中授权运行本会话的终端 App，然后重跑本脚本'
      )
    }
    throw new Error(`AppleScript 失败（${r.stderr.trim()}）`)
  }
}

/** 探测 Porti 的窗口/对话框结构（诊断用；结构差异大时返回 raw 字符串） */
function dialogState() {
  const r = spawnSync(
    'osascript',
    [
      '-e',
      `tell application "System Events"
  tell process "Porti"
    set info to "frontmost=" & (frontmost as text) & " wins=" & (count of windows)
    repeat with i from 1 to (count of windows)
      try
        set info to info & " | w" & i & ":" & (name of window i)
        set info to info & " sheets=" & (count of sheets of window i)
      end try
      try
        set info to info & " field1=" & (value of text field 1 of sheet 1 of window i)
      end try
    end repeat
    return info
  end tell
end tell`
    ],
    { timeout: 10000, encoding: 'utf8' }
  )
  return r.status === 0 ? r.stdout.trim() : `(探测失败 ${r.stderr.trim()})`
}

/** 全屏截图取证（需终端具备「屏幕录制」权限，否则只截到桌面壁纸） */
function captureScreen(name) {
  try {
    spawnSync('screencapture', ['-x', join(SHOTS, name)], { timeout: 15000 })
  } catch {}
}

/** 对话框内跳转到指定路径并回车确认（打开对话框会选中文件；保存对话框落到该目录） */
async function dialogGoTo(path) {
  if (MANUAL) return // 手动模式：仅打印提示，由用户完成对话框
  spawnSync('osascript', ['-e', `set the clipboard to ${JSON.stringify(path)}`])
  // 进程定向按键（keystroke 落在 process 内，不依赖全局前台）；每步留足动画时间。
  // 回车必须用 keystroke return：key code 36（CGEvent 键码）在 macOS 26 的
  // NSSavePanel/NSOpenPanel 上不触发默认按钮（实测 6 次回车无反应）。
  runAppleScriptChecked(`tell application "System Events"
  tell process "Porti"
    set frontmost to true
    delay 0.3
    keystroke "g" using {command down, shift down}
    delay 1.0
    keystroke "v" using {command down}
    delay 0.6
    keystroke return
  end tell
end tell`)
  await sleep(1200)
}

// ---- 4. 导入 Excel -----------------------------------------------------------
await clickNav('交易流水')
if (!(await clickButtonByText('导入 Excel'))) fail('未找到「导入 Excel」按钮')
await sleep(1500)
if (MANUAL) {
  console.log(`  → 请在文件对话框中选择：${XLSX}（Cmd+Shift+G 输入路径回车，再回车确认）`)
}
await dialogGoTo(XLSX)
// 部分 macOS 版本需要第二次回车确认选中文件；轮询预览出现，未出现则补一次回车
const previewOk = await waitFor(async () => {
  const shown = await evaluate(`document.body.innerText.includes('导入预览')`).catch(() => false)
  if (shown) return true
  if (!MANUAL) {
    runAppleScriptChecked('tell application "System Events" to keystroke return')
    await sleep(1500)
  } else {
    await sleep(2000)
  }
  return false
}, MANUAL ? DIALOG_TIMEOUT : 25000)
// 一轮未成：整段重试一次（对话框可能尚未就绪或首轮按键被吞）
if (!previewOk && !MANUAL) {
  console.log(`  → 首轮对话框自动操作未生效，重试。窗口状态：${dialogState()}`)
  captureScreen('dialog-retry-before.png')
  await dialogGoTo(XLSX)
  const retryOk = await waitFor(async () => {
    const shown = await evaluate(`document.body.innerText.includes('导入预览')`).catch(() => false)
    if (shown) return true
    runAppleScriptChecked('tell application "System Events" to keystroke return')
    await sleep(1500)
    return false
  }, 25000)
  if (!retryOk) {
    captureScreen('dialog-failed.png')
    fail(`导入预览未出现。窗口状态：${dialogState()}`)
  }
} else if (!previewOk) {
  fail('导入预览未出现（文件对话框是否选中了投资跟踪.xlsx？）')
}

const previewText = await evaluate(`document.body.innerText`)
if (!previewText.includes(`预计导入 ${GOLDEN.fundCount} 只基金、${GOLDEN.transactionCount} 笔流水`)) {
  fail(`导入预览数量不符：${previewText.slice(0, 400)}`)
}
console.log(`  导入预览：${GOLDEN.fundCount} 只基金、${GOLDEN.transactionCount} 笔流水 ✓`)

if (!(await clickButtonByText('确认导入'))) fail('未找到「确认导入」按钮')
const importOk = await waitFor(
  () => evaluate(`document.body.innerText.includes('导入完成')`).catch(() => false),
  30000
)
if (!importOk) fail('导入未完成（30s 超时）')
const importText = await evaluate(`document.body.innerText`)
if (!importText.includes(`已导入 ${GOLDEN.fundCount} 只基金、${GOLDEN.transactionCount} 笔流水`)) fail('导入笔数不符')
if (!importText.includes('全部一致')) fail('对账未显示「全部一致」')
console.log('  导入完成：对账全部一致 ✓')

// ---- 5. 概览查看（golden 值取自投资跟踪.xlsx 对账基准）-------------------------
await clickNav('概览')
// 汇总卡片默认「在持基金」；GOLDEN 是改动前的全部基金口径（含已清仓基金），先切换
await selectAllScope('概览页')
const stats = await evaluate(`(() => {
  const out = {}
  for (const s of document.querySelectorAll('.stat')) {
    const labelEl = s.querySelector('.stat-label')
    if (!labelEl) continue
    // 标签文本剔掉悬停标记（.hint-mark 的 ⓘ 是装饰，不是标签的一部分）
    const clone = labelEl.cloneNode(true)
    clone.querySelectorAll('.hint-mark').forEach((m) => m.remove())
    const label = clone.textContent.trim()
    if (label) out[label] = s.querySelector('.stat-value')?.textContent ?? ''
  }
  return out
})()`)
const money = (s) => Number(String(s).replace(/,/g, ''))
const checks = [
  ['总资产', (v) => Math.abs(money(v) - GOLDEN.totalAssets) <= 0.01, '775,962.32'],
  // 卡片标签：界面上是「持仓盈亏」（GOLDEN.totalPnl 就是它），旧稿写作「总盈亏」
  ['持仓盈亏', (v) => Math.abs(money(v) - GOLDEN.totalPnl) <= 0.01, '-8,351.48'],
  ['累计收益率', (v) => v === GOLDEN.totalReturnRate, GOLDEN.totalReturnRate]
]
for (const [label, ok, expect] of checks) {
  const v = stats[label]
  if (v === undefined || !ok(v)) {
    fail(`概览「${label}」= ${JSON.stringify(v)}，期望 ${expect}；实际卡片：${JSON.stringify(stats)}`)
  }
  console.log(`  概览「${label}」= ${v} ✓`)
}
// 年化收益率卡：终值随「今天」变化，先捕获，稍后与数据库独立 XIRR 计算交叉验证
const overviewAnnualized = stats['年化收益率']
if (overviewAnnualized === undefined) {
  fail(`概览缺少「年化收益率」卡；实际卡片：${JSON.stringify(stats)}`)
}
console.log(`  概览「年化收益率」= ${overviewAnnualized}（稍后交叉验证） ✓`)

// 持仓明细「年化收益率」列（盈亏比例之后）：表头存在 + 单元格为百分比或 —
const annualizedColumn = await evaluate(`(() => {
  const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent?.trim() === '持仓明细')
  if (!card) return null
  const heads = [...card.querySelectorAll('thead th')].map((th) => th.textContent)
  const idx = heads.indexOf('年化收益率')
  if (idx === -1 || heads.indexOf('盈亏比例') !== idx - 1) return { missing: true }
  const cells = [...card.querySelectorAll('tbody tr')].map((tr) => tr.children[idx]?.textContent ?? '')
  return { cells }
})()`)
if (annualizedColumn === null || annualizedColumn.missing) fail('持仓明细缺少「年化收益率」列（应紧跟盈亏比例之后）')
for (const c of annualizedColumn.cells) {
  if (!/^-?\d+\.\d{2}%$/.test(c) && c !== '—') {
    fail(`持仓明细年化收益率列格式异常：${JSON.stringify(c)}`)
  }
}
console.log(`  持仓明细「年化收益率」列：${annualizedColumn.cells.length} 行格式合规 ✓`)
await shot('overview.png')

// ---- 6. 改流水：修改备注 → 断言列表更新 → 还原 ---------------------------------
await clickNav('交易流水')
// GOLDEN 为全部基金口径：流水页卡片同样先切换
await selectAllScope('交易流水页')
const txStats = await evaluate(`(() => {
  const out = {}
  for (const s of document.querySelectorAll('.stat')) {
    const label = s.querySelector('.stat-label')?.textContent
    if (label) out[label] = s.querySelector('.stat-value')?.textContent ?? ''
  }
  return out
})()`)
if (txStats['累计收益率'] !== GOLDEN.totalReturnRate) {
  fail(`交易流水页「累计收益率」= ${JSON.stringify(txStats['累计收益率'])}，期望 ${GOLDEN.totalReturnRate}；实际卡片：${JSON.stringify(txStats)}`)
}
const txAnnualized = txStats['年化收益率']
if (txAnnualized === undefined) fail(`交易流水页缺少「年化收益率」卡；实际卡片：${JSON.stringify(txStats)}`)
console.log(`  交易流水页卡片：累计收益率 ${txStats['累计收益率']}、年化收益率 ${txAnnualized}（稍后交叉验证） ✓`)
const openedForm = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.table tbody tr')].find((tr) => tr.querySelector('button.btn-small:not(.btn-danger)'))
  if (!row) return false
  row.querySelector('button.btn-small:not(.btn-danger)').click()
  return true
})()`)
if (!openedForm) fail('未找到流水行「编辑」按钮')
await waitFor(() => evaluate(`document.body.innerText.includes('编辑流水 #')`).catch(() => false), 10000)
const noteField = `document.querySelector('.form-card > .form-grid input[type="text"]')`
const original = await evaluate(`${noteField}?.value ?? null`)
const marker = `${original ? original + '｜' : ''}冒烟验证`
const setValue = (expr, v) =>
  evaluate(`(() => {
    const el = ${expr}
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
await setValue(noteField, marker)
if (!(await clickButtonByText('保存'))) fail('未找到「保存」按钮')
const markerShown = await waitFor(
  () => evaluate(`document.body.innerText.includes('冒烟验证')`).catch(() => false),
  10000
)
if (!markerShown) fail('保存后列表未显示修改的备注')
console.log(`  改流水：备注改为「${marker}」并保存，列表已更新 ✓`)

// 还原备注
const reopened = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.table tbody tr')].find((tr) => tr.textContent.includes('冒烟验证'))
  if (!row) return false
  row.querySelector('button.btn-small:not(.btn-danger)').click()
  return true
})()`)
if (!reopened) fail('未找到含冒烟验证备注的行')
await waitFor(() => evaluate(`document.body.innerText.includes('编辑流水 #')`).catch(() => false), 10000)
const current = await evaluate(`${noteField}?.value ?? null`)
if (current !== marker) fail(`重新打开表单备注为 ${JSON.stringify(current)}，期望 ${JSON.stringify(marker)}`)
await setValue(noteField, original ?? '')
if (!(await clickButtonByText('保存'))) fail('还原时未找到「保存」按钮')
const reverted = await waitFor(async () => {
  const t = await evaluate(`document.body.innerText`).catch(() => '')
  return t.includes('编辑流水') === false && t.includes('冒烟验证') === false && t.length > 0
}, 10000)
if (!reverted) fail('备注还原后列表仍含冒烟验证标记')
console.log('  改流水：备注已还原为原值 ✓')
await shot('transactions.png')

// ---- 7. 导出 Excel -----------------------------------------------------------
await clickNav('设置')
if (!(await clickButtonByText('导出 Excel'))) fail('未找到「导出 Excel」按钮')
await sleep(800)
const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const expectedFile = join(EXPORT_DIR, `porti-导出-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.xlsx`)
if (MANUAL) {
  console.log(`  → 保存对话框中请：Cmd+Shift+G 输入 ${EXPORT_DIR} 回车，保持默认文件名，点「存储」`)
}
await dialogGoTo(EXPORT_DIR)
const exported = await waitFor(async () => {
  if (existsSync(expectedFile)) return true
  if (!MANUAL) {
    runAppleScriptChecked('tell application "System Events" to keystroke return') // 补一次回车触发「保存」
    await sleep(1500)
  } else {
    await sleep(2000)
  }
  return false
}, DIALOG_TIMEOUT)
if (!exported && !MANUAL) {
  // 保存对话框失败重试一次（与导入同策略）
  console.log(`  → 保存对话框首轮未成，重试。窗口状态：${dialogState()}`)
  await dialogGoTo(EXPORT_DIR)
  const exportedRetry = await waitFor(async () => {
    if (existsSync(expectedFile)) return true
    runAppleScriptChecked('tell application "System Events" to keystroke return')
    await sleep(1500)
    return false
  }, 25000)
  if (!exportedRetry) {
    captureScreen('dialog-export-failed.png')
    fail(`导出文件未出现：${expectedFile}。窗口状态：${dialogState()}`)
  }
} else if (!exported) {
  fail(`导出文件未出现：${expectedFile}（保存对话框中未完成存储？）`)
}
console.log(`  导出：${expectedFile} ✓`)

// 回读导出文件：三表齐全 + 概览汇总「总资产」与界面一致
const XLSXLib = await import(resolve(ROOT, 'node_modules/xlsx/xlsx.mjs'))
const wb = XLSXLib.read(readFileSync(expectedFile))
const sheetNames = wb.SheetNames.join('/')
if (sheetNames !== '概览/流水/净值') fail(`导出 sheet 不符：${sheetNames}`)
const rows = XLSXLib.utils.sheet_to_json(wb.Sheets['概览'], { header: 1 })
const assetRow = rows.find((r) => r[0] === '总资产')
if (!assetRow || Math.abs(Number(assetRow[1]) - GOLDEN.totalAssets) > 0.01) {
  fail(`导出概览「总资产」= ${JSON.stringify(assetRow?.[1])}，期望 ${GOLDEN.totalAssets}`)
}
console.log(`  导出回读：概览/流水/净值三表，总资产 ${assetRow[1]} 与界面一致 ✓`)
await shot('settings.png')

// ---- 8. 数据库断言（全新安装的 userData） -------------------------------------
// 年化收益率交叉验证工具（独立实现，不复用引擎代码）
const smokeDaysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000)

/** 数据库流水 + 总市值终值 → XIRR；口径与引擎一致（首笔流水 <30 天/净成本 ≤ 0/不收敛 → null） */
function xirrOfDb(db, terminalValue, today) {
  const rows = db.prepare('SELECT date, type, amount FROM transactions ORDER BY date').all()
  if (rows.length === 0) return null
  if (smokeDaysBetween(rows[0].date, today) < 30) return null
  const flows = []
  let netCost = 0
  for (const t of rows) {
    if (t.type === '买入' || t.type === '卖出') {
      flows.push({ date: t.date, amount: -t.amount })
      netCost += t.amount
    } else if (t.type === '分红现金') {
      flows.push({ date: t.date, amount: t.amount })
    }
  }
  if (netCost <= 0) return null
  const npv = (r) => {
    let s = 0
    for (const f of flows) s += f.amount * (1 + r) ** (-smokeDaysBetween(rows[0].date, f.date) / 365)
    return s + terminalValue * (1 + r) ** (-smokeDaysBetween(rows[0].date, today) / 365)
  }
  let lo = -0.9999
  let flo = npv(lo)
  let hi = 1
  let fhi = npv(hi)
  while (flo * fhi > 0) {
    hi *= 2
    if (hi > 1e9) return null
    fhi = npv(hi)
  }
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2
    const f = npv(mid)
    if (f === 0 || hi - lo < 1e-9) return mid
    if (flo * f < 0) {
      hi = mid
      fhi = f
    } else {
      lo = mid
      flo = f
    }
  }
  return (lo + hi) / 2
}

const percentString = (r) => (r === null ? '—' : `${(r * 100).toFixed(2)}%`)

const requireRoot = createRequire(import.meta.url)
const Database = requireRoot(resolve(ROOT, 'node_modules/better-sqlite3'))
const db = new Database(join(USER_DATA, 'porti.db'), { readonly: true })
const counts = {
  funds: db.prepare('SELECT COUNT(*) c FROM funds').get().c,
  transactions: db.prepare('SELECT COUNT(*) c FROM transactions').get().c,
  nav: db.prepare('SELECT COUNT(*) c FROM nav_history').get().c
}
if (counts.funds !== GOLDEN.fundCount || counts.transactions !== GOLDEN.transactionCount) {
  db.close()
  fail(`安装版数据库计数异常：${JSON.stringify(counts)}`)
}
console.log(`  安装版数据库：${counts.funds} 只基金 / ${counts.transactions} 笔流水 / ${counts.nav} 条净值 ✓`)

// 年化收益率卡与数据库交叉验证：终值随「今天」变化，用独立 XIRR 实现现场计算期望值
const smokeToday = new Date()
const smokeTodayStr = `${smokeToday.getFullYear()}-${String(smokeToday.getMonth() + 1).padStart(2, '0')}-${String(smokeToday.getDate()).padStart(2, '0')}`
const expectedAnnualized = percentString(xirrOfDb(db, GOLDEN.totalAssets, smokeTodayStr))
db.close()
if (overviewAnnualized !== expectedAnnualized || txAnnualized !== expectedAnnualized) {
  fail(`年化收益率卡（概览 ${overviewAnnualized} / 流水 ${txAnnualized}）与数据库独立计算 ${expectedAnnualized} 不符`)
}
console.log(`  年化收益率交叉验证：界面 ${overviewAnnualized} 与数据库独立 XIRR ${expectedAnnualized} 一致 ✓`)

// ---- 9. 收尾 ------------------------------------------------------------------
app.kill('SIGTERM') // 避免 AppleScript quit 触发「自动化」TCC 弹窗
spawnSync('hdiutil', ['detach', mountPoint, '-quiet'])
console.log(`GREEN: 安装版冒烟通过（导入→查看→改流水→导出），截图目录 ${SHOTS}`)
process.exit(0)

function fail(msg) {
  console.error(`RED: ${msg}`)
  try {
    app?.kill('SIGTERM')
  } catch {}
  try {
    if (mountPoint) spawnSync('hdiutil', ['detach', mountPoint, '-quiet'])
  } catch {}
  console.error(`截图目录：${SHOTS}`)
  process.exit(1)
}
