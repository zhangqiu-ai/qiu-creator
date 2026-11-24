# QC-093 MCP 驗收與發版前檢查

- 日期：2026-11-24。執行者：qc-test。
- 對象：main `e989492`（chore: close QC-094, start QC-093），包含 QC-087～092 和 QC-094。
- 規格：
  - `docs/mcp-plan.md`。
  - `docs/architecture.md` 的 MCP 一節。
  - `docs/decisions.md` 2026-11-24 的三條。
  - QC-087、088、089、091、092、094 的驗收記錄。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。
- 隔離：
  - 用乾淨的 checkout `qiu-creator-qc093`，從 `origin/main` 開，`pnpm install --frozen-lockfile`。
  - 所有服務都用臨時 `CREATORHUB_HOME`、臨時埠和臨時 HOME。資料都是我自己編的測試資料。
  - 沒有讀寫真實的 `~/CreatorHub`，沒有碰 `/Applications`，也沒有執行 launchctl 或 electron-builder。

**結論：可以發版。** 所有閘門 0 failed，MCP 10 個情境 10／10 passed，migration 可升級也可逐位元回滾。真 Agent（Claude Code）連線因使用者選擇跳過，標 NOT_VERIFIED。細節見第 6 節。

## 1. 原始碼檢查（`e989492`）

### 靜態檢查（負載 4.2–5.7）

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Lint | 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過（見下方說明） |
| 型別 | `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| 格式 | `pnpm format:check` | 通過 |

Lint 第一次跑失敗了 3 個錯誤，全是我放在工作樹裡、還沒提交的驗收腳本：`services/mac-server/tmp/qc093/*.ts`、`packages/agent-sdk/tmp/qc093/mcpcheck.ts`。錯誤是 "not found by the project service"。把這幾個檔案移出工作樹後重跑 root lint：通過，0 錯誤（負載約 20；lint 不受負載影響）。產品程式碼沒有 lint 錯誤。

### 單元測試（一次一個套件，負載 5.7 → 9.1）

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac-server | 45 | 547／0／547 |
| @qiu-creator/mac | 52 | 466／0／466 |
| @qiu-creator/markdown-editor-web | 6 | 62／0／62 |
| @qiu-creator/domain | 5 | 58／0／58 |
| @qiu-creator/installer | 2 | 42／0／42 |
| @qiu-creator/agent-sdk | 6 | 41／0／41 |
| @qiu-creator/i18n | 3 | 30／0／30 |
| @qiu-creator/platform-preview | 4 | 27／0／27 |
| @qiu-creator/contracts | 3 | 23／0／23 |
| @qiu-creator/api-client | 2 | 22／0／22 |
| @qiu-creator/design-tokens | 1 | 6／0／6 |
| **合計** | **129** | **1324／0／1324** |

### 整套 e2e（背景模式，開發建置；持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`）

| 模式 | 負載（開始 → 結束） | 結果（71 支） | 時間 |
| --- | --- | --- | --- |
| 一般 | 3.64 → 11.93 | 61 passed，0 failed，10 skipped | 3.4 分 |
| `QC_E2E_MOTION=on` | 11.93 → 30.48 | 62 passed，0 failed，9 skipped | 4.7 分 |

- skipped 是只在其中一種模式執行的 spec，和以往相同。
- 動效模式後段，機器上其他專案的工作讓負載升高；兩輪都沒有失敗，結果有效。

## 2. MCP 情境（MCP SDK client 經 stdio 連 `creatorhub mcp`）

**真 Agent（Claude Code）能否照工具說明正確使用：NOT_VERIFIED（使用者 2026-11-24 選擇跳過）。**

- 本機的 `claude` CLI 沒有登入（`loggedIn: false`）。
- 在登入前，我用 `claude -p --mcp-config` 試過一次，MCP 那端已經連上：init 顯示 `creatorhub connected`、39 個工具。
- 使用者選擇不登入，所以改用下面的做法。

**做法：**

- 用 `@modelcontextprotocol/sdk` 的 `Client`＋`StdioClientTransport`，啟動真正的子行程 `node packages/agent-sdk/bin/creatorhub.js mcp`。
- 子行程經 `CREATORHUB_URL`／`CREATORHUB_TOKEN` 連到臨時服務（臨時 `CREATORHUB_HOME`，埠 48931），逐一呼叫工具。
- 主權杖的動作（部分採用、打開開關、恢復）用 `api-client` 執行，代表 App 端的操作。

**測試資料（自編）：**

- 項目：「京都旅行」，有描述，關鍵字 京都／嵐山／清水寺，標籤 旅行。「咖啡筆記」，關鍵字 咖啡／手沖／烘焙度，標籤 咖啡。
- 作品三篇：「嵐山竹林清晨」、「手沖咖啡入門」、「雨後散步」。
- 兩把 Agent 權杖：
  - 「Claude Code 測試」：read、import、write、propose。
  - 「旅行助手」：同樣的範圍，但限「京都旅行」。
- 一張本機 PNG。

腳本和完整輸出放在共用筆記資料夾 `qc093-acceptance/`（`scenarios.ts`、`scenarios-output.txt`），不進倉庫。

**結果：10／10 passed。** 第一次跑有 5 個情境失敗，全是腳本自己的錯：讀錯 `work_get` 的回應層級、讀錯歸屬欄位的形狀。修好腳本後用全新的臨時資料重跑，10 個都通過。

| # | 情境 | 呼叫的工具（依序） | 結果 |
| --- | --- | --- | --- |
| S1 | 新建文章，`auto_assign` | `work_create`（帶冪等鍵、`auto_assign: true`） | passed：建立成功，自動歸入「京都旅行」（`kind: rule`，分數 0.9，原因「正文出現『京都』」…），回應帶 `auto_assignment` |
| S2 | 上傳本機圖片 | `asset_upload_file` ×2 → `work_attach_asset`（cover） → `asset_upload_file`（相對路徑） | passed：中文加空格的檔名上傳成功；同一個檔案再傳回 deduplicated，同一個 asset id；設為封面成功；相對路徑回 400 `validation_error`，帶 retry 提示 |
| S3 | 從網址匯入（本機假伺服器 127.0.0.1） | `asset_import_url` | passed（符合預期的拒絕）：400 `url_rejected`，`reason: blocked_address`，「address 127.0.0.1 is not publicly routable」，提示原樣重試會再失敗 |
| S4 | 依項目規則建議與歸入 | `work_create` → `projects_suggest` → `works_assign_projects` → `projects_suggest`（雨後散步） | passed：「烘焙度怎麼選」建議「咖啡筆記」0.83（`outcome: auto`）並附原因；歸入後標為 `kind: agent`，帶 Agent 名稱；「雨後散步」沒有建議，沒有動它 |
| S5 | 提案修改，主權杖部分採用 | `work_get` → `work_propose_edit` →（主權杖：只採用第 1 處）→ `proposal_get` | passed：提案分成 2 處，提案後正文不變；只採用第 1 處；Agent 查到 `partially_accepted`；新版本帶 `agent.via = proposal` |
| S6 | 開關關閉時直接改正文 | `server_status` → `work_get` → `work_update_body` | passed：403 `direct_edit_not_allowed`，訊息請改用提案；正文不變；`server_status` 回報 `allow_direct_body_edit` |
| S7 | 開關打開後直接修改，然後恢復 | （主權杖：打開開關）→ `work_get` → `work_update_body` →（主權杖：恢復到 `restore_to`、關閉開關） | passed：寫入成功；版本標明 Agent「Claude Code 測試」（`via: direct`）；恢復後正文和修改前完全相同 |
| S8 | 409 衝突，依提示重試 | `work_get` →（主權杖改標題）→ `work_update_meta`（舊 base）→ `work_update_meta`（用提示的 revision） | passed：409 `revision_conflict`，`details.current_revision` 給出新 revision 並帶 retry 提示；用它重試成功，主權杖改的標題沒被蓋掉 |
| S9 | 限定項目的權杖 | `works_search` → `work_get`（範圍外）→ `projects_list` → `work_create`（不帶項目）→ `work_create`（帶京都旅行） | passed：只搜到京都旅行的作品；範圍外作品回 404；項目清單沒有咖啡筆記；不帶項目建立回 403 `project_scope`，提示可用的項目；帶範圍內項目建立成功 |
| S10 | 主動呼叫不開放的功能 | `listTools` → `work_purge`、`backup_create`、`ai_rewrite` | passed：39 個工具裡沒有永久刪除、清空回收站、備份、雲端 AI、權杖或掛載相關的工具；直接呼叫回 MCP `-32602 Tool … not found`；作品都還在 |

## 3. 打包版（`e989492`，qc-release 建的 `--mac dir`，ad-hoc 簽名，沒有安裝）

### e2e spec

測試透過 `CREATORHUB_E2E_APP` 執行 .app，一律背景模式，home 和 userData 都是臨時目錄，持有 `qc-e2e.lock`。範圍：agent-proposals、library-projects、editor-preview、image-post（含 motion）、video-work、editor-tabs、new-api。

| 模式 | 負載（開始 → 結束） | 結果 |
| --- | --- | --- |
| 一般 | 3.19 → 3.26 | 18 passed，0 failed，1 skipped |
| `QC_E2E_MOTION=on` | 3.26 → 3.85 | 18 passed，0 failed，1 skipped |

skipped 的是 image-post-motion 只在其中一種模式執行的那一支。

### `bin/creatorhub mcp` 與「複製 MCP 設定」

1. **照 installer 的版面安裝：** 把 `services/mac-server/dist` 複製到臨時 HOME 的 `Library/Application Support/qiu-creator/server`。用 `env -i`（`PATH=/usr/bin:/bin`，沒有 Node）以附帶的 `bin/node server.mjs` 啟動服務；臨時 `CREATORHUB_HOME`，埠 48951。
2. **服務回報的 CLI 位置：** 主權杖的 `GET /api/v1/session` 回報 `cli`：
   - `command` 是 `<HOME>/Library/Application Support/qiu-creator/server/bin/creatorhub`；
   - `args` 是 `[]`，`source` 是 `installed`，`server_url` 是 `http://127.0.0.1:48951`。
3. **照「複製 MCP 設定」組設定：** 照 `apps/mac/src/renderer/agents-settings.ts` 的 `mcpConfig(secret, cli)` 組出 `mcpServers.creatorhub`，填入新建的 Agent 權杖。
4. **直接連線：** 用 MCP SDK client（`PATH=/usr/bin:/bin`）照這份設定啟動：
   - `initialize` 成功（`creatorhub`），`tools/list` 有 39 個工具；
   - `server_status` 回報 version 0.1.0、commit `e989492c…`，權杖類型 agent；
   - `works_search` 找到測試作品。
5. **installer dry run：** 依規定 launchctl 由 qc-release 執行。它用臨時 HOME、`--applications <臨時>/Apps`、`--port 7499`，不加 `--yes`，exit 0：
   - 報告印出 `creatorhub CLI: <HOME>/Library/Application Support/qiu-creator/server/bin/creatorhub`，以及同樣形狀的 `mcpServers` 設定：`args: ["mcp"]`，`env` 含 `CREATORHUB_URL`、`CREATORHUB_TOKEN`。
   - 第一次用預設的 `--applications` 和 `--port`，preflight 拒絕了，因為真實的 `/Applications/qiu-creator.app` 已存在、7420 埠被佔用。這是預期的保護，什麼都沒改。

### migration 0021、0022（只用臨時資料）

1. **舊版造資料：** 用 `a121162`（schema 到 0020）從原始碼在臨時 home 建資料：
   - 2 個項目、3 篇作品、5 個 revision，其中 1 篇在回收站；
   - 3 筆項目歸屬（一篇屬於兩個項目）；
   - 2 把舊權杖（read＋write、import）；
   - 8 筆 change_log。
   - 用 `.backup` 存成快照。
2. **升級：** 用打包版的伺服器（`dist/bin/node dist/server.mjs`）開快照的複本，`schema_migrations` 變成 `0020,0021,0022`。
   - API 讀回的作品、回收站、項目和權杖都和造資料時一樣。
   - 新欄位都是預設值：歸屬的 `added_by = user`；`description` 是空字串，`rules` 是空的四個陣列；權杖的 `allow_direct_body_edit = false`、`project_ids = null`；舊 revision 的 `agent_via` 全是 NULL；`change_log.actor` 全是 NULL。
3. **回滾：** 在升級後資料庫的複本上，依序執行 `PROJECT_RULES_ROLLBACK_SQL` 和 `AGENT_PROPOSALS_ROLLBACK_SQL`。結果的 `.dump` 和升級前的快照**逐位元相同**（diff 0 行），包含 schema 文字。
4. **舊版讀得到：** `a121162` 打開回滾後的複本，停在 0020，作品和權杖都讀得到。
5. **再升級：** 用打包版再開一次回滾後的複本，回到 `0020,0021,0022`，schema 與第一次升級的結果完全相同。

## 4. 介面截圖（打包版，一般模式）

用 `agent-proposals.spec.ts` 內建的 `QC091_SHOTS`，在打包版上拍，存在 `qc093/`，檔名沿用 `qc091-*`。

| 檔案 | 內容 |
| --- | --- |
| `qc091-inbox.png` | 提案收件匣：清單、Agent 說明、逐處勾選、「有重疊」標示 |
| `qc091-inbox-conflict.png`、`qc091-three-way.png` | 有重疊時不能採用、三方對照 |
| `qc091-editor-proposal-tab.png` | 編輯頁右側邊欄的「提案」分頁 |
| `qc091-tokens.png`、`-direct-confirm`、`-direct-on`、`-en`、`-zh-Hans`、`-en-dark` | 設定 › Agent 與 MCP：權杖、範圍、直接修改的確認、限定項目、最近活動與恢復上一版、「複製 MCP 設定」按鈕；三語與深色 |
| `qc091-project-rules.png` | 項目設定：描述、規則、試算（≥ 0.8 自動歸入） |
| `qc091-agent-assigned.png` | 作品卡上的 Agent 標示：「由 Claude Code 歸入『京都旅行』」、分數與原因、保留與復原 |

我逐張看過，畫面都和 spec 斷言的狀態一致。spec 刻意不點「複製 MCP 設定」，因為會寫到真實的剪貼簿；它組出的內容已由第 3 節的實際連線和 `agents-ui` 單元測試驗證。

## 5. 觀察（不影響結論）

- 從原始碼執行的開發版啟動器 `packages/agent-sdk/bin/creatorhub.js`，在 client 關掉 stdio 時，stderr 會印出 Node 的 "Warning: Detected unsettled top-level await"。協定與結果都不受影響。安裝版走 `creatorhub.mjs`，不經 tsx；但我沒有特別檢查它的 stderr，標 NOT_VERIFIED。
- 從原始碼執行時，`server_status` 的 commit 是 `null`；打包版會正確回報 `e989492c…`。這是預期行為。
- 本機的 `claude` CLI 沒有登入，是環境狀態，不是產品問題。

## 6. 結論

**可以發版。**

- typecheck、root lint、format 都通過。全套單元測試 1324／0／1324。
- e2e 一般模式 61 passed、0 failed、10 skipped；動效模式 62 passed、0 failed、9 skipped。
- 打包版：7 支 spec 兩種模式都是 18 passed、0 failed。`bin/creatorhub mcp` 在安裝版面能啟動，用「複製 MCP 設定」的內容可以直接連上。
- migration 0021、0022 可以升級、逐位元回滾，舊版讀得到，回滾後也能再升級。
- MCP 10 個情境 10／10 passed。
- 沒有發現產品缺陷，所以沒有交給 qc-bugfix。

**NOT_VERIFIED：**

- 真 Agent（Claude Code）能否照工具說明正確使用：使用者 2026-11-24 選擇跳過。
- 實際安裝到真實 HOME 與 launchd 載入：屬 qc-release 的正式升級。
- 安裝版 `creatorhub.mjs` 的 stderr 是否乾淨。
