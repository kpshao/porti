# 06: 概览页与大类配置对比

**What to build:** 概览页：顶部总资产/总盈亏/总收益率/落袋收益卡片；9 只持仓基金明细表（份额/净投入成本/最新净值/市值/持仓盈亏/盈亏比例）；5 大类对比区（目标比例/实际投入比例/实际市值占比/偏离，偏离用颜色提示）；大类目标比例与单只基金目标金额可编辑，编辑后对比实时更新。

**Blocked by:** 01（项目脚手架与数据库初始化）、02（计算引擎）、03（Excel 导入与对账）

**Status:** resolved

- [x] 顶部卡片与 Excel 汇总一致
- [x] 持仓明细表 9 只基金数字与 Excel 逐项一致
- [x] 5 大类对比计算正确：目标/实际投入/实际市值占比/偏离（默认目标：固守+25% / 纯债45% / 权益20% / 黄金5% / 流动性5%）
- [x] 目标比例与基金目标金额可编辑并持久化，对比实时更新
- [x] 偏离方向用颜色直观提示

## Comments

- **计算层复用**：卡片/持仓明细/大类对比全部来自 #02 计算引擎（computeTotals/computePositions/computeCategoryComparison），与 Excel 一致性由 M1 对账（e2e.test.ts）保证；本 ticket 新增 `targetService`（目标编辑，内存库 8 用例 TDD）与概览 IPC（overview:data / target:update-category / fund:update-target）。
- **默认目标种子**：ticket 默认值 25/45/20/5/5 在新库初始化时写入 category_targets（seedDefaultCategoryTargets，INSERT OR IGNORE）——Excel 导入用导入值覆盖、已导入库不受影响，直接新建基金的非导入场景也有配置基准。
- **总收益率口径矛盾（已知遗留，非本 ticket 改动）**：spec 核心计算规则写「总收益率 = 总收益 / 净投入成本」（总收益含落袋收益），但 M1 对账验收数字（-1.06% = 持仓盈亏/净投入成本）与 Excel 口径一致；#02 引擎已按 Excel 口径锁定。本 ticket 沿用引擎口径（与 Excel、交易流水页一致），spec 文本矛盾建议在 spec 修订时澄清。
- **目标编辑 UX**：行内数字编辑（失焦/回车提交），比例按百分比录入；非法数字本地回退，范围校验统一由服务层把关（中文错误回显）；偏离正数红/↑超配、负数绿/↓低配。
- **code-review 修正**：行内编辑框抽 InlineNumberEdit 组件；盈亏着色抽 pnlClass（null 无净值不着色）；commit 校验瘦身（范围校验只留服务层一处）；补默认目标种子（Spec 轴 a1 发现）。
