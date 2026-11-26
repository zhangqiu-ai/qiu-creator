## QC-104: 素材庫視頻無法全屏播放

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** frontend

使用者 2026-11-26 回報：素材庫選中視頻後，右側預覽播放器的全屏按鈕點了沒有反應。修好後素材庫、作品編輯頁和平台預覽裡的視頻都要能全屏，按 Esc 能退出。同時注意到素材卡上的視頻沒有縮圖（只有圖示），屬於同一處的話一併修好，不是的話寫在報告裡。

**Started:** 2026-11-26

## QC-103: Agent 寫入作品的文字統一簡繁字體

**Priority:** P2 | **Assignee:** qc-backend | **Tags:** backend

使用者 2026-11-26 反映 Agent 建的作品有時繁體、有時簡體。決策見 `docs/decisions.md` 2026-11-26：預設簡體，全域設定可改繁體，項目可覆寫；MCP 說明與 `server_status` 告知目標字體；Agent 權杖寫入的標題、正文、描述、標籤、平台版本文字由服務端用 OpenCC 轉換並在回應註明；使用者自己的文字與既有作品不動。設定頁與項目設定的介面另開任務給 qc-frontend。

**Started:** 2026-11-26

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據已合併到 main（`docs/evidence/qc033-*`）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
