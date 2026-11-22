# QC-075／QC-076 後端：AI 輸出語言、Prompt 庫、記住模型、平台標題與封面

- 日期：2026-11-22
- 分支：`feat/qc075-prompts-language`
- 依據：原型 PT-20261122-003（總監代核准），以及總監 2026-11-22 對語言、指令優先、匯出格式、變數與 QC-076 的決定。
- 範圍：
  - `packages/domain`：`search.ts` 新增 `detectLanguage`。
  - `packages/contracts`：新增 `ai-prompts.ts`；修改 `ai.ts`、`ai-text.ts`、`ai-video.ts`、`ai-images.ts`、`entities.ts`、`events.ts`。
  - `packages/api-client`：`ai.preferences`、`patchPreferences`、`models`、`prompts.*`、`promptSuggestionOf`。
  - `services/mac-server`：新增 `ai/prompt-service.ts`、`ai/language.ts`、`routes/ai-prompts.ts`；修改 `ai-service.ts`、`text-tasks.ts`、`video-tasks.ts`、`image-tasks.ts`、migration 0019、`server.ts`。
- 契約：已送 qc-frontend，以最後一版為準。

## 要求對照

| 要求 | 做法 |
| --- | --- |
| 輸出語言偏好存服務端，可選 follow、zh-Hans、zh-Hant、en，預設 follow | `GET/PATCH /ai/preferences` |
| follow 時偵測選取段；漢字分繁簡，拉丁字母比例判英文；判斷不出時用介面語言；候選回傳實際語言 | `detectLanguage`（domain，App 可共用）、`interface_language`；結果帶 `language` 與 `language_source` |
| prompt 指定的模型或語言優先於全域，候選標「prompt 指定」 | `language_source: prompt`、`model_source: prompt`；這時不改 `last_models` |
| prompts 表：CRUD、排序、分組、匯入匯出；內建唯讀可複製；migration 可回滾 | `0019_prompts`；名稱上限 40 字、內容上限 4000 字；`PROMPTS_ROLLBACK_SQL`；`/:id/duplicate` |
| 匯入匯出格式 `{version, prompts:[{name, group, scene, content, model?, language?}]}` | 照這個格式；名稱重複的匯入成「（副本）」，依原型 backendNeeds |
| AI 建議或改寫指令，只產生候選 | `POST /ai/prompt-suggestions`；寫入要另外走一般的 CRUD |
| 各作業接受 `prompt_id`、`language`、`model`；變數在服務端展開（五個） | rewrite、suggestions、images 接受；video 只接受 `language`；變數為 `{選取}{標題}{全文}{平台}{語言}` |
| 記住每個任務上次用的模型 | `last_models`（rewrite、suggestions、video、image、prompt） |
| 快速切換模型的清單（原型 backendNeeds） | `GET /ai/models?kind=chat\|image` |
| QC-076：標題與封面依平台的字數上限與比例 | 標題：suggestions 已依 `PLATFORM_LIMITS`，新增 `{平台}`。封面：images 加 `platform`，比例預設用 `PLATFORM_COVER_RATIOS`（比例清單新增 6:7），保留到素材庫後再設成平台版本的封面 |

## 設計取捨

- **路由放在 `/api/v1/ai/` 底下**，不用原型寫的 `/api/v1/prompts`：
  - 原因：沿用 AI 路由只限 owner 的規則。既有安全測試會逐一確認 agent 權杖碰任何 `/ai` 路由都被拒，新路由也通過了。
  - 原型寫的另外兩條也一併對應：`duplicate` 照原型；`prompt-suggestions` 放在 `/api/v1/ai/prompt-suggestions`。
- **視頻的 follow**：視頻沒有文字可以偵測，所以維持原本「與影片相同」的規則，`language` 為 null；快取鍵與 QC-075 之前相同。
- **內建指令寫在程式碼裡**：升級內建指令時不會動到自訂資料。原型 backendNeeds 提到 `builtin_version`，用這個做法就不需要了。
- **一般的 `POST /ai/jobs`**：直接收 system 與 prompt，是給 API 用戶端的通用入口，不套用 `prompt_id` 和 `language`。

## 測試

新增：

- **`test/ai-prompts.test.ts`，11 項**：
  1. 偏好：預設 follow；`last_models` 合併與清除；記錄事件；舊值 `auto` 回 400。
  2. 模型清單：只列已就緒的供應商；image 類目前沒有。
  3. 指令庫 CRUD：
     - 內建指令的順序與唯讀。
     - 上限：名稱 41 字、內容 4001 字、不存在的 scene 都回 400。
     - model 可以設定，也可以清除。
     - 沒帶版本回 428，版本過期回 409；改內建回 403；複製。
     - 完整重排成功，部分重排回 400；刪除；事件序列正確。
  4. 匯出與匯入：沒有 model 的指令不輸出 `model` 欄位；名稱重複改名「（副本）」；錯誤版本、錯誤 scene、超過 500 條都回 400。
  5. preview：五個變數都展開，加上未知變數與英文寫法 `{tags}`（保留原文）；偵測出繁體；沒有文字時用介面語言。
  6. follow：
     - 简体選取段偵測為 zh-Hans，提示詞換成简体规则，候選標 detected。
     - 英文段偵測為 en。
     - 帶 language 時記為 request；都沒帶時記為 preference。
     - 記住模型。
  7. prompt 指定：
     - 模型與語言都覆蓋請求，並標成 prompt。
     - 變數展開正確；使用次數加一；不改 `last_models`。
     - 內建縮寫對應 shorten mode；builtin-tone 沒帶 tone 回 400；scene 不符回 400。
  8. QC-076 標題：`{平台}` 代入「微信視頻號」，請求含 16 字上限；結果標示語言。
  9. 指令建議：結果完全相符（含偵測語言）；原有指令沒有被寫入；AI 回空內容時作業失敗。
  10. agent 權杖：四條新路由都回 403。
  11. migration 0019：model 兩欄要同時有值或同時為空（CHECK）；回滾與重新套用。
- **`test/ai-images.test.ts`，+2 項**：
  - QC-076 視頻號封面：比例 6:7、送出尺寸 1024x1536、提示詞含平台名、裁成 1024×1195；保留到素材庫後設成平台版本的封面。
  - 圖片指令的變數展開、記住模型、scene 不符回 400。
- **`test/ai-video.test.ts`，+1 項**：指定 en 的提示詞與結果正確；同一語言命中快取；記住模型。
- **`packages/domain/test/search.test.ts`，+1 項**：`detectLanguage` 判斷繁體、簡體、英文，以及判斷不出來的情況。

既有測試的調整：都是因為行為改變而更新期望，沒有放寬斷言。

| 測試 | 調整 |
| --- | --- |
| `ai-text.test.ts` | 改寫候選多了 `language: 'zh-Hant'`（偵測結果）、`language_source: 'detected'`、`model_source: 'default'` |
| `backups.test.ts` | `schema_version` 改為 `'0019'` |
| `search-fold.test.ts` | 0018 回滾的重新套用只到 0018 |

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1145 passed／0 failed／1145 total；負載 4.73 → 9.29 |
| e2e | NOT_VERIFIED：後端沒有介面變更，由 qc-frontend 接上後跑兩種模式 |
| 真實供應商 | NOT_VERIFIED：只用假服務 |

## 範圍外

- 前端：Prompt 頁、工具列與面板、內建指令名稱的三語在地化、平台預覽裡的標題與封面介面。
- 內建指令的「隱藏」：總監決定之後再做。
