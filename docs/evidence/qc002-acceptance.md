# QC-002 驗收記錄：Electron Mac 最小工程與編輯器（M0 前端）

日期：2026-11-16　分支：`feat/qc002-mac-app`　執行：qc-frontend（Claude Opus 5.5）

驗收層級：DESIGN.md 層級 3（新頁面、共用元件與主題、導航外殼）。第一期只做 Mac，iPhone／iPad 不在範圍。

## 版面依據

作品庫、編輯頁、版本衝突三個畫面照已核准原型 PT-20261116-001（使用者 2026-11-16 核准，視覺方向「暖白克制」）的 `Main`、`MacEditor`、`MacConflict` 畫板實作。程式碼依畫板重寫，沒有從畫布 HTML 複製。

**對齊的部分**
- 左側導航（窄視窗低於 1180px 時收成圖示列），底部顯示服務狀態。
- 作品庫：標題、數量、搜尋（⌘F）、網格／列表切換、新建（⌘N）；類型分段和帶數量的狀態篩選；網格卡片和列表表格。狀態包括載入骨架、空白庫、本機服務未回應、無符合作品加清除篩選。
- 編輯頁：返回、標題、儲存狀態標籤、`r{n}`、字數、視覺／原始碼（⌘/）、歷史面板；正文採 680px 閱讀欄，原始碼模式採 760px 等寬欄。儲存失敗時顯示「服務未回應，修改保留在此視窗」橫幅加重試。
- 版本衝突：遮罩對話框，左右並排「你的修改」與伺服器版本，可「查看差異」（刪除／新增標示）、「保留雙方」、「手動合併」（逐處選我的或伺服器，可直接改結果），解決後顯示結果，再按「返回編輯」。

**刻意的偏差**
- 導航只放作品庫。素材庫、匯入任務、AI 工作台、平台預覽、設定屬其他任務，依總監指示不做，也不放沒有目的地的連結。
- 編輯頁沒有 AI 面板與「預覽」按鈕（AI、平台預覽不在範圍）；版本歷史唯讀，沒有「恢復為新版本」（恢復屬 M2）。
- 卡片封面：契約還沒有封面素材，用中性色底加類型圖示佔位；原型的色塊也只是佔位。
- 衝突對話框的伺服器端標成「伺服器上的版本」並顯示修改時間。原型寫「磁碟上的版本」並標出來源（例如外部編輯器）；服務目前不回傳是哪個程式改的，所以沒有來源標籤。
- 空白庫只提供「新建」；「匯入」「掛載資料夾」屬 M1。
- 「檔案已在外部修改」橫幅需要變更事件（SSE，M1），目前要在儲存時收到 409 才會進入衝突處理。
- 色值仍是語義 token 的佔位值（系統預設色），等原型設計會話把正式值寫進 DESIGN.md「視覺基線」並合併後再替換。token 結構已補上原型需要的 sunken、各狀態的 soft 色與 scrim。字體用系統字體，因為 CSP 不載入外部字型。

## 環境

- macOS（Apple Silicon），Node 24.14.0，pnpm 12.21.0，Electron 45.3.2。
- 資料目錄：`mktemp -d` 建的臨時 `CREATORHUB_HOME`，用完已刪除；未讀寫 `~/CreatorHub`。
- mac-server：`node --import tsx src/main.ts`（127.0.0.1:7420）。App：`node apps/mac/scripts/dev.mjs --remote-debugging-port=9333`（Vite 5180）。視窗以 1440 寬驗收，窄視窗以 1000 寬驗收。
- 合成內容：`packages/markdown-editor-web/test/fixtures/` 的三份文件（結構齊全的旅行筆記、120 節中文長文、含 HTML／腳註／參照連結的文件）。

## 實機驗收方式

本機的 computer-use 缺少 macOS「螢幕錄製」權限，無法用滑鼠鍵盤操作。改用 Chrome DevTools Protocol 驅動**真實的 Electron 視窗**（`qc002-cdp.mjs`、`qc002-verify.mjs`）：

- 中文輸入法用 `Input.imeSetComposition`（Chromium 真實的組字路徑，會觸發 `compositionstart/update/end` 與 `isComposing`），依序送出 `z → zh → zhong → 中`，再用 `Input.insertText` 提交。
- 快捷鍵用 `Input.dispatchKeyEvent`（⌘S、⌘Z、⇧⌘Z、⌘/）。
- 結果以伺服器 API 與磁碟上的 `source.md` 核對，不只看畫面。

**限制**：沒有用實體鍵盤搭配 macOS 注音／拼音輸入法實際打字。CDP 的組字事件和系統輸入法走同一條 Chromium 路徑，但候選視窗位置、系統輸入法特有的行為（連續選字、Shift 切換中英）沒有驗證，標為 `NOT_VERIFIED`。建議使用者拿到後用實體鍵盤試打一次。

## 結果（40／40 通過，見 `qc002-verify-results.json`）

| 項目 | 證據 |
| --- | --- |
| 作品庫網格與列表都列出全部作品 | `qc002-01-library-grid.png`、`qc002-02-library-list.png` |
| 狀態篩選沒有結果時顯示「無符合作品」，可清除篩選 | `qc002-03-library-empty-filter.png` |
| 搜尋：組字期間不送出，提交後才搜尋 | — |
| 窄視窗（1000 寬）時導航收成 60px 圖示列 | `qc002-04-library-narrow.png` |
| 打開文件不產生新版本；標題列顯示 r1 與字數 | `qc002-05-editor.png` |
| 視覺模式：組字期間不儲存（包括按 ⌘S、等超過自動儲存延遲） | `qc002-06-ime-composing.png` |
| 提交後才儲存，狀態回到「已儲存」，游標停在新字之後 | — |
| ⌘Z 撤銷、⇧⌘Z 重做，磁碟內容一致 | — |
| 標題欄：組字期間不儲存，提交後儲存 | — |
| ⌘/ 在視覺與原始碼之間切換 | — |
| 版本歷史列出全部版本與 r 編號（唯讀） | `qc002-07-history.png` |
| Agent 先透過 API 寫入後，App 儲存收到 409：開啟衝突對話框，伺服器內容未被覆蓋，雙方並排，背後的編輯器不可操作 | `qc002-08-conflict.png` |
| 查看差異：刪除與新增標示 | `qc002-09-conflict-diff.png` |
| 保留雙方：我的草稿另存為「（我的修改）」，原作品顯示伺服器版本 | `qc002-10-conflict-done.png` |
| 手動合併：逐處選擇（標題取我的、末段取伺服器），寫回的內容正確 | `qc002-11-conflict-merge.png` |
| 含特殊語法的文件預設進原始碼模式，切到視覺前要確認 | `qc002-12-lossy-source-mode.png`、`qc002-13-lossy-confirm.png` |
| 原始碼模式：組字期間不儲存；存檔結果等於原文逐位元組加上插入的文字 | — |
| 中文長文（約 3.3 萬 px 高）可捲到底；每步一幀，p50 約 16ms、p95 約 19ms | `qc002-14-long-bottom.png` |
| 深色外觀套用深色 token | `qc002-15-editor-dark.png`、`qc002-16-library-dark.png` |
| 服務沒啟動時顯示「本機服務未回應」與位址，服務啟動後按重試即連上 | `qc002-17-service-down.png`、`qc002-18-retry-connected.png` |
| 關閉視窗、結束 Electron 後，服務的 `/health`、列表、建立作品都照常 | `qc002-close-window.txt` |

## Markdown 往返（自動測試）

`packages/markdown-editor-web/test/roundtrip.test.tsx` 在 jsdom 裡掛載真實的 MDXEditor（外掛組合和正式環境相同），流程是：讀入 → 匯出 → 編輯 → 匯出 → 再讀入。fixture 涵蓋標題、巢狀清單、編號清單、引用、對齊表格、程式碼區塊、行內程式碼、帶標題的連結、遠端圖片、相對路徑圖片、分隔線、中文長文。

- 主要結構（mdast 樹，去掉位置與清單鬆緊）完全一致；再讀入的結果穩定，不會漂移。
- 視覺模式會正規化的寫法：表格分隔列 `---` 變成 `-`（對齊保留，資料列不動），以及清單內縮。原稿如果用 `*` 寫清單，會改成 `-`。這些只在使用者於視覺模式**實際編輯**後才寫回，只打開不會寫。

## 未驗證（NOT_VERIFIED）

- 用實體鍵盤搭配 macOS 系統輸入法（注音、拼音）手動打字，原因見上方「限制」。
- 圖片顯示：相對路徑 `./assets/…` 和托管素材還沒有對應的 URL，所以視覺模式顯示破圖佔位。圖片語法本身的往返有自動測試保留。
- VoiceOver 實際朗讀：已加 `aria-label`／`role`／`aria-pressed`、對話框 `aria-modal`，背景設為 `inert`，但沒有開 VoiceOver 實測。
- 正式色值：等 DESIGN.md「視覺基線」合併後替換，屆時要再和原型做同狀態比對。
- 打包後（`file://` 加 meta CSP）的執行：沒有跑 electron-builder（屬發版範圍）。`corepack pnpm --filter @qiu-creator/mac build` 可以成功建置，CSP meta 也已寫入，但沒有用建置產物啟動驗收。

## 設計參考

- 已核准原型 PT-20261116-001：`Main`、`MacEditor`、`MacConflict` 畫板（見上方「版面依據」）。
- `/Users/feature/code/qiuge-design/cases/kami-content-first-document-hierarchy/case.md`（kind: product）：借鑑「用字級、間距和淡分隔線交代層級，少用裝飾」。編輯區的閱讀欄、標題字級與段距照原型落實，介面只用分隔線和底色區分層級。
- `/Users/feature/code/qiuge-design/cases/kubai-ai-writing-panel/case.md`（kind: concept，未經上線驗證）：本任務不做 AI，沒有直接採用。它「原文與建議對照、操作集中在一處」的做法和原型的衝突對話框一致：雙方並排，操作集中在對話框底部。
