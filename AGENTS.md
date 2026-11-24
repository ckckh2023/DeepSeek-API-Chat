# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Ticket 状态

`.scratch/*/issues/` 里的 `Status` 与 checkbox 是该 feature 的唯一进度记录（`.scratch/` 不入库，因此不会被任何自动化看见）。每完成一个 ticket 的验收，当场回填，不等收尾。

### Triage labels

Five canonical triage roles map 1:1 to label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: repo-root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
