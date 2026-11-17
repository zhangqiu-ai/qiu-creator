# QC-021 實機驗證記錄

- 日期：2026-11-17 15:55 PST；負載：3.63 3.48 3.07
- 分支：feat/qc021-ai-foundation（基底 7d58dd3，未提交變更）
- 服務：`buildServer` 跑在 `127.0.0.1:7420`，`CREATORHUB_HOME` 為臨時目錄。金鑰用記憶體實作（不碰 Keychain），三家供應商的 base URL 指向本機假伺服器（`test/fake-ai.ts`）。**沒有對任何真實第三方 API 發出請求。**

### 1. 只限主權杖

```console
$ Agent 權杖（read+import+write）呼叫 AI 路由
GET /api/v1/ai/providers → HTTP 403
PUT /api/v1/ai/providers/anthropic/key → HTTP 403
POST /api/v1/ai/jobs → HTTP 403
```

### 2. 沒有金鑰、沒有確認告知時拒絕送出

```console
$ POST /api/v1/ai/jobs（未存金鑰）
ai_key_missing
```
```console
$ PUT …/anthropic/key
{"key_configured":true,"ready":false,"consent":null}
```
```console
$ grep 金鑰 <回應>
回應中出現金鑰的次數：0
```
```console
$ POST /api/v1/ai/jobs（已存金鑰、未確認告知）
ai_consent_required - confirm the Claude notice before sending content to Anthropic
```
```console
$ GET /api/v1/ai/providers → Claude 的告知文字
notice v1
使用 Claude 時，你主動送出的內容（作品標題、正文、標籤，以及你選擇的圖片或視頻）會經網路傳送到 Anthropic 的伺服器處理。
Anthropic 依其服務條款處理與保留這些資料；本 App 不會在你沒有操作時自動送出任何內容。
費用由你的 API 金鑰帳戶支付，App 顯示的金額是依參考價格的估算。
```
```console
$ POST …/anthropic/consent {notice_version:1}
ready = true
```

### 3. 估算、送出、完成與用量

```console
$ POST /api/v1/ai/estimate
{"model":"claude-opus-5-5","input_tokens":32,"max_output_tokens":256,"max_cost_usd":0.005248,"estimated":true}
```
```console
$ POST /api/v1/ai/jobs（本月提醒 0.01 美元）
{"status":"queued","over_budget":false}
```
```console
$ GET /api/v1/ai/jobs/<id>
{"status":"succeeded","result":{"text":"京都紅葉散步：十一月限定的顏色"},"usage":{"input_tokens":1200,"output_tokens":300},"cost_usd":0.0108,"attempts":1}
```
```console
$ 同一個 Idempotency-Key 重送
HTTP/1.1 202 Accepted
idempotent-replayed: true
```
```console
$ 再送一次（本月已超過提醒金額）
{"status":"queued","over_budget":true}
本月 AI 費用估算 0.02 美元，已超過你設定的提醒金額 0.01 美元。任務仍會送出。
```

### 4. 失敗分類、自動重試、取消

```console
$ GPT：第一次 429，自動重試後成功（結構化輸出）
{"status":"succeeded","attempts":2,"json":{"titles":["秋天的京都","紅葉季散步"]}}
```
```console
$ Gemini 請求進行中（假伺服器 60 秒才回）→ POST …/cancel
cancelled
```
```console
$ GET /api/v1/ai/usage
anthropic jobs 2 in 2400 out 600 cost≈$0.0216
openai jobs 1 in 1200 out 300 cost≈$0.0150
本月 0.0366 / 0.01 over: true | 價格基準 2026-11-17
```

### 5. 日誌與事件

伺服器日誌行數：58；含 AI 路由的請求紀錄：27
```console
$ grep 金鑰 <server log（Fastify 日誌開啟）>
日誌中出現金鑰的次數：0
```
```console
$ curl /api/v1/events?since=0 | grep ai_job
   1 event: ai_job.cancelled
   5 event: ai_job.queued
   5 event: ai_job.running
   3 event: ai_job.succeeded
```

收尾：服務與假伺服器已停止，臨時資料目錄已刪除；埠 7420 已釋放。

## 自動測試

- `services/mac-server/test/ai.test.ts`（19），全部對本機假伺服器（`test/fake-ai.ts`），金鑰用記憶體實作：
  - AI 路由全部只限主權杖（含讀取）；金鑰只寫不讀，任何回應與驗證錯誤都不含金鑰；未存金鑰、未確認告知、告知版本不符時拒絕；告知按供應商分開。
  - 排隊後撤回告知或刪除金鑰，任務送出前失敗，假伺服器收到 0 個請求。
  - `KeychainSecretStore` 在測試執行器下讀、寫、刪都會丟錯。
  - 三家 adapter 的請求形狀（端點、認證標頭、模型、system、輸出上限）、用量與估算成本；三家原生結構化輸出與 JSON 解析，解析失敗記 `invalid_output` 且用量照計。
  - 401 不重試、429 重試後成功、529 重試三次後失敗、逾時重試、404 不重試；三家拒答／安全攔截記 `content_blocked`；供應商回傳內容夾帶金鑰時存成 `[REDACTED]`。
  - 取消排隊中與進行中的任務（假伺服器確認請求被中止）、重跑；重啟後 `running` 任務重新排隊；`Idempotency-Key` 重送。
  - 估算、月度提醒超額仍送出、用量彙總、價格覆寫、未知模型無價格照常執行、模型設定、`ai_job.*` 事件只帶狀態與供應商。
- `packages/contracts/test/ai.test.ts`（5）：三家供應商與預設模型都有價格、告知文字寫明公司、token 粗估、價格計算、金鑰與任務輸入驗證。
