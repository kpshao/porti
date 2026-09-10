# 02 · 界面：基金详情覆盖层 + 概览入口 + IPC

Status: resolved

## 描述

按 spec.md 实现基金详情视图。数据链路照抄 `stats:data` 模式：

- **IPC**：新增 `fund-detail:data` handler（fundCode + range 入参）：主进程全表读出 → `computeFundSeries` + `computePositions` + 年化 + 落袋收益组装 → 一次返回 `FundDetailData { position, annualized, realizedIncome, series, events }`（events = 该基金全部流水事件）。preload 暴露 `fundDetailData`；共享契约类型放主进程侧 types，照 `statsTypes.ts` 模式。
- **概览入口**：Overview 持仓表「名称」列改链接样式（新 CSS 类，主题色 + 悬停下划线）；仅份额非零行可点；点击设置 selectedFundCode 并打开覆盖层。
- **FundDetail 覆盖层组件**（新文件）：
  - 全屏覆盖层，复用 modal-overlay 模式（参照 TransactionForm），× 按钮与 Esc 关闭；关闭后状态重置
  - 标题：基金名称（代码）
  - 指标行：持仓成本 / 市值 / 持仓盈亏 / 盈亏比例 / 落袋收益 / 年化收益率（空值「—」）
  - 模式切换（默认收益率）：「收益率 / 金额」分段按钮；范围切换（默认全部）：「近1月 / 近3月 / 近1年 / 全部」
  - ECharts 折线：复用 Stats 的 `useEChart` + `lineChartOption`（抽取到共享位置）；配色/零基线/万单位沿用 issue 07-stats-charts 约定；收益率模式 null 点断开（connectNulls: false）
  - tooltip 两种模式均显示：日期、累计收益率、累计盈亏金额、市值
  - markPoint 标注四类流水事件（买入/卖出/分红现金/分红再投入，颜色与流水表 tag 同色系），悬停显示类型与日期；仅标注有净值记录的日期
  - 空态：series 为空时显示「暂无净值数据」提示
- 打开详情时重新取数（与既有页面挂载取数模式一致）

## 验收标准

- [x] 概览页点击基金名称打开详情，Esc / × 正常关闭
- [x] 收益率与金额模式切换正确；范围切换正确
- [x] 卖出/分红事件点在曲线上可见且可悬停
- [x] 清仓区间收益率曲线断开、金额曲线为平台（引擎黄金值用例覆盖）
- [x] 无净值基金显示空态提示
- [x] 新增流水/补录净值后重新打开详情数据为最新（每次打开重新取数）
- [x] 手工验收清单通过，并扩展现有冒烟脚本覆盖「打开基金详情」路径

## Comments

- 2026-09-10 实现完成：`fund-detail:data` IPC + `FundDetail` 覆盖层 + 概览名称链接入口；图表设施（useEChart/lineChartOption/配色）抽取到 `components/charts.tsx` 与 Stats 页共用。
- 新增端到端检查 `scripts/check-fund-detail.mjs`（沿用 check-stats-charts 的 CDP 模式，另剔除 ELECTRON_RUN_AS_NODE 环境变量），实测 GREEN：覆盖层打开、6 指标卡、走势图 canvas 渲染、金额/近1月切换、Esc 关闭全部通过。
