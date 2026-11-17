# QC-011 驗收記錄：Mac 作品管理與編輯完整化

- 日期：2026-11-17
- 執行者：qc-frontend
- 基線：已核准原型 PT-20261116-001，加上 PT-20261117-001（畫布第 31 版）。對照的是 Main 與 MacEditor 畫板的原始碼，沒有複製 HTML。
- 環境：
  - macOS、Electron 45 開發模式。
  - mac-server 跑在臨時 `CREATORHUB_HOME`，掛載資料夾也是臨時目錄。
  - 資料由 [qc011-seed.mjs](qc011-seed.mjs) 建立。
  - 沒有任何對外網路請求。

## Markdown 圖片：選用簽名網址

用 QC-010 的 `/works/:id/media` 簽名網址，不沿用 `qc-asset://` 代理。理由：

- 只有這個 API 知道相對路徑對應哪個檔案（托管的 `assets/…`，或掛載資料夾內的路徑）。
- 有些已解析的檔案沒有素材 id，代理無從指定。
- 簽名網址短效，只對單一檔案有效。權杖仍不進 renderer，第二期 WebView 也能用同一套。

其他做法：

- 素材庫檢視器仍走 `qc-asset://` 代理。
- 外部 `http(s)` 圖片不載入，改顯示佔位圖。CSP 的 `img-src` 因此拿掉 `https:`，改為加上服務來源。

## 自動測試

| 範圍 | 結果 |
| --- | --- |
| `corepack pnpm -r --workspace-concurrency=1 test` | 378 passed／0 failed／378 total（apps/mac 94，markdown-editor-web 16） |
| `corepack pnpm -r typecheck` | 9／9 套件通過 |
| `corepack pnpm lint` | 0 錯誤 |
| `corepack pnpm format:check` | 通過 |

### 先前一次並行執行的失敗

先前用並行的 `pnpm -r test` 跑過一次，出現 5 個逾時。原因判斷是機器負載：load average 約 24，其他程式占用 CPU。

- 失敗的測試分布在本任務沒有修改的套件，包括 mac-server 的 uploads、imports、media，以及 markdown-editor-web 的既有測試。
- mac-server 的 uploads 單獨重跑 3 次都通過。
- 改成一次跑一個套件後全部通過。
- 沒有調整任何逾時或斷言。

### 新增的測試

`apps/mac/test/work-management.test.ts`，對真實 mac-server：

- 狀態與標籤立即儲存，並產生 revision。
- 外部修改：
  - 沒有未儲存修改時直接載入新版本。
  - 有未儲存修改時改顯示提示，並暫停自動儲存，不覆蓋別人的修改。
  - 「比對並合併」會進入衝突流程；「捨棄」會重新載入。
- SSE 回聲（含請求途中先到的）不會被誤認成外部修改。
- 恢復版本：
  - 新增一筆 `restore` revision，歷史保留，檔案內容正確。
  - 恢復前先存掉未儲存的修改。
  - base 過期時回 409，不覆蓋。
- 外部檔案遺失：
  - 作品變唯讀，這個視窗的修改保留，恢復版本被擋下。
  - 檔案放回後恢復編輯，並把修改寫回原檔。
- 卸載後開啟的作品是唯讀。
- `./assets` 圖片解析成簽名網址：不帶權杖可以取得原檔；缺圖與外部網址顯示佔位圖。

`apps/mac/test/qc011-helpers.test.ts`：

- 媒體解析的快取與到期刷新、未知圖片先儲存再查、各種佔位圖、SVG 跳脫、服務離線時的處理。
- 外部來源標示與 `~` 縮寫。
- 檔案遺失的判斷。
- 標籤的切分與去重。
- 素材依掛載分組。

另外：

- `apps/mac/test/main-config.test.ts`：CSP 只允許從 App 本身、`qc-asset:` 與服務來源載入圖片和媒體。
- `packages/markdown-editor-web/test/editor.test.tsx`：圖片顯示用的 `src` 交給宿主解析，Markdown 原文不變。

## Electron 實機（等級 2，CDP 驅動真實視窗）

用 [qc011-verify.mjs](qc011-verify.mjs) 在全新種子資料上跑完：**31／31 通過**，結果在 [qc011-verify-results.json](qc011-verify-results.json)。

| 項目 | 截圖 |
| --- | --- |
| 列表：「外部」標籤（hover 顯示資料夾）、來源欄「外部掛載 · 寫作」 | [01](qc011-01-library-list-external.png) |
| 在 Finder 刪除原檔：不必重新整理就出現「檔案遺失」，卡片變灰 | [02](qc011-02-library-missing.png) |
| 遺失作品唯讀：紅色橫幅（路徑、放回原處後自動恢復、在 Finder 顯示資料夾）、儲存標籤顯示「唯讀」、恢復停用；放回檔案後自動恢復編輯 | [03](qc011-03-editor-missing.png) |
| 組字中外部編輯器改檔：顯示「檔案已在外部修改 · 外部編輯器 · r2」，我的字留著，原檔不被覆蓋 | [04](qc011-04-editor-external-change.png) |
| 「比對並合併」開啟衝突對話框，保留雙方 | [05](qc011-05-editor-compare.png) |
| 視窗沒有未儲存修改時，Agent 的修改即時顯示，不跳提示 | — |
| Markdown 圖片經簽名網址顯示、不超出閱讀欄；缺圖顯示「找不到圖片」佔位 | [06](qc011-06-editor-images.png) |
| 狀態改「待發布」立即儲存；組字中按 Enter 不新增標籤；新增與移除標籤都會儲存 | [07](qc011-07-editor-status-tags.png) |
| 歷史：選目前版本顯示「即目前版本」、恢復停用；選 r2 顯示「1 處不同」與差異；確認框「恢復 r2 為新版本 r8，歷史版本全部保留」 | [08](qc011-08-history-confirm.png) |
| 恢復後多一筆版本，服務記錄為 `restore` | [09](qc011-09-history-restored.png) |
| 素材檢視器的「引用」列出作品與角色（封面／正文），點擊開啟作品 | [10](qc011-10-asset-references.png) |
| 深色 | [11](qc011-11-editor-external-dark.png)、[12](qc011-12-library-dark.png) |

驗收腳本兩次失敗的經過：

- 第一次：用 `startsWith('2026')` 找作品，抓到了「保留雙方」產生的「（我的修改）」副本。
- 第二次：作品庫被 SSE 刷新時，點卡片的動作落空。
- 兩次都是腳本的問題：改成用完整標題比對、點擊後確認有打開並重試。產品程式碼沒有改。

## 同一根因一併處理

QC-010 讓掛載資料夾裡被引用的檔案也成為素材（`mount_id`）。所以素材庫改成依掛載分組顯示，「在 Finder 顯示」改用掛載根目錄解析路徑，掛載離線時整組變淡並顯示「找不到資料夾」。

## 刻意偏差

- 版本歷史的「來源」只顯示 revision 的 `source`。狀態與標籤的修改也記為「Mac 編輯」，因為服務沒有區分。
- 唯讀時，MDXEditor 的格式工具列仍然顯示，但不可用；原型只要求「不可編輯」。
- 掛載離線時，原型有「重新指定」按鈕。沒有變更掛載路徑的 API，所以不放；設定頁可以卸載後重新掛載。
- 外部修改提示的來源文字：`external` 顯示「外部編輯器」；另一個視窗或 Agent 的修改顯示「其他視窗或 Agent」。服務不提供具體 App 名稱（原型示意的是「VS Code」）。

## NOT_VERIFIED

- NOT_VERIFIED：實體鍵盤加 macOS 輸入法打字。組字由 CDP 的 `Input.imeSetComposition` 模擬。
- NOT_VERIFIED：VoiceOver 實際朗讀。
- NOT_VERIFIED：在 Finder 顯示資料夾（原生行為）。
- NOT_VERIFIED：簽名網址在長時間編輯中到期後自動換新。只有單元測試，沒有實機等滿 1 小時。
- NOT_VERIFIED：外接硬碟拔除造成的「卸載中」實機情境。以刪除檔案和 API 卸載代替。
- NOT_VERIFIED：用建置產物啟動。建置版的 CSP meta 預設服務是 `127.0.0.1:7420`；改用其他埠時，建置版的圖片會被擋下（開發版用回應標頭，沒有這個問題）。

## 清理

- mac-server、Vite、Electron 都已關閉，7420、5180、9333 埠已釋放。
- 臨時資料目錄與掛載資料夾已刪除。
- e2e 鎖已釋放。
