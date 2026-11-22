# QC-057 驗收記錄（後端）：AI 供應商測試連線

日期：2026-11-21　分支：`feat/qc057-provider-test`（從 `origin/main` 18c2539 開）　worktree：`/Users/feature/code/qiu-creator-qc057-be`

原型還沒核准，但總監已同意先做端點。全部使用臨時的 `CREATORHUB_HOME`、記憶體版 SecretStore（不碰 Keychain），以及一個本機假伺服器扮演四家供應商。沒有對真實供應商發出任何請求。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| `POST /api/v1/ai/providers/:provider/test`，只限 owner | `/api/v1/ai/*` 原本就只限主權杖；Agent 權杖回 403（有測試） |
| 用 Keychain 金鑰做不產生內容費用的探測，優先列模型端點 | 四家都打列模型端點（見第 2 節），不送內容；New API 沿用 QC-054 的 `/models` |
| 回傳 ok、延遲、模型數、錯誤碼 | `AiProviderTestResponse`：`ok`、`latency_ms`、`model_count`、`text_model_listed`、`error`、`tested_at`。探測失敗也回 200 加 `ok: false`；沒金鑰回 409 `ai_key_missing` |
| 金鑰不出 Mac、不進日誌 | 金鑰只放在標頭、只送到該供應商；回應與錯誤不含金鑰、網址或對方回應內容。測試開啟請求日誌並確認不含金鑰 |
| 卡片的「額度不足」狀態 | `ai_gateway_unreachable` 新增 `reason: 'quota'`：402，或錯誤內容提到 quota／billing／balance／餘額／額度的 429。限制見第 2 節 |
| 只用假服務測試 | 見第 3 節 |
| api-client、文件 | `client.ai.testProvider(provider)`；`docs/architecture.md` 新增 API 列與「測試連線」一節 |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 探測端點 | 列模型；或送一個最小的生成請求 | 列模型 | 四家都免費、不送內容，不需要使用告知；生成請求即使只有 1 token 也會計費，還會把內容送出去 |
| 各家的請求 | — | Gemini `GET /v1beta/models?pageSize=1000`（`x-goog-api-key`）；Claude `GET /v1/models?limit=1000`（`x-api-key`、`anthropic-version`）；GPT `GET /v1/models`（Bearer）；New API `GET {base_url}/models` | 用一次請求拿到完整清單，以便計數；共用 QC-054 的 `fetchModelList`，安全規則（不跟隨重新導向、2 MiB、逾時）一致 |
| 探測失敗時的 HTTP 狀態 | 200 加 `ok: false`；或 502 錯誤 | 200 | 測試的結果本身就是答案：畫面可以一律顯示延遲與原因。只有「沒有金鑰可以測」是 409 |
| 錯誤碼 | 沿用 QC-054 的三個碼；或新增一組 | 沿用 | 意思相同。三語通用文案改成不只講「中轉站」，前端可以依 `provider` 換成供應商名稱 |
| 額度不足 | 不分辨；或依 402 與錯誤內容分辨 | 分辨（`reason: quota`） | 卡片要求這個狀態。只比對關鍵字，不保存或回傳對方的回應內容 |
| 是否保存上次測試結果 | 存資料庫；或不存 | 不存 | 卡片要求不改已存設定的格式；App 可以保留 `tested_at`。若原型要求重開 App 後仍顯示「上次測試」，可以另外加 |
| New API 的測試 | 另外打一次；或走模型清單流程 | 走模型清單流程，`refresh` | 測完後下拉選單不必再查一次 |

**限制**：列模型不會消耗額度，所以額度用完時探測多半仍會成功；只有供應商在這個端點就回 402，或回提到額度的 429，才會顯示 `quota`。真正的額度問題仍會在實際任務失敗時顯示。

## 3. 自動測試

`services/mac-server/test/ai-provider-test.test.ts`（5 個測試）：
- 四家都成功：
  - 每家用自己的路徑和自己的金鑰標頭，方法都是 GET，請求內容 0 bytes，Claude 有帶 `anthropic-version`。
  - Gemini 的 `models/` 前綴會去掉；`model_count` 正確；`text_model_listed` 在 New API 為 false、其他為 true。
  - 沒有確認使用告知也能測。
  - 回應與伺服器日誌都不含任何金鑰。
- 探測失敗回 `ok: false`，逐一核對：
  - 401：`ai_key_invalid`。
  - GPT 的 `insufficient_quota`（429）、Gemini 的 `RESOURCE_EXHAUSTED`（429）、New API 的 402：都是 `quota`。
  - Claude 的 429、529：`unavailable`。
  - 不是清單：`missing_data`。
  - 錯誤 `details` 正確，回應與日誌都不含金鑰。
- 逾時（200 ms）與連線被拒（`ECONNREFUSED`）。
- New API 測試後，模型清單直接用快取，不再發請求。
- 四家沒有金鑰都回 409；Agent 權杖回 403；這兩種情況都沒有發出請求。

QC-054 的 `ai-models.test.ts`（19 個）在重構後全部照舊通過，包括一般的 429 仍是 `unavailable`。

## 4. 閘門結果

全套測試與 e2e 都是在持有鎖、而且 1 分鐘負載低於 15 時才開始跑。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **954 passed／0 failed／954 total**（2026-11-21 20:25，負載 1.73→3.37）：contracts 23、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 437（新增 5）、apps/mac 320、agent-sdk 6 |
| e2e（全部 spec，先 build `apps/mac`） | **20 passed／0 failed／20 total**（20:25–20:26，負載 5.60） |

沒有加長逾時、加重試或放寬斷言。

## 5. 範圍外（未做）

- 前端設定頁的重新設計與測試按鈕（原型核准後由 qc-frontend 做）。
- 保存上次測試結果（見第 2 節）。
- 本地模型的連線測試：目前的供應商清單裡沒有本地模型轉接器。

## 6. 收尾

- 假服務與測試伺服器都由測試自己關閉；臨時目錄已刪除。
- 全套與 e2e 的鎖都已釋放。
- 沒有修改 `.tasks/`；Plan 寫在交付報告裡。
- worktree 與分支保留，等總監驗收合併後再刪除。
