# QC-110 發版前檢查：QC-102、QC-103、QC-104

- 日期：2026-11-26。執行者：qc-test。
- 版本：`7fc7ffb`。乾淨 checkout `qiu-creator-qc110`，先跑 `pnpm install --frozen-lockfile`。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。全程負載低於 15。
- 隔離：
  - 服務都用臨時 `CREATORHUB_HOME`、臨時 HOME 和臨時埠 48951。
  - Agent 權杖是新建的測試權杖。
  - 沒有碰真實的 `~/CreatorHub`、`/Applications`、launchctl，也沒有連 7420 服務。
  - 沒有呼叫任何第三方 API。

**結論：不能發版（`7fc7ffb`）。**

- 閘門都通過。單元測試 1402／0／1402。
- 整套 e2e 兩種模式都是 **3 failed**（負載 2.4～4.1）。三個失敗是同一個根因，見第 4 節：
  - QC-103 把 Agent 權杖送來的**整份**文字轉成目標字體，連使用者原本的繁體文字也一起轉。
  - 測試面上，這三支 spec 用 Agent 權杖寫繁體，然後期望原樣顯示。
  - 產品面上，Agent 只改一行的提案，會把使用者沒動過的繁體行也改成簡體。
- QC-104 全屏的 spec 在兩種模式都通過。
- 用建置產物跑 `creatorhub mcp`（stdio），總監指定的情境（第 3 節 #1～#9）都符合 QC-102 和 QC-103 的規格。
- schema 是 `0023`。

## Plan

1. 從 `origin/main` 開 worktree，持 `qc-fullsuite.lock` 跑 lint、typecheck、format 和逐套件單元測試。
2. 持 `qc-e2e.lock`，在背景跑整套 e2e：一般模式和 `QC_E2E_MOTION=on` 各一次。
3. 用 `services/mac-server` 的 `build` 建出安裝版目錄結構（含 `bin/node` 和 `bin/creatorhub`），只帶 `PATH=/usr/bin:/bin` 啟動。
4. 用 Agent 權杖跑真的 `creatorhub mcp`，用 JSON-RPC 走完 QC-102 和 QC-103 的情境，再核對磁碟上的 `source.md` 和 schema。

## 1. 原始碼閘門

| 項目 | 結果 |
| --- | --- |
| 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過 |
| `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| `pnpm format:check` | 通過 |

單元測試一次跑一個套件，負載 3.2 → 4.3：

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac-server | 48 | 592／0／592 |
| @qiu-creator/mac | 56 | 483／0／483 |
| @qiu-creator/markdown-editor-web | 6 | 62／0／62 |
| @qiu-creator/domain | 5 | 58／0／58 |
| @qiu-creator/agent-sdk | 8 | 54／0／54 |
| @qiu-creator/installer | 2 | 42／0／42 |
| @qiu-creator/i18n | 3 | 30／0／30 |
| @qiu-creator/platform-preview | 4 | 27／0／27 |
| @qiu-creator/contracts | 4 | 26／0／26 |
| @qiu-creator/api-client | 2 | 22／0／22 |
| @qiu-creator/design-tokens | 1 | 6／0／6 |
| **合計** | 139 | **1402／0／1402** |

## 2. 整套 e2e（背景模式，持 `qc-e2e.lock`）

先跑 `pnpm --filter @qiu-creator/mac build`（exit 0），再跑 `playwright test --config=e2e/playwright.config.ts`。

| 模式 | passed | failed | skipped | 時間 | 負載（開始 → 結束） |
| --- | --- | --- | --- | --- | --- |
| 一般 | 62 | 3 | 10 | 3.6m | 2.4 → 3.5 |
| `QC_E2E_MOTION=on` | 63 | 3 | 9 | 4.8m | 3.5 → 4.1 |

兩種模式失敗的是同樣三支：

| spec | 失敗的斷言 | 實際 |
| --- | --- | --- |
| `agent-attached-media.spec.ts:24`（QC-102） | `:57` 標題 `toHaveValue('嵐山貼圖')` | `岚山贴图`：Agent 權杖建的作品被轉成簡體 |
| `agent-proposals.spec.ts:62`（QC-091） | `:125` 變更清單 `toHaveCount(3)` | 4：Agent 只改了 3 處，標題行 `# 京都紅葉季七日慢遊路線` 被轉成簡體，多出第 4 處 |
| `agent-proposals.spec.ts:336`（QC-092） | `:418` 卡片 `京都錦市場吃什麼` 上的「由 Agent 歸入」標示 | 找不到卡片：Agent 建的作品標題變成 `京都锦市场吃什么` |

推論：

- QC-102（f9fbdcd）和 QC-103（ba80289）是分開合併的。QC-102 的 e2e 用 Agent 權杖寫繁體標題。
- `agent-proposals` 這兩支在 QC-103 之前就有了，QC-103 的交付顯然沒有跑整套 e2e 的這兩支。

QC-104 的 `video-fullscreen.spec.ts:35` 在兩種模式都通過：

- 素材庫預覽、大圖預覽和視頻作品都能全屏。
- 按 Esc 會退出全屏，大圖預覽要再按一次 Esc 才關。

QC-102 的 spec 在拍第一張截圖之前就失敗了，所以這次沒有截圖。

## 3. 建置產物＋`creatorhub mcp` 端到端情境

### 環境

- 用 `pnpm build --out <tmpHOME>/Library/Application Support/qiu-creator/server` 建置。
  - `server.mjs` 裡有 OpenCC 轉換器，字表在建置產物內。
- 用 `env -i PATH=/usr/bin:/bin` 帶臨時 HOME 和 `CREATORHUB_HOME`，再以 `bin/node server.mjs` 啟動。
- Agent 權杖的權限是 `read, import, write, propose`。
- `bin/creatorhub mcp` 只帶 `CREATORHUB_URL`、`CREATORHUB_TOKEN`、`PATH`、`HOME`。
- 腳本和完整輸出放在共用筆記資料夾的 `qc110-prerelease/`（`qc110_agent.py`、`scenario-output.json`），不進倉庫。

### 結果

| # | 情境 | 預期 | 實際 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `initialize`、`tools/list`、`server_status` | 有 instructions，回報目標字體 | 40 支工具；instructions 寫明目標字體；`text_script.default = zh-Hans` | 通過 |
| 2 | 貼圖作品：用 `asset_upload_file` 傳兩張圖（`紅葉.png`、`竹林.png`），先掛紅葉，再把竹林掛在 `position: 0` | 順序是竹林、紅葉，並寫進 front matter | `work_get` 的 `media.images` 依序是竹林（present）、紅葉（present）；front matter 是 `images: [assets/竹林.png, assets/紅葉.png]` | 通過 |
| 3 | 視頻作品：掛 `walk.webm`（role video）和 `封面.png`（role cover） | 讀作品看得到視頻和封面 | `media.video` 是 `assets/walk.webm`（8 秒，360×640，present），`media.cover` 是 `assets/封面.png`；front matter 有 `video:` 和 `cover:` | 通過 |
| 4 | 磁碟核對 | 檔案複製進作品，每次掛上都留一個版本 | `source.md` 的 front matter 同上；作品的 `assets/` 有對應檔案；`revisions/` 每次掛上多一個版本（貼圖 3 版，視頻 3 版） | 通過 |
| 5 | Agent 用繁體建作品（標題、正文、tags；正文含 URL 和程式碼區塊） | 存成簡體，回應帶 `script_conversion` | 標題是 `岚山竹林与渡月桥`，tags 是 `旅游`、`摄影`；`script_conversion = {zh-Hans, [title, markdown, tags]}`；URL `https://example.com/繁體` 和程式碼區塊裡的繁體原樣保留 | 通過 |
| 6 | Agent 權杖 `PUT /settings/text-script` | 拒絕（只限主權杖） | 403 | 通過 |
| 7 | 主權杖改成 `zh-Hant` 之後，Agent 用簡體建作品 | 轉成繁體 | `server_status` 回報 `zh-Hant`；標題是 `簡體標題測試`，正文 `這裡的風景讓人難忘，後來我們發現了一家麵館。`，tags 是 `旅遊`；`script_conversion = {zh-Hant, …}` | 通過 |
| 8 | 改回 `zh-Hans`，主權杖用繁體 `POST /works` | 不轉換 | 201；標題和正文都是原本的繁體；沒有 `script_conversion` | 通過 |
| 9 | 項目覆寫：全域是 `zh-Hans`，項目 `text_script = zh-Hant`，Agent 在這個項目裡建簡體作品 | 依項目轉成繁體 | `臺北簡體稿`，`script_conversion = {zh-Hant, [title, markdown]}` | 通過 |

- MCP 連線關掉 stdin 後以 exit 0 結束，stderr 是空的。
- 資料庫裡 `schema_migrations` 最新一筆是 `0023 project_text_script`。
- `app_settings` 的 `work_text_script` 最後是 `zh-Hans`。

## 4. 缺陷：Agent 提案或修改時，使用者原本的繁體文字也被轉換（擋發版）

### 重現

在建置產物上用臨時服務重現。腳本和輸出放在筆記資料夾的 `qc110-prerelease/proposal-repro.json`。

1. 全域設定是 `zh-Hans`（預設）。
2. 主權杖建一篇繁體文章：

   ```text
   # 京都紅葉季七日慢遊路線

   第四天從京都車站搭 JR 奈良線到稻荷站，大約走 5 分鐘。

   伏見稻荷大社免門票。
   ```

3. Agent 權杖（`propose`）用 `POST /works/:id/proposals` 送出整份 Markdown，只改最後一行，改成 `伏見稻荷大社免門票，清水寺門票 500 日圓。`。

### 結果

- 201，`script_conversion = {zh-Hans, [markdown]}`。
- **3 個 hunks**：
  - 標題行被改成 `# 京都红叶季七日慢游路线`。
  - 第一段被改成 `第四天从京都车站搭 JR 奈良线到稻荷站，大约走 5 分钟。`。
  - 最後一行也是簡體。
- 使用者如果按「全部採用」，自己的繁體原文會整篇變成簡體。

### 預期

規格在 `packages/contracts/src/text-script.ts` 和 ba80289 的提交說明裡寫明：

> Owner writes and existing works are never converted.

所以只有 Agent 新寫的文字該轉換，使用者沒動過的行不該出現在 diff 裡。

### 根因

- `TextScriptService.forAgent`（`services/mac-server/src/works/text-script-service.ts:117`）對 Agent 送來的整個欄位做轉換，不分哪些是原本就有的內容。
- 下面這些端點都要求或常見是「送整份」：
  - 提案（`routes/proposals.ts:62`）：markdown。
  - `PATCH /works/:id`（`server.ts:690`，即 MCP 的 `work_update_body` 和 `work_update_meta`）：markdown 和整組 tags。
  - 平台版本（`routes/variants.ts:113`）。
- 結果是：只要原文用的字體和目標字體不同，Agent 每次提案或修改，都會把使用者原本的文字一起轉掉。
  - 對「允許直接修改正文」的權杖來說，這會在沒經過 diff 確認的情況下直接改寫原文。這違反 AGENTS.md「嚴禁 AI 直接覆蓋使用者原文」的精神。雖然有快照可以恢復，但使用者不會預期這種改動。
- `PATCH` 和 variants 的部分是讀程式碼得出的推論，沒有實際跑：**NOT_VERIFIED**。提案的部分已經實測。

### 建議方向（給修 BUG 的會話參考，不是本次範圍）

- 只轉換相對於 base（目前版本）新增或修改的部分。例如對 base 和 Agent 文字做行或詞級 diff，只轉換新增的片段；tags 只轉換新加的。
- 或者：作品既有內容的字體和目標不同時，不轉換，改成在回應裡提示。
- 三支 e2e 也要改成「Agent 寫入時預期被轉換」，或在測試裡用主權杖建作品。如何調整由修正的會話決定，不得放寬斷言。

## 5. 觀察（不擋發版）

- OpenCC 的簡轉繁用台灣標準，會把「台北」轉成「臺北」。這是 OpenCC 字表的正常行為，不是缺陷。使用者若偏好「台」，要另開需求。
- 貼圖作品的 description 是 Agent 傳的簡體，原樣存下。作品檔名（例如 `紅葉.png`）不會轉換，符合「路徑不轉」的設計。
- 我寫的跑測腳本有一行對根目錄的 `qiu-creator` 套件呼叫 `pnpm test`，因為環境沒有 `pnpm` 指令而失敗。那只是遞迴包裝，不算測試，上表也沒有計入。各套件都另外單獨跑過。

## 6. 收尾

- 臨時服務已停，埠 48951 已釋放。
- `qc-fullsuite.lock` 和 `qc-e2e.lock` 都已釋放。
- 臨時目錄和 worktree 在總監合併後刪除。
