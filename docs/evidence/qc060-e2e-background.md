# QC-060 e2e 在背景執行驗收

日期：2026-11-21　分支：`fix/qc060-e2e-background`

## 改了什麼

- `CREATORHUB_E2E_BACKGROUND=1`（只由 e2e fixture 設定）時，`apps/mac/src/main/main.ts`：
  - `app.setActivationPolicy('accessory')` 加 `app.dock.hide()`：不在 Dock、不在 ⌘Tab。
  - `ready-to-show` 用 `showInactive()`，不取得焦點、不啟用 App。
  - 選檔、選資料夾的原生對話框直接回「沒選」；「在 Finder 顯示」與開外部連結不實際執行。
- 沒有設這個變數的正式 App 走原本的程式碼路徑，行為不變。
- 新增 `e2e/specs/background-run.spec.ts`：Dock 隱藏、視窗可見但未取得焦點、選資料夾立即回 null。

## 焦點觀測

`docs/evidence/qc060-focus-watch.sh` 在指令執行期間每 0.25 秒用 `osascript` 記錄最前面的 App 與 Electron 行程的 `background only`。

| 紀錄 | 內容 |
| --- | --- |
| `qc060-focus-before.txt`（對照）| 關掉背景模式（變數設 0）、只跑 `settings-theme`：最前面的 App 兩次變成 `Electron`，執行後最前面變成 Antigravity。這是焦點被搶走的證據。 |
| `qc060-focus-after.txt`（背景模式，整套 e2e）| 25 個測試，約 1 分鐘：`front=Electron` 0 次；Electron 行程 `background only = true`。 |

after 紀錄裡最前面的 App 從 iPhone Mirroring 換成 Antigravity、再換成 Claude，是使用者自己在切換，沒有一筆是 Electron。所以「執行前後最前面 App 相同」在使用者同時操作電腦時看不出來，以 `front=Electron` 次數為準。

## 驗證

- 全部 e2e：25 passed／0 failed／25 total（含點擊、鍵盤、⌘ 快捷鍵、選單、截圖、QC-055 的 focus 事件案例），沒有放寬斷言、沒有加長逾時。
- `pnpm -r typecheck`、e2e `tsc`、`pnpm -r lint`、prettier：通過。
- 全倉測試：991 passed／0 failed，負載約 9。

## NOT_VERIFIED

- 真實使用者按鍵與滑鼠進入視窗（背景模式的視窗不是 key window，Playwright 走 CDP 輸入，所以不受影響）。
- 正式 App 的 Dock 與焦點行為：沒有改動，也沒有重新打包驗證。
