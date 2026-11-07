- 使用中文进行沟通

## Agent skills

### Issue tracker

issue 和 spec 存放在本仓库的 GitHub Issues（`kpshao/porti`），用 `gh` CLI 操作；仓库公开，写入前须脱敏。`.scratch/` 为历史归档，只读。见 `docs/agents/issue-tracker.md`。

spec issue 的实现工单是其子 issue（body 以 `Part of #N` 开头）；运行 `implement-spec` 前若 spec 无工单，先补建一张。

### Triage labels

五个标准角色标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）作为 GitHub issue 的 label 取值。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

### Coding standards

判断性编码规范见根目录 `CODING_STANDARDS.md`。