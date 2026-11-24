# QC-092 驗收記錄：項目自動歸屬

- 分支：`feat/qc092-auto-assign`（從 origin/main `fc5d484` 開）。
- 規格：
  - `.tasks/IN_PROGRESS.md` QC-092。
  - 原型 PT-20261124-001 的項目規則需求。
  - `docs/mcp-plan.md` 第 7 節。
  - `docs/decisions.md` 2026-11-24。
- 設計說明：`docs/architecture.md`「項目規則與自動歸屬（QC-092）」，以及 API 表、`0022` 遷移、MCP。

## 給前端（QC-091）的 API 形狀

- **項目：**
  - `Project` 多了 `description: string` 與 `rules: {keywords: string[], tags: string[], folders: string[], domains: string[]}`。型別上兩者都是 optional（舊服務沒有），新服務一定會回。
  - `POST /api/v1/projects`、`PATCH /api/v1/projects/:id` 可帶 `description` 與 `rules`。`rules` 整份取代；PATCH 照常帶 `base_revision`。
- **試算：**
  - 請求：`POST /api/v1/projects/:id/rules/preview`，body `{rules, limit?}`（`limit` 1–50，預設 20）。
  - 回應：`{items: [{work_id, title, updated_at, score, outcome, reasons, member}]}`。
  - `outcome` 為 `auto`（≥ 0.8）、`suggest`（0.5–0.8）、`none`；`member` 表示作品已在這個項目。
  - 只讀，用的是請求中的規則，不會儲存。
- **原因：** `{kind, value, weight, text}`。
  - `kind` 為 `folder`、`domain`、`keyword_title`、`tag`、`keyword_body`。
  - `text` 是繁體中文句子；介面請依 `kind` 與 `value` 自己組三語文案。
- **作品的項目：**
  - 請求：`GET /api/v1/works/:id/projects`。
  - 回應：`{items: [{project_id, project_name, added_by}]}`，其中 `added_by` 為 `{kind: user|agent|rule, token_id, token_name, score, reasons, at}`。
- **保留：** `POST /api/v1/works/:id/projects/:projectId/keep`，回同樣的列表。
- **復原歸入：** `DELETE /api/v1/works/:id/projects/:projectId`，回同樣的列表；手動的歸屬回 409 `membership_manual`。
- **候選：**
  - 已儲存的作品：`GET /api/v1/works/:id/project-suggestions`。
  - 尚未儲存的內容：`POST /api/v1/projects/suggestions`，body `{title, markdown?, tags?, source?}`。
  - 回應：`{items: [{project_id, project_name, score, outcome, reasons}]}`，分數高的在前，只列分數 > 0 的。
- **新建作品：** `POST /api/v1/works` 帶 `auto_assign: true` 時，回應多 `auto_assignment: {assigned, suggested}`。
- **事件：** `work.projects_changed` 帶 `by`（user、agent、rule）；保留時帶 `kept`，復原時帶 `undone: true`。
- **api-client：** `projects.workMemberships`、`keepMembership`、`undoMembership`、`workSuggestions`、`suggest`、`previewRules`。

## 實作

| 項目 | 位置 |
| --- | --- |
| 評分引擎（權重表、noisy-or、原因、門檻） | `packages/domain/src/project-rules.ts`（子路徑 `@qiu-creator/domain/project-rules`，因為用到 OpenCC 摺疊） |
| 契約 | `packages/contracts/src/project-rules.ts`、`projects.ts`、`api.ts`（`auto_assign`、`auto_assignment`、`membership_manual`） |
| 遷移 `0022_project_rules_membership` 與 `PROJECT_RULES_ROLLBACK_SQL` | `services/mac-server/src/db/migrations.ts` |
| 歸入來源（手動不被覆蓋、保留、復原） | `src/projects/membership.ts`、`project-service.ts` |
| 候選、試算、自動歸入（含項目限定） | `src/projects/project-rules.ts`、`server.ts`（`POST /works`） |
| 路由與權限（試算、建議為只讀；保留、復原只限主權杖） | `src/routes/projects.ts`、`src/auth/scopes.ts`、`src/auth/agent-rules.ts` |
| client | `packages/api-client/src/projects.ts` |
| MCP：`projects_suggest`、`project_rules_preview`；`work_get` 帶項目歸屬；`work_create` 的 `auto_assign`；`project_create`／`project_update` 的描述與規則；覆蓋表 | `packages/agent-sdk/mcp/` |

## 自動測試

- `packages/domain/test/project-rules.test.ts`（5 項）：空規則不相符；證據累加（0.84 自動、0.6 建議）；正文關鍵字各算一次，並做大小寫與繁簡摺疊；資料夾路徑或掛載、網域含子網域；門檻邊界。
- `services/mac-server/test/project-rules.test.ts`（9 項）：
  - 描述與規則的儲存（版本號、409、網域驗證）。
  - 候選排序與原因、草稿候選。
  - 試算：預設 20 篇、`member`、不會儲存。
  - 外部掛載依資料夾與掛載 id 相符（真的掛載臨時資料夾）。
  - `auto_assign`：≥ 0.8 歸入並記錄 rule、分數與原因；0.5–0.8 只建議；不帶 `auto_assign` 不歸入。
  - 歸入來源：
    - Agent 不能移除手動的歸屬，也不能把手動的改成自己的。
    - 保留後改為手動；復原只撤銷 Agent 或規則的歸入，手動的回 409；主權杖手動加入會覆寫成 user。
    - Agent 不能保留或復原（403）。
  - 項目限定：自動歸入只考慮範圍內的項目，不合適回 403 且不建立作品，範圍外的項目不出現在候選。
  - 試算與候選只需要 read。
  - 0022 回滾：欄位移除、歸屬保留、可以再升級，既有資料預設為 user。
- `packages/agent-sdk/test/mcp-project-rules.test.ts`（2 項）：經 MCP 建立項目、試算、設定規則、草稿與作品的候選、`auto_assign` 建立、`work_get` 帶出 rule 來源；Agent 無法移除手動歸屬。
- 覆蓋與權限一致測試涵蓋全部新路由；`mcp-client` 的工具清單已更新。
- 更新的既有測試：`projects.test.ts` 的 `work.projects_changed` 事件多了 `by: 'user'`；`backups` 的 `schema_version` 改為 `0022`。

## 範圍與 NOT_VERIFIED

- 介面屬 QC-091，本任務沒有介面變更，也沒有跑 e2e（**NOT_VERIFIED**）。
- 用真正的 Claude Code 連線測試排在 QC-093（**NOT_VERIFIED**）。

## 數字（2026-11-24）

- 全套 `pnpm -r --workspace-concurrency=1 --no-bail test`，開始時 1 分鐘負載 4.6：
  - 11 個套件全部通過，1297 passed，0 failed。
  - mac-server 544（45 個檔）；apps/mac 445；agent-sdk 41；domain 58；其餘套件 209。
  - 第一次跑時有 1 項失敗：contracts 的新建作品預設值多了 `auto_assign: false`，屬於預期中的改動，已更新預期值後重跑。
- typecheck：`pnpm -r typecheck`（含 apps/mac）加 `tsc -p e2e/tsconfig.json`，全部通過。
- 根目錄 `pnpm lint`（`eslint .`，含 e2e）：0 錯誤。
- prettier：所有變更檔案都通過。
