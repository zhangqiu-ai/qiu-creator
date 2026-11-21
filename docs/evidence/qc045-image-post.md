# QC-045 驗收記錄（前端）：貼圖作品，併 QC-048

日期：2026-11-21　分支：`feat/qc045-image-post`（從 main `b87d490` 開）
依據：原型 PT-20261121-001 的 NewType、ImagePost、ImagePostDark 畫板（`docs/design/prototype/changes.json` 的狀態清單與 `decisions`）；API 照 `docs/evidence/qc045-046-backend.md` 第 5 節。
畫布在這個會話仍然讀不到（Artifact 讀取回 network error），所以以 ledger 為準。ledger 沒寫到的細節是我的判斷，列在「與原型的差異／待確認」。

## 做了什麼

### 新建與作品庫（NewType）

- **新建選類型**：「新建」改成選單，有文章、貼圖、視頻三項，各附一行說明與數字鍵。
  - 鍵盤：⌘N 開啟，↑↓ 選擇，1–3 直接選，↩ 建立，esc 關閉。
  - 視頻在 QC-046 前停用，說明寫「即將推出」。
  - 新建時 `title` 由介面語言送出。
- **類型篩選**：全部、文章、貼圖、視頻，各顯示數量。「混合」只在「全部」出現，照 decisions。
- **卡片縮圖**：
  - 貼圖：顯示封面（沒指定時用第一張），加「N 張」。
  - 視頻：顯示封面幀，加時長與直式或橫式；QC-046 建好視頻作品後才看得到。
  - 有遺失檔案時，顯示「N 個檔案遺失」。
- **類型空狀態**：例如「還沒有貼圖」，加說明與「新建貼圖」；視頻的按鈕停用。
- **類型名稱**：照原型改成文章、貼圖、視頻（原本是長文、圖文）。英文的平台短名照 decisions 改成 RedNote、WeChat OA；Douyin、Channels 不變。

### 貼圖編輯（ImagePost）

放在 QC-047 的分頁框架裡：`TabPane` 依作品類型選編輯器，分頁的狀態保留、未存提示、重開恢復都沿用。

- **圖片格**：3:4 格，右下編號，封面標記；懸停時出現「設為封面」「移除」。
- **排序與移除**：
  - 拖曳排序時顯示插入線。
  - 選取後 ⌥←→ 移動，⌫ 移除；提示「已移除第 N 張」並附「復原」。
- **加圖**：沿用 QC-039 的流程，有以下來源：
  - 「＋」格：素材庫、上傳。
  - ⌘V 貼上、從 Finder 拖入，可拖到指定位置。
  - 右側素材抽屜：點選加到最後，或拖進圖片格的指定位置。
  - ⌘⇧I 開關素材抽屜，⌘⇧U 上傳。
- **上傳中與失敗**：上傳中顯示進度環；失敗時顯示原因，附「重試」「移除」。
- **檔案遺失**：顯示「檔案遺失」與「重新指定」，從素材庫選一張取代原位置。
- **平台上限只提示**：
  - 標題下方是各平台張數 chip，例如「小紅書 12/18」「視頻號 12/9」，超過的變成警告色。
  - 超過任一平台上限的圖片會變淡並加虛線，aria-label 寫出超過哪些平台。
  - 提示寫明「只是提示，不會阻擋儲存」。公眾號貼圖用 20 張。
- **封面設置**：從貼圖中選一張，或另外上傳；預覽 3:4、1:1、2.35:1 三種裁切；可以改回「第一張」。
- **標題、描述、話題、狀態**：
  - 標題下方是各平台字數 chip，例如「視頻號 16/16」。
  - 描述顯示字數，上限取各平台最小的 1,000 字。
  - 話題與狀態沿用文章的元件。
- **歷史**：沿用 `HistoryPanel`，比對整個原始檔（含 front matter）；恢復舊版本同樣會新增一個版本。
- **平台預覽**：頂欄的「預覽」開啟平台預覽頁。編輯器右側也有模擬預覽，可切換四個平台。
- **外部掛載的貼圖**：圖片要在 Finder 調整，介面停用加圖、排序、移除並說明原因；標題、描述、話題可以改。沒有素材 id 的圖片只顯示路徑，不顯示縮圖。

### 存檔與衝突

- **沿用 `WorkSession`**：自動儲存、`base_revision`、409、遠端更新、唯讀都跟文章相同。
- **草稿欄位**：貼圖草稿的 `markdown` 欄位放描述，另有 `images`（素材 id，依順序）與 `cover`。
- **送出內容**：存檔送 `description`、`images`、`cover`，front matter 由服務端維護。文章的請求不變。
- **衝突**：貼圖用簡化對話框，選項是「載入最新版本」或「另存我的文字」。文章的 Markdown 比對合併不適用於圖片清單。

### QC-048

- **匯入任務的錯誤細節**：
  - 沒有錯誤代碼時，原因改成通用的「失敗」，不再直接顯示服務端文字。
  - 服務端原文收進共用的「技術細節」，並經 `redactSecrets` 去掉金鑰與權杖。
  - 原本放在 tooltip 的原文已移除。
- **平台版本警告**：
  - 介面依 `code`、`limit`、`actual` 組出三語文案（`warningText`），例如「圖片 10 張，超過參考上限 9 張」「Has 10 images, over the guideline of 9」。
  - 平台預覽頁的警告列會列出每一條警告。
  - 貼圖作品的警告用 `imagesLimit`，所以公眾號以 20 張計。

## 異動檔案

| 檔案 | 用途 |
| --- | --- |
| `apps/mac/src/renderer/ImagePostEditor.tsx` | 貼圖編輯器 |
| `apps/mac/src/renderer/image-post.ts` | 圖片格與平台上限的純規則、`warningText` |
| `apps/mac/src/renderer/work-session.ts` | 草稿加 `images`／`cover`，貼圖與視頻送 `description`；狀態加 `media`、`file` |
| `apps/mac/src/renderer/editor-insert.ts` | `InsertSession` 加 `place` |
| `apps/mac/src/renderer/InsertUI.tsx` | 素材抽屜的 `forPost`（回到預覽、提示文字） |
| `apps/mac/src/renderer/EditorTabs.tsx` | `TabPane` 依類型選編輯器 |
| `apps/mac/src/renderer/LibraryPage.tsx` | 新建選單、類型篩選數量、卡片縮圖、類型空狀態 |
| `apps/mac/src/renderer/PreviewPage.tsx` | 警告依作品類型計算並以三語列出 |
| `apps/mac/src/renderer/ImportsPage.tsx`、`tasks.ts` | QC-048 技術細節 |
| `apps/mac/src/renderer/styles.css` | 新建選單、卡片縮圖、貼圖編輯器 |
| `packages/platform-preview/src/model.ts` | `workType` |
| `packages/i18n/src/catalog/imagePost.ts`（新）、`library.ts`、`format.ts`、`index.ts` | 三語文案；類型名稱；英文平台短名 |
| `apps/mac/test/image-post.test.ts`（新）、`tasks.test.ts` | 單元測試 |
| `e2e/specs/image-post.spec.ts`（新） | e2e |
| `docs/architecture.md` | 「貼圖編輯器（QC-045 前端）」一節 |

## 驗證

- **typecheck**（全部套件加 e2e）、`pnpm -r lint`、根目錄 `eslint .`、`format:check`：全部通過。
- **全倉測試**：867 passed／0 failed／867 total。2026-11-21 08:44:44–08:45:14，負載 3.47→8.29，持有 `qc-fullsuite.lock`。各套件：
  - contracts 21、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20。
  - markdown-editor-web 29、platform-preview 12、mac-server 393、apps/mac 279（新增 14）、agent-sdk 6。
- **e2e**：16 passed／0 failed／16 total（2026-11-21 08:46，負載約 4），其中新增 2 個。
- **單元測試 `image-post.test.ts`**（14 個）：
  - 圖片格規則：插入、插入線拖曳、⌥←→、移除封面退回第一張、重新指定、目前封面。
  - 平台張數：公眾號貼圖 20、視頻號 9，以及依位置判斷超過哪些平台。
  - 標題字數：以 code point 計。
  - QC-048 三語警告文案。
  - 新建選單三項，視頻停用。
  - 對真 mac-server 的 `WorkSession`：
    - 一次存檔寫入圖片、封面、描述，front matter 正確，歷史版本數正確。
    - 重新排序與取消封面後，描述不變。
    - 版本過期時是衝突、不覆蓋；載入最新版本後，草稿變成服務端內容。
    - 文章仍然只寫 Markdown。
- **`tasks.test.ts`**：沒有錯誤代碼時，原因是通用文字，原文只在技術細節裡。
- **e2e `image-post.spec.ts`**：
  1. ⌘N 開新建選單：視頻停用，↓↩ 建立貼圖。接著：
     - 從素材抽屜加 10 張，用檔案上傳 1 張，⌘V 貼上 1 張。
     - 第 10 張起標示「超過視頻號的張數上限」，平台 chip 與提示正確，存檔不受影響。
     - ⌥→ 移動，服務端的順序跟著變；⌫ 移除後「復原」。
     - 標題各平台字數與描述字數；描述存到服務端。
     - 封面選第 3 張，有三種裁切預覽，服務端的封面也更新。
     - 側邊預覽可切換平台。
  2. 用 API 建立 10 張的貼圖，刪掉第 5 張的實體檔後打開：
     - 第 5 張顯示「檔案遺失」；「重新指定」換成另一張後，服務端標回 present。
     - 平台預覽頁從原稿建立視頻號版本：警告是「圖片 10 張，超過參考上限 9 張」，切成英文是「Has 10 images, over the guideline of 9」。
     - 作品庫：類型篩選有數量，卡片的縮圖是封面，並顯示「10 張」；視頻的空狀態與停用的「新建視頻」。
     - 三語與深色截圖。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc045-zh-Hant-1-new-menu.png` | 新建選單（視頻停用） |
| `qc045-zh-Hant-2-editor.png` | 貼圖編輯器：12 張，超過上限的變淡加虛線，平台 chip，側邊小紅書預覽 |
| `qc045-zh-Hans-2-editor.png`、`qc045-en-2-editor.png` | 简体、English |
| `qc045-zh-Hant-3-cover.png` | 封面設置與三種裁切 |
| `qc045-zh-Hant-4-library.png` | 作品庫：類型數量、貼圖縮圖加張數 |
| `qc045-en-5-editor-dark.png`、`qc045-zh-Hant-5-editor-dark.png` | 深色 |
| `qc045-zh-Hant-6-missing.png` | 檔案遺失與重新指定 |
| `qc045-en-7-preview-warnings.png` | QC-048：平台預覽的英文警告 |

## 與原型的差異／待確認

- **畫布讀不到，下列細節是自行決定**：
  - 圖片格每格最小 132px，依寬度自動排列。
  - 側欄有「預覽」「素材」兩個分頁；打開素材抽屜時，它取代整個側欄，並附「回到預覽」。
  - 封面對話框的排版。
- **文章卡片的「文字摘要」沒有做**：作品列表 API 沒有摘要欄位。文章卡片仍顯示類型圖示。要做的話需要後端在列表加摘要。
- **衝突**：貼圖用簡化對話框（載入最新／另存文字），沒有逐段比對合併。「另存我的文字」只複製標題與描述，不複製圖片。
- **新建的預設標題**：仍是「未命名」，沒有依類型區分。

## 已知缺口

- 外部掛載的貼圖，如果 front matter 裡的圖片沒有素材 id，只顯示路徑，不顯示縮圖。後端第 5 節提到這需要另外決定是否註冊成素材。
- 編輯器自己的提示和分頁提示（例如「已經開啟」）都在畫面底部置中，同時出現會重疊（QC-047 已記錄）。
- 切換語言前出現的短暫提示，保持原來的語言（QC-042 已記錄）。
- 標題、描述只有一份共用文案；各平台各自的文字在平台預覽頁的平台版本裡改。`inherit` 的開關介面沒有做，畫板沒有列為貼圖編輯器的狀態。

## NOT_VERIFIED

- 從真的 Finder 拖檔案進圖片格（e2e 只模擬了上傳與貼上）。
- 拖曳排序的插入線：只有規則有單元測試；e2e 用的是鍵盤排序。
- 打包後的 App。
- 外部掛載的貼圖在介面上的樣子：規則與後端都有測試，但沒有截圖。
- VoiceOver。
