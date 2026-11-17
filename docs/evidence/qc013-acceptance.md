# QC-013 驗收記錄：四平台模擬預覽

- 日期：2026-11-17
- 執行者：qc-frontend
- 對照基線：MacPreview 畫板與 PT-20261117-001 的超出上限警告樣式，都取自畫布實際發布的第 31 版（version id `1794917665-dc4e`）。版本號已核對，對照的是畫板原始碼，沒有複製 HTML。
- 環境：macOS、Electron 45 開發模式；mac-server 跑在臨時 `CREATORHUB_HOME`，資料由 [qc013-seed.mjs](qc013-seed.mjs) 建立（一篇作品、12 張圖）。過程中沒有任何對外網路請求。

## 設計決定

- **`@qiu-creator/platform-preview` 不綁 Electron 或 DOM。**
  - 主入口是純 TypeScript：四個模板的版面資訊，加上 `buildPreviewModel()` 產生的 view model（截斷後的標題、正文區塊、會顯示的圖片、標籤與警告）。
  - DOM 模板另放在 `./react`，樣式在 `./style.css`。
  - 第二期 React Native 可以共用同一個 model，或在 WebView 直接用 DOM 模板。
- **預覽畫面的外觀。** 固定中性配色、不跟 App 主題，不用任何平台標誌，平台名稱只用文字；每個畫面都標「模擬」，下方也寫「版面為模擬，實際呈現以平台為準」。
- **字數上限。** 以 contracts 的 `PLATFORM_LIMITS` 為準。抖音標題 30 字、視頻號 16 字，和原型的示意值（55、64）不同。
- **每個平台一個 `VariantSession`，revision 各自計算。** 409 時不會覆蓋任何一方，草稿留在視窗，由使用者選：
  - 「載入最新版本」：捨棄自己的修改。
  - 「以我的修改覆蓋」：以最新 revision 為基準明確寫入；如果又被別人改了，會再出現 409。

## 自動測試

| 範圍 | 結果 |
| --- | --- |
| `corepack pnpm -r --workspace-concurrency=1 test` | 416 passed／0 failed／416 total（apps/mac 103、platform-preview 12） |
| `corepack pnpm -r typecheck` | 9／9 套件通過 |
| `corepack pnpm lint` | 0 錯誤 |
| `corepack pnpm format:check` | 通過 |

測試是一次跑一個套件。驗收當下機器 load average 高達 88～265，是其他程式造成的。

新增的測試：

- `packages/platform-preview/test/model.test.ts`
  - 以字元（code point）截斷，不會切斷 emoji。
  - 四個平台各用自己的上限。
  - 超出張數的圖片不顯示，圖片還在載入時也照實際張數計算。
  - 標籤上限。
  - 公眾號正文轉成區塊，其他平台用純文字。
  - Markdown 程式碼區塊與分隔線的處理。
- `packages/platform-preview/test/react.test.tsx`
  - 四個模板都有「模擬」標籤、截斷後的標題、純文字平台名，沒有外部圖片。
  - 沒有版本時的空狀態。
- `apps/mac/test/variants.test.ts`（對真實 mac-server）
  - 四個平台從原稿建立後，分別修改標題與正文，互不串改，原稿也沒變。
  - 兩個 session 同時改同一平台：後存的那個收到 409，不覆蓋；衝突期間自動儲存暫停；「以我的修改覆蓋」寫在最新版之上；另一個 session 會載入最新版。
  - 有未儲存修改時，遠端的新版本轉為衝突選擇。
  - 自己存檔產生的 SSE 回聲會被忽略。
  - 複製公眾號版本。
  - 重新從原稿產生會成為新 revision，歷史保留。
  - 只送出有變動的欄位、移動圖片、即時計算超限警告。

## Electron 實機（等級 2，CDP 驅動真實視窗）

用 [qc013-verify.mjs](qc013-verify.mjs) 在全新種子資料上跑：**20／20 通過**，結果在 [qc013-verify-results.json](qc013-verify-results.json)。

| 項目 | 截圖 |
| --- | --- |
| 從編輯頁按「預覽」進入；四個文字分頁；尚無版本時可從原稿建立；手機框標「模擬」 | [01](qc013-01-empty.png) |
| 四個平台分別建立（視頻號用複製公眾號版本），各改標題與正文：API 確認各自的值、互不串改，原稿沒變 | — |
| 只改抖音的封面：抖音的 `cover_asset_id` 改了，小紅書沒變；手機畫面換成新封面 | [02](qc013-02-douyin.png) |
| 小紅書標題超過 20 字：警告條、計數、輸入框邊框、欄位提示「預覽已截斷」、預覽截斷、分頁圓點；仍照常儲存，API 也回報警告 | [03](qc013-03-xhs-title-over.png) |
| 視頻號 12 張圖：「12/9 張」、多出 3 張變淡加虛線框、提示「多出的不會顯示」 | [04](qc013-04-channels-images-over.png) |
| 公眾號文章樣式；組字中按 Enter 不會新增標籤；Enter 新增的標籤只加到公眾號 | [05](qc013-05-mp-article.png) |
| 另一寫入者改同一平台（抖音）：出現衝突提示與紅點，對方的內容沒被覆蓋；「以我的修改覆蓋」寫在最新 revision 之上；另一次改用「載入最新版本」，顯示對方的版本 | [06](qc013-06-conflict.png) |
| 沒有未儲存修改的視窗會即時顯示 Agent 的修改 | — |
| 導航的「平台預覽」直接打開上次編輯的作品 | — |
| 深色；1000px 窄視窗 | [07](qc013-07-xhs-dark.png)、[08](qc013-08-mp-narrow.png) |

### 驗收過程中的修正

- **產品修正：封面不在圖片列表時看不到。** 從原稿建立時，作品的封面寫入 `cover_asset_id`，但不在 `image_asset_ids` 裡，所以選圖區看不到封面。已改成在列表最前面顯示一個「封」格。
- **腳本修正，產品程式沒有改：**
  - 作品庫被 SSE 重新整理時，點卡片的動作落空。已改成點擊後確認有打開，沒打開就重試。
  - 新增「封」格後，縮圖的位置往後移了一格，原本用位置挑縮圖的腳本選錯。已改成只從可排序的縮圖按鈕裡挑。

## 刻意偏差

- 兩個視窗同時編輯：App 只有一個視窗，無法同時開兩個實機視窗。實機以 API 寫入代表「另一個視窗或 Agent」；兩個 session 真正並行的情況由整合測試覆蓋。
- 原型的封面選擇是「點縮圖就設為封面」。實作改成先選取縮圖，再用工具列的「設為封面、往前移、往後移、從這個平台移除」，好讓圖片順序也能用鍵盤調整。
- 公眾號正文只做簡化的 Markdown 呈現（標題、段落、清單），不模擬公眾號的排版細節。
- 預覽裡的帳號名稱固定為「我的帳號」，日期取自版本最後更新時間。

## NOT_VERIFIED

- NOT_VERIFIED：實體鍵盤加 macOS 輸入法打字（組字由 CDP 的 `Input.imeSetComposition` 模擬）。
- NOT_VERIFIED：VoiceOver 實際朗讀。
- NOT_VERIFIED：兩個實機視窗同時編輯（理由見上方「刻意偏差」）。
- NOT_VERIFIED：各平台的上限與版面和真實平台是否一致。這些是 contracts 的參考值，原型也只是示意，沒有對照真實平台。
- NOT_VERIFIED：影片類素材的預覽。目前只有圖片；平台版本也還沒有影片欄位。
- NOT_VERIFIED：第二期移動端是否真的能直接共用。主入口沒有 DOM 依賴，但還沒在 React Native 中實際使用過。
- NOT_VERIFIED：用建置產物啟動。

## 清理

- mac-server、Vite、Electron 都已關閉，7420、5180、9333 埠已釋放。
- 臨時資料目錄已刪除，e2e 鎖已釋放。
