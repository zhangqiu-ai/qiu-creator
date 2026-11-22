## QC-054: New API 模型改成下拉選擇（自動查詢模型清單）

**Priority:** P1 | **Assignee:** qc-backend（API）＋ qc-frontend（設定頁） | **Tags:** M3, backend, frontend

使用者 2026-11-21：設定頁 New API 文字模型 ID 要手動輸入，很笨拙，要能下拉選。依使用者自建中轉站的接入指南（https://api.hahaeng.app/integration.md）：OpenAI 相容，`GET {base_url}/models` 帶 `Authorization: Bearer <key>`，取 `data[].id`；清單依金鑰權限而定，可能混有對話與圖片模型（例如 gpt-image-2）。

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

## QC-052: 作品庫：原地改名、右鍵選單、多選批量、卡片縮小

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

使用者 2026-11-21 要求（附截圖：作品庫卡片、編輯頁分頁）：
1. **原地雙擊改名**：作品庫卡片標題、列表列標題、編輯頁頂部分頁標籤都能雙擊進入改名；Enter 確定、Esc 取消、失焦確定；中文輸入法組字中按 Enter 不能提交。走 `PATCH /works/:id`，409 照既有衝突處理。
2. **右鍵選單**：卡片與列表列右鍵出現：開啟、在新分頁開啟、重新命名、改狀態（子選單）、複製路徑／在 Finder 顯示（若已有能力）、刪除。分頁標籤右鍵：重新命名、關閉、關閉其他。用 macOS 原生選單（Electron `Menu`）或符合 DESIGN.md 的自繪選單，二選一說明理由。
3. **多選批量**：⌘點選、⇧點選範圍、⌘A；框選可選做。選取後頂部出現批量列：改狀態、加／移除標籤、刪除、取消選取。刪除要確認框並寫明「可在最近刪除中還原 30 天」；做完給可撤銷的提示。
4. **卡片縮小**：作品庫格狀檢視卡片明顯縮小（縮圖比例變小、資訊精簡），在 1440 寬的視窗一列至少 5–6 張；保留列表檢視。
5. **最近刪除**：作品庫篩選加「最近刪除」入口，可還原或永久刪除（永久刪除要再確認）。

刪除、還原、批量依賴 QC-051 後端；1、2（除刪除）、4 可先做。三語文案進 `packages/i18n`，不准寫死中文。設計前查 qiuge-design（`data-display`、`content-editing`、`feedback` 標籤，Finder／Notion／Bear 類的多選與右鍵模式），引用卡片路徑。交付附截圖（三語至少簡中一張）與 e2e。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
