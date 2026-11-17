# In Progress

## QC-021: AI 任務基礎：供應商介面、Keychain 金鑰、任務佇列與用量記錄

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend | **Started:** 2026-11-17

- `AIProvider` 介面（文字生成、結構化輸出、檔案上傳），假供應商給測試用；真實供應商的 HTTP 呼叫集中在 adapter，可注入 base URL 以便用本機假伺服器測。
- 金鑰存 macOS Keychain（推薦 `@napi-rs/keyring`，記入 `docs/dependencies.md`；不用 `security` 命令列帶明文參數）。API：設定、刪除、查詢「是否已設定」，永遠不回傳值；日誌與錯誤訊息遮蔽請求內容與標頭。測試用記憶體實作，不碰真實 Keychain。
- `ai_jobs` 啟用：排隊／進行中／成功／失敗／取消、可讀失敗原因（429、金鑰無效、逾時、內容被拒）、重試、取消；冪等鍵；SSE 事件。
- 用量與成本：記錄供應商回報的 token／秒數，依可調整的價格表估算成本（標「估算」）。費用控制：任務送出前回傳估算；月度累計超過使用者設定金額時，回應帶提醒但不拒絕。
- 供應商 adapter：Gemini、Anthropic（Claude）、OpenAI（GPT）三家，模型名稱可設定；本地模型不做，介面預留。
- 首次使用告知：每個供應商記錄使用者已確認的告知（內容會送到哪個第三方），未確認時 API 拒絕送出。
- 只有 owner 權杖能用 AI 與金鑰路由；Agent 權杖不行。

