# 09: 打包与发布说明

**What to build:** 一条打包命令产出 Mac dmg（不签名，预留签名配置位）与 Windows exe；README 使用说明（安装方式、Excel 导入流程、日常净值更新流程、备份方式、已知限制）；在用户 Mac 上从 dmg 安装并验证基本流程。

**Blocked by:** 03（Excel 导入与对账）、04（交易流水页）、05（净值管理页与联网抓取）、06（概览页与大类配置对比）、07（收益统计页）、08（设置页与导出备份）

**Status:** resolved

- [x] Mac dmg 构建成功，未签名但可安装运行（右键打开）
- [x] Windows exe 构建成功（运行验证延后，V1 以 Mac 验收为准）
- [x] README 覆盖安装/导入/日常流程/备份/已知限制
- [x] dmg 安装后完成一轮「导入 → 查看 → 改流水 → 导出」冒烟验证
- [x] 打包配置预留签名参数（Apple Developer 证书路径可配置）

## Comments

- **打包配置**：新增 `electron-builder.yml`（`npm run package` = electron-vite build + electron-builder --mac --win，产物在 `release/`）。Mac dmg 用 `identity: '-'`（ad-hoc 签名保证 Apple Silicon 可运行，未经公证需右键打开），`hardenedRuntime: false`；不写 `notarize: false`——公证是否执行完全由环境变量决定（有 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 即自动公证，无则跳过），签名走 `CSC_LINK`/`CSC_KEY_PASSWORD`。Windows 固定 x64（构建机是 arm64 时默认会出 arm64 exe，与用户换机场景不符），`signAndEditExecutable: false` 跳过需 wine 的 exe 资源编辑。`npmRebuild: false`：better-sqlite3 v13 为 N-API 模块自带全平台 prebuild（ABI 与 Electron 版本无关），macOS 交叉构建 Windows 包时 node-gyp 无法从源码跨平台编译。
- **产物验证**：`Porti-0.1.0-arm64.dmg`（149M，dmg 内为相对符号链接的正常 bundle）；`Porti-Setup-0.1.0.exe`（126M，PE32+ x64 NSIS，`win-unpacked` 内确认 win32-x64 的 better-sqlite3 prebuild 已打包）。国内网络构建用 `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR` 指 npmmirror（GitHub 直连下载 NSIS 工具链超时）。
- **README**：安装（右键打开）/Excel 导入/日常净值更新/备份（拷贝 SQLite 文件，恢复指引与「更改数据文件位置拒绝已存在文件」实现一致）/已知限制（未签名、Windows 未运行验证、无自动更新等）/开发与打包说明。
- **冒烟验收**（2026-09-01 实测 GREEN）：`scripts/check-packaged-app.mjs` 从 dmg 挂载 → `ditto` 安装到 /Applications → 启动安装版 → CDP 驱动「导入 Excel（原生对话框自动键入）→ 概览 golden（775,962.32 / -8,351.48 / -1.06%）→ 改流水备注并还原 → 导出 Excel 回读三表一致」→ 数据库断言（10 基金/69 流水）全程通过。两次踩坑记录：① 从 dmg 拷贝安装必须用 `ditto`——Node `cpSync` 会把 framework 内相对符号链接改写成指向 dmg 挂载点的绝对路径，卸载后应用损坏（dyld 找不到 Electron Framework）；② 驱动 NSSavePanel/NSOpenPanel 的回车必须用 AppleScript `keystroke return`——`key code 36`（CGEvent 键码）在 macOS 26 上不触发默认按钮（实测连发 6 次回车无反应）。
- **原生对话框自动化**：对话框是独立窗口（非 sheet）；Cmd+Shift+G「前往文件夹」+ 剪贴板粘贴路径 + `keystroke return` ×2（第一次确认导航、第二次选中文件/保存）。终端需「辅助功能」权限（脚本对拒绝有明确提示，另备 `--manual-dialogs` 模式由人完成对话框）。
- **数据目录共享**：macOS 文件系统大小写不敏感，「Porti」与「porti」是同一目录，开发版与安装版共享 `~/Library/Application Support/porti/`。冒烟前会备份并移除旧库保证「全新导入」起点；冒烟完成后的安装版数据（10 基金/69 流水）即真实数据可直接使用。
- **code-review 修正**（双轴，Standards+Spec）：`notarize: false` 会永久关闭公证（与「预留签名」承诺矛盾，改为依赖环境变量自动判定）；README 恢复指引曾重新引入 issue 08 已否决的「把数据文件位置指向已有文件」承诺（改为放回同目录/选新路径）；「未签名」措辞改为「未使用开发者证书（ad-hoc）签名」；冒烟脚本提取 golden 常量、清死代码、加平台守卫、修复「零依赖」头注释（回读断言复用项目运行时依赖 xlsx/better-sqlite3）。保留项：CDP 通道与 `waitFor` 在三个检查脚本间重复（仓库既有自包含脚本惯例，与 issue 08 处理一致）。
