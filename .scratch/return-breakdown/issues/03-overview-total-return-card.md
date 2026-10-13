# 03: 概览卡片区改两行版式，补上「总收益」

**What to build:** 用户在概览页一眼看到「总收益」，并且不用心算就能看懂它是怎么来的——`持仓盈亏 + 已实现盈亏 = 总收益` 这三张卡的加法关系在版式上显式呈现。金额卡按正负着色，负数不再被视觉淹没。「年化收益率」挂一个说明：该数基于用户填写的买入日期计算，合并记录会拉长持有期使年化偏低。

**Blocked by:** 01（避免新卡片带着已废弃的旧名上线）

**Status:** resolved

- [x] 概览卡片区：第一行 总资产 / 总收益 / 累计收益率 / 年化收益率；第二行 持仓盈亏 + 已实现盈亏，加法关系肉眼可见
- [x] 「总收益」取现有汇总口径，不新造计算
- [x] 总收益、累计收益率、年化收益率按正负着色；总资产不着色
- [x] 「年化收益率」有说明文案，解释合并买入记录会使其偏低
- [x] 导出 Excel 的汇总区不受影响（原本就有总收益）
- [x] `npm test` + `npm run typecheck` 全绿
- [x] 跑起应用目视确认版式与着色

## Comments

**2026-10-13 实现完成**

- 7 项 checklist 全部落地；`npm test` 195/195、`npm run typecheck`、`npm run build` 全过。
- **界面**（`Overview.tsx` / `styles.css`）：卡片区改 `.summary-card-rows`（列向）＋两个 `.stat-row`。第一行总资产 / 总收益 / 累计收益率 / 年化收益率，第二行用细线隔开后写「持仓盈亏 ＋ 已实现盈亏 ＝ 总收益」——运算符 `.stat-op` 中性灰、与数值底对齐，等式读得出来。总收益取 `totals.totalReturn`（`compute.ts:158` 既有口径），**零引擎改动**。着色沿用 `utils/pnl.ts` 的 `pnlClass`：第一行后三张按正负，总资产不着色；第二行两张一并向用户暴露符号。
- **超出 spec 版式块的一处（有意）**：第二行末尾的「＝ 总收益」尾注（spec 的 ASCII 只画到「持仓盈亏 + 已实现盈亏」）。理由：ticket 要求「不用心算就能看懂它是怎么来的」，尾注把第二行与第一行的结果卡连成一个等式；不重复数值，避免同屏两个「总收益」数字。
- **年化说明**：`ANNUALIZED_HINT` 一句话挂在「年化收益率」卡的 `title` 上，标签补 ⓘ + `cursor: help` 做可发现性（spec 的 Further Notes 只授权 tooltip）。**初稿另加了一条常驻脚注，被 Spec 轴审查判为越界（spec 的两行版式没有第三行）且与 tooltip 逐字重复，已删**。
- **验收脚本** `scripts/check-overview-total-return-card.mjs`（CDP，零依赖，照 `check-zero-holding-cleanup.mjs` 模板）实测 **GREEN**，19 项断言：两行结构 + 标签序列 + `[+ | = 总收益]` 运算符；六张卡的显示值逐张对照 `window.api.overviewData()`（防渲染串字段）；**用卡片上显示的三个数当场手算 `−7,674.91 + (−10,358.20) = −18,033.11` = 总收益卡**；着色三张 + 总资产不着色 + 分解行两张；tooltip 文案含「买入日期 / 合并 / 偏低」及 ⓘ 标记。截图目视确认。
- **既有验收脚本回归**：`check-realized-pnl-labels.mjs`、`check-overview-grouping.mjs`、`check-zero-holding-cleanup.mjs` 三个重跑 **GREEN**（分组脚本的「Σ 大类市值 == 顶部总资产」仍成立，说明第一行的总资产卡没被改动波及）。
- **连带改动（原因都在本次）**：① `check-realized-pnl-labels.mjs` 的概览标签序列拆成 `OVERVIEW_LABELS`（流水页仍是单行的 `TX_LABELS`），两脚本的标签真相重复已在注释里互指；② 该脚本与 `check-packaged-app.mjs` 读 `.stat-label` 时改为剔掉 `.hint-mark`——ⓘ 会把标签文本变成「年化收益率ⓘ」，不剔则 key 取不到；③ `check-packaged-app.mjs` 的 `['总盈亏', …]` 改为 `['持仓盈亏', …]`（该键在 strict-cost-basis 改名后就已失效，属既有陈旧债，顺手改正；**该脚本依赖打包安装与原生对话框，本次未运行**）。
- **导出不受影响**：`exportService` 的汇总区本来就有「总收益」与「已实现盈亏」两行，本次零改动（已读代码确认，未跑导出）。

**2026-10-13 审查后修正**（/code-review 两轴：Standards 无硬性违规、Spec 无缺失项）

- **验收脚本自身的假通过**（Standards 轴，真缺陷）：`hasHintMark` 写作 `labelEl?.querySelector(...) !== null`，`labelEl` 为 null 时 `undefined !== null` 恒真 → 改为 `(… ?? null) !== null`。
- **死代码**（Spec 轴）：脚本里 `porti-total-return-before.png` 截图写了从不引用（模板残留，本脚本没有「前后对比」语义），已删。
- **命名**（Standards 轴）：`LABELS` 只服务流水页后名字已隐晦 → 改 `TX_LABELS`。
- **未采纳**：六块 `.stat` 的逐字重复（Standards 轴 Duplicated Code）——`Transactions.tsx` 同写法属仓库既有惯例，本次不引入新抽象；`#e5e6eb` / `#86909c` 字面量沿用文件现状（token 化属另挂起的 UI 风格改造）。
