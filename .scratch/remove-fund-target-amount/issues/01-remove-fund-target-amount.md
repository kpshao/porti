# 01: 移除单只基金目标金额

**What to build:** 从数据模型到界面彻底移除单只基金目标金额：删除 `funds.target_amount` 列（schema 1 → 2，老库删列前 `VACUUM INTO` 自动备份，失败则保持旧版本下次重试），删除 `Fund` / `FundInput` / `FundPosition` 的 `targetAmount` 字段、校验、仓储查询、计算透传、`updateFundTargetAmount` 服务与 `fund:update-target` IPC，导入忽略 Excel 第 8 列，导出删除「目标金额」列；概览持仓明细降为 11 列并回退宽度压缩（内边距 6px → 10px、删除目标金额输入框宽度规则）。大类目标比例、偏离、默认种子全部保留。详见 spec.md 与 ADR-0002。

**Blocked by:** 无

**Status:** resolved

- [x] 数据层：`schema.ts` 删列、`SCHEMA_VERSION = 2`；`db.ts` 新增 1→2 迁移（列存在 → `VACUUM INTO` 备份 → `DROP COLUMN`；失败不升版本）；`repo.ts` / `transactionService.ts` / `importer/write.ts` 去掉该列
- [x] 引擎：`types.ts` 删除 `Fund.targetAmount` / `FundPosition.targetAmount` / `FundInput.targetAmount`；`validation.ts` 删除字段与「目标金额不能为负」；`compute.ts` 不再透传
- [x] 服务与 IPC：删除 `updateFundTargetAmount`、`fund:update-target` handler、preload API、`env.d.ts` 声明；`TransactionForm` 新建基金不再传该字段
- [x] 导入导出：`parse.ts` 不再读第 8 列；`exportService.ts` 概览 sheet 删除该列
- [x] 界面：概览持仓明细 11 列，删除 `amountEdits` / `commitTargetAmount` / 目标金额列与提示文案；`InlineNumberEdit` 保留给目标比例
- [x] 样式：删除 `.table-positions .inline-edit` 宽度规则；横向内边距 8px（默认窗口刚好放下），持仓明细表外包 `.table-scroll-x` 承接窄窗口滚动；保留 `.group-cell` nowrap；名称列宽窗口 nowrap、窄窗口随表头一起折行
- [x] 测试：更新 compute / validation / transactionService / navService / targetService / exportService / importer / migrationService 相关用例；新增 1→2 迁移用例（备份产生、列消失、版本为 2、重复启动幂等）
- [x] 端到端脚本：`check-overview-grouping.mjs` 表头改 11 列并断言真实库副本迁移；`check-data-migration.mjs` 的 v1 夹具断言老库启动自动迁移
- [x] 验收：全量测试与 `npm run typecheck` 绿；默认窗口下 11 列无折行；真实库副本启动后 `funds.target_amount` 不存在且生成了 `.bak` 备份

## Comments

- **实施记录（2026-11-06）**：
  - **迁移**：`SCHEMA_VERSION` 1 → 2；新增 `src/main/schemaMigration.ts`（不依赖 Electron，便于单测）。1→2 步骤在列存在时先用 `VACUUM INTO` 生成 `porti.db.bak-YYYYMMDD-HHmmss` 一致性副本（含 WAL 内容），再 `ALTER TABLE funds DROP COLUMN target_amount`。`initDatabase` 捕获迁移异常并保持旧版本、下次启动重试；代码不读该列，旧库照常可用。旧版 `.portibak` 导入后经同一步迁移升到 v2。
  - **删链**：`funds.target_amount` 列、`Fund` / `FundInput` / `FundPosition` 字段、校验、仓储查询、计算透传、`updateFundTargetAmount`、`fund:update-target` IPC/preload/`env.d.ts`、导入第 8 列、导出「目标金额」列全部移除；新建基金不再传该字段。
  - **样式**：恢复 10px 内边距后最长基金名称仍折行，给 `.table-positions .fund-link` 加 `nowrap` 解决；`check-overview-grouping.mjs` 的「默认窗口无折行」断言保持通过。
  - **测试**：新增 `schemaMigration.test.ts` 3 条（删列 + 备份内容、重复迁移幂等、备份失败不删列）；全量 210 tests 绿；`npm run typecheck` 干净。
  - **端到端**：`check-overview-grouping.mjs` GREEN——真实库副本启动后 `user_version=2`、`target_amount` 列消失、生成 `porti.db.bak-*`，11 列表头且无折行；`check-data-migration.mjs` GREEN——v1 夹具启动后自动迁移断言通过。
  - **未直接改动真实库**：`~/Library/Application Support/porti/porti.db` 本次未启动；下次打开应用时走同一迁移路径，删列前自动留 `.bak`。
  - **文档**：ADR-0002 与 `CONTEXT.md`「大类目标比例」词条已落。
  - **追加修复（窗口缩放）**：窄窗口下「年化收益率」表头溢出表格/卡片。根因是 11 列在 10px 内边距下最小内容宽约 1051px，而默认 1280 窗口的卡片内宽约 1018px——表格一直按最小宽度溢出卡片，窗口越小越明显。修法：横向内边距改 8px（默认窗口 1018 vs 1018 刚好放下）；持仓明细表外包 `.table-scroll-x`（`overflow-x: auto`），窄窗口在卡片内横向滚动；卡片加 `container-type: inline-size`，内容宽 < 1006px 时允许表头与名称折行，减少滚动量。**不复用收益统计页的 `.table-scroll`**——它带 `max-height: 300px`，复用会把持仓表纵向裁到 300px（已由「未被纵向裁切」断言兜住）。端到端新增断言：默认窗口无横向滚动、表格未被纵向裁切、960 视口下滚动容器在卡片内且可横向滚动；全量测试与 typecheck 重跑仍绿。
