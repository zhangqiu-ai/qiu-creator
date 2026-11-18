# QC-026 驗收記錄：M3（AI 創作與 Gemini 視頻理解）

- 日期：2026-11-17；分支 `test/qc026-m3-acceptance`（基底 `origin/main` aa57d9f）；執行者 qc-bugfix
- **只用本機假服務，沒有發出任何真實請求。** Claude、GPT 用 `FakeAiServer`（各家原生的線上格式），Gemini 視頻用 `FakeGeminiVideo`（Files API 加 `generateContent`），都是這個倉庫測試裡既有的假服務；金鑰全是假字串，API 層測試存在記憶體，Electron 實機用倉庫外的暫存檔（模擬 Keychain 但跨重啟保留），**沒有碰真實 Keychain**。
- 範圍：QC-021 AI 基礎／金鑰／任務／費用、QC-022 文字候選與改寫、QC-023 Gemini 視頻理解、QC-024 編輯器 AI 面板、QC-025 AI 工作台與設定頁。已知缺陷 QC-027（衝突對話框兩邊顯示同一版本號）不重報；它在本次的衝突畫面截圖裡可見。

## 結論

M3 驗收四項全部通過，另測項目全部通過；**沒有發現需要修的缺陷**。有兩個觀察（不違反驗收項，見第 4 節）。真實的 Gemini 視頻、Claude、GPT 文字呼叫與真實 Keychain 存取標 `NOT_VERIFIED`。

## 1. 自動測試（API 層，持久）

`services/mac-server/test/m3-acceptance.test.ts`，23 項全過。一個伺服器同時接 Claude／GPT 假服務與 Gemini 視頻假服務，另開「重啟」用同一份資料夾與同一份金鑰存放。

| 驗收項 | 測試 | 重點斷言 |
| --- | --- | --- |
| 1 視頻直接送 Gemini | 上傳原始檔案、不轉檔 | 假 Gemini 收到的位元組與原檔完全相同；一次 `generateContent` 引用已上傳的檔案；沒有任何文字模型請求；估算階段不送出；遠端檔案分析後刪除 |
| 1 結果保存並沿用 | 重啟後沿用 | 重啟後 `GET /ai/jobs/:id` 結果相同；再分析回 `cached: true`、不送出、用量不變；同內容的視頻換名字重傳（去重為同一素材）也命中 |
| 2 改寫只產生候選 | 改寫候選 | 作品文字、磁碟檔案、歷史份數都沒變，沒有 `work.updated` 事件 |
| 2 原稿已變回 409 | 採用過期候選 | App 內修改加外部編輯器改檔後採用：`409 revision_conflict`，磁碟仍是外部版，沒有 `ai_accepted` 版本 |
| 2 採用後可從歷史恢復 | 採用再恢復 | `ai_accepted` 版本寫入檔案；恢復成新 `restore` 版本；歷史依序 `restore、ai_accepted、create` |
| 2 外部掛載 | 外部檔案 | 候選期間外部編輯器存檔，採用回 409，掛載檔案保持外部版 |
| 2 平台候選不直接寫入 | 標題／簡介／標籤候選 | 平台版本份數與版本號、作品與歷史都不變，只有先前手動建立的那一個版本事件 |
| 3 命中快取不送出不計費 | 快取命中 | 連按 3 次分析：假 Gemini 的 `starts`／`generates` 不變、`usage` 完全相同；帶 `reanalyze` 才新增第二次並計費（花費增加、`jobs` 變 2） |
| 3 進行中不重複送出 | 6 個同時請求（一半帶 `reanalyze`） | 只有一個任務、一次上傳、一次 `generateContent`；其餘回 `in_progress: true` |
| 3 冪等鍵有效 | `Idempotency-Key` | 同鍵同請求回原任務（`idempotent-replayed: true`），只有 1 個任務、1 次供應商請求、1 次計費；同鍵不同請求被拒（≥ 400）而不是靜默沿用 |
| 3 重啟不重跑 | 重啟 | 已完成的文字與視頻任務不再送出 |
| 4 狀態與失敗原因 | 429 | 重試 3 次後 `failed`／`rate_limited`、`attempts: 3`，事件有 3 次 `ai_job.queued` 與最後的 `ai_job.failed`，出現在 `status=failed` 列表 |
| 4 | 金鑰無效 | 立刻 `failed`／`invalid_key`、`attempts: 1`、供應商只收到 1 次；供應商回應的錯誤訊息把金鑰整串回顯，儲存的任務裡仍沒有金鑰 |
| 4 | 拒答、缺金鑰、未確認告知 | 拒答 `content_blocked`、`attempts: 1`；缺金鑰 `409 ai_key_missing`；未確認 `409 ai_consent_required`；都不送出 |
| 4 | Gemini 處理失敗 | `file_processing_failed`，錯誤文字含原因，遠端檔案刪除，沒有 `generateContent` |
| 4 | 取消與重試 | 排隊中與進行中都能取消（進行中的供應商連線被中止），取消或失敗後重試成功 |
| 4 | 服務重啟後續跑 | 視頻在 Gemini 處理中時重啟：完成一次、只計費一次、`attempts: 2`、沒有遺留的遠端副本；文字任務在 `running` 狀態重啟後恰好再跑一次 |
| 另 金鑰不外洩 | 掃描 | 對 API 回應（providers、settings、jobs、usage、單一任務、`/docs/json`）、SSE 事件、資料庫所有表、資料夾底下所有檔案（含 WAL）掃描三家金鑰：全部找不到；金鑰只在金鑰存放裡 |
| 另 Agent 權杖 | 從 OpenAPI 文件列舉 | 所有含 `/ai` 的路由（至少 19 個）：全權限的 Agent 權杖一律 `403`，無權杖一律 `401`；期間沒有任何請求送到供應商；Agent 用戶端不能讀或改金鑰 |
| 另 撤回告知／刪金鑰 | 排隊中的任務 | 改寫、一般任務、視頻任務在送出前被撤回告知或刪除金鑰：`consent_required`／`missing_key`，假 Claude／GPT／Gemini 都沒收到任何請求 |
| 另 月度提醒 | 提醒金額設到極小 | 文字與視頻任務都回 `over_budget: true` 與「仍會送出」的提醒，且照常成功 |

## 2. Electron 實機（CDP 驅動真實視窗）

[qc026-run.sh](qc026-run.sh) 拿 e2e 鎖、起假供應商（[qc026-fakes.mjs](qc026-fakes.mjs)，獨立行程，所以伺服器被殺也不丟失紀錄）、起**開著請求日誌**的真實 mac-server（[qc026-server.mjs](qc026-server.mjs)）、種資料（[qc026-seed.mjs](qc026-seed.mjs)：一篇作品、一支 56 秒 ffmpeg 測試影片）、起 Electron，跑 [qc026-verify.mjs](qc026-verify.mjs)，結束後關閉全部、確認埠釋放、刪臨時資料夾、放掉鎖。結果在 [qc026-verify-results.json](qc026-verify-results.json)：**62／62 通過，連續 4 次**。

| 節 | 內容 | 結果 |
| --- | --- | --- |
| 0 | 尚未設定：編輯器面板顯示「尚未設定 AI 金鑰」且不能送出（[01](qc026-01-no-key.png)） | 通過 |
| 1 | 設定頁以密碼欄位輸入 Claude 與 Gemini 假金鑰、確認告知（[02](qc026-02-settings-ready.png)）；金鑰不在畫面、輸入欄、localStorage、sessionStorage、IndexedDB、cookie；API 只回已存而不回金鑰 | 通過 |
| 2 | 編輯器改寫：候選有 diff（[03](qc026-03-candidate.png)），文字、檔案、歷史都沒變；供應商收到真實金鑰；候選期間外部編輯器改檔，按「採用」開啟衝突對話框（[04](qc026-04-conflict.png)），外部版仍在磁碟、沒有 `ai_accepted`；「保留雙方」把 AI 文字另存成作品；在新版本上重新生成並採用（[05](qc026-05-adopted.png)）寫成 `ai_accepted`；「復原」恢復成 `restore`，歷史 `restore、ai_accepted、external、create` | 通過 |
| 3 | 標題候選四平台（[06](qc026-06-titles.png)）：生成後沒有建立或改動任何平台版本，按「寫入平台版本」才建立四個 | 通過 |
| 4 | 工作台：估算先於送出且估算階段什麼都沒送；確認對話框（[07](qc026-07-confirm.png)）顯示時長與最多花費；對話框按兩下加 3 個並行 API 請求，只有 1 個任務（[08](qc026-08-processing.png)）；**處理中以 SIGKILL 殺掉伺服器**，launchd 式的迴圈重啟後任務續跑並完成（[09](qc026-09-result.png)）；上傳的位元組與原檔 sha256 相同；分析一次、計費一次、遠端無殘留；結果標「待核驗」附免責、超出片長的時間點標出；「沿用結果」不送出不計費；「重新分析」再問一次費用（[10](qc026-10-reanalyze-confirm.png)），只有它多一個任務並計費 | 通過 |
| 5 | 失敗原因：Gemini 429 不會好時「分析失敗」顯示「請求太頻繁（429）」附「重試」與「查看上次結果」（[11](qc026-11-failed-429.png)），任務記 `rate_limited`、3 次；按重試成功；視頻「取消」後遠端檔案刪除；Claude 429 顯示「生成失敗 · 請求太頻繁（429）」並可重試；金鑰無效（供應商把金鑰回顯）顯示「金鑰無效」（[12](qc026-12-failed-key.png)），只試 1 次，視窗與儲存的錯誤都不含金鑰 | 通過 |
| 6 | 在設定撤回 Claude 與 Gemini 的告知：編輯器面板要求重新確認且不能送出（[13](qc026-13-consent-withdrawn.png)）；API 對新分析回 `409 ai_consent_required`；撤回期間假供應商的請求數完全沒增加；重新確認後恢復 | 通過 |
| 7 | 月度提醒設成 $0.001：確認對話框顯示提醒（[14](qc026-14-over-reminder.png)），任務照常送出並成功，用量卡顯示超額提醒 | 通過 |
| 8 | 金鑰不在畫面、輸入欄、web storage、IndexedDB、cookie；視窗沒有向任何非本機主機發出請求；服務請求日誌確實開著（約 170 KB 請求行）而**不含任何金鑰、作品文字、提示詞或 AI 輸出**；資料夾（資料庫、WAL、library、cache）沒有任何金鑰；儲存的 AI 任務沒有金鑰 | 通過 |

驗收腳本本身在過程中修了三個我自己的問題，產品行為沒有改（對照第一次的 53／62 到後來的 62／62）：「保留雙方」產生的「（我的修改）」副本也符合我的卡片比對、Claude 的金鑰是 `Authorization: Bearer` 不是 `x-api-key`、等「重新分析」完成的條件在送出前就已成立。

## 3. 驗證數字

| 項目 | 結果 |
| --- | --- |
| `pnpm test`（一次跑一個套件，見 QC-018） | **552 passed、0 failed、共 552**（mac-server 312〔含本次 23〕、apps/mac 137、markdown-editor-web 22、platform-preview 12、api-client 15、contracts 16、domain 27、agent-sdk 6、design-tokens 5） |
| `pnpm -r typecheck` | 通過 |
| `pnpm lint` | 通過 |
| prettier（本次新增檔案） | 通過 |
| Electron 實機 | 62／62，連續 4 次 |
| 量測當下負載 | load average 約 3.5–4.4（每次執行前後都記錄） |

## 4. 觀察（不違反驗收項，未修）

1. **服務重啟後，已上傳完、Gemini 處理中的視頻會整支重傳。** 任務的 `remote_state` 存了遠端檔案名，但重啟後的重試沒有沿用，而是重新開始上傳；舊的遠端檔案有被刪除（沒有遺留）、結果正確、只計費一次。影響是頻寬與時間：2 GB 的檔案會重傳 2 GB。同一個行程內的 429 重試則會沿用遠端檔案（已有測試）。
2. **改寫與標題候選沒有冪等鍵也沒有「進行中就不重複」的保護。** 同一作品同時送兩個一樣的改寫請求，會成為 2 個任務、2 次供應商請求、2 次計費（`Idempotency-Key` 只有 `POST /ai/jobs` 支援，視頻分析有自己的進行中去重）。介面在生成中停用按鈕，而且 `/ai/*` 只限主權杖，所以實際風險低；只有想從 Agent 之外的第二個用戶端安全重試時才有影響。

## 5. NOT_VERIFIED

- 真實的 Gemini 視頻理解、Claude 文字、GPT 文字呼叫：需要使用者同意並自行存入金鑰。假服務驗證的是線上格式、錯誤分類與流程，不是模型輸出品質、真實費用、真實延遲或真實的限流行為。
- 真實 Keychain 存取（`KeychainSecretStore` 在測試下會拒絕建立）。
- 真實價格表：費用數字是依倉庫內「參考價格」算的估算。
- 用建置產物（非開發模式）啟動。
- 大於 256 KiB 區塊的真實大檔上傳（假服務用 256 KiB 區塊；實機 5.9 MB 影片 23 個區塊）；2 GB 上限與 1 小時預設解析度上限只在 API 層測試過（QC-023 的既有測試）。
- 本地模型（延後）。

## 6. 收尾

假供應商、mac-server、Vite、Electron 都已關閉，7420、7433、5180、9333 埠已釋放；臨時資料夾、金鑰暫存資料夾已刪；e2e 鎖已釋放；沒有用到 iOS Simulator。
