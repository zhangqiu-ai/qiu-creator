# QC-070 後端：New API 圖片與封面生成

- 日期：2026-11-22
- 分支：`feat/qc070-image-generation`
- 範圍：
  - `packages/contracts`：新增 `ai-images.ts`；`ai.ts` 與 `entities.ts` 的擴充。
  - `packages/api-client`：新增 `ai.images` 與 `imageResultOf`。
  - `services/mac-server`：新增 `ai/image-tasks.ts`、`ai/providers/new-api-images.ts`、`routes/ai-images.ts`；修改 `net/safe-download.ts`、`ai/ai-service.ts`、`routes/ai.ts`、`routes/media.ts`、`server.ts`、`layout.ts`。
- 契約：已與 qc-frontend 往返確認；實作時的調整已另外通知。

## 需求對照

| 總監要求 | 做法 |
| --- | --- |
| `POST {base_url}/images/generations`；金鑰不離開 Mac、不進日誌 | `NewApiImageClient`：金鑰只放在送往中轉站的 Authorization 標頭，`redirect: 'error'`。錯誤只保留短錯誤碼，不留回應內容、網址、提示詞。測試確認日誌與作業紀錄都不含金鑰。 |
| 模型沿用 QC-054 清單（kind=image） | `model` 必填，由前端從 `/ai/providers/new-api/models` 中挑 `kind: image` |
| AI 作業：進度事件、可取消、逾時與大小限制 | `ai_jobs` 的 action 為 `image_generation`，有 `ai_job.*` 事件。取消會中止請求（測試確認中轉站看到連線中斷）。逾時 180 秒。每張圖 ≤ 20 MiB，JSON 回應也有上限。不自動重試（max_attempts 1）。 |
| `b64_json` 或 `url`；url 下載防 SSRF、限大小、類型、重定向 | 用 `safeDownload`，新增三個選項：`allowedContentTypes`（只收圖片）、`signal`（跟著作業取消）、`trustedOrigin`。中轉站本身的 origin 可以在區網；其他私有位址和往外的重定向一律阻擋。最多 3 次重定向。 |
| 存成作品 `assets/` 的檔案，只在按「保留」時；之前放自動清理的暫存區 | 候選放在 `cache/ai-images/<job>/`，sharp 解碼後重新編碼，並裁成要求的比例。keep 時才收進素材庫、複製到 `assets/`。捨棄或保留後刪檔，24 小時後自動清掉。 |
| 有價格就估算，沒有就回「無法預估」；沿用 New API consent | `AiModelPrice` 新增選填 `per_image_usd`。estimate 的 `max_cost_usd` 為單價 × 張數，沒有單價時為 null。實際費用依單價或 token 計。送出前檢查 New API consent。 |
| 封面：標題＋摘要生圖，比例決定尺寸；「設為封面」以 base_revision 寫 front matter cover | `purpose: 'cover'`：提示詞由標題、純文字前 500 字、補充要求、風格組成。依比例挑最接近的通用尺寸送出，回來再裁切。`placement: cover` 寫入 `cover: assets/…`。 |
| 不直接覆蓋原文；保留時寫新版本，source 為 ai_accepted | 先核對 `base_revision`，不符回 409 `revision_conflict`，不複製任何檔案。之後用 `acceptAi` 寫成 `ai_accepted` 版本，並記到 `accepted_revision_id`。 |
| 測試只用假中轉站 | `test/ai-images.test.ts` 用本機 HTTP 假中轉站，沒有任何真實呼叫 |

## 設計取捨

- **只接受文章**：卡片範圍是「文章編輯」。貼圖、視頻作品回 400。外部作品回 409 `attach_external_unsupported`，原因同 QC-039：不往使用者的資料夾複製檔案。
- **素材 origin 用 `manual`**：`assets.origin` 有 CHECK 約束，新增 `ai` 必須重建資料表。`manual` 原本沒有任何地方使用，所以沿用它，檔名用 `ai-…` 標示。
- **不回報 progress**：原本打算在 phase 列舉加 `generating`、`downloading`，但 apps/mac 的 `ai-video.ts` 窮舉了 phase，一加就讓 typecheck 失敗，這屬於前端範圍。所以列舉不動，前端改用 status 判斷進行中；已通知前端。
- **尺寸**：只送 `1024x1024`、`1024x1536`、`1536x1024` 三種，這是 OpenAI 相容圖片模型最普遍接受的尺寸；精確比例（例如 3:4、2.35:1）由服務端裁切。若有中轉站或模型不接受這些尺寸，會回 `bad_request`，屬於 NOT_VERIFIED（真實中轉站沒有測）。

## 測試

`services/mac-server/test/ai-images.test.ts`，共 11 項：

1. **預估**：沒有單價時為 null；有 `per_image_usd` 時為單價 × 張數。
2. **base64 生成**：
   - 只對中轉站發一次請求，內容正確（`model`、`prompt` 含風格、`n`、`size` 為 1024x1536）。
   - 候選從 400×600 裁成 400×533（3:4），並可以用簽名網址讀出。
   - 作品版本不變，`assets/` 仍是空的，素材庫也沒有新增。
   - 費用 0.08（2 張 × 0.04）。日誌與作業紀錄都不含金鑰。
3. **保留插入**：
   - base 過期時回 409，而且素材數仍是 0。
   - 插入後的 Markdown 與預期完全一致；檔案在 `assets/`，素材 origin 為 manual。
   - 新版本的 source 是 `ai_accepted`、`ai_job_id` 正確，作業記下 `accepted_revision_id`。
   - 保留後候選變成 expired，同一張不能再保留（409 `ai_job_not_acceptable`）。
4. **封面**：
   - 提示詞包含標題、內文和補充要求；送出尺寸為 1536x1024，裁成 2.35:1（1536×654）。
   - 保留後 front matter 有 `cover:`，作品庫的 `card_image` 也有圖。
5. **url 回應**：
   - 中轉站同 origin 的網址可以下載。
   - `10.0.0.1` 被擋（`blocked_address`），而且不留暫存資料夾。
   - 從中轉站重定向到私有位址也被擋。
   - `text/html` 被擋（`unsupported_content_type`）。
   - 不是圖片的 base64 回 `invalid_output`。
6. **透明與素材庫**：有透明的圖存成 PNG；`library` 只進素材庫，不改版本。
7. **中轉站拒絕**：
   - `content_policy_violation` 回 `content_blocked`，回應裡回顯的金鑰沒有被保存。
   - 503 回 `provider_unavailable`。
   - 兩者都只送一次，不重試。
   - 撤銷 consent 後送出，回 409 `ai_consent_required`。
8. **輸入檢查**：不是文章回 400；`purpose: image` 卻沒有 prompt 也回 400。
9. **取消**：中轉站延遲回應時取消，作業變成 cancelled，中轉站看到連線中斷。
10. **捨棄與清理**：
    - 捨棄一張後，它是 expired，另一張還在；Bearer 讀已捨棄的那張回 404。
    - 清理只會刪掉超過 TTL 的資料夾。
11. **`insertImage`**：插在本文開頭、行尾、超出長度、front matter 之後；src 含空白；alt 跳脫。

既有測試沒有改動。第一次跑全套時，`m3-acceptance` 的「每個 AI 路由都拒絕 agent 權杖」失敗了。這個測試把 OpenAPI 裡所有含 `/ai` 的路徑都列入檢查，而簽名候選路由最初叫 `/media/v1/ai-images/…`，因為字串含 `/ai` 被誤列。這條路由走簽名驗證，和其他 `/media/v1` 路由一樣，只有 owner 才拿得到簽名網址。處理方式是把路徑改名為 `/media/v1/image-candidates/:jobId/:index`，安全測試本身沒有改，重跑後通過。

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1082 passed／0 failed／1082 total；負載 4.53 → 7.20 |
| e2e | NOT_VERIFIED：後端沒有介面變更，由 qc-frontend 接上後跑 |
| 真實 New API 生圖 | NOT_VERIFIED：依規定只用假中轉站；真實生成要使用者在安裝版自己操作 |

## 範圍外

- 前端的所有部分：浮動工具列、原位骨架與淡入、圖片分頁、價格設定 UI（`per_image_usd`）、「關閉作品時提示未保留候選」。
- 如果日後要讓圖片作業顯示進度文字，需要前端先在 `PHASE_LABEL` 加上新 phase 的標籤，後端才擴充列舉。
