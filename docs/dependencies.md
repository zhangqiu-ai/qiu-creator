# 依賴記錄

新增或升級依賴時更新本表：授權、版本、用途、替代方案。版本以 `pnpm-lock.yaml` 為準，這裡記錄選型理由。

套件管理：pnpm 12.21.0（`packageManager` 欄位，透過 `corepack pnpm` 執行）。pnpm 12 預設的供應鏈政策（發布未滿一天的版本不解析、install script 需允許）保持開啟；`pnpm-workspace.yaml` 的 `allowBuilds` 只允許 `esbuild`。

## 關鍵選擇

### TypeScript：釘 5.9.x，不用 7.0

- npm 最新是 TypeScript 7.0.2（原生版）。
- `typescript-eslint` 8.72.2 的 peer 範圍是 `typescript >=4.8.4 <6.1.0`，不支援 7.x；lint 規則是交付門檻，不能放棄型別感知 lint。
- Vitest 5 與 tsx 用 esbuild／Vite 轉譯，不依賴 `tsc` 版本，兩者都相容，所以瓶頸只有 typescript-eslint。
- 決定：`typescript ~5.9.3`。等 typescript-eslint 正式支援 7.x 後另開任務升級。
- 替代方案：TS 7 + oxlint／Biome（型別感知規則較少，暫不採用）；TS 6.0（同樣在 typescript-eslint 範圍內，但生態成熟度不如 5.9）。

### SQLite：better-sqlite3 13，不用 `node:sqlite`

- better-sqlite3 13.2.0 在套件內附帶預編譯二進位檔（`prebuilds/`），Node 24.14 / darwin-arm64 直接載入，無需 node-gyp 或 install script。
- 實測內建 SQLite 3.54.1，含 FTS5（`trigram` 分詞器可用於中文子字串搜尋）與 WAL。
- 同步 API 讓「核對 revision → 寫檔 → 寫庫」在同一個事件迴圈片段內完成，同一行程內的並發請求不會交錯。
- 替代方案：`node:sqlite`（Node 24 內建，無原生依賴，但仍標為實驗性／release candidate，API 與 FTS5 支援隨 Node 版本變動）。若日後 Electron 打包遇到原生模組問題，再評估切換。

## 執行期依賴

| 套件 | 版本 | 授權 | 用在 | 用途 | 替代方案 |
| --- | --- | --- | --- | --- | --- |
| fastify | ^5.12.8 | MIT | mac-server | HTTP 服務 | Hono、Express |
| @fastify/swagger | ^9.9.3（鎖 9.9.4） | MIT | mac-server | 從路由 schema 產生 OpenAPI 3 | 手寫 OpenAPI、zod-openapi |
| @fastify/swagger-ui | ^6.1.4 | MIT | mac-server | `/docs` 互動文件 | Scalar、Redoc |
| fastify-type-provider-zod | ^7.0.0 | MIT | mac-server | 以 Zod 4 契約做請求驗證、回應序列化、OpenAPI 轉換 | @fastify/type-provider-typebox（需改用 TypeBox） |
| better-sqlite3 | ^13.2.0 | MIT | mac-server | SQLite（WAL、FTS5） | `node:sqlite`（見上） |
| zod | ^4.6.7 | MIT | contracts、api-client、mac-server | 共用契約與執行期驗證 | Valibot、TypeBox |
| commander | ^15.1.0 | MIT | agent-sdk | `creatorhub` CLI 解析 | yargs、citty |
| tsx | ^4.23.15 | MIT | mac-server、agent-sdk | 直接執行 TypeScript 原始碼（`node --import tsx`、CLI bin）；M0 尚無建置步驟 | 之後改為 `tsc` 建置產物；Node 原生 type stripping（不支援 `.js` → `.ts` 對應） |

## 開發依賴（根目錄）

| 套件 | 版本 | 授權 | 用途 | 替代方案 |
| --- | --- | --- | --- | --- |
| typescript | ~5.9.3 | Apache-2.0 | 型別檢查（strict） | 見上 |
| typescript-eslint | ^8.72.2 | MIT | 型別感知 lint（`strictTypeChecked`） | oxlint |
| eslint | ^10.15.0 | MIT | lint（flat config） | Biome |
| @eslint/js | ^10.0.1 | MIT | ESLint 推薦規則 | — |
| eslint-config-prettier | ^10.1.8 | MIT | 關閉與 Prettier 衝突的規則 | — |
| globals | ^17.14.0 | MIT | Node 全域變數宣告 | — |
| prettier | ^3.10.1 | MIT | 程式碼格式（Markdown 不格式化，見 `.prettierignore`） | Biome |
| vitest | ^5.1.0 | MIT | 單元與整合測試 | node:test |
| @types/node | ^24.19.2 | MIT | Node 24 型別 | — |
| @types/better-sqlite3 | ^9.6.0 | MIT | better-sqlite3 型別 | — |

## 未來候選（尚未加入）

方案中提到、M1 以後才會引入：Sharp（縮圖）、Chokidar（資料夾監控）、ffprobe（視頻元資訊，需確認授權與打包）、tus 或等效續傳協議（大檔上傳）。加入時在此補記。
