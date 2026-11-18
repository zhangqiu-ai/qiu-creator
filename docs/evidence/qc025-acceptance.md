# QC-025 驗收記錄：AI 工作台與設定頁 AI 服務

- 日期：2026-11-17
- 執行者：qc-frontend
- 對照基線：已核准原型 PT-20261116-001 的 MacAI、MacSettings 畫板，取自畫布目前發布的版本（version id `1794960531-6249`）。只對照原始碼，沒有複製 HTML。
- 環境：
  - macOS，Electron 45 開發模式。
  - 伺服器用 [qc025-server.mjs](qc025-server.mjs) 啟動：真實的 mac-server，加上服務端測試用的本機假 Gemini（Files API 與 generateContent），金鑰存在記憶體。
  - Claude、GPT 指向本機一個關閉的埠，就算誤觸也送不出去。
  - 資料由 [qc025-seed.mjs](qc025-seed.mjs) 建立：在本機用 ffmpeg 產生 56 秒的測試視頻，不讀取任何使用者素材。
- **金鑰紅線**：
  - 全程只輸入假金鑰字串，例如 `AIzaFAKE-qc025-not-a-real-key-0000`，沒有碰 Keychain，也沒有發任何真實請求。
  - 截圖中的金鑰欄位是遮罩狀態。
  - 實機驗收另外確認了金鑰不在 DOM、輸入框、localStorage、sessionStorage 裡，API 也不會回傳。

## 原型未畫、依推薦實作（已回報總監）

動工時已向總監回報，共 15 項，照推薦先做。總監的回覆列在交付說明。

| # | 狀態 | 做法 | 截圖 |
| --- | --- | --- | --- |
| 1 | 範本 | API 只有一種視頻任務，一次回傳全部結果，所以不提供範本選擇，固定顯示五區。 | [10](qc025-10-result.png) |
| 2 | 模型 | Gemini 可選，旁邊用下拉選模型名；Claude、GPT 標「不支援視頻」，本地模型標「延後提供」，三者停用。 | [01](qc025-01-no-key.png) |
| 3 | 選視頻 | 「選擇視頻」打開對話框，列出素材庫的視頻並可搜尋；沒有視頻時給「前往素材庫」。 | [07](qc025-07-picker.png) |
| 4 | 送出前確認 | 每次都顯示大小、時長、模型、輸入 token、最多花費與本月累計，都標「估算」，超過提醒額度會警示。第一次使用時告知也併在同一個對話框，按鈕是「同意並上傳分析」。 | [08](qc025-08-confirm.png) |
| 5 | 解析度 | 確認對話框有「低解析度」勾選；片長超過 1 小時時自動勾選並說明原因。 | 整合測試 |
| 6 | 重複分析 | 「已分析過此影片」對話框：沿用免費；重新分析會寫明再次計費與估算金額，之後還要再確認一次。 | [12](qc025-12-reuse.png) |
| 7 | 進度 | 只有上傳時顯示百分比；處理與分析階段用不確定進度條加階段文字。 | [09](qc025-09-running.png) |
| 8 | 加入候選 | 改成「複製」，因為工作台沒有綁定作品。 | [10](qc025-10-result.png) |
| 9 | 時間點與封面 | 超出片長的時間點加警示；封面直接用影片在該秒的畫面；點擊會在素材檢視器從該秒開始播放。 | [10](qc025-10-result.png)、[11](qc025-11-viewer-at-time.png) |
| 10 | 任務歷史 | 放在用量卡裡：月度總額、各供應商小計、超額提醒、最近任務（狀態與費用），點了可以載入結果。 | [10](qc025-10-result.png)、[13](qc025-13-failed.png) |
| 11 | 金鑰輸入、刪除、模型 | password 欄位存到鑰匙圈後立即清空，只顯示狀態；刪除要二次確認；可以選文字模型與視頻模型。 | [03](qc025-03-key-entry.png)、[05](qc025-05-settings-ready.png)、[06](qc025-06-delete-confirm.png) |
| 12 | 告知確認 | 列中顯示完整告知（寫明送到哪家公司），加「我已了解，啟用」；可以撤回。 | [04](qc025-04-consent-needed.png) |
| 13 | 月度提醒 | 金額可以儲存或清除，並顯示本月估算用量。 | [05](qc025-05-settings-ready.png) |
| 14 | 僅本地模型 | 開關與本地模型列都停用，註明延後提供。 | [02](qc025-02-settings-ai.png) |
| 15 | 前往設定 | 編輯器面板和工作台的「前往設定」都會打開設定頁並聚焦「AI 服務」。 | [02](qc025-02-settings-ai.png) |

## 自動測試

| 範圍 | 結果 |
| --- | --- |
| `corepack pnpm -r --workspace-concurrency=1 test` | 527 passed／0 failed／527 total（apps/mac 135） |
| `corepack pnpm -r typecheck` | 9／9 套件通過 |
| `corepack pnpm -r lint`、`corepack pnpm lint` | 0 錯誤 |
| `corepack pnpm format:check` | 通過 |

新增的測試是 `apps/mac/test/ai-workbench.test.ts`，共 12 個。測試對真實 mac-server 跑，Gemini 用服務端的假伺服器，金鑰存在記憶體：

- 設定：
  - 金鑰只能寫入：視窗狀態與 API 回應都不含金鑰。
  - 確認告知、改模型、撤回、刪除。
  - 月度提醒的設定與清除，拒絕負數。
  - 小額費用的格式。
  - 模型選項。
- 工作台：
  - 沒有金鑰的狀態。
  - 估算 → 同意告知 → 分段上傳 → 結果標待核驗與超出片長。
  - 沿用不送出任何東西；重新分析才計費。
  - 失敗原因、查看上次結果、重試。
  - 取消。
  - 長片自動改用低解析度；切回預設解析度時說明原因。
  - 進度標籤。
  - 任務歷史與用量。

## Electron 實機（CDP 驅動真實視窗）

用 [qc025-verify.mjs](qc025-verify.mjs) 在全新資料上跑：**40／40 通過**，結果在 [qc025-verify-results.json](qc025-verify-results.json)。

| 項目 | 截圖 |
| --- | --- |
| 導覽多了「AI 工作台」；沒有金鑰時顯示「未設定 Gemini 金鑰」、前往設定，「改用本地模型」停用 | [01](qc025-01-no-key.png) |
| 前往設定：打開設定頁並聚焦 AI 服務 | [02](qc025-02-settings-ai.png) |
| 金鑰用 password 欄位輸入，存好後清空，只顯示「待確認告知」 | [03](qc025-03-key-entry.png)、[04](qc025-04-consent-needed.png) |
| Claude 確認告知後啟用；改模型；月度提醒 | [05](qc025-05-settings-ready.png) |
| 刪除金鑰前二次確認 | [06](qc025-06-delete-confirm.png) |
| 選視頻；送出前估算 | [07](qc025-07-picker.png) |
| 確認對話框：告知、大小、時長、模型、最多花費，以及超額警示 | [08](qc025-08-confirm.png) |
| 上傳與處理進度；取消後任務為 cancelled | [09](qc025-09-running.png) |
| 結果：待核驗、時間點（含超出片長）、封面畫面、標題與簡介加複製、用量卡 | [10](qc025-10-result.png) |
| 點時間點會在素材檢視器從 0:21 開始播放 | [11](qc025-11-viewer-at-time.png) |
| 沿用結果不送出；重新分析要再確認一次費用 | [12](qc025-12-reuse.png) |
| 429 失敗顯示原因、重試與查看上次結果；歷史標示失敗 | [13](qc025-13-failed.png) |
| 深色；1000px 窄視窗不會出現橫向捲動 | [14](qc025-14-result-dark.png)、[15](qc025-15-settings-dark.png)、[16](qc025-16-narrow.png) |

### 驗收過程中的修正

- React 開發模式會重複掛載，第一次卸載就把工作台的 session 釋放掉了，導致「未設定金鑰」不顯示。改成在 effect 裡建立 session。
- 只載入 metadata 的 `<video>` 不會畫出畫面，所以縮圖和封面是空白的。改成載入 metadata 後跳到指定秒數。
- 複製用的 `navigator.clipboard` 在視窗沒有焦點時會失敗，改用主程序既有的 `copyText`。
- 本次分析約 $0.0084，舊格式會顯示成 $0.01，所以小額改成顯示有效位數。
- 月度提醒那行文字被截斷，改成可以換行。

## 刻意偏差

- 拿掉原型確認對話框的「此服務不再詢問」：告知確認本來就會保存，而費用確認每次都應該出現。
- 「改用本地模型」顯示但停用。

## NOT_VERIFIED

- NOT_VERIFIED：真實 Gemini 的上傳、處理與回應；全程用本機假伺服器。
- NOT_VERIFIED：真實 macOS Keychain 的寫入與刪除。測試用記憶體存放，服務端的 Keychain 實作不在這張的範圍。
- NOT_VERIFIED：大檔（GB 級）與超過 1 小時的影片實際上傳；只用資料庫修改時長測試自動改用低解析度。
- NOT_VERIFIED：Chromium 解不了的格式（例如部分 HEVC .mov）的縮圖與封面畫面；會退回圖示，但沒有實測。
- NOT_VERIFIED：VoiceOver 朗讀、實體鍵盤加輸入法。
- NOT_VERIFIED：用建置產物啟動。

## 清理

- 假 AI 伺服器、Vite、Electron 都已關閉，7420、5180、9333 埠已釋放。
- 臨時資料目錄已刪除，e2e 鎖已釋放。
