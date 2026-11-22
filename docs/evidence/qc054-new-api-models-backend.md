# QC-054 驗收記錄（後端）：New API 模型清單

日期：2026-11-21　分支：`feat/qc054-new-api-models`（從 `origin/main` a758f2e 開）　worktree：`/Users/feature/code/qiu-creator-qc054`

全部使用臨時的 `CREATORHUB_HOME`、記憶體版的 SecretStore（不碰真實 Keychain），以及本機的假中轉站（`127.0.0.1` 上的 HTTP 伺服器）。存進去的 Base URL 是 `https://relay.example.test/v1`，從來沒有被連線過：轉接器的 base URL 覆寫會把請求導向假中轉站。沒有對真實中轉站或第三方發任何請求。前端（QC-052 之後做 combobox）已收到合約。

## 1. 交付內容

| 需求 | 實作 |
| --- | --- |
| 新端點，owner 權限，用 Keychain 的金鑰在 Mac 端查詢，金鑰不出 Mac、不進日誌 | `GET /api/v1/ai/providers/new-api/models`。`/api/v1/ai/*` 原本就只限主權杖。`AiService.listModels` 呼叫時才從 SecretStore 取出金鑰，只放進 `Authorization` 標頭。錯誤與日誌都不含金鑰、Base URL 或中轉站的回應內容，有測試 |
| 回傳 `{ models:[{id, kind, priced}], fetched_at }` | `AiProviderModelsResponse`（另帶 `provider`）。id 去重、排序；`priced` 依價格覆寫，每次讀取時重算 |
| 短暫快取，`?refresh=1` | 依 `credential_id` 在記憶體快取 10 分鐘，換金鑰或 Base URL 就失效。並行的請求共用一次查詢；失敗不快取 |
| 錯誤分流 | 401／403 → 502 `ai_key_invalid`。連不上 → 502 `ai_gateway_unreachable`（`reason`：timeout／dns／tls／connection／unavailable）。格式不對 → 502 `ai_gateway_bad_response`（`reason`：not_json／missing_data／too_large／unexpected_status／redirect）。沒有憑證 → 409 `ai_key_missing` |
| 逾時、大小上限照既有 provider | 逾時沿用轉接器的 `timeoutMs`；不跟隨重新導向（與 Chat Completions 相同）；回應最多 2 MiB（`AI_MODELS_MAX_BYTES`） |
| `kind` 保守判斷，判斷不了就 `unknown` | contracts 的 `classifyModelKind`：先看圖片標記，再看非對話標記（歸為 `unknown`），只有已知的對話系列才是 `chat`。伺服器不藏任何模型 |
| Base URL 少了 `/v1` | 在驗證錯誤裡建議正確網址，不自動補上（見第 2 節）；HTTPS 限制不變 |
| 測試只用假中轉站 | 見第 3 節 |
| 文件 | `docs/architecture.md`（API 表、New API 一節）。三語錯誤文案放在 `packages/i18n`（新錯誤碼要有文案 typecheck 才會過） |

## 2. 技術選擇（列出選項，照推薦做）

| 題目 | 選項 | 採用 | 理由 |
| --- | --- | --- | --- |
| Base URL 少了 `/v1` | A 存檔時自動補上；B 在驗證錯誤裡建議正確網址 | B | 金鑰會送到這個網址，送去哪裡應該由使用者看過、點過才算數。中轉站也可能用別的路徑，只補 `/v1` 可能猜錯。contracts 匯出 `suggestNewApiBaseUrl`，App 存檔前就能提示並一鍵採用，使用起來和自動補一樣方便 |
| 查清單前是否要先確認使用告知 | A 要；B 不要 | B | 查清單只送金鑰，不送任何內容。金鑰本來就是給這個中轉站用的；而且只在使用者打開下拉時才查 |
| 怎麼發請求 | A 用 `openai` SDK 的 `models.list()`；B 直接用 `fetch` | B | 需要分辨 DNS、TLS、逾時、重新導向、大小上限、非 JSON，SDK 會把這些錯誤包在一起 |
| 錯誤的 HTTP 狀態 | 502 加錯誤碼；或把金鑰無效改成 409 | 全部 502 | 都是上游的問題；前端只看 `error.code` 與 `details.reason` |
| 音訊、嵌入這類模型的 `kind` | 新增 `other`；或歸為 `unknown` | `unknown` | 照總監給的三值形狀；前端「只列對話」時會一起藏起來，但目前已存的模型要一直顯示（已告知前端） |

## 3. 自動測試

- `services/mac-server/test/ai-models.test.ts`（19 個測試）：
  - 成功：用的是 `GET /v1/models`，帶 `Bearer` 金鑰；排序、去重、略過沒有 id 的項目；`kind` 與 `priced` 正確；回應裡沒有金鑰。
  - 快取：10 分鐘內不再查；`refresh=1` 會重查；過期後重查；換金鑰後重查，而且用的是新金鑰；`priced` 在讀快取時也會依新的價格覆寫更新。
  - 兩個並行請求只發一次。
  - 沒有金鑰回 409；其他供應商回 400；Agent 權杖回 403；這些情況都沒有發出請求。
  - 錯誤：401、403、503、429、404、HTML、缺 `data`、`data` 裡沒有 id、宣告過大、串流過大、重新導向（新位置沒有被請求）都各自驗證錯誤碼與 `details`。錯誤內容和伺服器日誌都不含金鑰或存下的網址，而且失敗不會被快取。
  - 逾時（200 ms）；連線被拒（`ECONNREFUSED`）。
  - DNS 與 TLS 在本機無法真的製造，以 Node 回報的錯誤碼做單元測試。
  - Base URL 缺 `/v1`：四種輸入都回 400，附正確的 `suggested_base_url`，而且沒有存入；HTTP 網址不會給建議。
- `packages/contracts/test/ai.test.ts` 新增 2 個測試：`classifyModelKind` 的 20 個 id；`suggestNewApiBaseUrl` 的各種輸入，並確認建議的網址能通過原本的嚴格驗證。

## 4. 閘門結果

全套與 e2e 都在持有鎖、1 分鐘負載低於 15 時才開始。

| 項目 | 結果 |
| --- | --- |
| `pnpm -r typecheck` | 全部通過 |
| `pnpm -r lint` | 全部通過（0 error、0 warning） |
| `prettier --check .` | 通過 |
| `pnpm -r --workspace-concurrency=1 test`（一次一個套件） | **926 passed／0 failed／926 total**（2026-11-21 20:11，負載 4.95→6.30）：contracts 23（新增 2）、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 432（新增 19）、apps/mac 297、agent-sdk 6 |
| e2e（全部 spec，先 build `apps/mac`） | **18 passed／0 failed／18 total**（20:11–20:12，負載 5.04） |

沒有加長逾時、加重試或放寬斷言。

## 5. 範圍外（未做）

- Gemini、Claude、GPT 是否也改成線上查詢模型清單（卡片寫明不做）。
- 前端 combobox、各個 `reason` 的細部文案（qc-frontend，QC-052 之後）。

## 6. 收尾

- 假中轉站與測試伺服器都由測試自行關閉；臨時目錄已刪除。沒有另外開伺服器或預覽。
- 全套與 e2e 的鎖都已釋放。
- worktree 與分支保留，等總監驗收合併後再刪。
