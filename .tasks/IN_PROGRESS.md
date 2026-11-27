## QC-114: 項目分組與系列（Mac 介面）

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** frontend

依已核准原型 PT-20261126-002 方案 A 實作項目頁分段：未分組在上、段首折疊與 sticky、「⋯」選單、當作系列與「第 N 集」、列表「集」欄、拖曳歸組（插入線、多選、Esc、減少動態效果）、右鍵「移到分組」子選單與新建分組、「全部作品」卡片的「› 分組 #集數」、Agent 建立分組的標記。依賴 QC-113 的 API。

**Started:** 2026-11-27

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
