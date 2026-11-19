

## QC-036: 安裝器升級時 launchd bootout／bootstrap 競態

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M3, bug | **Started:** 2026-11-19

使用者要求升級到 e8aefb1，兩次都在 `launchctl bootstrap` 回 `5: Input/output error`，自動回滾成功，資料未動（證據分支 `release/qc033-upgrade2`）。launchd 日誌顯示 `bootout` 送出 SIGTERM 就回傳，服務約 20 ms 後才 removed；`packages/installer/src/ops.ts` 在 bootout 後立刻 bootstrap。修法：bootout 後等服務確實移除（有上限）再 bootstrap，並補假 launchctl 延遲移除的測試。
