# 01: 项目脚手架与数据库初始化

**What to build:** 用户在 Mac 上执行一条命令即可启动桌面应用：出现 Electron 窗口，左侧边栏可见「概览 / 交易流水 / 净值管理 / 收益统计 / 设置」五个入口（内容可为占位）；应用启动时在用户数据目录创建 SQLite 数据文件并建好 spec 定义的四张表；关闭后重启数据不丢失。

**Blocked by:** None（可立即开始）

**Status:** resolved

- [x] 一条命令启动应用窗口，Mac 可运行
- [x] 侧边栏五个页面入口可见，点击可切换（占位内容）
- [x] 首次启动自动创建 SQLite 数据文件与四张表（funds / category_targets / transactions / nav_history），schema 与 spec 完全一致
- [x] 关闭后重启应用，数据文件与其中的数据保留
- [x] 技术栈与 spec 一致：Electron + React + TypeScript + electron-vite + better-sqlite3

## Answer

完成。Electron 44 + React 19 + TS + electron-vite（vite 7）+ better-sqlite3 13（prebuilds 布局，Electron ABI 直接可用）。`npm run dev` 启动正常，首启自动建库建表（user_version=1），重启后数据保留（冒烟验证 0 错误）。注意：npm 11 会拦截安装脚本，package.json 中已含 allowScripts 放行记录；electron 二进制在首次安装时需 `node node_modules/electron/install.js` 手动补齐（已处理）。
