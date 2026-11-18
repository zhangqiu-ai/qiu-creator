# QC-027 修正記錄：衝突對話框的版本號

- 日期：2026-11-17
- 執行者：qc-frontend
- 問題：AI 採用遇到 409 時，衝突對話框寫「你的修改基於 r6，伺服器已是 r6」（見 [qc024 截圖 07](qc024-07-conflict.png)）。

## 根因

對話框用 `WorkSession.baseRevision` 顯示「你的修改基於」。但在以下兩種情況，`baseRevision` 在衝突發生時已經被改成伺服器的版本，所以兩邊顯示同一個號碼：

1. **AI 採用（截圖 07 的情況）**：
   - 候選產生後，另一個視窗寫入 r6。
   - 這個視窗沒有未儲存的修改，所以 SSE 的 `work.updated` 被靜默採用，`baseRevision` 變成 r6。
   - 接著按採用，accept 以候選的 `source_revision`（r5）為基準，得到 409。
   - 對話框讀到的 `baseRevision` 已經是 r6。
2. **一般編輯（較少見的時序）**：
   - 伺服器的新版本正在抓取時，使用者開始打字。
   - `remoteRevision` 用 `adopt(work, false)` 保留草稿，但同時把 `baseRevision` 推到新版本。
   - 之後按「比對並合併」，對話框一樣會顯示兩個相同的號碼。

一般編輯的另外兩條路徑本來就正確：儲存時遇到 409，以及有未儲存修改時收到遠端版本，都不會移動 `baseRevision`。

## 修正（只改衝突相關程式）

- `WorkSessionState` 新增 `conflictBase`，記錄衝突開始時草稿真正的基準版本：
  - 儲存 409：送出時帶的 `base_revision`。
  - AI 採用 409，或採用時已經有遠端新版本：候選的 `source_revision`。`acceptAi` 多了這個參數。
  - 比對並合併：`RemoteChange` 新增 `draftBase`，記下收到新版本那一刻草稿的基準；在抓取期間開始打字的情況，是 adopt 之前的版本。
  - 草稿被伺服器版本取代時清掉。
- `ConflictDialog` 改用 `conflictBase`；沒有時才退回 `baseRevision`。

## 測試

- 新增 `apps/mac/test/conflict-base.test.ts`，5 個測試，對真實 mac-server，AI 用注入的假供應商：
  - AI 採用在外部修改被靜默採用之後：base 是 r1，伺服器是 r2，兩者不同。
  - 一般儲存 409。
  - 抓取期間開始打字後按比對並合併。
  - 有未儲存修改時按比對並合併。
  - 從伺服器重新載入後清掉 `conflictBase`。
- `work-management.test.ts` 有一個斷言比對完整的 `remote` 物件，因為形狀多了 `draftBase`，補上這個欄位。斷言沒有放寬。
- 全倉 `pnpm -r --workspace-concurrency=1 test`：534 passed／0 failed／534 total。typecheck 9／9 套件通過；lint 0 錯誤；format 通過。

## Electron 實機

[qc027-verify.mjs](qc027-verify.mjs) 沿用 QC-024 的假 AI 伺服器（[qc024-server.mjs](qc024-server.mjs)）與種子資料，重現截圖 07 的情境：**4／4 通過**，結果在 [qc027-verify-results.json](qc027-verify-results.json)。

1. 產生候選（基於 r1）。
2. 另一個寫入者寫入 r2，編輯器靜默採用。
3. 按採用，衝突對話框顯示「你的修改基於 r1，伺服器已是 r2」，左欄「基於 r1」，右欄「r2」。

截圖：[qc027-01](qc027-01-ai-conflict-revisions.png)。這次 App 跟隨系統主題，所以是深色畫面。

## NOT_VERIFIED

- NOT_VERIFIED：「抓取期間開始打字」這條一般編輯路徑的實機截圖。時序很難穩定重現，只有整合測試覆蓋。
