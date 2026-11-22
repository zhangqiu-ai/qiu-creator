## QC-060: 端到端測試在背景執行，不搶前景與焦點

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M3

使用者 2026-11-21：「端到端測試的時候能不能在後台不要在前台，這樣會影響我操作電腦幹其它事情。」
- 原因：`apps/mac/src/main/main.ts` `createWindow()` 在 `ready-to-show` 時 `win.show()`，Playwright 每次啟動 Electron 都會把視窗帶到前景、搶焦點、出現在 Dock。
- 做法（僅測試模式，以 `CREATORHUB_E2E_PROFILE` 或專用旗標判斷，正式 App 行為不變）：`app.setActivationPolicy('accessory')`／`app.dock.hide()` 不出現在 Dock 與 ⌘Tab；視窗用 `showInactive()` 或維持隱藏＋`paintWhenInitiallyHidden`，不取得焦點、不啟用 App；必要時放到螢幕外。確認 Playwright 的點擊、鍵盤（含 ⌘ 快捷鍵與選單）、截圖、`focus`／`visibilitychange` 相關測試（QC-055 的 watchAiStatus）在不搶焦點下仍正確，不能靠放寬斷言或加逾時。
- 檔案選擇器、原生對話框、Finder 等若會跳到前景，也要改成測試模式下的假實作或不觸發。
- 驗收：整套 e2e 跑完期間，前景 App（例如使用者的瀏覽器）焦點不被搶走；附測試前後 `osascript` 取前景 App 的記錄。
- 規則：共用規則加一條「e2e 一律背景執行，不得搶前景」。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
