# 03: 历史 spec 与 CONTEXT.md 同步

**What to build:** 更新 `.scratch/porti-v1/spec.md`（简单成本法 → 严格成本法，标注恒等；核心计算规则同步；Out of Scope 删除「严格成本法留待 V2」）、`.scratch/annualized-return/spec.md`（Out of Scope 标注已实现）、`CONTEXT.md`（词汇：持仓成本/落袋收益/已实现收益）。

**Status:** resolved

- [x] porti-v1/spec.md：计算口径、核心计算规则、Out of Scope、Testing（注明 M1 golden 不变）
- [x] annualized-return/spec.md：Out of Scope 标注已实现（总收益率口径矛盾随之解决）
- [x] CONTEXT.md：补投资领域词汇（持仓成本/落袋收益/已实现收益）
- [x] issue 06（overview-allocation）口径矛盾标注已解决

## Comments

- **验收注释**（2026-09-09）：v1 spec 计算口径第 4 条与核心计算规则改严格成本法表述并标注恒等式；Out of Scope 中严格成本法条目改为「已由 .scratch/strict-cost-basis/ 实现」；Testing 注明真实 Excel 无卖出/分红现金故 M1 golden 数值不变。annualized spec Out of Scope 同步。CONTEXT.md 新增三个投资领域词汇（含 Avoid 用法）。issue 06 追加注释记录口径矛盾已解决。
