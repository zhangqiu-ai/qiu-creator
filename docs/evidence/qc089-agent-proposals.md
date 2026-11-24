# QC-089 驗收記錄：Agent 提案、直接修改開關、活動記錄與權杖限定項目

- 分支：`feat/qc089-proposals`（從 origin/main `486442f` 開）。
- 規格：
  - `.tasks/IN_PROGRESS.md` QC-089。
  - 已核准原型 PT-20261124-001 的 `backendNeeds`。
  - `docs/decisions.md` 2026-11-24 兩條。
  - `docs/mcp-plan.md` 第 5 節。
- 設計說明：`docs/architecture.md`「Agent 提案、直接修改、項目限定與活動記錄（QC-089）」，以及 MCP、API 表、`0021` 遷移、事件。

## 實作

| 項目 | 位置 |
| --- | --- |
| 遷移 `0021_agent_proposals_activity` 與 `AGENT_PROPOSALS_ROLLBACK_SQL` | `services/mac-server/src/db/migrations.ts` |
| 請求的操作者（AsyncLocalStorage）、`change_log.actor` | `src/auth/actor-context.ts`、`src/events/change-feed.ts` |
| 直接修改開關、項目限定、活動記錄的 hook | `src/auth/agent-rules.ts`、`src/auth/project-scope.ts`、`src/auth/activity-service.ts` |
| 權杖更新、活動 API | `src/auth/token-service.ts`、`src/routes/imports.ts` |
| 提案服務與路由 | `src/proposals/proposal-service.ts`、`src/routes/proposals.ts` |
| hunk、重疊、套用、三方區域（純函式） | `packages/domain/src/proposal-diff.ts` |
| 版本帶 `agent`；`WorkService.applyProposal` | `src/works/work-service.ts` |
| 範圍過濾：作品、項目、素材引用、任務、`/changes`、SSE | `work-service.ts`、`project-service.ts`、`asset-*.ts`、`routes/imports.ts`、`routes/session.ts`、`routes/events.ts` |
| 契約：`propose`、權杖欄位、更新與活動、提案、版本的 `agent`、事件的 `actor`、四個錯誤碼 | `packages/contracts` |
| client：`tokens.update/activity`、`proposals.*` | `packages/api-client` |
| MCP：`work_propose_edit`、`proposals_list`、`proposal_get`、`work_update_body`；`work_restore_revision` 改需開關；重試提示；覆蓋表 | `packages/agent-sdk/mcp` |
| 錯誤訊息與 `propose` 範圍標籤三語；`TokensPanel` 補 `propose` 標籤（只為通過型別檢查，介面在 QC-091） | `packages/i18n`、`apps/mac/src/renderer/TokensPanel.tsx` |

## 設計取捨（請總監過目）

1. **版本來源不新增 `agent_proposal`／`agent_direct`。** App 的 `REVISION_SOURCE_LABEL` 是窮舉表，新增值會讓前端型別檢查失敗；而 `revisions.source` 有 CHECK，新增值要重建資料表。改成加 `agent: {token_id, name, via: proposal|direct, proposal_id, restore_to}`，`source` 仍是 `edit`。QC-091 可以依 `agent` 顯示「採用 X 的提案」或「由 Agent〈X〉修改」。
2. **提案事件用實體 `work`**（`proposal.created`／`proposal.updated`，`data.proposal_id`），不新增 `proposal` 實體，避免重建 `change_log`；項目限定的過濾也自然適用。
3. **寫入前留快照：** 版本快照本身不可變，寫入前的版本就是快照；`agent.restore_to` 指向它，用既有的恢復 API 一鍵恢復。
4. **恢復舊版本也算改正文：** Agent 用 `POST /works/:id/revisions/:rid/restore` 同樣需要開關（QC-088 的 `work_restore_revision` 因此也需要）。
5. **素材庫維持共用：** 依 QC-062「素材庫維持共用」，項目限定不過濾素材本身；但素材的引用與使用中作品只列範圍內的作品。任務只列權杖自己建立的。
6. **既有行為的改變：** 在此之前，`write` 權杖能直接 `PATCH` 作品的 `markdown`，違反「嚴禁 AI 直接覆蓋原文」。現在需要開關。m2 三方測試的 Agent 因此在建立權杖時打開開關，因為那些情境測的正是會直接寫入的 Agent。

## 回覆總監：`variant_get` 與 `VariantView`

`variant_get` 呼叫 `client.variants.list/get`。api-client 在 QC-084 已改為用 `VariantViewListResponseSchema`／`VariantViewSchema` 解析回應（`packages/api-client/src/variants.ts` 第 61、62 行），所以工具回傳的一定是驗證過的 `VariantView`；MCP 層不重複引用 schema。

`packages/agent-sdk/test/mcp-client.test.ts` 斷言的欄位：

- 列表：四個平台依序，`[platform, exists, title, title_source]`，其中抖音為 `exists: true`、`title_source: override`，其他平台跟隨原稿。
- 單一平台：`revision: 1`、`body`（由原稿推導）、`body_source: work`、`cover: {asset_id}`、`cover_source: work`。
- `history: true` 時回傳覆寫歷史的 revision。

`mcp-write.test.ts` 的 `variant_update` 另外斷言 `title_source`、`body_source`、`exists`，以及 `reset_all` 之後的 revision。

## 自動測試

- `services/mac-server/test/agents.test.ts`（10 項）：
  - **直接修改：** 沒有開關時回 403，正文不變；改標題的版本會記下 Agent；主權杖打開開關後可以寫入，版本帶 `agent`（`via: direct`、`restore_to`）；可一鍵恢復；開關的變更出現在活動記錄。
  - **提案：**
    - hunk 與穩定 id；冪等鍵重送回同一個提案；沒有冪等鍵回 428；內容與 base 相同回 400。
    - 沒有 `propose` 的權杖不能建立（403）；Agent 不能採用（403）。
    - 部分採用 → 新版本帶 `via: proposal`；已決定的提案回 409 `proposal_closed`；數量歸零；事件帶 `actor`。
    - base 過期但沒有重疊時可以採用，舊 base 回 409。
    - 有重疊時，hunk 標 `conflict`，`conflicts` 給 base／mine／theirs；全收回 409 `proposal_conflict`，作品不變；只收不重疊的 hunk 可以成功。
    - 捨棄後保留 30 天（以注入的時鐘測試清除時機）。
  - **項目限定：**
    - 列表、搜尋、facets 只含範圍內；範圍外的作品、平台版本、項目回 404。
    - 不能建立項目；新作品必須帶範圍內的項目；不能歸入範圍外的項目。
    - 事件與提案也被過濾；解除限制後恢復全部可見。
  - **活動記錄：** 讀取不記；成功的修改帶 revision；409、403（包含 `direct_edit_not_allowed` 和缺權限）都記下錯誤碼；分頁；只限主權杖；`change_log.actor` 正確。
  - **權杖更新驗證：** 不存在的項目回 404；Agent 不能更新權杖（403）。
  - **0021 回滾：** 表與欄位移除，權杖範圍去掉 `propose`，`proposal.*` 事件刪除，之後可以再升級。
- `packages/domain/test/proposal-diff.test.ts`（8 項）：拆 hunk、插入與刪除、重疊規則、部分套用、rebase 到之後的修改、三方區域。
- `packages/agent-sdk/test/mcp-proposals.test.ts`（3 項）：
  - MCP 提案 → 使用者部分採用 → Agent 查到結果；Agent 不能 `work_update_body`。
  - 開關打開前後 `server_status.allowed` 與 `work_update_body` 的差異，版本標明 Agent。
  - 項目限定經 MCP 生效：只搜到範圍內，範圍外回 404，建立作品沒帶項目回 403，提示列出可用的項目。
- 依新規則更新的既有測試：
  - `m2-three-party`：Agent 打開開關。
  - `revisions-restore`：沒有開關回 403，有開關回 200。
  - `session-changes`：新欄位。
  - `backups`：`schema_version` 改為 `0021`。
  - `variant-overrides-migration`：只跑到 0020。
  - agent-sdk：工具清單、權限與唯讀標記、`work_restore_revision` 需要開關。
- 覆蓋與權限一致測試涵蓋新路由與 `propose` 權限。

## 範圍與 NOT_VERIFIED

- 介面（收件匣、權杖設定、活動記錄）屬 QC-091；這次只為通過型別檢查補了 `propose` 標籤。
- 用真正的 Claude Code 連線測試排在 QC-093：**NOT_VERIFIED**。

## 數字（2026-11-24）

- 全套 `pnpm -r --workspace-concurrency=1 --no-bail test`，開始時 1 分鐘負載約 4：
  - 11 個套件全部通過，1281 passed，0 failed。
  - mac-server 535（44 個檔）；apps/mac 445；agent-sdk 39；domain 53；其餘套件 209。
- typecheck：`pnpm -r typecheck`（含 apps/mac）加 `tsc -p e2e/tsconfig.json`，全部通過。
- 根目錄 `pnpm lint`（`eslint .`，含 e2e）：0 錯誤。
- prettier：所有變更檔案都通過。
- e2e：只改了 `TokensPanel` 的型別表，沒有可見的介面變更，本任務沒有跑 e2e（**NOT_VERIFIED**）。
