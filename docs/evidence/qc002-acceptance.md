# QC-002 驗收記錄：Electron Mac 最小工程與編輯器（M0 前端）

日期：2026-11-16　分支：`feat/qc002-mac-app`　執行：qc-frontend（Claude Opus 5.5）

驗收層級：DESIGN.md 層級 3（新頁面、共用元件與主題、導航外殼）。第一期只做 Mac，iPhone／iPad 不在範圍。

## 環境

- macOS（Apple Silicon），Node 24.14.0，pnpm 12.21.0，Electron 45.3.2。
- 資料目錄：`mktemp -d` 建的臨時 `CREATORHUB_HOME`，用完已刪除；未讀寫 `~/CreatorHub`。
- mac-server：`node --import tsx src/main.ts`（127.0.0.1:7420）。App：`node apps/mac/scripts/dev.mjs --remote-debugging-port=9333`（Vite 5180）。
- 合成內容：`packages/markdown-editor-web/test/fixtures/` 的三份文件（結構齊全的旅行筆記、120 節中文長文、含 HTML／腳註／參照連結的文件）。

## 實機驗收方式

本機的 computer-use 缺少 macOS「螢幕錄製」權限，無法用滑鼠鍵盤操作。改用 Chrome DevTools Protocol 驅動**真實的 Electron 視窗**（`qc002-cdp.mjs`、`qc002-verify.mjs`）：

- 中文輸入法用 `Input.imeSetComposition`（Chromium 真實的組字路徑，會觸發 `compositionstart/update/end` 與 `isComposing`），依序送出 `z → zh → zhong → 中`，再用 `Input.insertText` 提交。
- 快捷鍵用 `Input.dispatchKeyEvent`（⌘S、⌘Z、⇧⌘Z）。
- 結果以伺服器 API 與磁碟上的 `source.md` 核對，不只看畫面。

**限制**：沒有用實體鍵盤搭配 macOS 注音／拼音輸入法實際打字。CDP 的組字事件和系統輸入法走同一條 Chromium 路徑，但候選視窗位置、系統輸入法特有的行為（連續選字、Shift 切換中英）沒有驗證，標為 `NOT_VERIFIED`。建議使用者拿到後用實體鍵盤試打一次。

## 結果（25／25 通過，見 `qc002-verify-results.json`）

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| 打開文件不產生新版本 | 通過 | `qc002-01-visual-editor.png` |
| 視覺模式：組字期間不儲存（包括按 ⌘S、等超過自動儲存延遲） | 通過 | `qc002-02-ime-composing.png`（「中」正在組字，狀態仍是已儲存） |
| 提交後才儲存，游標停在新字之後 | 通過 | `qc002-03-ime-committed.png` |
| ⌘Z 撤銷、⇧⌘Z 重做，磁碟內容一致 | 通過 | — |
| 標題欄：組字期間不儲存，提交後儲存 | 通過 | — |
| 版本歷史列出全部版本（唯讀） | 通過 | `qc002-04-history.png` |
| Agent 先透過 API 寫入，App 再儲存時收到 409：顯示「版本衝突」、草稿保留、伺服器內容未被覆蓋 | 通過 | `qc002-05-conflict.png` |
| 查看差異同時顯示雙方內容 | 通過 | `qc002-06-diff.png` |
| 另存新作品，雙方都保留 | 通過 | — |
| 含特殊語法的文件預設進原始碼模式，切到視覺前要確認 | 通過 | `qc002-07-lossy-source-mode.png`、`qc002-08-lossy-confirm.png` |
| 原始碼模式：組字期間不儲存；存檔結果等於原文逐位元組加上插入的文字 | 通過 | — |
| 中文長文（約 2.7 萬 px 高）可捲到底；每步一幀，p50 15.5ms、p95 19ms、最大 30ms | 通過 | `qc002-09-long-bottom.png` |
| 深色外觀套用深色 token | 通過 | `qc002-10-dark.png` |
| 服務沒啟動時顯示「服務未運行」，服務啟動後按重試即連上 | 通過 | `qc002-11-service-down.png`、`qc002-12-retry-connected.png` |
| 關閉視窗、結束 Electron 後，服務的 `/health`、列表、建立作品都照常 | 通過 | `qc002-close-window.txt` |

## Markdown 往返（自動測試）

`packages/markdown-editor-web/test/roundtrip.test.tsx` 在 jsdom 裡掛載真實的 MDXEditor（外掛組合和正式環境相同），流程是：讀入 → 匯出 → 編輯 → 匯出 → 再讀入。fixture 涵蓋標題、巢狀清單、編號清單、引用、對齊表格、程式碼區塊、行內程式碼、帶標題的連結、遠端圖片、相對路徑圖片、分隔線、中文長文。

- 主要結構（mdast 樹，去掉位置與清單鬆緊）完全一致；再讀入的結果穩定，不會漂移。
- 視覺模式會正規化的寫法：表格分隔列 `---` 變成 `-`（對齊保留，資料列不動），以及清單內縮。原稿如果用 `*` 寫清單，會改成 `-`。這些只在使用者於視覺模式**實際編輯**後才寫回，只打開不會寫。
- 實機在視覺模式編輯一次後，比對版本快照，磁碟上的差異只有表格分隔列和新增的文字。

## 未驗證（NOT_VERIFIED）

- 用實體鍵盤搭配 macOS 系統輸入法（注音、拼音）手動打字，原因見上方「限制」。
- 圖片顯示：遠端範例網址連不到，相對路徑 `./assets/…` 也還沒有對應的素材 URL，所以視覺模式顯示破圖佔位。圖片語法本身的往返有自動測試保留。對應到 `/api/v1/assets/:id/stream` 留給後續任務。
- VoiceOver 實際朗讀：已加 `aria-label`／`role`，但沒有開 VoiceOver 實測。
- 正式視覺：原型 PT-20261116-001 還在等使用者核准，目前是系統預設樣式加 token 佔位，沒有和原型比對。
- 打包後（`file://` 加 meta CSP）的執行：沒有跑 electron-builder（屬發版範圍）。`corepack pnpm --filter @qiu-creator/mac build` 可以成功建置，CSP meta 也已寫入，但沒有用建置產物啟動驗收。

## 設計參考

- `/Users/feature/code/qiuge-design/cases/kami-content-first-document-hierarchy/case.md`（kind: product）：借鑑「用字級、間距和淡分隔線交代層級，少用裝飾」。調整：編輯區限制閱讀行寬（44em）、行高 1.75；介面只用分隔線和底色區分側欄、標題列與內文，不加裝飾色。視覺基線還沒核准，這些數值都是佔位。
- `/Users/feature/code/qiuge-design/cases/kubai-ai-writing-panel/case.md`（kind: concept，未經上線驗證）：本任務不做 AI，沒有直接採用。它「原文與建議對照、操作集中在一處」的做法用在衝突處理：「查看差異／另存新作品／重新載入」集中在同一列，差異檢視用 −／＋ 標出雙方。
