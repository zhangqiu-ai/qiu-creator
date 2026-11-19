# In Progress

## QC-032: 打包與安裝腳本

**Priority:** P1 | **Assignee:** qc-release | **Tags:** M3

QC-004 拆出。electron-builder 設定（未簽名 .app 裝 `/Applications`）；安裝／升級／解除安裝腳本：服務建置產物複製到 `~/Library/Application Support/qiu-creator/server`、渲染並載入 launchd plist、升級前自動備份、失敗可回到上一版。依賴記入 `docs/dependencies.md`。**試打包與真實安裝都要使用者明確要求後才做。**

**Started:** 2026-11-18（使用者「Start packaging」授權開工與試打包；真實安裝另行確認）
