# QC-053 驗收記錄：最近刪除作品在其他地方的殘留

日期：2026-11-21　分支：`fix/qc053-trash-followups`（從 `origin/main` de835ed 開）　worktree：`/Users/feature/code/qiu-creator-qc053`

這是 QC-051 回報的三個範圍外問題。測試全部使用臨時的 `CREATORHUB_HOME`，沒有網路請求（URL 匯入的拒絕發生在下載之前）。`.tasks/` 沒有修改。

## 1. 交付內容

| 問題 | 實作 |
| --- | --- |
| 素材的 `asset_in_use` 與 `references` 仍列出已刪除作品 | 在 `references` 中，`works`／`variants` 只列沒有被刪除的作品；最近刪除中作品的引用（含它們的平台版本）另列在新欄位 `in_trash`。只有前者會讓刪除素材需要 `confirm`。`GET /assets/:id/works` 也不列已刪除作品（同一個根因） |
| agent-sdk CLI 沒有刪除與批量指令 | `works delete`、`works restore`、`works batch <trash\|restore\|set-status\|add-tags\|remove-tags>`，以及 `works list --trash`。只需要 `write` 權限；不提供永久刪除，也不提供移到系統垃圾桶 |
| 已刪除作品仍可當 URL 匯入的 `link_work_id` | 建立任務時回 409 `work_in_trash`（`details.work_id`、`deleted_at`），不會建立任務 |
| 文件 | `docs/architecture.md`（套件表、API 表、最近刪除一節）；`README.md`（CLI 用法） |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 已刪除作品的引用算不算「使用中」 | A 照舊計入，加上標記；B 不計入，另外列出並標「在最近刪除中」 | B | 刪除素材本身 30 天內可以恢復，使用者看不到、也沒在編輯的作品不應擋住清理。連結與平台版本的 id 都保留，素材和作品各自恢復後引用都會回來（有測試） |
| B 的代價 | — | 寫進文件與 contracts 註解 | 素材**永久刪除**時，已刪除作品的連結也會移除，作品之後再恢復就缺這個素材（有測試）。刪除回應的 `references.in_trash` 仍會列出這些作品，App 可以在刪除或永久刪除前提示 |
| `in_trash` 的形狀 | 每項加上 `in_trash: true`；或另開一個欄位 | 另開 `in_trash: { works, variants }`，項目形狀與原本相同 | 原本只讀 `works`／`variants` 的用戶端不用改，就不會再把已刪除作品當成使用中 |
| 任務建立後作品才被刪除 | 下載完不連結；或照原本設定連結 | 照原本連結 | 連結會像其他連結一樣保留，作品恢復後就在；建立時的拒絕已涵蓋使用者能看到的情況 |
| CLI 的版本保護 | 一律自動用目前版本；或要求明確指定 | 要求 `--base-revision` 或 `<id>:<revision>`；`--use-current-revision` 必須明確加上 | 與 API 相同的衝突保護；Agent 想放棄保護時要自己說出來 |
| CLI 的權限 | — | 刪除、恢復、批量只需要 `write`；不提供 purge、清空、`move_original_to_trash` | 最小權限：CLI 能做的都在 30 天內可以挽回 |
| `works list` 的輸出 | 加一欄 revision；或維持原樣 | 維持原樣（`--trash` 時日期欄改成刪除時間） | 避免改動既有腳本解析的格式；需要版本時用 `--json` |

## 3. 自動測試

- `services/mac-server/test/trash-followups.test.ts`（4 個測試）：
  - `references` 把已刪除作品的封面連結與小紅書封面放進 `in_trash`，`GET /assets/:id/works` 不列出它們。
  - 還有一般作品使用時仍回 `asset_in_use`。
  - 只被已刪除作品使用的素材，單筆和批量刪除都不需要 `confirm`，刪除回應帶 `in_trash`。素材與作品恢復後，連結與平台版本封面都回來。
  - 素材永久刪除後再恢復作品：連結和封面都已清掉。
  - URL 匯入指定已刪除作品回 409 `work_in_trash`，`import_jobs` 沒有新資料列；作品恢復後同一個請求會被接受。
- `packages/agent-sdk/test/cli.test.ts` 新增 4 個測試，用只有 `read`＋`write` 的 Agent 權杖：
  - delete 沒帶版本時拒絕；帶版本可以刪除；`list --trash` 列得出來；`restore --use-current-revision` 會恢復。
  - batch：`add-tags` 混用 `<id>:<revision>` 與 `--use-current-revision`；`set-status` 其中一項版本過期時，回 `revision_conflict`，其他項照樣成功，退出碼 1；`--json` 輸出。
  - 不合法的 id、不存在的動作 `purge`、沒帶 `--tags`：都在送出前就拒絕。`works --help` 裡沒有 purge 或清空指令。
  - 只讀權杖刪除回 403，作品沒有變化。
- 既有的三個精確比對斷言（`asset-library.test.ts` 兩處、`work-media-attach.test.ts` 一處）補上 `in_trash: { works: [], variants: [] }`：形狀多了一個欄位，斷言的嚴格程度不變。

## 4. 閘門結果

全套與 e2e 都是在持有鎖、而且 1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **962 passed／0 failed／962 total**（2026-11-21 20:35，負載 3.30→5.21）：contracts 23、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 441（新增 4）、apps/mac 320、agent-sdk 10（新增 4） |
| e2e（全部 spec，先 build `apps/mac`） | **20 passed／0 failed／20 total**（20:35–20:37，負載 7.15） |

沒有加長逾時、加重試或放寬斷言。

## 5. 給前端（未做，屬前端範圍）

- 素材刪除確認與永久刪除前，可以用 `references.in_trash` 提示「也被 N 個在最近刪除中的作品使用」。永久刪除時尤其需要，因為那些作品恢復後會缺這個素材。

## 6. 收尾

- 測試伺服器由測試自己關閉，臨時目錄已刪除。
- 全套與 e2e 的鎖都已釋放。
- 沒有改 `.tasks/`。
- worktree 與分支保留，等總監驗收合併後再刪。
