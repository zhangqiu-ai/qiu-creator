## QC-051: 作品刪除進「最近刪除」、可還原，支援批量操作

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

使用者 2026-11-21 授權：QC-051／052 完成驗收後直接發版安裝（「做完直接發版安裝」）。使用者 2026-11-21 要求作品庫支援右鍵刪除和多選批量編輯（配合 QC-052）。目前沒有刪除作品的 API。
- 刪除＝移入「最近刪除」，保留 `ASSET_TRASH_RETENTION_DAYS`（30 天）後才自動永久刪除；期間可還原，還原後 revision 與歷史不變。比照素材庫的 trash 做法（QC-037），列表加 `scope=trash`。
- 受管作品：資料夾留在原地或移到 CreatorHub 內的回收區，不能直接 `rm`；外部掛載作品：只取消索引，不動原檔（要移到 macOS 垃圾桶必須是使用者明確勾選，比照素材）。
- 批量端點：一次對多個作品做「刪除／還原／改狀態／加減標籤」，每項帶 `base_revision`；部分失敗要逐項回報（409、找不到），不能整批靜默覆蓋。帶冪等鍵。
- 發出變更事件（`work.trashed`、`work.restored` 等），contracts、api-client 同步更新；scopes 加權限。
- 改名沿用 `PATCH /works/:id` 的 title；確認貼圖、視頻（front matter）和文章（H1／檔名）改名都正確，不必新端點。
- 不做不可逆遷移；若要加 migration（例如 `deleted_at`），要可回滾並寫進 docs/architecture.md。

### Plan（qc-backend，2026-11-21）
- migration `0016_work_trash`：`works` 加 `deleted_at`、`removal`（同素材三種）與部分索引；新表 `work_exclusions`（永久刪除的外部作品路徑，重新掃描不再收回）。只加欄位與表；回滾 SQL 寫進 architecture.md 並有測試。
- `WorkTrash`（比照 `AssetLibrary`）：刪除、還原（revision 不變）、永久刪除、清空、每小時清 30 天前的。託管作品資料夾留原地，永久刪除時才刪；資料夾內被素材庫引用的檔案先搬到 `library/assets/<id>/`。外部預設只取消索引，`move_original_to_trash` 僅 owner，經可注入的 `SystemTrash`。
- 已刪除作品：GET 可讀；PATCH 與 `/works/:id/*` 的寫入回 409 `work_in_trash`；列表 `scope=active|trash`，`ids=` 遵守 scope。
- `POST /works/batch`：trash／restore／set_status／add_tags／remove_tags，每項帶 `base_revision`、逐項回報、Idempotency-Key（新增 async 版冪等）。
- 事件 `work.trashed`／`work.restored`／`work.deleted`；contracts、api-client；scopes：刪除、還原、批量為 `write`，永久刪除與清空只限 owner。
- 改名：補測試確認貼圖／視頻寫 front matter title、文章（託管與外部）只改作品標題不動原文。

## QC-052: 作品庫：原地改名、右鍵選單、多選批量、卡片縮小

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

使用者 2026-11-21 要求（附截圖：作品庫卡片、編輯頁分頁）：
1. **原地雙擊改名**：作品庫卡片標題、列表列標題、編輯頁頂部分頁標籤都能雙擊進入改名；Enter 確定、Esc 取消、失焦確定；中文輸入法組字中按 Enter 不能提交。走 `PATCH /works/:id`，409 照既有衝突處理。
2. **右鍵選單**：卡片與列表列右鍵出現：開啟、在新分頁開啟、重新命名、改狀態（子選單）、複製路徑／在 Finder 顯示（若已有能力）、刪除。分頁標籤右鍵：重新命名、關閉、關閉其他。用 macOS 原生選單（Electron `Menu`）或符合 DESIGN.md 的自繪選單，二選一說明理由。
3. **多選批量**：⌘點選、⇧點選範圍、⌘A；框選可選做。選取後頂部出現批量列：改狀態、加／移除標籤、刪除、取消選取。刪除要確認框並寫明「可在最近刪除中還原 30 天」；做完給可撤銷的提示。
4. **卡片縮小**：作品庫格狀檢視卡片明顯縮小（縮圖比例變小、資訊精簡），在 1440 寬的視窗一列至少 5–6 張；保留列表檢視。
5. **最近刪除**：作品庫篩選加「最近刪除」入口，可還原或永久刪除（永久刪除要再確認）。

刪除、還原、批量依賴 QC-051 後端；1、2（除刪除）、4 可先做。三語文案進 `packages/i18n`，不准寫死中文。設計前查 qiuge-design（`data-display`、`content-editing`、`feedback` 標籤，Finder／Notion／Bear 類的多選與右鍵模式），引用卡片路徑。交付附截圖（三語至少簡中一張）與 e2e。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
