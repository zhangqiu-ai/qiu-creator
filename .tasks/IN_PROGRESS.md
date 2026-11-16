# In Progress

## QC-001: 搭建 monorepo 骨架與 Mac 服務最小主鏈路（M0 後端）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M0, backend

### Plan

- pnpm workspace 根設定、TypeScript／lint／測試工具鏈、`packages/contracts`、`domain`、`api-client`、`agent-sdk` 骨架。
- `services/mac-server`：Fastify、設定（`CREATORHUB_HOME`）、SQLite（WAL）與第三章全部實體的首個遷移、`/health`、作品建立／讀取／列表／帶 revision 校驗的修改（409 衝突）、`source.md` 原子寫入與歷史快照、Range 視頻流。
- launchd plist 範本（不安裝）、`docs/architecture.md`、`docs/dependencies.md`。
