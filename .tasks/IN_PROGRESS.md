## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。

## QC-094: 安裝時附帶 creatorhub CLI，MCP 設定帶真實路徑

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-091 驗收發現：打包安裝不含 `creatorhub` CLI，「複製 MCP 設定」只能給文件範例路徑，Agent 實際無法連線。installer 安裝服務時一併安裝建置好的 CLI（固定路徑、用同一個 Node runtime），App 的「複製 MCP 設定」帶出真實的命令路徑；發版前檢查要驗證這條路徑可啟動 `creatorhub mcp`。QC-093 依賴這張。

