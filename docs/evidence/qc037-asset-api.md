# QC-037 驗收記錄：素材編輯、刪除與「最近刪除」API（後端）

日期：2026-11-19　分支：`feat/qc037-asset-api`（從 `origin/main` 01b65e6 開）　worktree：`/Users/feature/code/qiu-creator-qc037`

依據：原型 PT-20261119-001「v2 · 素材庫：刪除與編輯」（`docs/design/prototype/changes.json` 的 `backendNeeds`），以及總監核准的 Plan 和三點補充。

全部在臨時目錄進行（`CREATORHUB_HOME` 在 `$TMPDIR/creatorhub-test-*`）。系統垃圾桶一律注入假實作，沒有碰真實的 `~/CreatorHub`、垃圾桶或 Keychain，也沒有對第三方發請求。

## 1. 交付內容

| 項目 | 位置 |
| --- | --- |
| 契約（只增不改） | `packages/contracts/src/assets.ts`、`events.ts`、`api.ts` |
| api-client | `assets.update`／`trash`／`restore`／`references`／`batch`，`trash.purge`／`empty` |
| migration 0013 `asset_metadata_trash` | `services/mac-server/src/db/migrations.ts` |
| 服務 | `src/assets/asset-library.ts`（編輯、刪除、恢復、永久刪除、批次、30 天清除） |
| 系統垃圾桶 | `src/assets/system-trash.ts`（`/usr/bin/trash`，可注入） |
| 路由 | `src/routes/asset-library.ts`；`GET /assets/:id` 加 `ETag` |
| 既有服務調整 | `asset-service.ts`：列表範圍與標籤篩選、作品素材清單排除已刪除、已刪除不可連結、重新上傳相同內容即恢復、外部重掃不復活 |
| Markdown 引用偵測 | `media/work-media.ts` 的 `markdownReferrers` |
| 文件 | `docs/architecture.md`（API 表、schema、新章節、SSE 動作） |

## 2. 和 Plan 不同或補充的地方

- **永久刪除時平台版本的 `image_asset_ids`**：Plan 原本寫「讀取時略過不存在的 id」。實作改成刪除當下把該 id 從平台版本目前的圖片清單移除，不產生新版本，歷史保留原值。
  - 理由：封面欄位本來就由外鍵設成 NULL，兩者行為一致。
  - 這樣也不用改平台版本每一條讀取路徑和字數檢查。
- **`DELETE /trash/:id` 用在不在最近刪除的素材上**：回 404（「不在最近刪除裡」），沒有用 Plan 說的 409。
  - 理由：從 `/trash` 這個集合來看，這筆資源本來就不存在。
  - 這樣也不用另外新增錯誤碼。
- **恢復時的排序**：恢復的素材排在作品各用途清單的最後。刪除期間其他素材可能已經重新排序，原本的位置未必還有意義。
- **總監補充的三點**：
  1. `/usr/bin/trash` 不存在、執行失敗，或執行後檔案還在原處，一律回 500 `trash_failed`，訊息是「無法移到系統垃圾桶，原檔未變動」，資料庫不改。
  2. 永久刪除託管素材時，回應的 `markdown_referrers` 會列出目前 Markdown 仍連到該檔的作品。只提示，不阻擋刪除。
  3. 給前端的 API 摘要見第 4 節。

## 3. 測試

`services/mac-server/test/asset-library.test.ts`，16 項：

- **編輯**：
  - 有 revision 時，沒帶 base 回 428，base 過期回 409，可以改用 If-Match，ETag 正確。
  - 標籤會去重；傳 null 清除欄位。
  - 發出的 `asset.updated` 事件裡，fields 正確。
  - 磁碟上的檔案不動。
  - 搜尋會比對顯示名稱；標籤篩選要完全相符。
- **刪除未引用的託管素材**：
  - 檔案留在原位，purge_at 等於刪除時間加 30 天。
  - 列表裡不見，最近刪除裡看得到，內容仍可串流。
  - 重複刪除或編輯回 409 `asset_in_trash`。
  - 恢復一個未被刪除的素材，什麼都不改。
- **刪除被引用的素材**：
  - 沒帶 confirm 回 409，details.references 和 `/references` 的結果相同。
  - 刪除後作品素材清單看不到它，重新排序只需要列出看得到的素材，也不能再連結它。
  - 平台版本完全不變。
  - 恢復後引用回來，排在最後。
  - 發出的 `work.assets_changed` 事件依序是 trashed、restored。
- **重新上傳相同內容**：直接恢復原本那筆，並發出 `asset.restored`（reason 為 reuploaded）。
- **永久刪除**：
  - 只能刪最近刪除裡的素材，否則回 404。
  - 刪掉 library 資料夾和縮圖。
  - 作品連結和平台版本的封面、圖片 id 都被移除，平台版本沒有產生新版本。
  - 作品資料夾裡被 Markdown 連到的檔案：回應列出那個作品，檔案刪除，source.md 保留。
- **清空最近刪除**：沒帶 confirm 回 400；帶了就全部刪除，事件的 reason 是 empty。
- **30 天清除**：
  - 用注入的時鐘測：差一秒時不刪，滿 30 天才刪，事件的 reason 是 expired。
  - 另有一項測試確認定時器確實會觸發清除。
- **外部素材**：
  - 預設只解除索引，原檔的位元組完全不變。
  - 重新掃描、重新解析 Markdown 後，素材都不會復活。
  - 恢復後重新出現在作品素材清單。
  - 永久刪除只刪資料庫列，原檔不動。
- **移到系統垃圾桶**（用假實作）：
  - 移過去的是 realpath 解析後的原檔路徑，原處已不見。
  - 恢復回 409 `asset_file_missing`；模擬在 Finder 放回原處之後，恢復成功。
- **系統垃圾桶失敗**：回 500 `trash_failed` 和中文訊息，原檔還在，資料庫沒變，也沒有發事件。
- **找不到 trash 指令**：測 `MacSystemTrash` 本身，會拋錯，檔案仍在。
- **託管素材帶 `move_original_to_trash`**：回 400。
- **批次**：
  - 加、減標籤，各筆 revision 正確。
  - 有任一 id 不存在就回 404，所有素材都不變。
  - 刪除時有被引用的素材而沒帶 confirm，回 409，details.assets 列出是哪些；帶 confirm 後全部移到最近刪除。
  - 已刪除的素材再批次加標籤，回 409 `asset_in_trash`。
- **權限**：Agent 權杖可以讀 references 和最近刪除。6 個會改資料的呼叫都回 403，資料不變。

其他測試：

- `test/db-and-config.test.ts`：從 0012 升級到 0013，既有素材資料完全保留，新欄位都是預設值；removal 填不合法的值會被 CHECK 擋下。
- `packages/api-client/test/client.test.ts`：
  - 確認 PATCH、恢復、DELETE（帶 body）和清空送往正確的路由。
  - 確認四個新錯誤碼和它們的 details 會保留在 `ApiError` 上。
- 因行為改變而改寫的既有斷言，都沒有放寬：
  - `backups.test.ts` 的 `schema_version` 改成 `'0013'`。
  - `db-and-config.test.ts` 的 0012 升級測試只套到 0012 為止。

## 4. 給前端（qc-frontend）的 API 摘要

所有會改資料的路由只限 owner 權杖，Agent 權杖拿到 403。讀取只需要 `read`。用 api-client 的寫法放在括號裡。

**素材欄位（`AssetRecord` 新增，都是選填，舊用戶端不受影響）**

- `display_name`：null 時顯示 `original_name`。
- `tags`：字串陣列。
- `alt_text`、`note`。
- `revision`：編輯時當作 `base_revision` 送回。
- `deleted_at`：沒刪除時是 null。
- `purge_at`：最近刪除裡的素材何時自動永久刪除。
- `removal`：`trashed`（託管）、`unindexed`（外部，只移出素材庫）或 `original_trashed`（外部，原檔已移到系統垃圾桶）。

**列表**：`GET /api/v1/assets?scope=active|unreferenced|trash&tag=&q=&kind=&limit=&offset=`（`assets.list({ scope })`）

- 預設是 `active`。
- `trash` 依刪除時間新的在前。
- `q` 同時比對顯示名稱和原檔名。

**編輯**：`PATCH /api/v1/assets/:id`（`assets.update(id, { base_revision, display_name?, tags?, alt_text?, note? })`）

- 至少要改一個欄位；傳 null 會清除該欄位。
- 沒帶 base 回 428 `precondition_required`。
- base 過期回 409 `revision_conflict`，`details.current_revision` 是目前的數字版本。前端自動儲存時要用最新的 revision。
- 素材在最近刪除時回 409 `asset_in_trash`。
- 成功時回新的素材，`ETag` 是 `"<revision>"`。

**刪除**：`DELETE /api/v1/assets/:id`，body 是 `{ confirm?, move_original_to_trash? }`（`assets.trash(id, opts)`）

- 回 `{ asset, references }`。
- 被引用但沒帶 confirm：409 `asset_in_use`，`details.references` 是 `{ works:[{work_id,title,role,position}], variants:[{work_id,title,platform,usage}] }`，可以直接拿來顯示確認框。
- 未引用的託管素材直接成功，前端可以給「復原」toast，按下時呼叫恢復。
- 外部素材預設只移出素材庫；`move_original_to_trash: true` 才把原檔移到系統垃圾桶。
- 系統垃圾桶失敗：500 `trash_failed`，訊息「無法移到系統垃圾桶，原檔未變動」，什麼都沒改。
- 託管素材帶 `move_original_to_trash`：400。
- 已在最近刪除：409 `asset_in_trash`。

**引用**：`GET /api/v1/assets/:id/references`（`assets.references(id)`），格式同上。不含 Markdown 裡的連結。

**恢復**：`POST /api/v1/assets/:id/restore`（`assets.restore(id)`）

- 引用一併回來，在作品素材清單裡排在最後。
- 檔案不在原路徑時回 409 `asset_file_missing`。例如原檔還在系統垃圾桶：提示使用者先在 Finder「放回原處」再重試。
- 對未刪除的素材呼叫不會出錯，原樣回傳。

**永久刪除一筆**：`DELETE /api/v1/trash/:id`（`trash.purge(id)`）

- 回 `{ id, removal, markdown_referrers:[{work_id,title}] }`。
- `markdown_referrers` 不是空的，代表那些作品的 Markdown 會出現失效的圖片，可以提示使用者。
- 素材不在最近刪除時回 404。

**清空**：`DELETE /api/v1/trash`，body 是 `{ confirm: true }`（`trash.empty()`）

- 回 `{ purged: [...] }`，每筆格式同上。
- 沒帶 confirm 回 400。

**批次**：`POST /api/v1/assets/batch`（`assets.batch(...)`）

- 格式：`{ action: 'add_tags'|'remove_tags', ids, tags }` 或 `{ action: 'trash', ids, confirm? }`，ids 最多 200 個。
- 全部成功或全部不做，成功時回 `{ items: AssetRecord[] }`。
- 有任一 id 不存在回 404，`details.asset_id` 是哪一個。
- 有已刪除的素材回 409 `asset_in_trash`，`details.asset_ids` 列出。
- 有被引用的素材而沒帶 confirm，回 409 `asset_in_use`，`details.assets` 是 `[{ id, references }]`。
- 批次刪除時，外部素材只移出素材庫，不會移原檔。

**已刪除素材的其他行為**

- 仍可以 GET、串流和取縮圖，最近刪除的預覽要用。
- 連結到作品回 409 `asset_in_trash`。
- 使用者再上傳內容完全相同的檔案，會直接恢復這筆，回 `deduplicated: true`。

**SSE 事件**

- `asset.updated`：`data.fields`、`data.revision`。
- `asset.trashed`：`data.removal`。
- `asset.restored`。
- `asset.deleted`：`data.removal`，以及 `data.reason`，值是 `manual`、`empty` 或 `expired`。
- `work.assets_changed`：`data.change` 是 `trashed`、`restored` 或 `deleted`。收到時重抓該作品的素材清單。

**新錯誤碼**：`asset_in_use`（409）、`asset_in_trash`（409）、`asset_file_missing`（409）、`trash_failed`（500）。

## 5. 閘門

在 HEAD `25f7a86` 上執行：

| 閘門 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 通過 |
| `pnpm -r lint` | 通過 |
| `prettier --check`（本任務改動的檔案） | 通過 |
| `pnpm -r --workspace-concurrency=1 --no-bail test` | **679 passed／0 failed／679 total** |

- 全倉測試在 2026-11-19 07:34:55–07:35:18（PST）執行，開始時 1 分鐘負載 7.96，結束時 16.42。
- 等到 qc-frontend QC-041 釋放全倉測試鎖後才取得鎖，跑完已釋放。

| 套件 | passed／total |
| --- | --- |
| contracts | 16／16 |
| design-tokens | 5／5 |
| domain | 27／27 |
| installer | 39／39 |
| markdown-editor-web | 22／22 |
| api-client | 18／18 |
| platform-preview | 12／12 |
| mac-server | 361／361 |
| apps/mac | 173／173 |
| agent-sdk | 6／6 |

## 6. NOT_VERIFIED 與範圍外

- 真實的 `/usr/bin/trash`：沒有在測試中執行，因為會動到真實垃圾桶。已確認本機（macOS 27.0.1）有這個指令；介面的錯誤處理已經測過。實機操作留給前端串接後的驗收。
- Markdown 引用偵測只看作品**目前**的 Markdown，不看歷史版本。託管 Markdown 只能連到自己作品資料夾裡的檔案，所以只檢查擁有該檔的作品。
- 範圍外發現：無。
