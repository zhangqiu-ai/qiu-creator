## QC-102: Agent 掛到貼圖／視頻作品的附件，編輯頁看不到

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** backend, frontend

使用者 2026-11-26 用 Gemini、Claude Code Agent 經 MCP 建立兩個作品：文字有了，圖片和視頻只進了素材庫，作品編輯頁顯示「圖片 0」「尚未選擇視頻」「暫無封面」。服務日誌顯示 `POST /api/v1/works/:id/assets`（MCP `work_attach_asset`，不帶 copy_into_work）對貼圖作品 f70a1bed… 連打 5 次、視頻作品 f3a98acb… 打 2 次，都回 200。推測：連結寫進 work_assets 表，但貼圖／視頻編輯頁和作品卡讀的是另一份資料（作品自己的媒體清單），兩者不同步。修好後 Agent 照工具說明操作，App 必須看得到；同一根因的 API／MCP 說明一併修。

**Started:** 2026-11-26

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
