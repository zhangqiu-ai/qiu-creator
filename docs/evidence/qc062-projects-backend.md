# QC-062 驗收記錄（後端）：作品庫的項目

日期：2026-11-21　分支：`feat/qc062-projects`（從 `origin/main` 開）　worktree：`/Users/feature/code/qiu-creator-qc062-be`

依據：原型 PT-20261121-003（總監代核准，main 441c523）在 `docs/design/prototype/changes.json` 中的 `backendNeeds`，以及總監的指示。測試全部使用臨時的 `CREATORHUB_HOME`，沒有任何網路請求，也沒有改動作品檔案。`.tasks/` 沒有修改。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| `projects`／`work_projects` 多對多，migration 可回滾 | `0017_projects`：新增兩張表；`change_log` 允許 `project` 實體，做法比照 0011 重建、保留序號。`PROJECTS_ROLLBACK_SQL` 有測試 |
| CRUD、排序、封存、軟刪除與復原 | `GET/POST /projects`；`GET/PATCH/DELETE /projects/:id`，PATCH 需要 `base_revision` 或 `If-Match`；`POST /projects/:id/restore`；`PUT /projects/order`。已刪除的項目 30 天後自動清掉，作品不受影響 |
| 作品篩選 `project_id`／`unassigned`，作品帶 `project_ids` | `GET /works?project_id=`、`?unassigned=1`。作品物件（列表與詳情）都帶 `project_ids`，依側欄順序，含已封存的項目、不含已刪除的。`POST /works` 可以帶 `project_ids` |
| 批量加入／移出 | `POST /works/batch/projects { work_ids, add, remove }`：項目先整體檢查，作品逐一回報結果；作品的 revision 不變 |
| 項目概覽、項目用到的素材 | `GET /projects/:id/summary`（各狀態作品數、最近更新時間、`asset_count`）；`GET /assets?project_id=`（作品連結的素材，加上 front matter 記住的素材 id） |
| 事件 | `project.created`／`updated`／`deleted`／`restored`／`reordered`，以及 `work.projects_changed` |
| contracts、api-client、agent-sdk CLI | `packages/contracts/src/projects.ts`；`client.projects.*`；`creatorhub projects list/create/add/remove`、`works list --project/--unassigned` |
| 名稱上限 60 字、8 種顏色 | `PROJECT_NAME_MAX_CHARS = 60`，中文一字算一個；`color` 為 0–7 |
| 歸屬只存資料庫，不寫 .md | 只寫進 `work_projects`；有測試確認託管作品的 `source.md` 與掛載資料夾的檔案在加入項目前後完全相同 |
| 文件 | `docs/architecture.md`（遷移、API 表、新增「項目」一節、事件、權限、套件表）、`README.md`（CLI） |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 項目事件的 entity | 用既有的 `system`；或新增 `project` | 新增 `project` | 用戶端可以直接依 entity 過濾事件。代價是要重建 `change_log`（0011 已有先例，會保留序號） |
| 改名要不要帶版本 | 不帶；或比照素材帶 `revision` | 帶 | 依 AGENTS.md「衝突不靜默覆蓋」：兩個視窗同時改名時回 409，不會互相覆蓋 |
| 刪除後多久真的刪 | 不自動刪；或 30 天 | 30 天，每小時檢查 | 原型寫「purge later」；與作品、素材的最近刪除一致 |
| 批量要不要帶 `base_revision`／冪等鍵 | 帶；或不帶 | 不帶 | 歸屬不是作品內容，加入或移出本身就是冪等的，重送結果相同 |
| 封存的項目 | 不算歸屬；或算 | 算 | 依原型：「未分類」不包含已封存項目的作品 |
| 排序請求 | 允許只列一部分；或必須列出全部 | 必須列出全部未刪除的項目 | 避免兩個用戶端同時排序時出現重複的位置；少列或多列都回 400，並附 `missing`／`unknown` |

## 3. 自動測試

- `services/mac-server/test/projects.test.ts`（10 個）：
  - 項目 CRUD：去掉前後空白；60 字可以、61 字回 400；顏色 8 回 400；改名沒帶版本回 428、版本過期回 409；`If-Match`；封存；排序，少列時回 400 並附 `missing`；事件的 entity 與 `data` 正確。
  - 軟刪除與復原：刪除後不出現在列表、作品的 `project_ids` 與篩選，讀取回 404；作品仍在其他項目；復原後作品與位置都回來。
  - 30 天後清除：用注入的時鐘測試；第 29 天還在，第 30 天後清掉；作品仍在，歸屬清空。
  - 批量：一般作品、最近刪除中的作品、不存在的作品混在一起，逐項回報；`project_ids` 依側欄順序；revision 與 `source.md` 不變；重複加入不發事件；移出；項目已刪除時整批回 404，什麼都不改。
  - 新建時帶 `project_ids`；項目不存在時不建立任何作品，也不建資料夾。
  - 篩選：`project_id`；`unassigned` 包含只屬於已刪除項目的作品、不包含已封存項目的作品；兩個參數一起帶回 400；作品進最近刪除後數量變少，還原後回到原本的項目。
  - 概覽與素材：各狀態數、`asset_count`；`assets?project_id=` 包含連結的素材與 front matter 裡的素材，不包含最近刪除中作品用到的素材，也不包含其他作品的素材；項目已刪除時回 404。
  - 掛載資料夾的作品加入項目後，檔案的 sha256 與資料夾內容都不變。
  - 權限：只有 read 的權杖可以讀，6 種修改都回 403；有 write 的權杖可以修改。
  - 遷移回滾：刪除兩張表與項目事件，其他事件保留；舊版遷移可以照常套用；序號繼續往上；可以重新套用 0017。
- `packages/agent-sdk/test/cli.test.ts` 新增 2 個：
  - 用 read＋write 權杖執行 create、list、add、remove，以及 `works list --project`、`works list --unassigned`。
  - 有項目失敗時退出碼為 1；顏色或 id 不合法時拒絕；只有 read 權杖時 create 回 403。
- 因新增 migration 而調整的既有測試（嚴格程度不變）：
  - `backups.test.ts` 的 `schema_version` 改成 `0017`。
  - `work-trash.test.ts` 的 0016 回滾測試改成從只套用到 0016 的資料庫開始，因為回滾一律由新到舊進行；原本的寫法會把 0017 也套用進去。
  - `packages/contracts/test/contracts.test.ts`：建立作品時的預設值多了 `project_ids: []`。

## 4. 閘門結果

已與 `origin/main` d85b6a4 同步。全套測試在持有鎖、1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **1016 passed／0 failed／1016 total**（2026-11-21 22:30，負載 7.23→13.24）：contracts 23、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 472（新增 10）、apps/mac 341、agent-sdk 12（新增 2） |
| e2e | **NOT_VERIFIED**：依總監規定，QC-064 合併前暫停全套 e2e。這次只改後端：作品物件多了 `project_ids`，並新增路由 |

第一次跑全套時，contracts 的預設值斷言失敗（少了 `project_ids: []`，見第 3 節），依賴 contracts 的套件因此沒有跑。修正後重跑的結果如上。沒有加長逾時、加重試或放寬斷言。

## 5. 給前端

合約摘要已另外寄給 qc-frontend。重點：作品物件的 `project_ids`、`works.list({ project_id | unassigned: '1' })`、`client.projects.*`、`assets.list({ project_id })`，以及事件 `project.*` 與 `work.projects_changed`。

## 6. 收尾

- 測試伺服器與臨時目錄都已由測試清掉，全套測試的鎖已釋放。
- 沒有跑 e2e，也沒有開視窗。
- 沒有改 `.tasks/`。
- worktree 與分支保留，等總監驗收。
