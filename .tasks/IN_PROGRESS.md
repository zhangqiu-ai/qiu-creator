## QC-059: editor-tabs e2e 游標還原偶發失敗

**Priority:** P2 | **Assignee:** qc-test（診斷）→ qc-bugfix（修正） | **Tags:** M3

2026-11-21 20:30 QC-054 第一次整套 e2e（負載 5.21）：`e2e/specs/editor-tabs.spec.ts:121` 用 ⌘⇧[ 切回分頁後 `source.selectionStart` 期望 11、5 秒內一直是 10。之後單跑 3 次、整套重跑都通過。log 在 `docs/evidence/qc054-e2e-editor-tabs-failure.log`（若已合併）。判斷是產品的游標還原競態還是測試時序，不准加長逾時或重試。

- 2026-11-21 qc-test 診斷：產品競態。游標只在非同步 `selectionchange` 事件時保存，快速切分頁會遺失；3／3 重現、對照 3／3 通過。證據 `docs/evidence/qc059-caret-race.md`。交 qc-bugfix 修產品程式碼。

## QC-057: 設定頁重新設計：每個分類獨立頁面，AI 服務重整並加連線測試

**Priority:** P1 | **Assignee:** qc-prototype（原型）→ qc-frontend ＋ qc-backend（實作） | **Tags:** M3, prototype, frontend, backend

使用者 2026-11-21（附設定頁 AI 服務截圖）：
- 「不要所有設置都堆在一個頁面中來滾動，左側的設置選項各自一個頁面，並且佈局和排版要重新設計得更合理、美觀和優雅。」
- 「AI服務的設置頁面裡的佈局和分類也要重新設計，目前非常不合理，理解起來很困難，還有模型測試聯通等等功能也缺少，要再優化！」

現況問題（總監整理）：外觀／本機服務／備份與還原／AI 服務／文件夾／關於全部在 `SettingsPage.tsx` 一頁捲動，左側只是錨點；AI 服務一張大卡混了「僅本地模型」開關、四個供應商、狀態徽章、撤回確認／刪除密鑰、模型下拉、New API 模型 ID、本地模型、每月提醒金額，層級不清；沒有連線測試。

**步驟一：原型（qc-prototype，新提案 PT；使用者 2026-11-21 授權總監代核准）**
- 設定改成左側導覽＋右側單頁（每個分類一頁，切換不捲動整份；可用 ⌘, 開啟、記住上次分類）。重新設計六個分類的版面與排版，參照 DESIGN.md 與 macOS 系統設定、Raycast、Linear 一類的設定頁（查 qiuge-design `navigation`、`data-display`、`feedback`，引用卡片）。
- AI 服務重新分類，建議結構（原型可調整並說明理由）：
  1. 供應商清單（Gemini／Claude／GPT／New API／本地）：每列顯示狀態（未設定／已設定／連線正常／失敗＋時間）、用途（視頻理解、改寫、標題）、資料送往哪裡。
  2. 單一供應商詳情：金鑰（存入、更換、刪除）、Base URL（New API）、模型選擇（New API 用 QC-054 的線上清單下拉；其他用已知清單＋可重新整理）、**測試連線**按鈕與結果（延遲、可用模型數、錯誤原因）、首次使用告知與撤回。
  3. 「用途對應」：哪個任務預設用哪個供應商／模型（文字改寫、標題、視頻理解），一眼看懂。
  4. 用量與費用：本月估算、每月提醒金額，與供應商設定分開。
  5. 隱私：「僅本地模型」開關與說明。
- 狀態：空狀態（都沒設定）、測試中、測試成功、金鑰無效、連不上、額度不足。三語文案長度都要放得下。

**後端已合併（2026-11-21，6b54beb）**：`POST /api/v1/ai/providers/:provider/test`（owner），四家都探測免費的列模型端點；回 `{ok, latency_ms, model_count, text_model_listed, error, tested_at}`，失敗也 200＋ok:false；新增 reason `quota`（402 或提到額度的 429）；不保存上次結果；api-client `ai.testProvider()`。

**原型已核准（2026-11-21）**：PT-20261121-002 由總監代核准（畫布上傳失敗，依帳本核准，見 `approvalCaveat`）。AI 服務改四分頁（供應商、用途、用量、隱私），供應商清單＋詳情雙欄。後端補：`last_test` 保存、429 分 quota／rate_limited、`GET/PUT /ai/defaults`、usage `unpriced_jobs`、New API Base URL 顯示與 `base_url_host`。三家線上模型清單不在本次範圍。

**步驟二：實作（核准後）**
- 後端：`POST /api/v1/ai/providers/:provider/test`（owner），用 Keychain 金鑰在 Mac 端做**不產生內容費用**的探測（優先列模型清單端點；New API 用 `/models`），回傳 ok、延遲、模型數、錯誤碼；金鑰不出 Mac、不進日誌；假服務測試。測試連線只在使用者按下時發出。
- 前端：照核准原型重做設定頁與 AI 服務；QC-054 的模型下拉元件沿用。e2e、三語截圖。
- 不改已存的金鑰與設定資料格式；若要遷移偏好設定，要相容舊值。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
