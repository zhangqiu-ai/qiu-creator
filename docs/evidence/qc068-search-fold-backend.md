# QC-068 後端：搜尋比對與命中摘要

- 日期：2026-11-22
- 分支：`feat/qc068-search-backend`
- 基礎：先 cherry-pick 前端的 ab374f5（`@qiu-creator/domain/search`、opencc-js）。
- 範圍：`packages/domain`（只動型別接線）、`packages/contracts`、`services/mac-server`。
- 契約：依 qc-frontend 提案 E／F，已回覆前端。

## 變更

**E. 搜尋比對**
- 新增 `registerSqlFunctions(db)`，註冊 SQL 函式 `search_fold`。`openDatabase` 與 `runMigrations` 都會呼叫，所以 migration 和備份還原的連線也有這個函式。
- 新增 migration `0018_search_fold`：用 `search_fold` 就地 fold `works_fts` 的 title、tags、body，不讀原稿。
- 新增 `SEARCH_FOLD_ROLLBACK_SQL`，有測試。
- `indexFts` 寫入前先 fold。
- 查詢一律用 `searchKey(q)`：
  - 3 個 code point 以上：trigram MATCH 片語。
  - 不滿 3 個：在 `works_fts` 三欄用 `instr` 掃描。這是行為改變，2 字查詢現在也比對內文。
- 素材名稱改為 `instr(search_fold(original_name), ?) OR instr(search_fold(display_name), ?)`。
- facets、refs 共用 `filterSql`，跟著一起改。

**F. 命中摘要**
- `WorkListItemSchema` 加 `match_excerpt`。
- 只在帶 `q` 時才給這個欄位。標題沒命中、但 `workPlainText`（不截斷的卡片純文字）有命中時，給 `matchExcerpt(text, q, WORK_EXCERPT_MAX_CHARS)`；其他情況為 null。
- `card-images.ts` 拆出 `workPlainText`；`workExcerpt` 的輸出不變。

**domain 型別接線（修正 ab374f5）**
- 問題：apps/mac 與 e2e 的 typecheck 失敗（TS7016）。`opencc-dict.d.ts` 只在 domain 自己的 tsconfig 裡，其他會編譯到 `search.ts` 的專案看不到它。
- 修法：
  - `packages/domain/package.json` 加 subpath import `#opencc/ts-characters`：`types` 指向 d.ts，`default` 指向 `opencc-js/dict/TSCharacters`。
  - d.ts 改為模組宣告。
- 驗證：
  - 全倉 typecheck（含 e2e）通過。
  - esbuild 打包與 Vite lib 建置都能解析，並實測 fold 結果正確。

## 測試

新增 `services/mac-server/test/search-fold.test.ts`，共 5 項：

1. 作品搜尋：
   - 繁簡互通（`设计` 找到 `設計筆記`）。
   - 全半形（`ab`、`abc` 找到 `ＡＢＣ`）、大小寫（`MARKDOWN`）、標籤（`tools` 找到 `Ｔｏｏｌｓ`）。
   - 2 字查詢（`常用`）會比對內文。
   - 查詢尾端的空白會先 trim 掉，不影響結果。
   - facets、refs 的結果一致。
2. 編輯後索引仍是 fold 過的文字（`鬱金香` 存成 `郁金香`，用 `郁金香` 找得到）。
3. `match_excerpt`：
   - 遠處命中時回帶 `…` 的片段，長度不超過上限；用簡體查詢也取到繁體原文的片段。
   - 標題命中、只有標籤命中、只在 URL 命中時為 null。
   - 不帶 q 時沒有這個欄位。
4. 素材名稱：全形加繁體的檔名、display_name，都能用半形、簡體查到。
5. migration 0018：就地 fold；rollback 後舊版 migration 集合可以開啟；重新套用時 fold 已經 fold 過的文字不會改變結果。

既有測試的調整都是因為新 migration，斷言沒有放寬：

| 測試 | 調整 |
| --- | --- |
| `backups.test.ts` | `schema_version` 改為 `'0018'` |
| `projects.test.ts` 的 0017 rollback 測試 | 改用 `openDatabase(file, upTo0017)` |

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1071 passed／0 failed／1071 total；負載 2.09 → 5.66 |
| e2e | NOT_VERIFIED：後端沒有介面變更，高亮的 e2e 由 qc-frontend 負責 |

## 範圍外與注意

- 短查詢與素材查詢是逐列掃描，作品、素材在數千件以內可接受；量大時再考慮存 fold 欄位並建索引。
- fold 規則以後若改變（例如更新字表），需要新增 migration 重新 fold。
