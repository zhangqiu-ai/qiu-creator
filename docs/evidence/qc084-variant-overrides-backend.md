# QC-084 後端驗收記錄：平台版本只存覆寫值，正文由原稿推導

- 分支：`feat/qc084-variant-overrides`
  - 早期提交 `3088b0f`：contracts、api-client、`deriveVariantBody`，已交給前端。
  - 服務端提交：見交付報告。
- 規格：
  - `docs/design/prototype/changes.json` 中 PT-20261123-001 的 `dataModel` 與 `backendNeeds`。
  - `docs/decisions.md` 2026-11-23（QC-084）。
- 設計說明：`docs/architecture.md`「覆寫值與推導正文（QC-084）」。

## 實作

| 項目 | 位置 |
| --- | --- |
| 推導函式 `deriveVariantBody`／`deriveWorkVariantBody`，回傳 `{format, text, blocks, map}`；查詢函式 `sourceOffsetAt`、`textOffsetAt`、`blockAtSource`；`checkDerivedLimits`（`body_too_long` 帶 `cut_at`、`source_offset`） | `packages/platform-preview/src/derive.ts` |
| 契約：`VariantView`、`PatchVariantOverridesRequest`、`VariantOverrideRevision`、`work.variant_changed`、錯誤碼 `body_not_editable` | `packages/contracts/src/variants.ts`、`events.ts`、`api.ts` |
| api-client：`variants.list/get/patch/remove/revisions/revision`；`generate`／`redraft` 已棄用 | `packages/api-client/src/variants.ts` |
| 遷移 `0020_variant_overrides`、`VARIANT_OVERRIDES_ROLLBACK_SQL` | `services/mac-server/src/db/migrations.ts` |
| 服務：解析、PATCH、409、事件、舊資料回填 | `services/mac-server/src/variants/variant-service.ts`、`routes/variants.ts` |
| 素材引用與永久刪除改看覆寫值 | `services/mac-server/src/assets/asset-service.ts`、`asset-library.ts` |
| 錯誤訊息三語 | `packages/i18n/src/catalog/errors.ts` |

## 自動測試

- `packages/platform-preview/test/derive.test.ts`（13 項）：
  - 7 種 Markdown 寫法（front matter、標題、清單、巢狀、待辦、引言、圖片、HTML、程式碼、表格、註腳、跳脫、emoji、縮排程式碼）。四個平台的輸出都與凍結的 QC-009 舊實作 `test/support/legacy-draft.ts` 逐字相同。
  - 原稿對應位置的正確性。
  - 貼圖與視頻作品的簡介。
  - `cut_at`／`source_offset`，含 emoji 造成的 UTF-16 偏移。
- `services/mac-server/test/variants.test.ts`（16 項）：
  - 沒有資料列時四平台都跟隨原稿。
  - 原稿改了，正文跟著變，且不發平台事件。
  - 設定覆寫值、改回跟隨，其他平台和原稿不受影響。
  - PATCH 沒有改變任何值時不升 revision。
  - 送 `body` 字串回 400，送舊欄位被 strict 拒絕。
  - 圖片隱藏、新增、移除的規則；封面與圖片驗證。
  - 以 base 0 並發建立時只有一筆成功，其他回 409。
  - If-Match、428、ETag。
  - 歷史只記覆寫值。
  - 墓碑與 QC-019（版本號不重複）。
  - 已棄用端點。
  - 超限警告的 `cut_at`／`source_offset`。
  - 權杖權限。
- `services/mac-server/test/variant-overrides-migration.test.ts`（4 項）：
  - SQL 往返：0019 的 fixture → 0020 → 回滾 → 資料表逐列相同 → 可以再升級。
  - 回填 fixture：
    - 小紅書：未改過的草稿 → 全部跟隨。
    - 抖音：只因原稿後來改了才不同 → 全部跟隨。
    - 公眾號：兩者都有（從舊原稿產生草稿，之後原稿改過，使用者又改了標題與正文）→ 標題覆寫，正文轉成 legacy body override；沒動過的標籤跟隨。
    - 視頻號：只有使用者改過（封面與圖片順序），並且 `inherit` → 標題、正文、標籤跟隨，封面與圖片覆寫保留。
  - 回填不升版本、不發事件、不改舊欄位；legacy 正文可以清除。
  - 回填後回滾，資料表逐列相同；遷移後新設的覆寫值在回滾時寫回舊欄位。
- 依新模型改寫的既有測試：
  - `asset-library`：素材在回收站時，平台不顯示該圖片，覆寫值與引用保留；永久刪除時清掉封面覆寫。
  - `trash-followups`、`typed-works`、`m2-three-party`。
  - `ai-prompts`：0019 的回滾測試只套用到 0019 為止。
  - `backups`：`schema_version` 改為 `0020`。

## 數字（2026-11-23）

- 全套 `pnpm -r --workspace-concurrency=1 --no-bail test`，開始時 1 分鐘負載 7.3：
  - mac-server 42 個檔、522 passed，0 failed。
  - 其他後端與共用套件全部 passed（含 contracts、api-client、domain、i18n、platform-preview）。
  - apps/mac 425 個中 10 failed：`variants`、`preview-ai`、`video-work` 三個測試檔使用舊的變體 API，屬前端範圍，見下。
- 修改遷移 fixture 後重跑 mac-server：522 passed，0 failed。
- typecheck：除 apps/mac 之外全部通過；`e2e/tsconfig` 只有 `editor-preview`、`video-work` 兩支 spec 有錯，同樣屬前端範圍。
- 根目錄 `pnpm lint`：只有同兩支 e2e spec 的 4 個錯誤。

## 範圍外，NOT_VERIFIED

- `apps/mac` 的 `variant-session.ts`、`PreviewPanel.tsx` 和相關單元測試，以及 e2e 的 `editor-preview.spec.ts`、`video-work.spec.ts`，仍使用舊型別（`cover_asset_id`、`inherit`、正文 PATCH）。這些屬於前端（qc-frontend）同時進行的畫面重做，本分支不改，所以本分支單獨跑 `apps/mac` typecheck 和 e2e 不會通過。兩種模式的 e2e 要在包含本分支的前端分支上驗收：**NOT_VERIFIED**（本分支）。
- 沒有介面變更，不附截圖。
