# QC-045／046 驗收記錄（後端）：貼圖與視頻作品

日期：2026-11-21　分支：`feat/qc045-046-works-backend`（從 `origin/main` decf254 開，2026-11-21 rebase 到 be89e30，含 QC-043）　worktree：`/Users/feature/code/qiu-creator-qc045b`

依據：原型 PT-20261121-001（已核准）在 `docs/design/prototype/changes.json` 的 `backendNeeds` 與 `decisions`。

全部使用臨時的 `CREATORHUB_HOME` 與臨時掛載資料夾；沒有碰真實資料，也沒有對第三方發請求（AI 任務用資料庫裡的假紀錄）。前端等這支 API 合併後再接。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| 存放：Markdown 加 front matter（`type`、`title`、有序的 `images`、`cover` 為路徑或 `{time_seconds}`、`video`、`tags`），正文是描述 | `packages/domain/src/front-matter.ts`：`parseWorkSource`／`writeWorkSource`，用 `yaml` 的文件模型 |
| 圖片與視頻照 QC-039 attach 複製進作品的 `assets/` | `WorkComposer` 呼叫 `WorkMediaAttacher.attach`：相同內容沿用；APFS 上用 clone；雜湊改成 1 MiB 分段讀取，GB 級的視頻不會整檔放進記憶體 |
| 寫回帶 `base_revision`／`If-Match`，衝突回 409，保留歷史快照 | 沿用 `WorkService` 的版本檢查與 `commitRevision`：先寫快照，再原子替換，最後寫資料庫；提交前再查一次版本 |
| 外部掛載作品不搬檔、不寫入新媒體 | 只接受同一個掛載資料夾裡已索引的檔案，其餘回 409 `attach_external_unsupported`；改文字只寫它自己的 `.md` |
| 不讀 front matter 的舊文章，行為不能變 | 文章的 PATCH 仍走原本的 `WorkService.patch`，不讀也不寫 front matter；媒體欄位回 400 |
| `POST /works` 帶 `type` | `type: image|video` 時寫入初始 front matter，可帶 `description` |
| `PATCH /works/:id` 一次原子寫入 `title`／`description`／`tags`／`images`／`cover`／`video_asset_id` | `WorkComposer.patch`，一次寫入就是一個版本 |
| 列表補 `thumbnail`、`image_count`、`duration_seconds`、`orientation`；`GET /works?ids=` | `TypedWorkMedia.summary`；`ids` 依要求的順序回傳，並列出 `missing_ids`；另加 `missing_media` |
| 平台版本加 `images`、`cover`、`inherit` | 見第 2 節 |
| 媒體遺失要標出來 | 每個檔案帶 `status`（`present`／`missing`）；列表有 `missing_media` 計數 |
| 視頻理解沿用 QC-023；採用建議走一般 PATCH，產生 `ai_accepted` 版本 | PATCH 加 `ai_job_id`；任務須已成功，而且屬於這個作品或分析的正是它的視頻，否則回 409 `ai_job_not_acceptable` |
| `PLATFORM_LIMITS` 補公眾號貼圖 20 張（reference，只提示） | `wechat_mp.imagePostImagesMax: 20`、`imagesLimit()`；`checkVariantLimits` 對貼圖作品用它 |
| 文件 | `docs/architecture.md`（新增「貼圖與視頻作品」一節，以及 API 表、遷移）、`docs/dependencies.md`（`yaml`） |

## 2. 技術選擇與差異（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| YAML 讀寫 | `yaml`；js-yaml；gray-matter；自寫子集解析器 | **`yaml` 2.9.1（ISC，沒有依賴）** | 只有它的文件模型能在寫回時保留註解、未知鍵與鍵的順序；外部作品的 `.md` 是使用者手寫的，不能丟資料。已記錄在 `docs/dependencies.md` |
| front matter 程式放哪 | mac-server；`packages/domain` | **domain** | 不綁 Electron，第二期 iPhone／iPad 和前端都能用同一份 |
| 路徑怎麼對應到素材 id | 每次雜湊比對；在作品資料列快取；front matter 存 id | **快取 `works.media_index`** | front matter 照原型只存相對路徑；App 寫入時記下對應的素材 id。還原舊版本等情況查不到時，用內容比對一次並記住，列表不必每次雜湊 |
| 新建時 `title` 是否可省略 | 選填（服務端給預設標題）；必填 | **維持必填** | 服務端給預設標題就會產生中文字串，違反 QC-043「服務端不產生介面文字」的原則；由前端依介面語言送標題。**與原型 `title?` 不同，請前端注意** |
| 平台版本 `inherit` 的語意 | 寫入時複製；讀取時算出 | **讀取時算出** | 作品改了，沿用中的版本就跟著變，不會累積新版本；版本自己的文字保留，關掉沿用時恢復 |
| 被移出 `images` 的檔案 | 刪除；保留 | **保留在 `assets/`** | 歷史版本還會引用它；也保留在 QC-037 的引用裡 |
| 遷移編號 | 0014；0015 | **0015** | 0014 已被 QC-043 的分支使用。執行器只要求遞增，中間有空號沒關係；兩支誰先合併都可以 |

其他：

- 視頻封面幀：照原型決定由 App 從播放器截圖上傳，服務端不打包 ffmpeg，所以沒有做 `GET /assets/:id/frame`。
- 外部作品 front matter 裡的圖片不會自動註冊成素材（`asset_id` 是 null），縮圖改用 `path` 經作品檔案路由取得。
- 外部掛載的 `.md` 只有 front matter 寫明 `type: image|video` 時，才當成貼圖或視頻作品；其他都維持文章，標題規則也不變。

## 3. 測試

- **`packages/domain/test/front-matter.test.ts`（7 項）**：
  - 沒有 front matter 的文章原樣不動。
  - 讀取所有欄位，包括視頻幀封面。
  - 不合法的 YAML、非 mapping、形狀不對的欄位都會標出，不猜。
  - 新檔的鍵順序固定。
  - 未知鍵、註解和順序都保留，讀了再寫回逐字相同。
  - `null` 會移除欄位；可以在沒有 front matter 的描述前面加上 front matter。
- **`services/mac-server/test/typed-works.test.ts`（15 項）**：
  - 建立貼圖與視頻作品；文章不能帶 `description`。
  - 一次 PATCH 寫入圖片、封面、描述、標題和標籤：
    - 檔案複製進 `assets/`，front matter 的順序正確。
    - ETag 正確，歷史裡有新舊兩版。
    - QC-037 的引用有記錄。
    - 重新排序或移除圖片後，檔案仍保留。
  - 版本檢查：
    - 沒帶版本回 428；版本過期回 409，檔案不變，也沒有殘留的複製檔。
    - 兩個同時從同一版本寫入：只有一個成功，失敗的一方沒有留下檔案。
  - front matter：
    - 寫回時保留手寫的未知鍵與註解。
    - 不合法時回 409 `front_matter_invalid`，檔案不動。
    - 素材類型不符或欄位不屬於這種作品，回 400；素材不存在回 404。
  - 視頻作品：
    - 寫入視頻與幀封面；列表卡片顯示縮圖、時長與直式。
    - 採用 AI 建議產生 `ai_accepted` 版本；任務失敗時回 409。
  - 列表：
    - 卡片欄位齊全；刪掉一張圖後 `missing_media` 變成 1，詳細資料裡該檔標成 `missing`。
    - `ids` 依要求的順序回傳，並列出 `missing_ids`。
  - 舊文章：即使正文以 `---` 開頭，改標題和標籤時檔案逐字不變；不回 `media`；媒體欄位回 400。
  - 外部掛載：
    - 從 front matter 讀到類型、標題、標籤和檔案；遺失的檔案有標出。
    - 素材庫的檔案回 409。
    - 改描述只寫它自己的 `.md`：資料夾檔案清單不變，作品資料夾沒有 `assets/`。
  - 平台版本：
    - 草稿取自 front matter，包括幀封面。
    - `inherit` 會跟著作品的改動，版本號不變；關掉沿用時恢復版本自己的文字，版本歷史會記錄。
    - `images` 和 `cover` 是新名稱；圖片作品不能用幀封面。
- **`packages/contracts/test/variants.test.ts`（新增 3 項）**：
  - 公眾號貼圖第 21 張圖才提示（文章不提示）。
  - 平台版本 PATCH 的新欄位；同一個欄位不能同時用新舊兩種名稱。
  - 作品 PATCH 的新欄位；`ids` 會去掉重複，且最多 200 個。
- **`packages/api-client/test/client.test.ts`**：`ids` 以逗號分隔送出。
- **既有測試**：只因為加了遷移 0015 而改寫兩處斷言，沒有放寬：
  - `db-and-config` 中 0013 的升級測試只套到 0013。
  - `backups` 的 `schema_version` 改成 `0015`。
  - 其他作品、媒體、掛載、平台版本的測試都沒有改，仍然通過。

## 4. 閘門

rebase 到 be89e30（含 QC-043）後，在 HEAD `d228de5` 上重跑：

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 e2e 的 tsc） | 通過 |
| `pnpm -r lint` | 通過 |
| `prettier --check`（本分支改動的檔案） | 通過 |
| `pnpm -r --workspace-concurrency=1 --no-bail test` | **831 passed／0 failed／831 total** |
| e2e（全部 spec，含 QC-043 的 `server-text`） | **9 passed／0 failed／9 total** |

- 全倉測試：2026-11-21 08:02:05–08:02:34（PST），開始時 1 分鐘負載 13.40，持全倉鎖。
- e2e：08:02:34–08:03:23，持 e2e 鎖。
- 兩個鎖跑完都已釋放。
- rebase 前（decf254 上）的結果是 816／0／816 與 8／0／8，已被這次取代。

**衝突處理**：

- 遷移照順序放：`0014_ai_job_error_detail`（QC-043），然後 `0015_typed_works_media`。
- `backups.test.ts` 保留 QC-043 對 `details.reason` 的斷言，`schema_version` 改成 `0015`，沒有放寬。
- `docs/architecture.md` 兩個遷移都列出。

| 套件 | passed／total |
| --- | --- |
| contracts | 21／21 |
| design-tokens | 5／5 |
| domain | 34／34 |
| i18n | 29／29 |
| installer | 39／39 |
| api-client | 20／20 |
| markdown-editor-web | 28／28 |
| platform-preview | 12／12 |
| mac-server | 393／393 |
| apps/mac | 244／244 |
| agent-sdk | 6／6 |

## 5. NOT_VERIFIED 與給前端的注意事項

- 沒有實際用 GB 級視頻測試 clone 與分段雜湊，測試只用了小檔案。
- 外部 front matter 裡的圖片沒有自動建立素材紀錄。如果前端需要素材 id（例如平台版本要用），要另外決定是否在解析時註冊。
- **新建作品必須帶 `title`**（第 2 節）。
- `thumbnail.asset_id` 可能是 null，這時用 `path` 經 `/api/v1/works/:id/files/…` 或簽名網址取圖。
- 平台版本在 `inherit: true` 時，`title`／`body`／`tags` 是算出來的共用文案；要編輯版本自己的文字，前端應先關掉沿用。
- 範圍外發現：平台版本的 `warnings[].message` 仍是服務端產生的繁體文字（`checkVariantLimits`）。它已經有 `code`、`limit`、`actual`，介面可以自己組句，總監已併入 QC-048。契約 `VariantWarningSchema` 的 `code`、`limit`、`actual` 都是必填；公眾號貼圖的 `limit` 是 20。
