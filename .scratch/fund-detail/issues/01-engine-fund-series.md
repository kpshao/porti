# 01 · 引擎：单基金收益走势纯函数

Status: resolved

## 描述

在 `src/engine/compute.ts` 新增纯函数：

```
computeFundSeries(fundCode, funds, transactions, navPoints): FundSeriesPoint[]
```

- 点集 = 该基金有净值记录的日期（升序）；每个点：
  - `marketValue` = sharesAsOf × latestNavAsOf（截至该日）
  - `costBasis` / `realizedIncome` 按日截断推进（复用 `applyCostBasis`，先例 `computeStatsSeries`）
  - `totalReturn` = marketValue − costBasis + realizedIncome
  - `totalReturnRate` = costBasis > 0 ? totalReturn / costBasis : null
- 无净值记录 → 空序列
- 范围过滤不在此函数内；在数据组装层按「今天」往前 N 天过滤点集（「今天」显式入参以保持可测）

类型 `FundSeriesPoint` 加入 `src/engine/types.ts`。

口径约束：不得偏离 strict-cost-basis spec 的 `applyCostBasis` 语义；不动既有函数签名与口径。

## 验收标准

- [x] compute.test.ts 新增 describe，手算黄金值用例全绿：
  1. 单笔买入 + 两日净值上涨：每点 totalReturn / totalReturnRate 手算一致
  2. 买入 → 部分卖出 → 分红现金：移动加权成本、realizedGain、cashDividends 逐步手算一致
  3. 分红再投入：份额增加、成本不变、totalReturn 跳升
  4. 全部卖出后：costBasis = 0 期间 totalReturnRate 为 null、totalReturn 等于落袋收益平台
  5. 同日多笔流水按 date, id 顺序截断（沿用既有排序约定）
  6. 无净值记录 → 空序列
  7. 净值日期早于首笔流水的点：marketValue 为 0、totalReturnRate 为 null
- [x] `npm test`（或仓库既有测试命令）全量通过

## Comments

- 2026-09-10 实现完成：`computeFundSeries` + `filterFundSeriesRange` 落于 compute.ts，黄金值用例 7 个 + 范围过滤边界用例 4 个，compute.test.ts 共 57 用例全绿；全量 `npm test` 180 用例通过。
- 范围过滤按 spec「组装层完成」落在独立纯函数 `filterFundSeriesRange`（「今天」显式入参），由 `fund-detail:data` handler 调用。
