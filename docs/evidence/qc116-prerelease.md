# QC-116 發版前檢查：QC-113、QC-114、QC-115（項目分組與系列、降低提示頻率）

- 日期：2026-11-27。執行者：qc-test。
- 對象：`c1816f5`。乾淨 worktree `qiu-creator-qc116`，`pnpm install --frozen-lockfile`。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。全程負載低於 15：單元測試最高 9.3，e2e 最高 4.5。
- 隔離：
  - 所有服務都用臨時 `CREATORHUB_HOME`、臨時 HOME 和臨時埠（48961、48962）。
  - Agent 權杖都是新建的測試權杖。
  - 沒有碰真實的 `~/CreatorHub`、`/Applications`、launchctl，也沒有連 7420 服務。
  - 沒有呼叫第三方 API，也沒有跑 electron-builder。

**結論：可發版（`c1816f5`）。**

- 閘門都通過。單元測試 1459／0／1459。
- 整套 e2e：一般模式 69 passed／0 failed／10 skipped，`QC_E2E_MOTION=on` 70 passed／0 failed／9 skipped。
- 前端會話提醒的三條 spec 在兩種模式都通過。
- MCP 分組情境全部符合預期。
- 0023 → 0024 遷移、回滾、再升級都正常。
- 打包版煙霧測試是 **NOT_VERIFIED**：依 AGENTS.md「發版邊界」，打包只由發版會話執行。交給 qc-release，在升級前用不簽名的本機建置驗證 App 能啟動、能顯示分組。

## Plan

1. 從 `origin/main`（`c1816f5`）開 worktree。持 `qc-fullsuite.lock` 跑 lint、typecheck、format 和逐套件單元測試，每 5 秒記錄一次負載。
2. 持 `qc-e2e.lock`，在背景跑整套 e2e，一般模式和 `QC_E2E_MOTION=on` 各一次，同樣記錄負載。
3. 用 `services/mac-server` 的 `build` 建出新版（`c1816f5`）服務產物。另外開一個暫時的 detached worktree，建出目前發佈版（`4501a9f`，schema 0023）的服務產物。兩者都用 `env -i PATH=/usr/bin:/bin` 啟動。
4. 遷移演練：用舊版服務造資料 → 新版升到 0024 → 執行 `PROJECT_GROUPS_ROLLBACK_SQL` → 舊版開啟 → 新版再升級。
5. MCP：用 Agent 權杖跑真的 `bin/creatorhub mcp`（stdio），走完分組的建立、歸組（含 position）、改名（含過期的 base_revision）、刪除；再確認只能提案的權杖被拒。
6. 讀 QC-114 和 QC-115 改動的 e2e，確認沒有放寬斷言。

## 1. 原始碼閘門

| 項目 | 結果 |
| --- | --- |
| 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過 |
| `pnpm -r typecheck` | 通過 |
| `tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| `pnpm format:check` | 通過 |

單元測試一次跑一個套件。負載 3.3 → 8.6，每 5 秒取樣的 1 分鐘負載最高 9.3。

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac-server | 49 | 607／0／607 |
| @qiu-creator/mac | 61 | 523／0／523 |
| @qiu-creator/markdown-editor-web | 6 | 62／0／62 |
| @qiu-creator/domain | 5 | 58／0／58 |
| @qiu-creator/agent-sdk | 9 | 56／0／56 |
| @qiu-creator/installer | 2 | 42／0／42 |
| @qiu-creator/i18n | 3 | 30／0／30 |
| @qiu-creator/platform-preview | 4 | 27／0／27 |
| @qiu-creator/contracts | 4 | 26／0／26 |
| @qiu-creator/api-client | 2 | 22／0／22 |
| @qiu-creator/design-tokens | 1 | 6／0／6 |
| **合計** | 146 | **1459／0／1459** |

## 2. 整套 e2e（背景模式，持 `qc-e2e.lock`）

先跑 `pnpm --filter @qiu-creator/mac build`（exit 0），再跑 `playwright test --config=e2e/playwright.config.ts`。共 79 個測試，沒有重試，也沒有 flaky。

| 模式 | passed | failed | skipped | 時間 | 負載（開始 → 結束，1 分鐘） |
| --- | --- | --- | --- | --- | --- |
| 一般 | 69 | 0 | 10 | 3.5m | 2.8 → 3.4 |
| `QC_E2E_MOTION=on` | 70 | 0 | 9 | 4.9m | 3.4 → 3.6 |

- 兩種模式期間，每 5 秒取樣的 1 分鐘負載最高 4.5。
- skipped 都是刻意的模式分工：`*-motion.spec.ts` 裡「只在動效模式錄影」或「一般模式已涵蓋」的 `test.skip`。不是失敗被跳過。

前端會話提醒的三條，兩種模式都通過：

| spec | 一般 | 動效 |
| --- | --- | --- |
| `agent-attached-media.spec.ts:24` | 通過 | 通過 |
| `agent-proposals.spec.ts:62` | 通過 | 通過 |
| `agent-proposals.spec.ts:336`（QC-115 改動後在 `:340`，同一個測試「項目設定：描述、規則與試算；Agent 歸入的作品卡標示、保留與復原」） | 通過 | 通過 |

本次改動的 spec 也都通過：

- QC-114：`project-groups.spec.ts:76`（分段、拖曳歸組與集數）。
- QC-115：`editor-tabs.spec.ts` 的 6 個測試，包括新加的「看得到就只閃一下，收在分頁列外才提示」。

QC-115 的 e2e 改動我讀過 diff，判斷沒有放寬：

- 原本斷言「出現某個提示」的地方，改成斷言「不出現提示」，同時改用畫面上看得到的結果來證明動作完成。例如分頁 `tab--flash`、作品卡上的 Agent 標示消失、列表少一列。這是 QC-115 要的行為改變。
- 「分頁收在分頁列外時仍要提示」另外有正向斷言。
- 限制（不擋發版）：「不出現提示」用 `toHaveCount(0)` 斷言，在提示延遲出現的情況下可能太早通過。目前只有單元測試和截圖證明提示真的不會出現。

## 3. MCP 實測：項目分組與系列（QC-113）

### 環境

- 新版服務產物 build-info 是 `c1816f5`，用 `env -i PATH=/usr/bin:/bin` 啟動。
- 主權杖建立項目「京都旅行」和 3 篇作品，另外建 1 篇不在項目裡的作品。
- 兩個權杖：
  - 寫入權杖：`read, write`。
  - 只能提案的權杖：`read, propose`。
- `bin/creatorhub mcp` 只帶 `CREATORHUB_URL`、`CREATORHUB_TOKEN`、`PATH`、`HOME`。
- 腳本和完整輸出放在共用筆記資料夾的 `qc116-prerelease/`（`qc116_mcp.py`、`mcp-output.json`），不進倉庫。
- 第一次跑時我的腳本把 `project_get` 的分組讀成頂層 `groups`，正確位置是 `project.groups`，是腳本錯誤。修正後清空資料目錄重跑。

### 結果

| # | 步驟 | 實際 | 判定 |
| --- | --- | --- | --- |
| 1 | `tools/list`（寫入權杖） | 有 `project_group_create`、`project_group_update`、`project_group_delete`、`works_assign_group` | 通過 |
| 2 | `project_group_create` 建系列「第一季」（`ordered: true`） | revision 1；`created_by = {agent, QC-116 寫入 Agent}`；`work_ids` 是空的 | 通過 |
| 3 | 再建一個同名分組 | 409 `group_name_taken`，`details.group_id` 是既有分組 | 通過 |
| 4 | `works_assign_group` 把第二集、第三集加到最後 | `work_ids` 依序是第二集、第三集 | 通過 |
| 5 | `works_assign_group` 把第一集放在 `position: 1` | `work_ids` 依序是第一集、第二集、第三集（後面的往後移） | 通過 |
| 6 | 把不在項目裡的作品歸組 | 409 `work_not_in_project`，`details.work_ids` 列出那篇作品 | 通過 |
| 7 | `project_get` | `project.groups` 有「第一季」：`ordered: true`、`work_count: 3`、`work_ids` 是第一、二、三集 | 通過 |
| 8 | `work_get`（第一集） | `project_groups = [{group_name: 第一季, ordered: true, episode: 1}]` | 通過 |
| 9 | `project_group_update` 帶目前的 `base_revision: 1` 改名 | 改成「第一季：秋天」，revision 2 | 通過 |
| 10 | 再用過期的 `base_revision: 1` 改名 | MCP isError：409 `revision_conflict`，`details.current_revision = 2`，`retry` 提示重新讀取。REST `PATCH` 一樣是 409 | 通過 |
| 11 | `project_group_delete` | 成功；之後 `project.groups` 是空的，3 篇作品的 `project_groups` 都是空的（回到未分組），4 篇作品都還在 | 通過 |
| 12 | 只能提案的權杖呼叫 `project_group_create`、`works_assign_group` | 都是 403 `forbidden`（`required: write`），`retry` 寫「不要重試，請使用者授權」。REST 建立一樣是 403 | 通過 |
| 13 | 兩條 MCP 連線結束 | 都是 exit 0，stderr 是空的 | 通過 |

觀察（不擋發版）：

- 只能提案的權杖在 `tools/list` 也看得到 4 支分組寫入工具，要到呼叫時才被 403 拒絕。這和其他寫入工具一致：MCP instructions 要 Agent 先用 `server_status` 看自己能用哪些工具。
- 409 `revision_conflict` 的 `details.base_revision` 是字串 `'1'`，`current_revision` 卻是數字 `2`，型別不一致。Agent 照 `retry` 用 `current_revision` 重試不受影響。

## 4. 遷移演練：0023 → 0024 → 回滾 → 0023 → 0024

- 舊版產物：`4501a9f`（目前發佈版，schema 0023），從暫時的 detached worktree 建置。
- 新版產物：`c1816f5`。
- 兩版用同一個臨時 `CREATORHUB_HOME`，依序啟動。
- 腳本和完整輸出放在 `qc116-prerelease/`（`migrate.sh`、`api.py`、`migrate-output.txt`）。

| 步驟 | 結果 |
| --- | --- |
| 1. 舊版造資料 | schema `0023 project_text_script`。2 個項目：京都旅行 4 篇，咖啡筆記 2 篇。6 篇作品，其中 1 篇同時在兩個項目，1 篇沒有項目，1 篇改過兩版。另存 0023 資料庫副本 |
| 2. 新版開啟同一份資料 | schema 升到 `0024 project_groups`。作品和項目數量不變。`work_projects` 6 列的 `group_id` 都是 NULL。兩個項目的 `groups` 都是空的，每篇作品的 `project_groups` 都是空的，也就是**既有作品都在未分組** |
| 2b. 為了讓回滾有內容 | 在京都旅行建系列「第一季」並歸入 2 篇（201／200） |
| 3. `PROJECT_GROUPS_ROLLBACK_SQL` | exit 0。schema 回到 `0023`。`project_groups` 表已刪除，`work_projects` 欄位回到 0023 的樣子（沒有 `group_id`、`position`）。`pragma integrity_check` 是 ok |
| 4. 舊版開啟回滾後的資料庫 | 正常啟動，schema 0023，6 篇作品和 2 個項目（4／2 篇）都在 |
| 5. 新版再開啟 | 再次升到 0024，資料不變 |

- 兩版服務的日誌都沒有 error。
- 限制：造資料時我把作品移到回收站的呼叫寫錯了路由（404），所以這次舊資料裡沒有回收站中的作品，`回收站裡的稿` 只是一般作品。這不影響「既有作品都在未分組」和回滾的判定，但回收站作品的升級路徑這次沒有涵蓋：NOT_VERIFIED。

## 5. 打包版煙霧測試

**NOT_VERIFIED。**

- AGENTS.md「發版邊界」規定只有發版會話能執行 electron-builder。本機也沒有 `c1816f5` 的打包產物可以重用。
- 請 qc-release 在升級前，用不簽名的本機建置確認兩件事：App 能啟動；項目頁能顯示分組和系列。
- 開發版 App 在 e2e 的 desktop fixture 下已經驗證過分組介面（`project-groups.spec.ts`，兩種模式都通過）。

## 6. 收尾

- 臨時服務都已停，埠 48961、48962 已釋放。
- `qc-fullsuite.lock` 和 `qc-e2e.lock` 都已釋放。
- 暫時的舊版 worktree `qiu-creator-qc116-old` 和臨時資料目錄都已刪除。
- `qiu-creator-qc116` 和分支 `test/qc116-prerelease` 在總監合併後刪除。
