# QC-079 後端：拼音搜尋

- 日期：2026-11-22
- 分支：`feat/qc079-pinyin-search`
- 範圍：
  - `packages/domain`：`search.ts`，新增依賴 pinyin-pro。
  - `services/mac-server`：`db/database.ts`、`works/work-service.ts`、`assets/asset-service.ts`。
  - 文件：`docs/dependencies.md`、`docs/architecture.md`。
- 高亮契約已送 qc-frontend。API 回應格式不變；前端用 domain 的 `findMatches` 標字，黃色樣式由前端負責。

## 比對規則（domain）

- **什麼算拼音查詢**：`pinyinKey(q)` 去掉空白與撇號、轉小寫、全形轉半形；只含字母且至少 2 個字母時才算。
- **每個字可以怎麼打**：
  - 全拼（changyong）、首字母（cy，zh／ch／sh 也算首字母）、兩者混用（changy、cyong）。
  - 最後一個音節可以只打到一半（changyo）。
- **繁體與多音字**：先走 QC-068 的 fold（繁轉簡），再取 pinyin-pro 的所有讀音，多音字全收（銀行可以打 yinhang，行走可以打 xingzou）。ü 可以打 v 或 u。
- **非漢字**：照原樣比對，所以 A股 可以打 agu。
- **命中範圍**：`findMatches` 回傳原文範圍，拼音命中直接對到中文字上（cy 標出「常用」），並和字面命中合併。
- **最短長度**：標題、標籤、素材名稱至少 2 個字母；正文與 `match_excerpt` 至少 `PINYIN_LONG_TEXT_MIN_LENGTH`（4）個字母。

## 服務端

- **SQL 函式**：新增 `search_pinyin(folded, key)`，和 `search_fold` 一樣，每條連線都會註冊。
- **作品**：
  - 比對 `works_fts` 的 title、tags；key 至少 4 個字母時也比對 body。
  - 這個條件和字面比對用 OR 合併在 `filterSql`，所以 list、分頁、facets、refs 的結果一致。
  - `match_excerpt` 用同一個正文門檻。
- **素材**：比對 `search_fold(original_name)` 與 `search_fold(display_name)`。

### 與任務卡不同：沒有加拼音索引欄位，也沒有 migration

- **任務卡原本的要求**：在 FTS 索引加全拼與首字母欄位，並用 migration 重建索引。
- **為什麼不加**：要支援混用（cyong）與多音字（yinhang），比對時每個字都要在多種讀音、多種打法之間選擇。這無法事先寫成固定字串來做子字串比對。只存「全拼＋首字母」兩欄，會漏掉混用與多音字，也會和前端高亮的規則不一致。
- **改成的做法**：查詢時直接比對 FTS 裡已 fold 的文字，用讀音快取和起始字母遮罩加速。
- **代價**：見下方量測。若日後作品量大到需要，再做預先計算的讀音索引。
- **好處**：不動原稿、不動索引；沒有 migration，也就不需要回滾。

## 量測

量測方式：
- 環境：本機測試伺服器，暫存資料目錄，負載約 5（1 分鐘平均）。
- 資料：用 SQL 直接寫入合成作品，標題 8 字、正文為隨機中文。
- 每個查詢連跑 3 次，記錄每次的時間。

| 資料量 | 建索引（fold＋FTS 寫入） | 查詢 | 總筆數 | 時間（ms，3 次） |
| --- | --- | --- | --- | --- |
| 300 件 × 2000 字 | 221 ms | `cy`（只比標題、標籤） | 2 | 10／3／3 |
| | | `jingdu`（含正文） | 300 | 27／24／22 |
| | | `qsjs`（無命中） | 0 | 40／41／40 |
| | | `xqwz` | 115 | 39／39／39 |
| | | `qiutianlvxing`（無命中） | 0 | 39／41／44 |
| | | `京都`（字面） | 168 | 6／4／4 |
| 3000 件 × 3000 字 | 3627 ms | `cy` | 16 | 44／40／39 |
| | | `jingdu` | 3000 | 287／281／274 |
| | | `qsjs` | 0 | 638／716／762 |
| | | `xqwz` | 1778 | 635／907／740 |
| | | `qiutianlvxing` | 0 | 804／1502／949 |
| | | `京都` | 2300 | 40／38／36 |

- 加起始字母遮罩前，3000 件那組的 `jingdu` 是 430／393／400 ms，`qsjs` 是 970／817／944 ms。
- 一次列表會掃兩次：先 count，再取分頁。
- 建索引的時間就是既有的 fold 加上 FTS 寫入；拼音不另外建索引，所以不會增加這段時間。
- domain 量測：純 JS 掃 900 萬字（3000×3000）每個查詢約 220–470 ms；`findMatches` 處理一筆標題約 0.02 ms。

## 測試

- **`packages/domain/test/search.test.ts`，+5 項**：
  1. 全拼、首字母、混用、有無空格、撇號、大小寫、全形、zh／ch／sh、最後音節打一半。
  2. 多音字：銀行、行走、長大，以及 綠 的 lv 和 lu 兩種打法。
  3. 繁體字先轉簡再取拼音，範圍落在原文；字母與漢字混在一起的情況。
  4. 字面命中與拼音命中合併；`pinyinKey` 的邊界情況。
  5. 正文門檻 4 個字母；`matchExcerpt`；`matchesPinyinFolded`。
- **`services/mac-server/test/search-pinyin.test.ts`，3 項**：
  1. 標題、標籤用 2 個字母，正文用 4 個字母；多音字；字面查詢並存；facets、refs、分頁結果一致。
  2. 用拼音找到正文時，`match_excerpt` 有給段落，而且用同一條規則標出的字是「秋天旅行」；標題命中或只有標籤命中時，沒有段落。
  3. 素材的原始檔名與顯示名稱都能用拼音找到。

既有測試沒有改動。

## 閘門

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`） | 通過 |
| `pnpm lint`（根目錄 `eslint .`） | 通過 |
| prettier（變更檔） | 通過 |
| 全套單元測試（`pnpm -r --workspace-concurrency=1 --no-bail test`） | 11 套件，1153 passed／0 failed／1153 total；負載 5.33 → 7.00 |
| e2e | NOT_VERIFIED：後端沒有介面變更，由 qc-frontend 做黃色高亮後跑兩種模式並截圖 |
