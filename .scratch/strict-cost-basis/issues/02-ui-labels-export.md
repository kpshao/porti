# 02: UI 与导出文案同步 + 服务层测试

**What to build:** 三页文案同步（概览/流水卡片「总盈亏」→「持仓盈亏」；持仓明细列「净投入成本」→「持仓成本」，含概览表、导出表、收益统计 tooltip；收益统计图注口径更新；导出汇总行「净投入成本」保留）；`exportService.test.ts`、`transactionService.test.ts` 断言更新（数值不变）。口径详见 spec.md。

**Status:** resolved

- [x] Overview.tsx：卡片「持仓盈亏」、表头「持仓成本」、p.costBasis
- [x] Transactions.tsx：卡片「持仓盈亏」（对账表列名不动）
- [x] Stats.tsx：tooltip「持仓成本」（costBasis）、图注改「累计收益 = 总市值 − 持仓成本 + 落袋收益（分红现金 + 卖出已实现收益）」
- [x] exportService.ts：汇总行「持仓盈亏」、持仓明细表头「持仓成本」+ costBasis；汇总「净投入成本」行保留
- [x] exportService.test.ts / transactionService.test.ts：标签与字段断言更新，数值全不变
- [x] （可选）TransactionForm.tsx 术语微调

## Comments

- **验收注释**（2026-09-09）：三页卡片/表头/tooltip/图注与导出表文案全部同步；TransactionForm 提示语「净投入成本含手续费」→「成本按含手续费金额计」。测试注意：exportService 概览表「总收益率」期望值 13.63 → **13.89**（seed 含分红现金 60，新口径分子 = 总收益 3249.49/23400），这是 issue 06 口径修正的预期可见变化，其余数值全不变；transactionService 补 costBasis 与 totalReturnRate 断言。全量 169 测试 + typecheck 绿。
