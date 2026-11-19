# QC-040 驗收記錄：編輯頁捲動時內容被遮擋

日期：2026-11-19　分支：`fix/qc040-editor-scroll`（從 origin/main `8d4e9af` 開）

## 原因

- `.editor__body` 是 `flex-wrap: wrap` 加 `overflow: auto`，整個區域是一個捲動容器，正文和 AI 面板都放在裡面。
- `.panel` 沒有高度上限。候選一長，面板就把那一行撐得比視窗高，在面板上捲動時捲的是外層的 `.editor__body`。
- 外層一捲，正文欄（含 sticky 的工具列，它只對正文欄自己的捲動有效）和 AI 分頁列一起被推到標題列下方。結果是內容頂部被截掉，正文甚至整欄消失（截圖 01）。

## 修法（只改 `apps/mac/src/renderer/styles.css`）

- `.editor__body` 改成 `overflow: hidden`，本身不再捲動。正文欄 `.editor__doc` 與側欄 `.panel` 各自 `overflow: auto`，並加上 `min-height: 0`，讓兩欄的高度都限制在編輯區內。
- 正文工具列維持原本的 sticky。AI 分頁列 `.ai__tabs` 和歷史面板標頭 `.panel__head` 改成 sticky，面板捲動時固定在上方。
- 窄視窗：`<main class="editor">` 設成 container（`editor`）。編輯區寬度小於 820px（兩欄放不下）時改成上下排列：正文佔剩下的高度，面板最高 45%，兩者各自捲動。判斷依據是編輯區自己的寬度，不是整個視窗的寬度。

## 自動測試

`e2e/specs/editor-scroll.spec.ts`（Playwright，跑真的 Electron、真的服務和假 AI 上游）：

- 測試內容是 24 節的長文，加上一份有幾十個差異段落的候選。
- 用滑鼠滾輪捲動正文與 AI 面板，之後檢查：
  - `.editor__body` 的 `scrollTop` 一直是 0。
  - 正文欄位於狀態列之下、視窗之內。
  - 工具列在正文欄內；工具列正下方的元素屬於正文。
  - AI 面板與分頁列都在視窗內，面板可以捲到最後一個差異段落。
- 涵蓋視覺模式、原始碼模式，以及 1000×800 與 760×800 兩種窄視窗。
- 修正前執行會失敗（`.editor__body` 的 `scrollTop` 是 1500），修正後通過。

設定 `QC040_SHOTS=<dir>` 時，測試會同時存下截圖。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc040-01-before-visual-scrolled.png` | 修正前：在 AI 面板上捲動，整個編輯區被捲上去，正文欄消失 |
| `qc040-02-after-visual-scrolled.png` | 修正後：視覺模式，工具列與 AI 分頁列固定，兩欄各自捲動 |
| `qc040-03-after-source-scrolled.png` | 修正後：原始碼模式 |
| `qc040-04-after-narrow-1000.png` | 修正後：1000 寬，仍是兩欄 |
| `qc040-05-after-narrow-760.png` | 修正後：760 寬，上下排列，面板限高，採用列可見 |

## 驗證

- `pnpm -r typecheck`：通過。`tsc -p e2e/tsconfig.json`：通過。
- `pnpm -r lint` 與根目錄 `pnpm lint`：0 錯誤。`pnpm format:check`：通過。
- `pnpm test:e2e`：2 passed／0 failed／2 total（`editor-scroll`、`new-api`），期間持有 e2e 鎖。
- 全倉 `pnpm -r --workspace-concurrency=1 --no-bail test`：**660 passed／0 failed／660 total**。
  - 執行時間 2026-11-19 07:05:21–07:05:42。負載開始 3.81、結束 5.53，期間持有全倉測試鎖。
  - 各套件：contracts 16、design-tokens 5、domain 27、installer 39、markdown-editor-web 22、api-client 16、platform-preview 12、mac-server 344、apps/mac 173、agent-sdk 6。

## NOT_VERIFIED

- 歷史面板捲動時標頭固定：只套用了同樣的 sticky 規則，沒有寫自動測試。
- 觸控板的慣性捲動：只用滑鼠滾輪事件驗證。
