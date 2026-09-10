# 01: 引擎成本基础 + 类型 + 引擎测试

**What to build:** 计算引擎新增移动加权平均成本基础纯函数（`CostBasisState`/`applyCostBasis`/`costBasisStates`），改造 `computePositions`（新增 costBasis 字段、pnl/pnlRatio 改持仓成本口径）、`computeTotals`（落袋收益 = Σ分红现金 + Σ卖出已实现收益；总盈亏改浮动盈亏；总收益率改总收益/净投入成本）、`computeStatsSeries`（costBasis 增量推进，netCost 字段改名 costBasis）；`types.ts` 同步（FundPosition 新增 costBasis、Totals/StatsPoint 注释与字段）；`compute.test.ts` 既有断言更新 + 新增「严格成本法」用例。口径与接缝详见 spec.md。

**Status:** resolved

- [x] compute.ts：新增 CostBasisState/applyCostBasis/costBasisStates（含超卖防护、清仓归零兜底）
- [x] compute.ts：computePositions 返回 costBasis，pnl = 市值 − costBasis，pnlRatio 按 costBasis ≤ 0 保护
- [x] compute.ts：computeTotals 落袋/浮动盈亏/总收益率新口径，totalReturn 数值恒等
- [x] compute.ts：computeStatsSeries 用 Map<fundCode, CostBasisState> 增量推进，字段 netCost → costBasis
- [x] types.ts：FundPosition.costBasis、Totals/StatsPoint 注释与字段同步
- [x] compute.test.ts：既有断言更新（卖出与分红现金、大类配置字面量、时间序列字段名与期望值）+ 新增 spec「必测用例」全部
- [x] 恒等回归：golden fixtures 与时间序列 totalReturn 期望值不变；e2e 对账不动

## Comments

- **验收注释**（2026-09-09）：compute.ts 新增 `CostBasisState`/`applyCostBasis`/`costBasisStates` 三个纯函数（日期升序稳定排序、同日按输入顺序，写入 JSDoc）；超卖防护（sharesBefore ≤ 0 消耗成本 0）+ 部分超卖钳制（min(均价消耗, 剩余成本)）+ 清仓归零兜底（份额 ≤ 0 时持仓成本置 0 消浮点残留）。computeTotals 落袋收益按 costBasisStates 的流水 fundCode 统计（含已删除基金流水，与现状逐笔遍历一致）；总收益率 = 总收益/净投入成本、分母 ≤ 0 时 null（顺带解决 issue 06 口径矛盾）。新增 9 个严格成本法用例（多次买入均价、部分卖出亏损、分红再投入 0 成本、清仓、清仓后再买、超卖防护、货基资金池全流程、净投入为负、同日顺序），全部手算黄金值；既有断言同步更新且 totalReturn 期望值全部不变（恒等式回归）。引擎测试 46 个全绿。
