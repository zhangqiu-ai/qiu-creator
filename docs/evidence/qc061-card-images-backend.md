# QC-061 驗收記錄（後端）：作品庫卡片圖與摘要

日期：2026-11-21　分支：`feat/qc061-thumbnails`（從 `origin/main` 開，已 rebase 到 edac9c0）　worktree：`/Users/feature/code/qiu-creator-qc061-be`

合約由 qc-frontend 提出草案，qc-backend 調整後雙方定案，總監核准（有 ffmpeg 用 ffmpeg，否則由 App 截幀上傳；不用 Quick Look）。測試全部使用臨時的 `CREATORHUB_HOME`：視頻是假的位元組，ffmpeg 是假的 shell 腳本或直接關閉，圖片用 sharp 現場產生。沒有任何網路請求，也沒有改動原稿。`.tasks/` 沒有修改。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| 視頻卡：封面幀，沒有封面時取第一幀；WebP，最長邊 512；放可重建的 `cache/` | 有 ffmpeg 時由伺服器取封面時間那一幀；否則列表標 `needs_frame`，由 App 截幀後上傳到 `PUT /works/:id/thumbnail-frame`。一律存成 `cache/work-thumbnails/<id>-<version>.webp` |
| 評估 ffmpeg 或更輕的方案，寫進 `dependencies.md` | 見第 2 節；`docs/dependencies.md` 新增「視頻卡片幀」一節 |
| 文章：正文第一張圖或 front matter cover；加 excerpt | `card_image`／`thumbnail` 取 front matter 的 `cover` 或第一張本機 Markdown 圖片；`excerpt` 為純文字，最多 120 字（照前端的要求） |
| 卡片直接可用的網址（前端要求） | `card_image.url`：列表簽好的 `/media/v1/works/:id/thumbnail?…&v=`。到期時間是下一個整點再加一小時，至少還有 60 分鐘，同一小時內不變；`needs_frame` 時為 null |
| 總監的要求：PUT 幀 | 需要 `write`；作品必須存在，而且不在最近刪除中；上限 2 MiB；用 sharp 實際解碼，不只看 MIME；只寫 `cache/`；用 `version` 指紋確認，換封面或換視頻前截的幀回 409 |
| 總監的要求：簽名網址 | 網址只有 HMAC，不含金鑰；有到期時間；日誌的 `sig` 一律遮蔽（有測試） |
| `asset_id` 為空時也要能用 | 一律用路徑解析；`GET /works/:id/thumbnail` 由伺服器直接回圖，用不到 `asset_id` |
| 原稿不改 | 來源只讀；測試逐位元組比對圖片、視頻與掛載資料夾的檔案，前後都相同 |
| contracts、api-client、i18n、文件 | `WorkCardImage`、`card_image`、`excerpt`、`WorkThumbnailQuery`、`ThumbnailFrameQuery`／`Response`；錯誤碼 `thumbnail_unavailable`、`thumbnail_frame_stale`，含三語文案；`client.workThumbnails.path`／`get`／`putFrame`；`docs/architecture.md` 新增「作品庫卡片圖與摘要」一節與 API 表 |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 視頻取幀 | A ffmpeg（不打包）；B Quick Look `qlmanage`；C 透過 osascript 呼叫 AVFoundation；D 內建 Swift 工具；E App 用 Chromium 截幀後上傳 | A＋E | 本機實測：A 能精準取幀（0.06 秒），但授權是 GPL，所以不打包；B 不能指定時間，取到的幀不準；C 傳 `CMTime` 時 osascript 崩潰（exit 139）；D 需要發版流程配合。E 由前端提出：Chromium 本身就能解碼，沒裝 ffmpeg 的 Mac 也能取到準確的幀 |
| 卡片怎麼載圖 | 列表直接帶簽名 url；或前端用 `qc-asset://` 代理加 `version` | 代理加 `version` | 照前端的做法：`version` 用在網址上清快取，伺服器回 `ETag`；`v` 相符時回 immutable，可以長期快取 |
| ffmpeg 解不開某支視頻 | 直接回錯誤；或改請 App 截幀 | 改請 App 截幀 | 同一個版本只試一次 ffmpeg；失敗後列表改標 `needs_frame` |
| 文章沒有圖片時的 `thumbnail` | 給 null；或維持不出現這個欄位 | 不出現 | 舊版列表的輸出不變，前端改看 `card_image` |
| 舊的快取 | 留著；或產生新版本時刪掉 | 刪掉 | 每個作品只保留目前那一張 |
| 上傳幀的權限 | `write`；或只限主權杖 | `write`（照總監的要求） | 只寫快取，不寫作品內容 |
| 簽名到期時間要對齊整點 | 維持一小時上限；或允許最多兩個 TTL | 允許兩個 TTL | 要符合「至少 60 分鐘而且同一小時內網址不變」，到期時間可能落在 60 到 120 分鐘之後；超過兩個 TTL 的仍拒絕（有單元測試） |

## 3. 自動測試

新增 `services/mac-server/test/card-images.test.ts`（12 個測試），以及 `media-units.test.ts` 的簽名到期時間單元測試（1 個）：
- **貼圖**：
  - 作品自己 `assets/` 裡沒有對應素材的圖片（`asset_id: null`）照樣有卡片圖。1200×900 縮成 512×384 的 WebP，`ETag` 與 `Cache-Control` 正確，304 也正確；原圖的 sha256 不變。
  - 封面優先；替換封面檔後 `version` 改變，快取只保留新的一張。
  - 缺檔回 `missing`，沒有來源回 `none`，壞圖回 `decode_failed`。
- **文章**：
  - 跳過 http 圖片，取第一張本機圖片；`excerpt` 去掉 H1 與 Markdown 語法。
  - 沒有圖片時沒有卡片圖，維持舊的列表形狀，`excerpt` 照樣有。
  - 託管文章不能用 `../` 跳出自己的資料夾。
  - 掛載資料夾的文章可以取圖，`../` 跳出掛載點的不給圖；原檔不變，資料夾裡沒有多出任何檔案。
  - 摘要截在 160 字（中文一字算一個），去掉程式碼區塊、清單、引言標記。
- **視頻**：
  - 沒有 ffmpeg：`needs_frame` 加 `frame_source`（含封面時間 3.5）。換一支視頻或換時間上傳回 409；正確的幀上傳後 `needs_frame` 變成 false，可以取回 288×512 的圖；原視頻的位元組不變。
  - 上傳的拒絕條件：`text/plain` 與壞圖回 415，超過 2 MiB 回 413，有圖片封面回 409 `thumbnail_frame_stale`，最近刪除中的作品回 409 `work_in_trash`。
  - 有假 ffmpeg：伺服器帶 `-ss 2` 取幀，結果是 512×288，快取裡沒有留下暫存檔。ffmpeg 失敗時回 404 `needs_frame`，之後列表改標 `needs_frame`。
- **簽名網址**：到期時間是下一個整點再加一小時（10:20 → 12:00），同一小時內再列一次網址不變；不帶權杖也能取圖；改過的簽名、換成別的作品 id、已過期的網址都回 403。
- **指紋**：同一路徑的視頻被替換後，舊 `version` 的幀回 409，快取裡沒有留下任何檔案。
- **權限與日誌**：只有 read 權杖上傳回 403；write 權杖可以上傳；read 權杖可以看圖；日誌中找不到 `sig` 的值，只看到 `sig=[REDACTED]`。
- `test/helpers.ts` 預設 `ffmpeg: null`，不依賴本機的 Homebrew ffmpeg；需要時用假的 ffmpeg 腳本。

## 4. 閘門結果

已 rebase 到 `origin/main` 441c523，在最終程式碼上執行。全套測試在持有鎖、1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **1004 passed／0 failed／1004 total**（2026-11-21 22:15，負載 6.55→8.12）：contracts 23、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 462（新增 13）、apps/mac 341、agent-sdk 10 |
| e2e | 加簽名網址之前的版本（edac9c0）跑過一次全套：**25／25**，背景模式。最終版本的全套 e2e 剛開始跑，總監就通知「QC-064 合併前暫停全套 e2e」，所以我立刻停掉；鎖已釋放，沒有殘留的程序。**最終版本的 e2e：NOT_VERIFIED**。這次的後端改動沒有動到 UI，只在列表加了欄位、加了新路由 |

沒有加長逾時、加重試或放寬斷言。

## 5. 給前端

- 列表欄位 `card_image`、`excerpt`。
- 取圖：`client.media.absoluteUrl(card_image.url)`；也可以用 Bearer 版的 `client.workThumbnails.path(id, version)`。
- 上傳幀：`client.workThumbnails.putFrame(id, bytes, { version, source, timeSeconds, contentType })`。
- 收到 409 `thumbnail_frame_stale` 時重新取列表。

## 6. 收尾

- 測試伺服器、假的 ffmpeg 與臨時目錄都已由測試清掉。
- 全套測試與 e2e 的鎖都已釋放；中途停掉的 e2e 沒有留下程序。
- 沒有修改 `.tasks/`。
- worktree 與分支保留，給前端接著測試，也等總監驗收。
