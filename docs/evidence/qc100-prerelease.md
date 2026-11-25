# QC-100 發版前檢查：Agent 即時狀態（QC-095～098），含 QC-101 補驗

- 日期：2026-11-25。執行者：qc-test。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。全程負載低於 15。
- 隔離：
  - 所有服務都用臨時 `CREATORHUB_HOME`、臨時埠和臨時 HOME，Agent 權杖都是新建的測試權杖。
  - 沒有碰真實的 `~/CreatorHub`、`/Applications`、launchctl，也沒有連真實的 7420 服務。
- 檢查分兩輪：
  - 第一輪在 `45876bc`，查出 `creatorhub mcp` 斷線時以 exit 13 結束。總監判定擋發版，開 QC-101 交給 qc-bugfix 修。
  - QC-101 合併後，第二輪在 `dc4272b` 補驗。

**結論：可以發版（`dc4272b`）。**

- 閘門都通過。單元測試 1356／0／1356；`dc4272b` 上 agent-sdk 47／0／47。
- 兩種模式的整套 e2e 都是 0 failed。
- 打包版：6 支 spec 兩種模式都是 14／14。
- 經打包的 `creatorhub mcp` 回報 working 和 done，GET 和 SSE 都看得到；關掉 stdin 或送 SIGTERM，都以 exit 0 結束，stderr 是空的。
- schema 是 `0022`。

## 1. 原始碼閘門

### `45876bc`（乾淨 checkout `qiu-creator-qc100`，`pnpm install --frozen-lockfile`）

| 項目 | 結果 |
| --- | --- |
| 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過（負載 3.4） |
| `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| `pnpm format:check` | 通過 |

單元測試（一次一個套件，負載 5.9 → 7.5）：

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac-server | 46 | 563／0／563 |
| @qiu-creator/mac | 54 | 477／0／477 |
| @qiu-creator/markdown-editor-web | 6 | 62／0／62 |
| @qiu-creator/domain | 5 | 58／0／58 |
| @qiu-creator/agent-sdk | 7 | 43／0／43 |
| @qiu-creator/installer | 2 | 42／0／42 |
| @qiu-creator/i18n | 3 | 30／0／30 |
| @qiu-creator/platform-preview | 4 | 27／0／27 |
| @qiu-creator/contracts | 4 | 26／0／26 |
| @qiu-creator/api-client | 2 | 22／0／22 |
| @qiu-creator/design-tokens | 1 | 6／0／6 |
| **合計** | **134** | **1356／0／1356** |

整套 e2e（背景模式，開發建置；持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`）：

| 模式 | 負載（開始 → 結束） | 結果（73 支） | 時間 |
| --- | --- | --- | --- |
| 一般 | 7.47 → 6.12 | 63 passed，0 failed，10 skipped | 3.4 分 |
| `QC_E2E_MOTION=on` | 6.12 → 3.60 | 64 passed，0 failed，9 skipped | 4.6 分 |

skipped 的是只在其中一種模式執行的 spec，和以往相同。

### `dc4272b`（QC-101 合併後，同一個 worktree 重定基到 `origin/main`）

| 項目 | 結果 |
| --- | --- |
| 根目錄 `pnpm lint` | 通過（負載 2.9） |
| `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| `pnpm format:check` | 通過 |
| `@qiu-creator/agent-sdk` 測試 | 7 個檔案，47／0／47 |

**沒有重跑整套 e2e，理由：** `45876bc..dc4272b` 只改了 `packages/agent-sdk/mcp/stdio.ts`、它的測試 `packages/agent-sdk/test/mcp-client.test.ts`，以及 `.tasks`。App、服務和 e2e 都沒動；45876bc 上兩種模式的 e2e 都是 0 failed。這是總監的決定。

## 2. 打包版

### 2.1 `45876bc` 的建置：App 的 e2e

qc-release 建的 `--mac dir`，ad-hoc 簽名，沒有安裝。

測試透過 `CREATORHUB_E2E_APP` 執行 .app，一律背景模式，home 和 userData 都是臨時目錄，持有 `qc-e2e.lock`。範圍：agent-live、agent-proposals、library-projects、editor-preview、editor-tabs、new-api。

| 模式 | 負載（開始 → 結束） | 結果 |
| --- | --- | --- |
| 一般 | 4.11 → 3.29 | 14 passed，0 failed |
| `QC_E2E_MOTION=on` | 3.29 → 3.58 | 14 passed，0 failed |

截圖用 `agent-live.spec.ts` 內建的 `QC097_SHOTS`，在打包版上拍。一般模式存在 `qc100/`，動效模式存在 `qc100/motion/`：

| 檔案 | 內容 |
| --- | --- |
| `qc097-grid.png`（兩種模式都有） | 作品卡的 Agent 標籤與狀態：工作中（藍框、跳動的點）、3 分鐘沒有回報（虛線框）、下載失敗與「重試 2 項」、提案待審與「審閱提案」、已完成、兩個 Agent 同時工作；配圖生成中的骨架卡；頁首「2 個 Agent 工作中」 |
| `qc097-sidebar-popover.png` | 側欄「● 2」與「正在工作」浮層，列出 Claude Code 和 Codex |
| `qc097-list.png`、`qc097-editor-propose.png`、`qc097-editor-direct-typing.png`、`qc097-grid-dark.png`、`qc097-grid-en.png` | 列表、編輯頁的提案與直接修改、深色、英文 |

**卡片動效：** `motion/qc097-grid.png` 是動效模式下、動畫進行中拍的一格靜態畫面：跳動的點、外框和骨架都有。這次沒有錄影；動畫本身的時序由 agent-live spec 在 `QC_E2E_MOTION=on` 下的斷言涵蓋。

### 2.2 `agent_status_report`（第一輪 `45876bc`，第二輪 `dc4272b`）

**做法：**

1. 把打包的 `services/mac-server/dist` 照 installer 的版面，複製到臨時 HOME 的 `Library/Application Support/qiu-creator/server`。
2. 用 `env -i`（`PATH=/usr/bin:/bin`）以附帶的 `bin/node server.mjs` 啟動服務；臨時 `CREATORHUB_HOME`，埠 48971。
3. 主權杖建一篇測試作品，和一把 Agent 權杖（read、import、propose）。
4. 主權杖開 `GET /api/v1/events` 的 SSE 串流。
5. 啟動打包的 `bin/creatorhub mcp`：stdio，`PATH=/usr/bin:/bin`，`CREATORHUB_URL` 指向臨時埠。用 JSON-RPC 依序呼叫 `initialize`、`tools/list`、`server_status`，再對這篇作品呼叫 `agent_status_report`：先 `working`（step「正在整理第一段」），再 `done`（step「整理完成」）。每次回報後讀一次 `GET /api/v1/agents/activity?work_ids=…`。
6. 關掉 stdin，記錄結束碼和 stderr。再開一個連線，`initialize` 後送 SIGTERM，記錄結束碼和 stderr。

腳本 `qc100_agent.py` 放在共用筆記資料夾 `qc100-prerelease/`，沒有進倉庫。

| 檢查 | `45876bc` | `dc4272b` |
| --- | --- | --- |
| `initialize`、工具數 | 成功，40 個（含 `agent_status_report`） | 成功，40 個 |
| `server_status` 的 commit | `45876bc2…` | `dc4272b0…` |
| 回報 `working` | 成功，回傳 `state: working`、step、`expires_at`（2 分鐘） | 同左 |
| 之後 `GET /agents/activity` | 200；`working` 與 step；`counts.all = {agents: 1, works: 1}` | 同左 |
| 回報 `done` | 成功，`expires_at` 為 8 秒後 | 同左 |
| 之後 `GET /agents/activity` | 200；`done`，step「整理完成」 | 同左 |
| SSE `agent.activity` | 收到兩筆，依序 `working` 和 `done`，Agent 名稱、作品與 step 都對，帶 `counts` | 同左 |
| Agent 權杖讀 `GET /agents/activity` | 403（只限主權杖） | 403 |
| 關掉 stdin 後結束 | **exit 13**；stderr 有 "Warning: Detected unsettled top-level await at …/server/creatorhub.mjs:45219" | **exit 0**，stderr 是空的 |
| SIGTERM | 沒有測 | **exit 0**，stderr 是空的 |

## 3. 資料庫

這次沒有新的 migration。原始碼的最後一個遷移仍是 `0022`。兩次打包版建出的新資料庫，`schema_migrations` 都是 `…,0020,0021,0022`。

## 4. 第一輪發現的缺陷（QC-101，已修，已補驗）

- **現象：** MCP client 關掉 stdin 後，`creatorhub mcp` 以 exit code 13 結束，stderr 印出 Node 的 unsettled top-level await 警告。從原始碼執行和打包版都一樣。QC-093 那時只看到 stderr 警告，標了 NOT_VERIFIED；這次確認了結束碼。
- **根因：**
  1. `@modelcontextprotocol/sdk` 1.32.2 的 `StdioServerTransport` 只監聽 stdin 的 `data` 和 `error`；`onclose` 只有在明確呼叫 `close()` 時才觸發。
  2. 所以 `packages/agent-sdk/mcp/stdio.ts` 的 `serveMcpStdio` 等待 `onclose` 的 promise，在 stdin 結束後永遠不會 resolve。
  3. 事件迴圈清空時，`src/bin.ts` 的頂層 `await runCli(...)` 還沒有結束，Node 以 13 退出。
- **處理：** 總監判定擋發版，開 QC-101（P2），由 qc-bugfix 修：`c9f603f`，合併成 `5d6aff3`。修正後在 `dc4272b` 的打包版上，關掉 stdin 和 SIGTERM 都是 exit 0，stderr 是空的（見 2.2）。

## 5. NOT_VERIFIED

- 卡片動效的錄影：只有動效模式下的一格靜態截圖（2.1）。
- 在真的 Claude Code 裡呼叫 `agent_status_report`：協定已由打包的 stdio 行程實際驗證。
- 實際安裝到真實 HOME 與 launchd 載入：屬 qc-release 的正式升級。
