# QC-088 驗收記錄：MCP 匯入與寫入工具

- 分支：`feat/qc088-mcp-write`（從 origin/main `c0179af` 開）。
- 規格：`.tasks/IN_PROGRESS.md` QC-088；`docs/mcp-plan.md` 第 4、5 節；總監 2026-11-24 對五條待決路由的決定。
- 設計說明：`docs/architecture.md`「MCP（QC-087、QC-088）」。

## 實作

| 項目 | 位置 |
| --- | --- |
| 21 個匯入與寫入工具（見架構文件的表） | `packages/agent-sdk/mcp/write-tools.ts` |
| 工具定義、strict 參數、錯誤與 `retry` 提示（`retryHint`） | `mcp/define.ts` |
| 唯讀工具（`variant_get` 改照 QC-084 `VariantView` 說明） | `mcp/read-tools.ts`；`mcp/tools.ts` 合併兩組 |
| annotations：`readOnlyHint` 依權限、`destructiveHint`（`work_trash`、`project_delete`）；instructions 補上 409、冪等鍵與不改正文 | `mcp/server.ts` |
| 「待 QC-088」清單清空，新增排除 | `mcp/coverage.ts` |
| tus 上傳接受分塊讀取的 `source` | `packages/api-client/src/assets.ts` |

**五條待決路由的處理（依總監決定）：**

- 版本恢復：做成 `work_restore_revision`，屬 write。
- 項目排序：排除，原因「側欄排序屬於使用者介面偏好」。
- 項目刪除與恢復：做成 `project_delete`、`project_restore`，屬 write，可恢復。
- generate 與 draft：排除，原因「QC-084 後已棄用」。

另外，單次直傳 `POST /assets/uploads` 也排除，因為 MCP 一律走 tus。

**刻意的限制：**

- `work_update_meta` 只收 title、tags、status：不改正文，也不改簡介。
- 所有工具的參數都是 strict：多送的欄位會回錯誤，不會被默默丟掉。
- `asset_upload_file` 只收本機絕對路徑的一般檔案（拒絕相對路徑、資料夾、不存在的檔案、空檔），類型與大小由服務判斷。
- `asset_upload_file` 不直接連到作品，因為連結需要 write 權限；先上傳，再用 `work_attach_asset`。

## 自動測試

- `packages/agent-sdk/test/mcp-write.test.ts`（9 項）。全部用臨時資料目錄；網址匯入用本機假服務加假 DNS，不連外網。
  - **建立一篇貼文的完整情境：**
    - `work_create`：同一把冪等鍵重送回同一篇作品；同一把鍵配不同內容回 422 加重試提示。
    - 上傳本機檔案（含中文與空格檔名），重複上傳回 `deduplicated`。
    - 匯入網址，用 `job_wait` 等到完成，再用 `job_get`、`jobs_list` 查看。
    - 連結封面與正文圖片、排序、移除連結，以 `copy_into_work` 複製進作品資料夾。
    - 建立項目、歸入、依項目搜尋。
    - 全程正文沒有被改過。
  - **編輯與衝突：**
    - `work_update_meta` 成功後，以舊 base 再改回 409，`details.current_revision` 和 `retry` 都帶新的 revision。
    - 多送 `markdown`、缺少 `base_revision` 都被拒絕。
    - `work_restore_revision` 新增一個版本。
  - **回收站與批量：** 移到回收站、依 scope=trash 搜尋；改回收站中的作品回 409 `work_in_trash`，提示先 `work_restore`；恢復；批量加標籤；`set_status` 缺 status 回 400。
  - **平台版本：** 以 base 0 覆寫 → revision 1；舊 base 回 409，提示 `base_revision = 1`；設定 body 被拒絕；`reset_all` 改回跟隨原稿。
  - **項目：** 改名、以舊 base 改回 409、刪除、恢復。
  - **權限不足：** read 權杖建立作品回 403（`required: import`）；import 權杖改中繼資料回 403（`required: write`）；資料都沒變。
  - **上傳的拒絕：** 相對路徑、資料夾、不存在的檔案回 400；不是媒體的檔案由服務回 415。
  - **私有位址：** 網址解析到私有位址時，任務以 `blocked_address` 失敗。
  - **api-client 分塊上傳：** `source` 經多次 PATCH 上傳。
- `test/mcp-coverage.test.ts`：
  - 覆蓋測試與權限一致測試，涵蓋新工具（含 `read_or_own_import`）。
  - `MCP_PENDING` 與 `MCP_PENDING_AREAS` 都是空的。
  - `readOnlyHint`、`destructiveHint` 的對應正確。
- `test/mcp-client.test.ts`：
  - 工具清單、toolsets、server_status 依新工具更新。
  - `variant_get` 照 `VariantView` 斷言：四個平台的 `exists`、`title_source`、推導正文、封面來源、覆寫歷史。

## 範圍與 NOT_VERIFIED

- 沒有介面變更。
- 正文的提案與直接修改屬 QC-089。
- 用真正的 Claude Code 連線測試排在 QC-093：**NOT_VERIFIED**。

## 數字（2026-11-24）

- 全套 `pnpm -r --workspace-concurrency=1 --no-bail test`，開始時 1 分鐘負載 2.5：
  - 11 個套件全部通過，1260 passed，0 failed。
  - agent-sdk 36（CLI 12、MCP 覆蓋 6、MCP client 9、MCP 寫入情境 9）；mac-server 525；apps/mac 445；其餘套件 254。
- typecheck：`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`，全部通過。
- 根目錄 `pnpm lint`（`eslint .`，含 e2e）：0 錯誤。
- prettier：所有變更檔案都通過。
