# QC-082 後端：中轉站讀不到模型清單時，模型選單仍能選 New API

- 日期：2026-11-22
- 分支：`fix/qc082-models-fallback`
- 範圍：
  - `packages/contracts`：`ai-prompts.ts` 的 `AiModelsResponseSchema`。
  - `services/mac-server`：`ai/ai-service.ts` 的 `switchableModels`。
  - 文件：`docs/architecture.md`。

## 問題

QC-075 的 `GET /api/v1/ai/models` 在 New API 清單讀取失敗時，只在 `errors` 記一筆，`items` 裡完全沒有 New API。結果模型選單選不到它。

## 修正

- **先用快取**：清單讀取失敗時，如果有同一組憑證的快取清單，就用它，即使已超過 10 分鐘的有效期限。這些項目標為 `source: 'cache'`，錯誤項帶 `fallback: 'cache'` 和 `cached_at`。
- **沒有快取時用已存的模型**：列出 New API 的 `text_model`（chat 類），加上 preferences 的 `last_models` 裡各任務上次用的 New API 模型；類別用同一個 `classifyModelKind` 判斷。這些項目標為 `source: 'configured'`，錯誤項帶 `fallback: 'configured'`。
- **兩者都沒有時**：錯誤項帶 `fallback: 'none'`。
- **錯誤原因**：錯誤項帶 `code`（例如 `ai_gateway_unreachable`、`ai_key_invalid`）與 `reason`（來自 `details.reason`，例如 `timeout`、`dns`、`unavailable`、`quota`；沒有就是 null）。
- **所有項目都帶 `source`**：清單成功時是 `list`；其他供應商列的是設定的文字模型，所以是 `configured`。
- **相容舊伺服器**：`source`、`reason`、`fallback`、`cached_at` 在 schema 裡都有預設值，舊伺服器的回應照樣能解析。
- **前端顯示**：看到 `fallback` 不是 `none` 時，顯示「清單讀取失敗，使用已存模型」，並附上 `reason`。已告知 qc-frontend。

## 測試

新增 `services/mac-server/test/ai-models-fallback.test.ts`，共 4 項，只用假中轉站，時鐘可注入：

1. 清單成功：chat 與 image 都依清單列出，`source: list`。
2. 先成功一次，時間推過快取期限後中轉站回 503：改用快取清單（`source: cache`），錯誤項為 `ai_gateway_unreachable`、`reason: unavailable`、`fallback: cache`，並帶 `cached_at`。
3. 一開始就讀不到（401）：chat 列出 `text_model` 與上次用的 New API 模型；上次用的 OpenAI 模型不會混進來。image 列出上次用的圖片模型。錯誤項為 `ai_key_invalid`、`fallback: configured`。
4. 沒有清單（404），也沒有任何已存的圖片模型：items 為空，`fallback: none`。

既有測試的調整：`ai-prompts.test.ts` 的模型清單期望值多了 `source: 'configured'`，這是新增欄位，沒有放寬斷言。

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1190 passed／0 failed／1190 total；負載 14.86 → 24.00（其他會話同時在跑，沒有逾時） |
| e2e | NOT_VERIFIED：後端沒有介面變更；前端的提示文字由 qc-frontend 加上後驗證 |
