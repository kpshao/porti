# 05: 净值管理页与联网抓取

**What to build:** 净值管理页：每只基金一张净值历史表（日期/净值/来源）；「一键抓取」按钮为全部持仓基金从公开行情接口拉取最新净值并写入（auto 来源）；应用启动时自动尝试抓取（失败静默不阻塞启动）；支持手动补录某只基金某日的净值（manual 来源），同基金同日已有记录时给出明确处理方式。

**Blocked by:** 01（项目脚手架与数据库初始化）、02（计算引擎）、03（Excel 导入与对账）

**Status:** resolved

- [x] 净值历史表按基金展示，来源标记（导入/自动/手动）可见
- [x] 一键抓取为 10 只基金写入当日净值，接口解析正确
- [x] 启动自动抓取：成功静默更新、失败不阻塞启动且界面有状态提示
- [x] 手动补录某基金某日净值可用；同基金同日已有记录时给出明确处理方式
- [x] 抓取器有 mock 测试（成功解析与失败路径），不依赖真实网络跑测试

## Comments

- **接口选择**：spec 提及的经典接口 `fundgz.1234567.com.cn/js/{code}.js` 已下线（404）。改用天天基金（东方财富）批量接口 `fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo`（Fcodes 逗号拼接一次取回全部基金，字段 PDATE=净值日期 / NAV=单位净值 / SHORTNAME=简称）。实现时以 curl 探测的真实响应为 golden 基准。
- **抓取范围决策**：spec 措辞为「全部持仓基金」，但验收清单明确「10 只基金」而 Excel 持仓概览仅 9 只持仓——以验收数字为准，按**库内全部基金**抓取（新建但未持仓的基金也会自动补净值，对用户无副作用）。
- **写入策略**：auto 来源用 `INSERT OR IGNORE`——同基金同日已有记录（import/manual）不覆盖；手动补录用 upsert 覆盖并变更为 manual 来源，覆盖前界面弹确认框展示原记录来源与净值（「明确处理方式」落在界面确认 + 服务层 upsert 语义）。
- **启动自动抓取**：main 进程启动后 fire-and-forget 调用，失败静默不阻塞；最近状态经 `nav:fetch-status` 暴露，净值管理页挂载时轮询（3s × 6 次，覆盖 8s 超时）——成功仅小字提示（静默更新）、失败横幅提示并可一键重试/手动补录。
- **测试**：fetcher 9 用例（mock HTTP：解析成功/净值缺失跳过/ErrCode/非 JSON/缺 Datas/网络错误传播/空代码短路）+ navService 9 用例（内存库：manual 覆盖策略/auto 不覆盖/缺失基金计数/空库早退/状态机 ok/failed/静默）。另以真实 Excel 10 只基金 + 真实接口做过一次性冒烟（成功写入 10 条，临时用例已删）。期间发现并修复真 bug：User-Agent 含中文导致 undici 拒绝请求，已改纯 ASCII。
- **code-review 修正**：running 横幅单次回查改轮询防卡死；ok 状态改小字静默提示；`HTTP {status}` 中文；`FetchStatus.at` → `finishedAt`；复用 `ensureFundExists`；`ipcErrorMessage` 提取到 renderer utils；契约类型统一收口 `src/main/navTypes.ts`。
- **已知遗留（非本 ticket）**：`src/importer/parse.test.ts` 有 2 个失败——`投资跟踪.xlsx` 被手工修改（1.0577 可疑行改为 1.553），#03 黄金验收的预期值失效，待另行处理。
