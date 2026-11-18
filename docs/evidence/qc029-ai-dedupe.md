# QC-029 驗收記錄：重啟後沿用遠端檔、文字任務去重

日期：2026-11-17　分支：`fix/qc029-ai-dedupe`（從 `211a5ef` 開）　範圍：`services/mac-server`、`packages/contracts`（只增）、`packages/api-client`、`docs/architecture.md`

全部只用本機假服務（`test/fake-gemini-video.ts`、`test/fake-ai.ts`）與臨時資料目錄，沒有對任何第三方 API 發請求，也沒有碰真實 Keychain。

## 1. 重啟後沿用遠端檔

**根因：** 關閉服務時 `AiService.stop()` 會中止進行中的任務，視頻執行器把這個中止當成「使用者取消」，於是刪掉遠端檔並清空 `remote_state`。重啟後只能從頭上傳。

**修正：**

- 執行器多了 `shuttingDown()`。如果是服務關閉造成的中止，就不刪遠端檔，也保留 `remote_state`（上傳網址或遠端檔名）。使用者取消照舊刪除。
- 帶著遠端檔名的下一次執行，先用 `files.get` 查那個檔案，再決定怎麼做：

  | 查到的情況 | 處理 |
  | --- | --- |
  | `PROCESSING` 或 `ACTIVE`，且離到期還有 1 小時以上 | 沿用，不重傳 |
  | 不可重試的錯誤（例如 404、403），視為檔案已不在 | 重傳 |
  | `FAILED` | 盡量刪掉舊檔，再重傳 |
  | 快過期或已過期 | 盡量刪掉舊檔，再重傳 |
  | 429、5xx、逾時 | 保留狀態，照一般規則重試 |

  - 到期時間取自 `File.expirationTime`，已用 `@google/genai` 3.4.0 的型別定義確認這個欄位。檔案沒給這個欄位時，用 `remote_state.uploaded_at` 加 48 小時推算。
- 同一根因：還沒傳完的上傳，關閉服務時也會被清掉上傳網址。修正後一併保留，重啟後照 QC-023 的 `query` 續傳。這個情況沒有另外寫測試，見第 5 節。
- 分析只送一次（`generateContent` 一次），費用只算一次。

**測試**（`test/ai-video.test.ts`，「across a service restart (QC-029)」）：

情境：上傳完成後，把檔案停在 Gemini 的 `PROCESSING`，然後關掉服務。關閉時先驗兩件事：沒有刪除任何遠端檔，遠端只有 1 個檔案。之後在同一個 home 和同一個金鑰庫上重新開機。

| 測試 | 驗證 |
| --- | --- |
| 沿用 | `starts` 1、上傳片段數不變、`generates` 1 且用的是原檔、結束後刪掉原檔、用量 1 筆 |
| 遠端檔已不見（`vanish`） | 重傳一次（`starts` 2），新檔內容等於原片，刪掉新檔，用量 1 筆 |
| 已是 `FAILED`（`fail`） | 重傳；分析用的是新檔；舊檔與新檔都刪掉 |
| 快過期（還剩 10 分鐘，`expire`） | 重傳；舊檔與新檔都刪掉 |
| 重啟後使用者取消 | 仍立即刪除遠端檔、不送分析 |

假 Gemini 新增三個控制項，`expire`、`fail`、`vanish`，並在回應裡帶 `expirationTime`（預設上傳後 48 小時）。

## 2. 文字任務去重

範圍：`POST /api/v1/works/:id/ai/rewrite`、`/ai/suggestions`。

- **進行中去重：** 新的 `AiService.submitOnce()` 對以下欄位取雜湊：供應商、解析後的模型、action、作品、`source_revision`、完整輸入（提示詞、Schema、輸出上限）、task。雜湊存進 `ai_jobs.cache_key`，前綴與視頻快取鍵不同。
  - 同鍵已有 `queued` 或 `running` 的任務時，直接回那個任務，`in_progress: true`，不送出也不計費。`budget` 是目前的本月狀態。
  - 查核與建立都是同步的，同一行程內兩個並行請求不會都建立。
  - 已完成的任務（成功、失敗、取消）不算重複，可以再生成一次。
- **`Idempotency-Key`：** 沿用既有的 `IdempotencyService`。
  - 鍵依端點區分。請求內容是 `{ work_id, body }`，所以同一個鍵用在另一篇作品會回 422。
  - 重送回原任務的目前狀態，加 `Idempotent-Replayed: true`；原任務已完成也一樣。同鍵不同請求回 422 `idempotency_key_reused`。

**測試**（`test/ai-text.test.ts`，「no duplicate text jobs (QC-029)」）：

| 測試 | 驗證 |
| --- | --- |
| 並行兩個相同改寫 | 同一個任務，`in_progress` 一真一假；供應商只收到 1 次請求；任務 1 筆、用量 1 筆。完成後再請求是新任務，供應商收到第 2 次 |
| 不同參數或新版本 | 不同模式、選取範圍、作品改過之後的同參數請求，都是各自的新任務 |
| 並行兩個相同平台候選 | 同一個任務；換平台是新任務 |
| 冪等鍵 | 同鍵同內容（完成後）回原任務並帶 replay 標頭；同鍵改內容 422；同鍵換作品 422；平台候選經 api-client 的 `idempotencyKey` 選項重送回同一任務 |

## 3. 契約與前端需要知道的

- **contracts（只增）：** 新增 `WorkAiJobResponseSchema` / `WorkAiJobResponse`，等於 `CreateAiJobResponse` 加 `in_progress: boolean`。`CreateAiJobResponseSchema` 沒改。
- **api-client：**
  - `ai.rewrite` 與 `ai.suggest` 的回傳型別改成 `WorkAiJobResponse`。這是加欄位，舊用法照常編譯，`apps/mac` 的 typecheck 與測試都過。
  - 兩者多一個選填的 `options?: IdempotencyOptions`。
- **前端可能要處理 `in_progress`：** 回 `in_progress: true` 時，拿到的是先前那個還在跑的任務。介面應該接著顯示那個任務的進度，不要當成新任務，例如不要再加一筆紀錄或重設計時。目前介面在生成中會停用按鈕，所以一般操作碰不到這個情況；兩個視窗或重複點擊時才會碰到。要不要開前端任務由總監決定。

## 4. 測試的調整（沒有放寬任何斷言）

- `test/m3-acceptance.test.ts` 的「a video job interrupted by a service restart…」：原有斷言全部保留，另加兩條更嚴的新正確斷言，`starts` 為 1、遠端檔案數為 1，也就是重啟後只上傳一次。
- `test/fake-ai.ts` 修了一個假服務的缺陷：延遲回覆用 `req.destroyed` 判斷用戶端是否還在。Node 24 讀完請求內容後就把 `req` 標成 destroyed，所以延遲回覆永遠不會送出，只會等到逾時。改成只看 `res.destroyed`。既有測試只拿延遲回覆來做逾時和取消，不受影響，全部通過。

## 5. 閘門（2026-11-17 17:57，負載 5.08 → 5.44）

- `corepack pnpm -r typecheck`：通過（exit 0）
- `corepack pnpm -r lint`：通過（exit 0）；改動檔案 `prettier --check` 通過
- `corepack pnpm -r --workspace-concurrency=1 test`：**566 passed / 0 failed / 566 total**

  | 套件 | 測試數 |
  | --- | --- |
  | contracts | 16 |
  | design-tokens | 5 |
  | domain | 27 |
  | markdown-editor-web | 22 |
  | api-client | 15 |
  | platform-preview | 12 |
  | mac-server | 321 |
  | apps/mac | 142 |
  | agent-sdk | 6 |

**NOT_VERIFIED：**

- 真實 Gemini 對已不存在的檔案實際回 404 或 403。程式把兩者都當成檔案已不在，所以結果相同。
- 上傳到一半時關閉服務、重啟後續傳的情況，沒有寫自動測試。行為和 QC-023 已測過的斷線續傳走同一段程式。
