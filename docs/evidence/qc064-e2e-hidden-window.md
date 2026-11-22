# QC-064 e2e 視窗完全不出現在螢幕上

- 日期：2026-11-21。執行者：qc-test。基準：origin/main `441c523`。
- 使用者回報：QC-060 之後，測試視窗雖然不搶焦點，仍以 `showInactive()` 畫在螢幕上，蓋住使用者的視窗。
- QC-060 的驗收只量「前景 App」，沒量「螢幕上有沒有視窗」。

## 做法（選定方案）

背景模式（`CREATORHUB_E2E_BACKGROUND=1`）下，`apps/mac/src/main/main.ts` 做了三件事：

- **視窗從不顯示**：不呼叫 `show()` 或 `showInactive()`。既然不在螢幕上，就不會蓋住其他視窗，也不會攔截滑鼠。
- `webPreferences` 加上 `backgroundThrottling: false` 和 `paintWhenInitiallyHidden: true`：隱藏的頁面照常繪製，rAF 與計時器不被節流。
- Playwright 原本就經 CDP 操作、截圖。Playwright 對 Chromium 頁面預設已開啟 focus 模擬，所以 `toBeFocused`、鍵盤輸入不受影響，不需要另外處理。

正式 App 不設這個變數，仍走 `ready-to-show` → `show()`，**行為不變**。

### 沒選的方案

| 方案 | 不選的原因 |
| --- | --- |
| 移到所有螢幕範圍外 | macOS 會把視窗夾回螢幕；多螢幕排列會變；仍是螢幕上的真實視窗 |
| 透明度 0 | 仍會攔截點擊（總監已排除） |
| `offscreen: true` 離屏渲染 | 改變輸入與繪製路徑，和正式 App 差異更大；隱藏視窗已足夠 |

### 打包版（QC-061）

- 這個做法寫在主程序，不在 `electron-entry.mjs`，所以打包版設 `CREATORHUB_E2E_BACKGROUND=1` 時同樣生效。
- 同時併入 qc-frontend 為 QC-061 提供的兩處改動：
  - `main.ts` 讀 `CREATORHUB_E2E_PROFILE` 並設定 userData。
  - fixture 支援 `CREATORHUB_E2E_APP`。
- 打包版實際跑 e2e：`NOT_VERIFIED`（屬 QC-061）。

## 量測方法

- `qc064-winwatch.swift`：每 100 ms 呼叫兩次 `CGWindowListCopyWindowInfo`。
  - `.optionOnScreenOnly`：列出螢幕上的視窗。
  - `.optionAll`：確認測試行程確實存在，避免把「沒有測試在跑」誤判為「視窗不在螢幕上」。
- 只計測試視窗：擁有者是 Electron／qiu-creator，而且執行檔路徑在 `~/code/qiu-creator*` 底下。
  - 這樣會排除使用者正在用的 `/Applications/qiu-creator.app`。量測時它就開在螢幕上（pid 48911），第一版腳本把它誤算進去，已修正。
- 前景 App：每 0.5 秒用 `lsappinfo front` 取樣一次。

## 結果

| 執行 | 建置 | e2e | 測試視窗在螢幕上 |
| --- | --- | --- | --- |
| 對照組：`background-run`＋`sidebar` | origin/main（QC-060，`showInactive`） | 2／2 通過 | **22 次取樣命中**，2 個行程，例如 `bounds X 87 Y 60 W 1266 H 810, alpha 1` |
| 開發：4 個 spec | QC-064 | 8／8 通過 | 0 次 |
| 開發：4 個 spec（影片、主題、貼圖、素材） | QC-064 | 7／7 通過 | 0 次 |
| **驗收：整套 e2e** | QC-064 | **25／25 通過**（1.0 分鐘） | **0 次**（約 550 次取樣；期間出現過 24 個測試 Electron 行程） |

- 驗收時間：2026-11-21 22:19:31 → 22:20:34，負載 3.99 → 6.99。
- 前景 App：120 次取樣，全部是使用者自己的 App（Antigravity 57 次、magpie 64 次），**Electron 0 次**。
- 截圖：`QC047_SHOTS` 在隱藏視窗下照常產生 1440×900 的截圖，深色與三種語言都正確（QC-061 截圖可用）。
- 沒有放寬任何斷言，也沒有加長逾時或加重試。

### 改動的測試

`background-run.spec.ts`：

- `windowVisible` 的期望從 `true` 改成 `false`。這是新行為本身，不是放寬斷言。
- 新增斷言：隱藏的視窗裡 rAF 仍連續觸發 3 幀。游標與捲動還原都依賴 rAF。

## 量測中的意外

- 22:16 開發跑測時，`qiu-creator-qc061-be` worktree 正在跑**整套** e2e（pid 44734），它的測試視窗出現在螢幕上 40 次取樣。
- 這違反 QC-064 修好前「暫停整套 e2e」的規定，已即時回報總監。
- 驗收那一輪開始前確認過沒有其他 e2e 或 Electron 測試行程；驗收期間的總命中數是 0。

## 驗證範圍

- `pnpm --filter @qiu-creator/mac typecheck`、`lint`：通過。
- `tsc -p e2e/tsconfig.json`：通過。
- e2e：整套 25／25 通過。
- 根目錄 `eslint .`：30 個錯誤，**都已存在於 origin/main**，與本次無關（對照組相同）：
  - `e2e/specs/ai-workbench.spec.ts`
  - `e2e/specs/library-actions.spec.ts`
  - `e2e/specs/settings-v4.spec.ts`
- 沒有跑 `pnpm test` 的各套件單元測試：只改了 Mac 主程序在 e2e 模式下的分支和 e2e 檔，單元測試不涵蓋這部分。
