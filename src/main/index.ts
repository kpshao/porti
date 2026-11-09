import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { dbInfo, getDb, initDatabase } from './db'
import { registerAiIpc } from './aiIpc'
import { registerDataIpc } from './dataIpc'
import { autoFetchNavs } from './navService'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Porti - 基金仓位管理',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 开发模式由 electron-vite 注入渲染进程地址，生产模式加载打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initDatabase()
  ipcMain.handle('db:info', () => dbInfo())
  registerDataIpc()
  registerAiIpc()
  createWindow()

  // 启动自动抓取净值：不阻塞启动、失败静默（状态由净值管理页横幅展示）
  void autoFetchNavs(getDb())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
