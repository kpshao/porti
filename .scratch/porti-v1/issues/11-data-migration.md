# 11: 换机迁移（导出/导入迁移包）

**What to build:** 换机迁移：旧电脑「导出迁移包」→ 新电脑「导入迁移包」。迁移包为单个 `.portibak` 文件（无损数据库副本 + `migration_meta` 元信息：应用版本/schema 版本/导出时间）；导入时校验（可打开、有元信息、完整性检查、schema 版本不高于当前——高于当前拒绝并提示升级），确认后自动备份现有数据再热替换生效（关连接→替换→重开→刷新窗口，失败回退重启）；新电脑空库首启弹窗引导导入（可跳过，跳过后不再弹）。设置页新增「换机迁移」卡片。

**Blocked by:** 08（设置页与导出备份）、09（打包与发布）

**Status:** resolved

- [x] 导出迁移包：单文件 .portibak，含全部数据与元信息，导出后可独立打开
- [x] 导入迁移包：校验（无效/损坏/高版本拒绝，中文报错）、确认框、自动备份现有数据、热替换立即生效
- [x] 首启引导：空库 + 未跳过时弹窗（导入迁移包/稍后再说），跳过标记持久化
- [x] 设置页「换机迁移」卡片（导出迁移包/导入迁移包按钮 + 说明文案）
- [x] 单元测试：迁移包往返/校验拒绝路径/替换文件/备份命名/设置标记持久化
- [x] 无头端到端：有数据不弹引导 + 卡片齐全；空库弹引导、跳过后消失且标记落盘
- [x] README 换机迁移说明

## Comments

- **迁移包**：新增 `migrationService`（main 侧，TDD 9 用例，独立于 electron）：`createMigrationBundle` 用 `db.backup()` 产出无损副本（含未落盘 WAL 内容，写出前先移除目标防残留合并）再写 `migration_meta` 元信息（应用版本/schema 版本/导出时间）；`validateMigrationBundle` 只读打开校验（可打开、有元信息、`integrity_check`、schema 版本——高于当前拒绝并提示升级，低于当前走预留升级路径，当前仅版本 1）；`replaceDbFile` 关连接 → 清 WAL/SHM 伴随文件 → 复制替换；`uniqueBackupPath` 防备份文件名冲突（-2/-3 序号）。
- **导入流程**：校验 → 确认框（展示迁移包内容概况 + 自动备份路径/无需备份）→ 复用导出逻辑自动备份现有数据 → `swapDatabase`（db.ts：关连接 → 替换 → `initDatabase` 重开）→ 刷新渲染窗口立即生效；重开失败回退 `app.relaunch`。导入来自更新版本的包被拒（中文报错回显）。
- **首启引导**：`migration:first-run-check` = 空库（`hasAnyData` 复用重复导入防护的判空）且未跳过；跳过标记 `migrationPromptDismissed` 持久化进 settings.json。**settingsStore 重构**：`saveSettings` 全量写 + `saveDbPath` 改为合并写（旧实现整文件覆盖会丢新字段，已修复并有回归测试）。
- **契约**：IPC `migration:export` / `migration:import` / `migration:first-run-check` / `settings:dismiss-migration-prompt`；preload 与 env.d.ts 同步。`SCHEMA_VERSION = 1` 常量上提至 schema.ts（db.ts 建库判断与迁移校验共用）。
- **界面**：设置页新增「换机迁移」卡片（导出迁移包/导入迁移包按钮 + `.portibak` 说明文案）；首启模态弹窗（「欢迎使用 Porti」+ 导入迁移包…/稍后再说，导入校验失败中文回显在弹窗内）。
- **验收**（2026-09-07 实测）：vitest 139 用例全绿（新增 migrationService 9 + settingsStore 3，含「saveDbPath 保留跳过标记」回归）；无头端到端 `scripts/check-data-migration.mjs` 三场景 GREEN——A 有数据不弹引导且设置页卡片齐全、B 空库弹引导→稍后再说→弹窗消失且标记落盘、C 复用 profile 重启不再弹；截图时点状态断言与截图一致。导出/导入涉及原生对话框不在无头断言范围，迁移包内容一致性由 migrationService 往返测试覆盖（导出→读回→校验→替换→重开数据一致）。旧设置页冒烟 `check-settings-page.mjs` 回归 GREEN。
- **领域文档**：CONTEXT.md 新建（词汇表含迁移包/换机迁移，与「导出」术语分离）；ADR-0001 记录迁移包单文件格式决策（拒绝 zip 与平铺双文件）。spec.md 新增用户故事 33-35 与换机迁移实现决策。
