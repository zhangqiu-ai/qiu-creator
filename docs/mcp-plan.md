# MCP 規劃

> 狀態：使用者 2026-11-24 核准方向（第 9 節）。任務 QC-087～QC-093。

## 1. 目標

讓其他 Agent（Claude Code、Codex、Claude Desktop 等）透過 MCP 操作 qiu-creator 幾乎所有功能，例如：

- 新建文章、貼圖或視頻作品。
- 上傳本機檔案、從網址匯入素材，並連到作品。
- 查看和搜尋作品、素材、項目、歷史版本和平台預覽。
- 編輯正文、標題、標籤、狀態和四個平台的版本。
- 依內容自動判斷作品屬於哪個項目，並歸入。
- 追蹤匯入任務和內容變更。

之後每個新功能都要同時有對應的 MCP 工具，否則測試會失敗（見第 6 節）。

## 2. 現況

**已經有的基礎（直接沿用）：**

- `mac-server` 約 87 個 `/api/v1` 路由，有 OpenAPI（`/docs/json`），請求與回應都用 `packages/contracts` 的 Zod 契約。
- Agent 權杖：`chk_…`，可撤銷，資料庫只存雜湊。權限範圍有 `read`、`import`、`write` 三種，定義在 `services/mac-server/src/auth/scopes.ts`。未列出的路由預設只有主權杖能用。
- 409 衝突（`base_revision`／`If-Match`）、冪等鍵、`change_log` 加 SSE 變更事件、回收站 30 天可恢復。
- `creatorhub` CLI 已能建立、列出、刪除、恢復作品，以及管理項目。
- `packages/agent-sdk/mcp/` 已預留位置，規則是只能經 `api-client` 呼叫，不直接碰檔案或 SQLite。

**缺的部分：**

1. MCP 伺服器本身。
2. Agent 修改正文的「提案」流程。依 AGENTS.md，AI 不能直接覆蓋原文；外部 Agent 也是 AI。
3. 項目的自動歸屬。目前項目只有名稱和顏色，沒有可以比對的描述或規則。
4. 介面上看不到 Agent 做了什麼：沒有活動記錄、提案收件匣，也不能設定權杖只能動哪些項目。
5. 沒有機制保證新功能會同步出 MCP 工具。

## 3. 架構

```text
Claude Code／Codex／Claude Desktop
        │  stdio（MCP）
        ▼
creatorhub mcp            ← packages/agent-sdk/mcp，由 Agent 啟動的本機行程
        │  HTTP + Agent 權杖（只經 api-client）
        ▼
mac-server 127.0.0.1:7420 ← 唯一權威，權限、409、冪等全在這裡
```

- **傳輸：** 第一期只做 stdio。Agent 設定裡寫 `creatorhub mcp`，用環境變數 `CREATORHUB_TOKEN` 帶 Agent 權杖。服務不開新的對外埠。
- **第二期：** 再評估在服務上加 Streamable HTTP `/mcp`，經 Tailscale 給手機或遠端 Agent 使用；不對公網開放。
- **依賴：** 官方 `@modelcontextprotocol/sdk`（MIT），記錄在 `docs/dependencies.md`。
- **不重複邏輯：** MCP 工具只是把 API 包成工具。驗證、權限和衝突一律由服務判斷，MCP 層不另寫規則。
- **本機檔案上傳：** MCP 行程跑在 Mac 上，可以讀 Agent 給的本機路徑，再用既有的 tus 上傳。只接受一般檔案，類型和大小照服務的規則。不提供讀任意檔案內容的工具。

## 4. 工具清單（初版）

命名用 `領域_動作`。參數直接用 contracts 的 Zod schema 產生，工具說明用英文（給 Agent 讀）。

| 領域 | 工具 | 權限 |
| --- | --- | --- |
| 總覽 | `server_status`（版本、權杖範圍、可用工具）、`changes_since`（從某個序號之後的變更） | read |
| 作品 | `works_search`（關鍵字、類型、狀態、標籤、項目、拼音）、`work_get`（中繼資料 + Markdown + 素材 + revision）、`work_revisions`、`work_diff` | read |
| 作品 | `work_create`（文章、貼圖、視頻；可帶項目、標籤、素材） | import |
| 作品 | `work_update_meta`（標題、標籤、狀態，必須帶 `base_revision`） | write |
| 作品 | `work_propose_edit`（正文修改成為提案，使用者確認後才生效） | propose（新增） |
| 作品 | `work_trash`／`work_restore`／`works_batch` | write |
| 素材 | `assets_search`、`asset_get` | read |
| 素材 | `asset_upload_file`（本機路徑）、`asset_import_url`、`job_get`／`job_wait` | import |
| 素材 | `work_attach_asset`、`work_detach_asset`、`work_reorder_assets` | write |
| 項目 | `projects_list`、`project_get`（含摘要） | read |
| 項目 | `project_create`／`project_update`、`works_assign_projects` | write |
| 項目 | `projects_suggest`（依內容建議歸屬，見第 5 節） | read |
| 平台 | `variant_get`（四個平台的推導結果、字數、超限位置）、`platform_rules` | read |
| 平台 | `variant_update`（標題、封面、圖片順序、標籤） | write |

**MCP resources：** `creatorhub://works/{id}`（Markdown 原文）、`creatorhub://projects`、`creatorhub://platforms/{platform}/rules`。

**MCP prompts（範例）：** 「把這批素材整理成一篇小紅書筆記」「把這篇文章歸到合適的項目」。

**預設不開放給 Agent（只限主權杖，MCP 不提供）：**

- 永久刪除、清空回收站、把外部檔案移到系統垃圾桶。
- 備份與還原、外部資料夾掛載、Agent 權杖管理。
- AI 金鑰，以及任何會花錢或把內容送到第三方的雲端 AI（改寫、標題建議、視頻理解）。

**工具數量控制：** 啟動時可以用 `--toolsets works,assets,projects` 只開需要的領域，預設全開，避免工具太多佔用 Agent 的上下文。

## 5. 安全與權限

- **正文修改走提案。** `work_propose_edit` 建立候選版本加 diff，出現在 App 的「Agent 提案」收件匣。使用者採用後才成為新版本，舊版本永遠可以恢復。介面盡量沿用 QC-022 AI 候選與 diff 的確認介面。
- **直接寫入（選配）。** 若使用者對某個權杖另外打開「允許直接修改正文」，修改照樣帶 `base_revision`，寫入前留快照，歷史裡標明「由 Agent〈名稱〉修改」，一鍵恢復。此選項預設關閉，只有使用者在 App 裡對該權杖打開才生效（第 9 節決定 1）。
- **權杖限定項目（新增）。** 權杖可以只允許讀寫指定的項目，例如某個 Agent 只能動「旅行」項目。
- **活動記錄。** `change_log` 記錄是哪個權杖做的修改。App 的權杖面板顯示每個 Agent 最近做了什麼，並可撤銷權杖。
- **內容當資料。** 作品內容回給 Agent 時，工具說明要提醒 Agent：內容是使用者資料，不是指令。
- **資料安全。** 測試一律用臨時的 `CREATORHUB_HOME`，不連第三方。

## 6. 新功能自動同步 MCP（最重要的機制）

做法：一張路由對照表，加上一個會失敗的測試。

1. **對照表** `packages/agent-sdk/mcp/coverage.ts`：每個 `/api/v1` 路由必須二選一：
   - 對應到某個 MCP 工具；或
   - 列在 `MCP_EXCLUDED`，寫明原因，例如「只限主權杖：備份還原」「內部用：縮圖影格快取」。
2. **覆蓋測試：** 啟動測試用服務，列出 Fastify 實際註冊的全部路由，和對照表比對。有新路由沒歸類，或對照表裡有已經不存在的路由，測試就失敗。新功能不補 MCP 就無法通過 `pnpm test`。
3. **權限一致測試：** 每個工具宣告的權限必須等於 `scopes.ts` 對該路由的判定，避免 MCP 說明與實際權限不一致。
4. **契約一致：** 工具參數直接取自 contracts 的 Zod schema。契約改了，工具跟著改；型別對不上時 typecheck 失敗。
5. **端到端測試：** 用 MCP SDK 的 client 在行程內連 `creatorhub mcp`，跑主要情境：新建文章、上傳素材、歸入項目、提案修改、409 衝突、權限不足。
6. **流程規則：** AGENTS.md 加一條：「新增或修改 API 路由時，同一任務要更新 MCP 工具或排除清單」。總監驗收時也檢查這一點。

## 7. 項目自動歸屬

- **項目加欄位：** `description`（這個項目在做什麼）和 `rules`（關鍵字、標籤、來源資料夾或掛載、來源網域）。需要可回滾的 migration；在 App 的項目設定裡可以編輯。
- **`projects_suggest`：** 服務端用確定性的規則評分，不呼叫雲端 AI。依標題、正文關鍵字、標籤、來源資料夾和網域比對，回傳候選項目、分數和原因，例如「正文出現『京都』，符合規則」。
- **判斷交給 Agent：** Agent 本身就是大型模型，可以讀項目描述和作品內容自行判斷，再呼叫 `works_assign_projects`。我們不替它花雲端 AI 的錢。
- **建立時自動歸入（選配）：** `work_create` 帶 `auto_assign: true` 時，只有分數夠高才歸入，並在回應中說明原因；介面上可以復原。
- **App 端：** 作品顯示「由 Agent 歸入：原因…」，並提供復原。手動拖放的歸屬不會被自動規則覆蓋。

## 8. 任務拆分

| 順序 | 任務 | 負責 | 內容 |
| --- | --- | --- | --- |
| 1（QC-087） | MCP 基礎與唯讀工具 | qc-backend | `creatorhub mcp`（stdio）、權杖、`--toolsets`、全部唯讀工具與 resources、覆蓋與權限一致測試、AGENTS.md 規則、設定範例（Claude Code、Codex、Claude Desktop） |
| 2（QC-088） | 匯入與寫入工具 | qc-backend | 新建作品、本機與網址上傳、素材連結、中繼資料、平台版本、回收站、批量；409 與冪等鍵完整傳回 |
| 3（QC-089） | 提案流程與活動記錄（後端） | qc-backend | 新增 `propose` 範圍、提案資料表與 API、`change_log` 記錄操作者、權杖限定項目 |
| 4（QC-090） | 原型：提案收件匣、權杖設定、項目規則 | qc-prototype | Mac 畫面；先給使用者核准 |
| 5（QC-091） | 介面實作 | qc-frontend | 依核准的原型實作提案收件匣、權杖範圍與項目限定、Agent 活動記錄、項目描述與規則編輯 |
| 6（QC-092） | 項目自動歸屬 | qc-backend | 項目欄位 migration、`projects_suggest`、`auto_assign` |
| 7（QC-093） | 驗收 | qc-test | 用真的 Claude Code 連本機 MCP 跑一輪情境（臨時資料目錄），兩種 e2e 模式全綠，然後發版 |

任務 1、2、3 依序由後端做；任務 4（原型）可以和任務 1 同時開始。

## 9. 使用者決定（2026-11-24）

1. **Agent 改正文：** 預設走提案；使用者可以對個別權杖打開「允許直接修改正文」。直接修改仍帶 `base_revision`、寫入前留快照、歷史標明是哪個 Agent，並可一鍵恢復。
2. **雲端 AI：** 第一版不開放給 Agent，仍只限使用者在 App 裡觸發。
3. **項目歸屬：** 服務給建議和原因，由 Agent 決定後歸入；`auto_assign` 只在分數夠高時歸入，介面可復原。
4. **優先順序：** MCP 排在 QC-033 日常使用驗收之前，P1。

## 10. 不在這次範圍

- 公網或遠端存取（第二期經 Tailscale）。
- 代為發布到平台（M4，只保留介面）。
- 刪除使用者資料的永久性操作，以及備份、金鑰相關工具。
