## QC-111: 簡繁轉換誤轉使用者原文（QC-103 缺陷，擋 QC-110 發版）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** backend

QC-110 發現：`TextScriptService.forAgent` 把 Agent 送來的整份文字都轉換，沒有區分使用者原有的文字和 Agent 新寫的文字。Agent 對繁體文章只改一行的提案，會把標題和其他段落也改成簡體；`PATCH /works/:id`（`work_update_body`、`work_update_meta` 整份正文與整份標籤）和平台版本同樣有風險，違反「使用者自己的文字不轉」。應只轉 Agent 相對目前版本新增或修改的文字，以及新增的標籤。e2e 有 3 個失敗：`agent-proposals.spec.ts:62` 是這個缺陷；`agent-attached-media.spec.ts:24`、`agent-proposals.spec.ts:336` 是 Agent 新建作品用繁體標題、照新規則本來就該轉成簡體，屬行為變更，需要更新測試的設定或預期，並寫明理由。

**Started:** 2026-11-26

## QC-110: 發版前檢查與升級（QC-102～104）

**Priority:** P1 | **Assignee:** qc-test, qc-release | **Tags:** M3

qc-test 在 main（66068e9 之後）跑一般與 `QC_E2E_MOTION=on` 兩種模式全套 e2e，加上 Agent 經 MCP 建貼圖／視頻作品並掛附件、繁體文字被轉成簡體的端到端檢查（臨時資料目錄）。第一輪（a057917）不可發版：QC-103 誤轉原文，開 QC-111；修好後重跑。通過後 qc-release 升級本機安裝（含 migration 0023，升級前備份），總監複核 /health。

**Started:** 2026-11-26

## QC-106: 項目內作品分組／系列（原型）

**Priority:** P2 | **Assignee:** qc-prototype | **Tags:** prototype

使用者 2026-11-26 要求：項目裡的作品要能分組、成系列，不要全部混在一起。先做原型給使用者核准，再開後端和前端的實作任務。原型要回答這些問題：分組和系列是不是同一個概念、作品能不能同時屬於多個分組、系列要不要排序或集數、要不要支援巢狀、怎麼和項目規則與自動歸類搭配、MCP 怎麼讓 Agent 建立和使用分組。

**Started:** 2026-11-26

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
