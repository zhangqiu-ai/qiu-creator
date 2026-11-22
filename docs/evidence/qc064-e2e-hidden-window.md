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

### 正式驗收（總監要求重測，2026-11-21 22:30）

- 由腳本等到 1 分鐘負載低於 8、而且沒有其他 e2e 或測試 Electron 行程時才自動開跑。
- 8 個測試跑完後緊接著跑整套。

| 執行 | 時間 | 負載（1 分鐘） | e2e passed／failed／total | 測試視窗在螢幕上（任何 worktree） | 前景 App |
| --- | --- | --- | --- | --- | --- |
| 8 個測試（`background-run`、`sidebar`、`editor-tabs`、`editor-scroll`） | 22:30:20 → 22:30:39 | 7.80 → 7.80 | **8／0／8** | **0 次**（150 次取樣；期間 8 個測試 Electron 行程） | Claude 37 次，Electron 0 次 |
| **整套 e2e** | 22:30:39 → 22:31:44 | 7.80 → 9.41 | **25／0／25** | **0 次**（600 次取樣；期間 26 個測試 Electron 行程） | Claude 68、Antigravity 25、qiu-creator 25、ChatGPT 5 次，Electron 0 次 |

- 前景的「qiu-creator」是使用者已安裝、正在使用的 `/Applications/qiu-creator.app`（pid 48911）。
  - 測試行程的執行檔是 workspace 的 `Electron`，一次都沒有出現在前景。
- 截圖：`QC047_SHOTS` 在隱藏視窗下照常產生 1440×900 的截圖，深色與三種語言都正確（QC-061 截圖可用）。
- 沒有放寬任何斷言，也沒有加長逾時或加重試。

### 對照組

| 執行 | 建置 | e2e | 測試視窗在螢幕上 |
| --- | --- | --- | --- |
| `background-run`＋`sidebar`，22:15，負載約 6 | origin/main（QC-060，`showInactive`） | 2／0／2 | **22 次取樣命中**，2 個行程，例如 `bounds X 87 Y 60 W 1266 H 810, alpha 1` |

### 作廢的量測（照實記錄）

| 時間 | 執行 | 作廢原因 |
| --- | --- | --- |
| 22:16 | 8 個測試，8／0／8；自己的視窗 0 次 | 與 qc-backend 在 `qiu-creator-qc061-be` 跑的整套 e2e 重疊。它的視窗出現在螢幕上 40 次 |
| 22:16 | 影片、主題、貼圖、素材，7／0／7；0 次 | 同一個時段，不採用 |
| 22:19 | 整套 25／0／25；0 次；負載 3.99 → 6.99 | 總監要求整個時段的量測一律重做 |
| 22:21–22:25 | 8 個測試 8／0／8；整套 **23／2／25** | 負載 24 → 41（其他會話的 Xcode 建置、tsc、服務測試），結果不算數。同時 `qiu-creator-qc061` 在舊建置上跑 e2e，它的視窗出現在螢幕上 150 次。自己的視窗兩輪都是 0 次 |

- 22:21–22:25 那輪的兩個失敗：
  - `new-api.spec.ts:12`：整個測試超過 30 秒逾時。
  - `settings-v4.spec.ts:29`：期望看到「正在連線」，但 5 秒內一直是上一次的「連線正常」。
  - 這兩項在 22:30 低負載重跑時都通過了。是否只在高負載下才會失敗，這次沒有另外追查（見下方驗證範圍）。

### 改動的測試

`background-run.spec.ts`：

- `windowVisible` 的期望從 `true` 改成 `false`。這是新行為本身，不是放寬斷言。
- 新增斷言：隱藏的視窗裡 rAF 仍連續觸發 3 幀。游標與捲動還原都依賴 rAF。

## 驗證範圍

- `pnpm --filter @qiu-creator/mac typecheck`、`lint`：通過。
- `tsc -p e2e/tsconfig.json`：通過。
- e2e：整套 25／0／25 通過（22:30，負載 7.80 → 9.41）。
- 高負載下的 `new-api`、`settings-v4` 失敗：`NOT_VERIFIED`。不確定是測試時序還是產品問題，建議另開票，由 qc-test 在低負載下用重現腳本判定。
- 根目錄 `eslint .`：30 個錯誤，**都已存在於 origin/main**，與本次無關（對照組相同）：
  - `e2e/specs/ai-workbench.spec.ts`
  - `e2e/specs/library-actions.spec.ts`
  - `e2e/specs/settings-v4.spec.ts`
- 沒有跑 `pnpm test` 的各套件單元測試：只改了 Mac 主程序在 e2e 模式下的分支和 e2e 檔，單元測試不涵蓋這部分。
