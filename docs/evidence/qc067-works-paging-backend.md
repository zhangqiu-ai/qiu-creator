# QC-067 後端：作品庫分頁、篩選數量、全選參照

- 日期：2026-11-22
- 分支：`feat/qc067-works-pagination`
- 範圍：`packages/contracts`、`packages/api-client`、`services/mac-server`。
- 契約依 qc-frontend 的提案 A–D，已回覆前端。

## 變更

| 項目 | 內容 |
| --- | --- |
| A. cursor 分頁 | `GET /api/v1/works` 加 `cursor`，response 加 `next_cursor` |
| B. 篩選數量 | `GET /api/v1/works/facets` |
| C. 全選參照 | `GET /api/v1/works/refs` |
| D. 刪除項目數量 | `GET /api/v1/projects/:id/summary` 加 `sole_count` |
| api-client | `works.facets()`、`works.refs()`；`list` 支援 `cursor` |

**A. cursor 分頁**
- keyset 沿用列表順序：`updated_at DESC, id`；最近刪除是 `deleted_at DESC, id`。
- 每頁多讀一筆，判斷有沒有下一頁。
- cursor 是 base64url JSON（scope、排序鍵、id）。scope 不符或格式錯誤，回 400 `validation_error`（`details.field: cursor`）。
- 帶 cursor 時忽略 `offset`，response 的 offset 回 0。
- 帶 `ids` 時 `next_cursor` 為 null。

**B. 篩選數量**
- 與列表共用篩選，但不含 `type`、`status`。
- 只做一次 `GROUP BY type, status`。

**C. 全選參照**
- 與列表同篩選，不分頁，依列表順序回輕量欄位。
- `project_ids` 用子查詢的 `json_group_array` 一次取回，不逐筆查詢。
- 上限 `WORK_REFS_MAX = 10000`，超過回 413 `payload_too_large`（`details.total`、`details.max`）。沿用既有錯誤碼，不需要新的 i18n。

**D. `sole_count`**
- 計算對象：在這個項目、不在最近刪除、也不屬於其他未刪除項目的作品數。
- 已封存的項目也算其他項目。

**共用與文件**
- `next_cursor` 在契約中預設為 null：QC-067 之前的伺服器不回這個欄位，讀起來就是只有一頁（api-client 有測試）。
- 列表的篩選 SQL 抽成 `WorkService.filterSql`，list、facets、refs 共用，行為不變。
- `docs/architecture.md`：路由表，並新增「作品庫分頁」一節。

## 測試

新增 `services/mac-server/test/works-paging.test.ts`（7 項），以及 api-client 2 項（cursor、facets、refs 的查詢字串；舊伺服器沒有 `next_cursor`）。works-paging 的 7 項：

1. 23 件、每 3 件同一時間，以 limit 5 翻頁：
   - 順序與 SQL 排序完全一致，同時間的作品以 id 分開。
   - 每頁的 `total` 都是 23。
   - 帶 cursor 時 offset 被忽略；不帶 cursor 的 offset 分頁照舊。
   - 剛好最後一頁、以及帶 `ids` 時，`next_cursor` 為 null。
2. 翻頁途中更新一件較舊的作品：後面的頁不重複，也不出現它，其餘作品全部取到。
3. 最近刪除依 `deleted_at` 翻頁。另一個 scope 的 cursor、亂碼、缺欄位的 cursor 都回 400 `field: cursor`。
4. facets 依 tag、project、unassigned、trash 篩選計數。傳了 type、status 會被忽略。總數與 list 的 total 一致。
5. refs：
   - 欄位完整；`project_ids` 包含已封存的項目，依側欄順序。
   - 依類型、項目、搜尋篩選。
   - `project_id` 加 `unassigned` 回 400。
6. 以 SQL 複製出 10000 件，refs 全部回傳（本機約 0.1 秒）；第 10001 件時回 413，details 正確；較窄的篩選仍可用。
7. `sole_count`：只在本項目、另一個項目已刪除的作品要算；也在其他項目、已封存項目、最近刪除中的作品不算。

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1055 passed／0 failed／1055 total；負載 4.00 → 7.68 |
| e2e | NOT_VERIFIED：本任務沒有介面變更，前端接上後由 qc-frontend 跑 300 件以上的 e2e |

## 範圍外

- 前端的接線不在本任務範圍：`LibraryPage` 的分頁、chip 數量、⌘A 改用 refs、刪除項目對話框改用 `sole_count`，由 qc-frontend 負責。
