# QC-051 驗收記錄（後端）：作品刪除、最近刪除與批量操作

日期：2026-11-21　分支：`feat/qc051-works-trash`（從 `origin/main` 762b883 開）　worktree：`/Users/feature/code/qiu-creator-qc051`

全部使用臨時的 `CREATORHUB_HOME`、臨時掛載資料夾和假的 `SystemTrash`。沒有碰真實資料或系統垃圾桶，也沒有對第三方發請求。API 草案已在動工時傳給前端會話（QC-052）。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| 刪除進最近刪除，30 天後才永久刪除，期間可恢復，revision 與歷史不變 | `src/works/work-trash.ts` 的 `WorkTrash`：只標記 `deleted_at`／`removal`。每小時清一次超過 `WORK_TRASH_RETENTION_DAYS`（30）的作品 |
| 列表 `scope=trash` | `GET /works?scope=active\|trash`。`ids=` 也遵守 scope，已刪除的列在 `missing_ids` |
| 託管作品不直接 `rm` | 資料夾留在 `library/works/<id>/`，只有永久刪除才刪。資料夾裡被素材庫引用的檔案先搬到 `library/assets/<id>/` |
| 外部掛載只取消索引，移到垃圾桶要明確勾選 | 預設 `unindexed`，檔案不動，重新掃描不收回。`move_original_to_trash` 只限主權杖、只限單筆，失敗回 500 `trash_failed` 且不做任何改動。永久刪除後記進 `work_exclusions`，之後也不會再被索引 |
| 批量刪除、恢復、改狀態、加減標籤，每項帶 `base_revision`，逐項回報，帶冪等鍵 | `POST /works/batch`：逐項處理，回 `results`、`succeeded`、`failed`。冪等新增 `IdempotencyService.runAsync`，同一個鍵的並行請求只會執行一次 |
| 事件 | `work.trashed`、`work.restored`、`work.deleted` |
| contracts、api-client、scopes | `packages/contracts/src/work-trash.ts`；`Work` 新增 `deleted_at`、`purge_at`、`removal`；新錯誤碼 `work_in_trash`；`client.works.trash`／`restoreFromTrash`／`purge`／`emptyTrash`／`batch`。scopes：刪除、恢復、批量需要 `write`；永久刪除與清空只限主權杖 |
| 改名沿用 PATCH title | 不新增端點。測試確認：貼圖與視頻作品寫進 front matter 的 `title`；文章只改作品標題，H1 與檔名不動；外部檔案不改名，重新掃描後標題保留 |
| migration 可回滾並寫進 architecture.md | `0016_work_trash` 只加欄位、索引和一張表。`WORK_TRASH_ROLLBACK_SQL` 的回滾有測試，回滾後可重新套用 |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 託管作品刪除時資料夾放哪 | A 留在原地；B 搬到 CreatorHub 內的回收區 | A | 不搬檔，恢復時不會因為搬移失敗而出錯；與素材做法一致 |
| 永久刪除外部作品後，重新掃描怎麼辦 | A 會再被索引；B 記一張排除表 | B | 使用者刪掉的東西不應該 30 天後自己回來。資料夾裡的新檔照常索引；取消掛載後重新掛同一個資料夾會沿用同一筆掛載記錄，排除仍然有效 |
| 作品資料夾內的素材庫檔案（Markdown 匯入的圖片） | A 跟著資料夾一起刪；B 先搬到 `library/assets/<id>/` | B | 素材庫裡的素材不應該因為刪作品而失效。有檔案搬不動時保留資料夾，不刪 |
| 刪除期間寫入的保護 | A 每個服務各自檢查；B `server.ts` 加一個 `preHandler` | B（PATCH 另外在 `WorkService` 也檢查） | `/works/:id/…` 底下的寫入一次全部擋下，之後新增的子路由也自動受保護 |
| 批量的權限 | A 只限主權杖；B 需要 `write` | B | 30 天內可以恢復。不可逆的永久刪除與系統垃圾桶只限主權杖 |
| 恢復的錯誤碼（原檔還在垃圾桶） | A 新增 `work_file_missing`；B 沿用 `source_missing` | B | 意思相同，少一個錯誤碼 |
| 批量的 HTTP 狀態 | A 200 加逐項結果；B 207 | A | 前端只要看 `results[].ok` |

## 3. 自動測試

新增 `services/mac-server/test/work-trash.test.ts`，共 20 個測試：

- **託管作品**
  - 刪除與恢復：revision 與歷史相同、資料夾留在原處、`purge_at` 是刪除後 30 天、`ids` 遵守 scope、事件正確。
  - 沒帶版本回 428，`If-Match` 或版本過期回 409。
  - 已刪除作品的 PATCH、attach、平台版本、恢復版本都回 409 `work_in_trash`。
- **權限**：只有 read 的權杖不能刪除；`write` 可以刪除與恢復，但不能 purge、清空或移到垃圾桶；Agent 呼叫批量沒帶冪等鍵回 428。
- **永久刪除**：
  - 資料列、版本、FTS、資料夾都刪除。
  - 作品資料夾內的素材搬到素材庫，內容不變。
  - 清空要 `confirm`。
  - 30 天到期自動清除（注入時鐘）。
- **外部作品**：
  - 只取消索引，原檔不變，`work_count` 不計入，重新掃描與 purge 後都不會回來，新檔照常索引。
  - 移到假垃圾桶：失敗時什麼都不改；成功後恢復回 409 `source_missing`，模擬「放回原處」後才能恢復。
  - 託管作品不能用 `move_original_to_trash`。
- **批量**：
  - 一批裡有成功、409（附 `current_revision`）、404，前面成功的不回滾。
  - 改狀態、加減標籤會產生新版本，結果沒變的項目 revision 不變；文章的 Markdown 不動；貼圖作品的標籤寫進 front matter。
  - 已刪除作品回 `work_in_trash`。
  - 同一個冪等鍵兩個並行請求只寫一次，第二個帶 `Idempotent-Replayed`；換了內容回 422。
  - id 重複、超過 200 項、空陣列都回 400。
- **改名**：託管文章、貼圖、視頻、外部文章（見第 1 節）。
- **migration**：回滾後舊遷移可以開啟資料庫，並能再次升級。

另外 `backups.test.ts` 的 `schema_version` 從 `0015` 改成 `0016`，因為備份記錄的是最新的遷移（斷言的嚴格程度不變）。

## 4. 閘門結果

全部在 worktree 內執行，全套與 e2e 都在持有鎖、1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **905 passed／0 failed／905 total**（2026-11-21 19:39，負載 5.67→5.71）：contracts 21、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 413（含新增 20）、apps/mac 297、agent-sdk 6 |
| e2e（`playwright test`，全部 spec，先 build `apps/mac`） | **18 passed／0 failed／18 total**（19:39–19:40，負載 4.65） |

沒有加長逾時、加重試或放寬斷言。

## 5. 範圍外發現（未修）

- 素材的「使用中」檢查（`asset_in_use`）與 `references` 仍會列出已刪除的作品。恢復作品時連結會跟著回來，所以目前保留；要不要排除，由前端或總監決定。
- `packages/agent-sdk` 的 CLI 沒有刪除與批量指令，只能透過 api-client 使用。
- 已刪除作品仍可當作 URL 匯入的 `link_work_id`（匯入時只檢查作品存在）。

## 6. 收尾

- 測試伺服器、Electron、臨時 `CREATORHUB_HOME` 與臨時掛載資料夾都由測試自己清掉；沒有另外開伺服器或預覽。
- 全套與 e2e 的鎖都已釋放。
- worktree 與分支保留，等總監驗收合併後再刪。
