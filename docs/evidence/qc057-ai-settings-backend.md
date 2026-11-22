# QC-057 驗收記錄（後端追加）：上次測試、429 細分、各任務預設、未定價用量、Base URL

日期：2026-11-21　分支：`feat/qc057-ai-settings-backend`（從 `origin/main` c690b18 開；原型 PT-20261121-002 已核准）　worktree：`/Users/feature/code/qiu-creator-qc057-be2`

依據：`docs/design/prototype/changes.json` 中 PT-20261121-002 的 `backendNeeds` 與 `approvalDecisions`，以及總監的五點追加。測試全部使用臨時的 `CREATORHUB_HOME`、記憶體版 SecretStore 與本機假服務，沒有任何真實請求，也沒有碰 Keychain。`.tasks/` 沒有修改。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| 1. `last_test` 保存上次測試結果並放進供應商狀態，重開後仍在 | 存在 `app_settings` 的 `ai_last_test`：`status`（ok／failed）、`at`、`latency_ms`、`model_count`，另加 `error_code`、`reason`，讓失敗狀態在重開後也能顯示原因。不含金鑰。換金鑰、換 Base URL 或刪除金鑰時清除 |
| 2. 429 細分 | 在既有 reason 之外新增 `rate_limited`。402，或錯誤內容含 `insufficient_quota`、`RESOURCE_EXHAUSTED`、quota、billing、餘額等字樣的 429 → `quota`；其他 429 → `rate_limited`；`unavailable` 只剩 5xx |
| 3. `GET/PUT /api/v1/ai/defaults` | `{ rewrite, title, video }`：只存供應商 id，`video` 只能是 `gemini` 或 null。PUT 整份取代，省略的欄位視為 null。null 表示沿用現在的行為，伺服器不依它挑選供應商。只限 owner |
| 4. 用量 `by_provider` 加 `unpriced_jobs` | 有用量但 `cost_estimate` 為 null 的任務數 |
| 5. New API 狀態回完整 `base_url` 與 `base_url_host` | 只有 New API 的狀態有這兩個欄位，其他供應商沒有。值在第一個 `/api/v1/ai/providers…` 請求前從 Keychain 讀一次，之後隨憑證變更同步更新。SQLite 仍然不存 Base URL |
| 原型 limits：測試 10 秒逾時 | `AI_TEST_TIMEOUT_MS = 10_000`；轉接器的逾時比較短時，用轉接器的 |
| 儲存相容、可回滾 | 沒有 migration。新增的兩個值各占 `app_settings` 一個 key；舊版會略過不認得的 key；值損壞時當作沒設定。已存的金鑰與設定格式都沒變 |
| 範圍外 | Gemini、Claude、GPT 的線上模型清單沒有做 |
| api-client、文件 | `ai.defaults()`、`ai.putDefaults()`；`docs/architecture.md`（API 表、測試連線、新增「AI 設定的其他欄位」一節） |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| 新資料存哪裡 | 新表加 migration；或 `app_settings` 加 key | `app_settings` | 原型的 storage 寫的就是 service settings table。不需要遷移，「可回滾」自然成立 |
| Base URL 怎麼回傳 | 在 SQLite 鏡像一份；或從 Keychain 讀進記憶體 | 記憶體 | 不改金鑰的儲存格式，SQLite 也不多一份網址；只在第一次請求時讀一次 Keychain |
| `last_test` 的欄位 | 只放原型列的四個；或再加錯誤碼與原因 | 再加 `error_code`、`reason` | 原型的失敗狀態要區分金鑰無效、連不上、額度不足；只有 `status: failed` 不夠 |
| 金鑰更換後的 `last_test` | 保留；或清除 | 清除 | 舊結果描述的是舊金鑰。測試進行中換了金鑰，那次的結果不保存 |
| Gemini 的 `RESOURCE_EXHAUSTED` | 歸 `quota`；或歸 `rate_limited` | `quota`（照核准的對應） | Gemini 的每分鐘限流也用這個碼，所以有可能把暫時限流顯示成額度不足。已在文件註明；之後若要細分，要看錯誤裡的 `QuotaFailure` 細節 |

## 3. 自動測試

- `test/ai-provider-test.test.ts` 新增 2 個測試：
  - **上次測試**：GPT 測試成功、Claude 回 401、New API 回一般的 429。重開服務（同一個 home 和 SecretStore）後，三家的 `last_test` 都在，而且內容精確；New API 的 reason 是 `rate_limited`。Gemini 沒測過，所以是 null。
  - **Base URL**：重開後 `base_url`、`base_url_host` 從 Keychain 讀回。換 GPT 金鑰、換 New API 的 Base URL、刪除 Claude 金鑰之後，三家的 `last_test` 都清掉；`base_url` 跟著改變；刪除 New API 金鑰後為 null。
  - `app_settings` 裡沒有任何金鑰。
  - **逾時**：`effectiveTimeout` 的 10 秒上限。
- `test/ai.test.ts` 新增 2 個測試：
  - **預設值**：初始全是 null；PUT 後讀回；`video: 'openai'` 與不存在的供應商都回 400；PUT `{}` 清空；Agent 權杖回 403。
  - **未定價用量**：GPT 有價格，`unpriced_jobs` 為 0；兩個 New API 任務沒有價格，`unpriced_jobs` 為 2、`cost_usd` 為 0；設定價格覆寫後，新的任務就有價格。
- 因核准的行為變更而調整的斷言（嚴格程度不變）：
  - `ai-models.test.ts` 與 `ai-provider-test.test.ts`：一般的 429 從 `unavailable` 改成 `rate_limited`。
  - `ai.test.ts`：原本斷言供應商狀態不含 Base URL；現在改成斷言 New API 回完整的 `base_url` 與 `base_url_host`、GPT 沒有這兩個欄位。金鑰仍然不能出現，SQLite 仍然不能有 Base URL。

## 4. 閘門結果

已 rebase 到 `origin/main` 91a395c（含 QC-053），在 rebase 後的程式碼上重跑。全套與 e2e 都在持有鎖、1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **969 passed／0 failed／969 total**（2026-11-21 20:45，負載 3.76→5.22）：contracts 23、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 445（本次新增 4）、apps/mac 323、agent-sdk 10 |
| e2e（全部 spec，先 build `apps/mac`） | **21 passed／0 failed／21 total**（20:45–20:46，負載 4.59） |

rebase 前在 c690b18 上也跑過一次：961／0／961，e2e 21／21。沒有加長逾時、加重試或放寬斷言。

## 5. 給前端

- `last_test.reason` 會是 `quota` 或 `rate_limited`（原型的「額度不足」與「暫時受限，稍後重試」），也可能是 `timeout`、`dns` 等連線原因。
- 用途頁的 `video` 只能選 Gemini；欄位為 null 時沿用現在的挑選方式。
- 用量列 `unpriced_jobs > 0` 時顯示「無法預估」。
- 隱私頁用 `base_url_host`；設定詳情顯示完整的 `base_url`。

## 6. 收尾

- 假服務、測試伺服器與臨時目錄都已由測試自行清掉。
- 全套與 e2e 的鎖都已釋放。
- 沒有改 `.tasks/`。
- worktree 與分支保留，等總監驗收合併後再刪除。
