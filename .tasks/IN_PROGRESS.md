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

**步驟二：實作（核准後）**
- 後端：`POST /api/v1/ai/providers/:provider/test`（owner），用 Keychain 金鑰在 Mac 端做**不產生內容費用**的探測（優先列模型清單端點；New API 用 `/models`），回傳 ok、延遲、模型數、錯誤碼；金鑰不出 Mac、不進日誌；假服務測試。測試連線只在使用者按下時發出。
- 前端：照核准原型重做設定頁與 AI 服務；QC-054 的模型下拉元件沿用。e2e、三語截圖。
- 不改已存的金鑰與設定資料格式；若要遷移偏好設定，要相容舊值。

## QC-055: 作品編輯頁視頻 AI 誤報「尚未設定 Gemini 金鑰」

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M3, bug, frontend

使用者 2026-11-21 授權：與 QC-052／054 一起驗收後直接發版安裝（「一起發版」）。
使用者 2026-11-21 截圖：AI 工作台用 Gemini 分析同一支視頻成功（19:54，$0.0036），但作品編輯頁的視頻 AI 理解面板仍顯示「尚未设置 Gemini 密钥／前往设置」。
- 總監初查（假設，待證實）：`apps/mac/src/renderer/ai-video.ts` 的 `loadProvider()` 只在建立 session 時讀一次 providers，`noKey` 一旦為 true 就不會重設；`ai_key_missing` 也會把它設成 true。分頁由 QC-047 恢復，金鑰在分頁開啟後（19:31）才存入，於是一直停在舊狀態。另查：工作台與編輯頁是否用不同的 provider 狀態來源、consent 是否也有同樣的不同步。
- 修法方向：金鑰、consent、模型設定變更時（變更事件或設定頁儲存後）兩處都要重新讀取；視窗回到前景或面板重新顯示時也要重讀；`noKey` 由最新狀態決定，不是只會變 true。
- 補持久測試：先開編輯頁、後存金鑰 → 面板自動變可用；撤回金鑰 → 兩處都顯示未設定。e2e 用假 Gemini。
- 不碰真實金鑰與真實 Gemini。

## QC-056: AI 工作台版面重整（捲動後錯位）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

使用者 2026-11-21 授權：與 QC-052／054 一起驗收後直接發版安裝（「一起發版」）。
使用者 2026-11-21：「AI 工作台的界面佈局和操作不合理，一滾動就全跑偏了，要重新優化。」截圖顯示：左欄（視頻、任務、模型、重新分析）與右欄（摘要、時間點、標題建議、簡介建議）一起捲動，結果捲下去後左欄只剩一大片空白，「用量／最近任務」卡掉到左下角，與右欄內容錯開；右欄結果很長。
- 目標：左側設定欄固定（sticky 或獨立捲動），右側結果區獨立捲動；用量與最近任務移到不干擾主流程的位置（例如左欄底部可收合、或獨立分頁／抽屜），提出方案並說明理由。
- 結果區：摘要、時間點、標題建議、簡介建議之間要能快速跳轉（段落錨點或分段標籤）；時間點可點跳到預覽（若工作台有預覽）；建議可「採用到作品」時照既有候選＋diff 流程，不可直接覆蓋。
- 最近任務點選後顯示該次結果，選中狀態清楚；失敗任務可看原因、重試。
- 視窗寬度 1280–1920 都要成立；查 qiuge-design（`ai-chat`、`data-display`、`navigation`）引用卡片。屬既有頁面重排，不是新頁面；若需要新增功能區塊（例如任務抽屜），先回報總監判斷是否要原型核准。
- 三語文案進 i18n；交付截圖（捲動前後各一張）與 e2e。
- 順序：在 QC-052 之後、QC-054 前端之前或之後由前端自行評估，回報預估。

## QC-054: New API 模型改成下拉選擇（自動查詢模型清單）

**Priority:** P1 | **Assignee:** qc-backend（API）＋ qc-frontend（設定頁） | **Tags:** M3, backend, frontend

**後端已合併（2026-11-21，d21248d）**：`GET /api/v1/ai/providers/new-api/models`、10 分鐘快取、refresh=1、錯誤碼 ai_key_invalid／ai_gateway_unreachable／ai_gateway_bad_response；Base URL 少 /v1 不自動補，400 附建議網址＋`suggestNewApiBaseUrl()`。剩前端。

使用者 2026-11-21 授權：與 QC-052 一起驗收後直接發版安裝（「一起發版」）。設定頁 New API 文字模型 ID 要手動輸入，很笨拙，要能下拉選。依使用者自建中轉站的接入指南（https://api.hahaeng.app/integration.md）：OpenAI 相容，`GET {base_url}/models` 帶 `Authorization: Bearer <key>`，取 `data[].id`；清單依金鑰權限而定，可能混有對話與圖片模型（例如 gpt-image-2）。

後端：
- 新端點（例如 `GET /api/v1/ai/providers/new_api/models`，owner 權限）：用 Keychain 裡的金鑰在 Mac 端查詢，金鑰不出 Mac、不進日誌；回傳 `{ models: [{ id, kind: chat|image|unknown, priced: boolean }], fetched_at }`。短暫快取（例如 10 分鐘），支援 `?refresh=1`。
- 錯誤分流：401／403 → 金鑰無效；逾時、DNS、TLS → 連不上中轉站；非 JSON 或缺 `data` → 中轉站回應格式不對。都回錯誤碼＋參數（三語文案在前端），不吞錯。逾時、大小上限照既有 provider。
- `kind` 用保守規則判斷（id 含 image／dall-e／tts／whisper／embedding 等標為非對話），判斷不了就 `unknown` 不藏起來。
- Base URL：接入指南說應用可能自動補 `/v1`；輸入 `https://host` 不帶 `/v1` 時，存檔前提示並補上，或在驗證錯誤裡直接建議正確網址（二選一，說明理由），不放寬 HTTPS 限制。
- 測試一律用假中轉站，不打真實網址。

前端（QC-052 完成後接）：
- 「New API 文字模型 ID」輸入框改成可搜尋的下拉（combobox）：開啟時載入清單，有「重新整理」；預設只列對話模型，可切換顯示全部；保留手動輸入作為後備（清單載入失敗或模型不在清單時）。目前已存的模型不在清單時要標「不在中轉站清單中」。
- 選了沒有價格的模型時，提示「費用無法預估」，沿用既有的未定價處理。
- 錯誤用三語文案顯示，附 TechnicalDetails。
- 查詢清單本身會連到使用者的中轉站：只在使用者打開下拉或按重新整理時才發，不在頁面載入時自動發。

範圍外（不做，寫進交付）：Gemini／Claude／GPT 是否也改成線上查詢。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
