# 依賴記錄

新增或升級依賴時更新本表：授權、版本、用途、替代方案。版本以 `pnpm-lock.yaml` 為準，這裡記錄選型理由。

套件管理：pnpm 12.21.0（`packageManager` 欄位，透過 `corepack pnpm` 執行）。pnpm 12 預設的供應鏈政策（發布未滿一天的版本不解析、install script 需允許）保持開啟；`pnpm-workspace.yaml` 的 `allowBuilds` 只允許 `esbuild` 與 `electron`（QC-002：`electron` 的 install script 從 GitHub Releases 下載 Electron 執行檔，`@electron/get` 以套件內附的 `checksums.json` 驗證 SHA-256）。

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

### 可續傳上傳：tus 1.0.0（@tus/server + @tus/file-store）

- 選 tus 而非自訂分塊協議：開放標準，伺服器與用戶端都有成熟實作；第二期 iPhone／iPad（React Native）可直接用 tus-js-client 或 api-client 內建的極簡 tus 用戶端，不必再設計協議。
- @tus/server 2.4.7（MIT）以 `handle(req, res)` 掛在 Fastify 路由上（`reply.hijack()`），鑑權沿用 `/api` 的 Bearer hook；@tus/file-store 2.1.2（MIT）把進行中的上傳存在 `data/uploads/`，斷線後 `HEAD` 取得 `Upload-Offset` 從斷點續傳。
- 上傳完成時在 `onUploadFinish` 做 magic bytes 校驗、大小上限與 sha256 去重，再移入素材庫；不通過就刪檔並回 413／415。
- 已知問題：FileStore 建構時以非同步 `mkdir` 建目錄，callback 內直接 `throw`；目錄在那瞬間被刪會變成未捕捉例外。服務端以子類別改成同步建立（見 `src/routes/assets.ts` 的 `UploadFileStore`）。可考慮回報上游。
- 替代方案：自訂 `POST/PATCH/HEAD` 分塊協議（少一個依賴，但要自己維護用戶端與邊界情況）；@fastify/multipart（不支援續傳）。

### 類型判斷：file-type（magic bytes）

- file-type 22.3.0（MIT，純 ESM，Node ≥ 22）從檔頭判斷實際類型，不看副檔名。白名單：JPEG、PNG、GIF、WebP、HEIC／HEIF、AVIF、MP4／M4V、MOV、WebM、MP3、M4A、WAV。
- Markdown 沒有 magic bytes：只有在檔名是 `.md`／`.markdown`、偵測不到任何二進位簽章、且內容是不含 NUL 的合法 UTF-8 時才接受。
- 替代方案：libmagic（`file` 指令，需外部程式）、自寫簽章表（維護成本高）。

### 縮圖：sharp

- sharp 0.35.5（Apache-2.0），以 `@img/sharp-*` 預編譯套件提供 libvips（LGPL-3.0，動態連結），不需 install script。產出 WebP（最長邊 512px）到 `cache/thumbnails/`，可隨時刪除重建。
- 打包注意：Electron／發版時要帶上對應平台的 `@img/sharp-darwin-arm64` 與 `@img/sharp-libvips-darwin-arm64`；libvips 為 LGPL，需保留其授權聲明。
- 替代方案：macOS `sips`（只限 Mac、功能少）、jimp（純 JS，慢且格式少）。

### 視頻元資料：ffprobe（外部程式，不打包）

- 只在找得到時使用：`CREATORHUB_FFPROBE` 指定的路徑 → `PATH` → `/opt/homebrew/bin`、`/usr/local/bin`。找不到時任務照常成功，素材 `metadata_status` 記為 `unavailable`，介面不顯示時長／尺寸，不報錯。
- 授權與打包：FFmpeg 為 LGPL-2.1+，啟用 GPL 元件（例如 Homebrew 預設建置含 x264／x265）時整體為 GPL。為避免把 GPL 二進位檔隨 App 散布，**目前不打包 ffprobe**，由使用者自行安裝（`brew install ffmpeg`）。若日後要內建，需改用 LGPL-only 建置並附原始碼取得方式，屆時另行決定。
- 本機實測：Homebrew ffprobe 9.0.2。測試一律用假 ffprobe 腳本，不依賴本機安裝。

### 視頻卡片幀：ffmpeg（外部程式，不打包）＋ App 截幀（QC-061）

- 作品庫視頻卡的封面幀，有 ffmpeg 時由伺服器用 ffmpeg 取（`-ss <封面時間> -frames:v 1`，輸出 PNG 再用 sharp 轉 WebP 512）。尋找順序比照 ffprobe：`CREATORHUB_FFMPEG` → `PATH` → `/opt/homebrew/bin`、`/usr/local/bin`。授權與打包同上：**不打包**。
- 沒有 ffmpeg，或 ffmpeg 解不開某支視頻時，列表標 `needs_frame`，由 App 用隱藏的 `<video>` 加 canvas 截取封面那一幀，上傳到 `PUT /works/:id/thumbnail-frame`。Chromium 本身就能解 H.264、HEVC、VP9、AV1，所以不靠 GPL 工具也能拿到準確的封面幀。
- 評估過但沒採用：
  - macOS Quick Look（`qlmanage -t`）：內建、0.15 秒，但無法指定時間，取到的幀不準。
  - 用 `osascript -l JavaScript` 呼叫 AVFoundation 的 `AVAssetImageGenerator`：傳 `CMTime` 結構時 osascript 直接崩潰（exit 139），不可靠。
  - 內建一個小的 Swift 工具：準確，也沒有授權問題，但需要發版流程在打包時編譯並簽章；以後如果要讓伺服器在沒開 App 時也能產生，再另外評估。
- 測試一律用假 ffmpeg 腳本，或關閉 ffmpeg（`ffmpeg: null`），不依賴本機安裝。

### 資料夾監控：chokidar 6

- chokidar 6.0.0（MIT，Node ≥ 22.22，唯一依賴 readdirp）。用 `awaitWriteFinish`：檔案大小在設定時間內（預設 2 秒）不再變化才觸發 add／change，寫一半的檔案不會被索引；`atomic: true` 把編輯器「刪除＋重建」式的存檔合併成一次 change；`followSymlinks: false`。
- 已知限制：macOS 的 FSEvents 在大量 I/O 時可能延遲（測試中在多個測試檔並行時量到 12–14 秒）或合併事件。對策：每 10 分鐘對所有掛載做一次完整重掃，且服務啟動時一定重掃，保證最終一致；自動測試改用 chokidar 的 polling 後端以求穩定，原生後端在實機證據中驗證。
- 替代方案：Node 內建 `fs.watch({ recursive: true })`（無 awaitWriteFinish、無 atomic 合併，需自行實作）、@parcel/watcher（原生模組，需 install script）。

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
| @tus/server | ^2.4.7 | MIT | mac-server | tus 1.0.0 可續傳上傳伺服器 | 自訂分塊協議 |
| @tus/file-store | ^2.1.2 | MIT | mac-server | tus 上傳暫存（`data/uploads/`） | — |
| file-type | ^22.3.0 | MIT | mac-server | magic bytes 類型判斷 | libmagic |
| sharp | ^0.35.5 | Apache-2.0（libvips：LGPL-3.0） | mac-server | 圖片縮圖與尺寸 | sips、jimp |
| chokidar | ^6.0.0 | MIT | mac-server | 外部資料夾監控 | fs.watch、@parcel/watcher |
| @anthropic-ai/sdk | ^1.9.0 | MIT | mac-server | Claude（Messages API）adapter（QC-021） | 自寫 fetch（官方建議用 SDK；型別與錯誤類別省工） |
| openai | ^7.57.0 | Apache-2.0 | mac-server | GPT（Responses API）adapter（QC-021） | 自寫 fetch |
| @google/genai | ^3.4.0 | Apache-2.0 | mac-server | Gemini（`generateContent`、之後的檔案上傳）adapter（QC-021） | 自寫 fetch；舊的 `@google/generative-ai`（已停止維護） |
| @napi-rs/keyring | ^2.1.2 | MIT | mac-server | macOS Keychain 存取 AI 金鑰（QC-021） | `security` 命令列（明文會出現在參數中，不採用）；keytar（已封存） |
| tsx | ^4.23.15 | MIT | mac-server、agent-sdk | 直接執行 TypeScript 原始碼（`node --import tsx`、CLI bin）；M0 尚無建置步驟 | 之後改為 `tsc` 建置產物；Node 原生 type stripping（不支援 `.js` → `.ts` 對應） |

### AI 供應商 SDK 與 Keychain（QC-021）

- 三家都用官方 SDK，不自寫 HTTP：各家的認證標頭、錯誤類別、結構化輸出參數由 SDK 維護，跟得上 API 變動。實際觀察到的差異（以 SDK 為準，不是憑記憶）：
  - `@anthropic-ai/sdk` 1.x 把 API 金鑰放在 `Authorization: Bearer`，並送 `anthropic-version: 2026-10-21`。
  - `@google/genai` 3.x 呼叫 `/v1/models/<model>:generateContent`（REST 文件範例是 `/v1beta`）。
- 三個 SDK 都可以注入 base URL，測試一律指向本機假伺服器；SDK 自帶的重試全部關掉（Anthropic／OpenAI `maxRetries: 0`、Gemini `retryOptions.attempts: 1`），重試由 AI 任務佇列統一管理。
- `@google/genai` 依賴的 `protobufjs` 有 postinstall，內容只是印版本格式警告，在 `pnpm-workspace.yaml` 的 `allowBuilds` 明確設為 `false`。
- `@napi-rs/keyring` 走 Security framework，金鑰不經過命令列參數；附 darwin-arm64／x64 預建二進位，不需要安裝腳本。測試時 `KeychainSecretStore` 會拒絕建立，改用記憶體實作。

### Markdown 編輯器：MDXEditor 4，原始碼模式用純 `<textarea>`（QC-002）

- 實施方案第 2 節指定 MDXEditor；4.5.0 以 Lexical 0.48 為核心，MIT，支援 React 19。
- 視覺模式匯出時會正規化寫法（清單符號、表格對齊、檔尾換行）。為守住原稿：
  - 匯出選項固定為最常見寫法（`-` 清單、`---` 分隔線、`*` 強調、表格不補空白對齊），並補回檔尾換行。
  - 含 HTML、腳註、參照式連結、特殊表格、數學、指令區塊的文件預設進原始碼模式；切到視覺要確認。
  - 原始碼模式用原生 `<textarea>`，不經任何轉換，中文輸入法行為最穩定，內容逐位元組保留。
- 替代方案：Milkdown（ProseMirror，外掛多但 API 變動大）、TipTap + markdown 擴充（Markdown 是附加功能，往返較弱）、CodeMirror 6 原始碼為主加預覽（往返最安全，但沒有所見即所得）。

### Electron 主程序與 preload 建置：esbuild，不用 electron-vite（QC-002）

- 只需要把兩個 TypeScript 入口打成 CommonJS（sandbox preload 必須是單一檔案），esbuild 已在依賴樹內，`scripts/build-electron.mjs` 約 30 行。
- 替代方案：electron-vite 6（整合度高，但多一層抽象與依賴）、electron-forge（含打包，屬發版範圍）。

### 字型：Inter（QC-002）

- **來源**：npm `@fontsource-variable/inter` 5.3.0，其 `files/*.woff2` 由 Fontsource 從 Inter 官方發行版（<https://github.com/rsms/inter>，The Inter Project Authors）產生。
- **授權**：SIL Open Font License 1.1。全文在套件內的 `LICENSE`，隨 App 散布時必須一併附上。OFL 允許隨軟體打包與再散布，但不得單獨販售字型，修改後的版本也不得沿用保留名稱。我們沒有修改字型。
- **載入方式**：renderer 匯入 `wght.css` 與 `wght-italic.css`，Vite 把 woff2 複製進建置產物，以相對路徑載入。CSP 的 `font-src 'self' data:` 不允許遠端字型。各子集以 `unicode-range` 劃分，中文仍由 PingFang TC 顯示。
- **發版時**：「項目發版」打包時，要把 `LICENSE`（OFL）放進 App 的第三方授權說明。
- **替代方案**：直接放官方 woff2（少一個依賴，但要自己維護 `@font-face` 與子集）；只用系統字型（不符合視覺基線）。

### mac-server 建置產物：esbuild 打包 + 複製原生模組 + 附帶 Node（QC-030）

- 需求：服務以建置產物安裝到 `~/Library/Application Support/qiu-creator/server`，不靠 tsx、不靠倉庫的 `node_modules`（使用者 2026-11-18 決定）。
- 做法：`services/mac-server/scripts/build.ts` 用 esbuild（0.28.2，MIT，倉庫已有，Mac App 也在用）把 `src/main.ts` 打成單一 ESM `server.mjs`，`@qiu-creator/*` 與純 JS 依賴全部打包進去。
  - 不能打包的套件連同依賴閉包一起複製到產物的 `node_modules/`，解開所有符號連結。名單見 `EXTERNAL_PACKAGES`：
    - 原生模組：better-sqlite3、@napi-rs/keyring、sharp（含 `@img/sharp-*` 與 libvips）。
    - @fastify/swagger-ui：會從自己套件目錄讀靜態檔。
    - file-type：執行期才用非字面的 `import()` 載入 strtok3，打包器看不到。
  - 把建置時的 Node 執行檔複製成 `bin/node`（Node.js 授權 MIT），確保原生模組的 ABI 一致。
- 產物約 200 MB，其中 Node 約 110 MB、libvips 約 20 MB。
- 驗證：`test/build-artifact.test.ts` 把產物複製到倉庫外的資料夾，在沒有倉庫 PATH 的環境啟動，驗證以下幾點：
  - `/health` 的 commit 正確。
  - SQLite 讀寫正常。
  - sharp 能產生縮圖。
  - keyring 原生模組能載入，但不讀 Keychain。
  - `/docs` 可用。
  - 產物裡沒有符號連結。
- 替代方案：
  - `pnpm deploy --prod`：工作區套件是 TypeScript 原始碼，Node 不會對 `node_modules` 內的 `.ts` 做型別剝除，仍需轉譯；pnpm 12 對工作區套件的 deploy 也要額外設定。
  - `tsc` 輸出 JS 加完整 production `node_modules`：產物大、要處理工作區套件的路徑。
  - Node SEA（單一執行檔）：原生模組仍要另外放，而且還是實驗性功能。
  - 用系統 Node（Homebrew）執行：Node 大版本升級會讓原生模組的 ABI 不符，服務起不來。

## 執行期依賴：Mac App 與共用前端套件（QC-002）

| 套件 | 版本 | 授權 | 用在 | 用途 | 替代方案 |
| --- | --- | --- | --- | --- | --- |
| react / react-dom | ^19.3.1 | MIT | mac、markdown-editor-web（peer） | UI | Preact（MDXEditor 不支援） |
| @mdxeditor/editor | ^4.5.0 | MIT | markdown-editor-web | 視覺 Markdown 編輯（見上） | Milkdown、TipTap |
| @fontsource-variable/inter | ^5.3.0 | OFL-1.1（字型）／MIT（打包腳本） | mac | DESIGN.md 指定的 Inter 可變字型（wght 軸，正體與斜體），由 Vite 打進 App，不從網路載入（見「字型」一節） | 直接放 rsms/inter 官方 woff2；系統字體（不符視覺基線） |
| mdast-util-from-markdown | ^2.1.0 | MIT | markdown-editor-web、mac-server | 解析 Markdown，偵測可能有損語法、比對結構 | remark（較重） |
| micromark-extension-gfm / mdast-util-gfm | ^3.0.0 / ^3.1.0 | MIT | markdown-editor-web、mac-server | GFM（表格、腳註、刪除線、待辦）解析 | — |
| micromark-extension-frontmatter / mdast-util-frontmatter | ^2.0.0 / ^2.0.1 | MIT | markdown-editor-web、mac-server | YAML frontmatter 解析 | — |
| yaml | ^2.9.1 | ISC | domain（mac-server 經由它） | 讀寫貼圖與視頻作品的 front matter（QC-045/046）。`parseDocument` 保留註解、未知鍵與鍵的順序，App 寫回使用者手寫的檔案時不會丟資料。沒有其他依賴，純 JS，esbuild 直接打包 | js-yaml（MIT，讀寫會丟註解與格式）；gray-matter（依賴 js-yaml，同樣問題）；自寫子集解析器（使用者手寫的 YAML 形式太多，不可靠） |

QC-010：mac-server 用同一組 mdast 套件與版本，從 Markdown 找出圖片與影音引用（`src/media/markdown-refs.ts`），讓伺服器與編輯器對「什麼算圖片」的判斷一致。沒有新增任何套件。

### 介面多語言：自建 `@qiu-creator/i18n`，不用 i18next（QC-042）

- 沒有新增第三方套件。`packages/i18n` 是工作區內的套件，約兩百行核心程式加上文案目錄，只用標準的 `Intl`（`PluralRules`、`NumberFormat`、`DateTimeFormat`、`RelativeTimeFormat`）。
- 選自建的原因：
  - 型別：每區以繁體物件定義鍵，简体與 English 缺鍵或多鍵都會 typecheck 失敗；`t()` 的鍵是字面型別聯集，打錯鍵會編譯失敗。i18next 要額外的型別擴充設定才做得到，而且做不到三語同鍵的檢查。
  - 需求簡單：只需要佔位符、英文單複數與 `Intl` 格式化，不需要命名空間載入、後端、語言偵測外掛。
  - 第二期 React Native 直接沿用：純 TS，不依賴 DOM 或 Electron。
- 替代方案：i18next + react-i18next（MIT，生態成熟、有 ICU 外掛；但要另外維護型別擴充，多兩個執行期依賴）；FormatJS／react-intl（ICU MessageFormat 完整，但較重，訊息語法對這個專案過度）。日後需要更複雜的語法（性別、選擇）時再評估遷移，目錄的結構可直接轉成 i18next JSON。

## 開發依賴：Mac App 與共用前端套件（QC-002）

| 套件 | 版本 | 授權 | 用在 | 用途 | 替代方案 |
| --- | --- | --- | --- | --- | --- |
| electron | ^45.3.2 | MIT | mac | 桌面殼層（打包屬發版範圍，未加入 electron-builder） | Tauri（非 Node 主程序，與方案不符） |
| vite | ^8.3.8 | MIT | mac | renderer 開發伺服器（5180）與建置 | webpack |
| @vitejs/plugin-react | ^6.3.0 | MIT | mac | React JSX 與 Fast Refresh | — |
| esbuild | ^0.28.2 | MIT | mac | 主程序與 preload 打包（見上） | electron-vite |
| jsdom | ^31.0.1 | MIT | markdown-editor-web | 測試中掛載真實 MDXEditor 做往返驗證。要求 Node ≥24.15，本機 24.14 可跑但安裝時有 engine 警告 | happy-dom（Lexical 相容性較少驗證） |
| @types/react / @types/react-dom / @types/mdast | ^19.3.0 / ^19.3.0 / ^4.0.4 | MIT | mac、markdown-editor-web、mac-server（只有 @types/mdast） | 型別 | — |

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
| @playwright/test | 1.65.1 | Apache-2.0 | 在原始碼建置的 Electron 上執行跨介面與服務的流程測試（`corepack pnpm test:e2e`） | WebdriverIO |
| @types/node | ^24.19.2 | MIT | Node 24 型別 | — |
| @types/better-sqlite3 | ^9.6.0 | MIT | better-sqlite3 型別 | — |
| esbuild（mac-server 開發依賴） | 0.28.2 | MIT | mac-server 建置產物打包（QC-030，見上） | pnpm deploy、tsc |

### 打包：electron-builder 26.18.0（QC-032）

- 授權 MIT；只放在 `apps/mac` 的 devDependencies，不進 App 本體。用途：把已經由 vite／esbuild 打包好的渲染層與主程序包成 `qiu-creator.app`（`--mac dir --arm64`，不做 dmg、不公證、不自動更新）。
- 它會從 GitHub Releases 下載 Electron 執行檔並以 `@electron/get` 驗證；該檔已在 pnpm 的 electron 依賴下載過，沿用快取。
- `electron-winstaller`（Windows 安裝檔用）的 install script 在 `pnpm-workspace.yaml` 的 `allowBuilds` 設為 `false`：我們只做 macOS。
- 簽章：`identity: '-'`（ad-hoc）。未簽名的 Electron 在 Apple Silicon 改過 Info.plist 後 `codesign --verify` 失敗、無法啟動。
- 替代方案：@electron/packager（更輕，沒有 builder 的設定檔與 asar 整合，需自己處理簽章）；Electron Forge（較重，含 makers 與 publisher，用不到）。
- 安裝腳本（`packages/installer`）只用 Node 內建模組與 `tsx`（已有），沒有新增執行期依賴。
- App 圖示（QC-041）：`apps/mac/build/icon.svg` 是原稿，`apps/mac/scripts/build-icon.mjs` 用服務端已有的 sharp 轉出各尺寸，再由 macOS 內建的 `iconutil` 產生 `build/icon.icns`。只在開發時執行，沒有新增依賴。

## 未來候選（尚未加入）

目前沒有。Sharp、tus、ffprobe 已於 QC-005 加入，chokidar 於 QC-007 加入，AI SDK 與 keyring 於 QC-021 加入，electron-builder 於 QC-032 加入（見上）。
