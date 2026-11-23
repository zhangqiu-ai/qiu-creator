# QC-084 發版前檢查

- 日期：2026-11-23。執行者：qc-test。
- 對象：main `9f766be`（Merge QC-084: editor preview redesign）。
  - 用乾淨的 checkout：`qiu-creator-qc084-pre`，從 `origin/main` 開，`pnpm install --frozen-lockfile`，檢查時工作樹沒有改動。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。
- 全程負載都低於 15。各步驟的 1 分鐘負載寫在下面。
- 跑整套時持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`，跑打包版時持有 `qc-e2e.lock`，沒有和其他 e2e 重疊。

**結論：**

- 規定的閘門都通過：靜態檢查；單元 1220／0／1220；兩種模式的整套 e2e 都 0 failed；打包版三支 spec 兩種模式都 7／7；遷移演練 32 項 0 失敗，回退也符合預期。
- 但**加跑時 editor-tabs 重現了偶發失敗**（32 次機會中失敗 3 次）。根因是測試端的時序競爭，不是產品缺陷，詳見 1 節。
- 另外發現一個介面缺陷：公眾號摘要露出 Markdown 語法（見「發現的問題」）。
- 兩者都沒有修。

## 1. 原始碼檢查（`9f766be`）

### 靜態檢查（負載 4.8–7.2）

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Lint | 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過，0 錯誤 |
| 型別 | `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json` | 通過 |
| 格式 | `pnpm format:check`（`prettier --check .`） | 通過 |

### 單元測試（一次一個套件，負載 6.8–7.2）

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| `@qiu-creator/mac-server` | 42 | 522／0／522 |
| `@qiu-creator/mac` | 49 | 434／0／434 |
| `@qiu-creator/markdown-editor-web` | 6 | 62／0／62 |
| `@qiu-creator/domain` | 3 | 45／0／45 |
| `@qiu-creator/installer` | 2 | 39／0／39 |
| `@qiu-creator/i18n` | 3 | 30／0／30 |
| `@qiu-creator/platform-preview` | 4 | 25／0／25 |
| `@qiu-creator/contracts` | 3 | 23／0／23 |
| `@qiu-creator/api-client` | 2 | 22／0／22 |
| `@qiu-creator/agent-sdk` | 1 | 12／0／12 |
| `@qiu-creator/design-tokens` | 1 | 6／0／6 |
| **合計** | 116 | **1220／0／1220** |

### 整套 e2e（工作區 Electron，背景模式，視窗不上屏）

先 `pnpm --filter @qiu-creator/mac build`，再跑 `playwright test --config=e2e/playwright.config.ts`。

| 模式 | 開始／結束負載 | passed | failed | skipped | total | 用時 |
| --- | --- | --- | --- | --- | --- | --- |
| 一般 | 4.87 → 4.18 | 58 | **0** | 10 | 68 | 3.0 分 |
| `QC_E2E_MOTION=on` | 4.18 → 5.17 | 59 | **0** | 9 | 68 | 4.0 分 |

- skipped 都是設計上的模式分工（各 spec 的 `test.skip(motionOn …)`／`test.skip(!motionOn …)`），不是跳過失敗。
- 這兩次沒有 flaky，也沒有重試（設定裡沒有 retries）。

### editor-tabs.spec 偶發失敗的追查

- **規定的兩次整套（一般、動效）裡都通過**（各 5／5）。
- 為了確認，另外加跑（都持有兩把鎖，負載 3.3–4.6）：
  - `--repeat-each=30` 單跑 editor-tabs（150 次測試）：**1 failed**，149 passed。
  - 一般模式整套再跑兩次：**兩次都 failed 1**（57 passed，10 skipped）。
- 三次失敗的位置和症狀完全一樣：
  - 測試「開多個作品、切換保留狀態…」的步驟「切換時保留模式、草稿、游標與捲動」，`editor-tabs.spec.ts:176`。
  - 預期游標 21，實際 12。
- 三次都是同一個根因：**測試端的時序競爭，不是產品缺陷**。
  - 證據：失敗快照（`error-context.md`）裡原始碼的內容是「`## 第 1 節 QZ分頁…`」。也就是說，`Z` 插在第 11 個字（上一步還原的游標）後面，不在測試設定的第 20 個字。
  - 經過：
    1. 前一小段（「在同一個 task 裡捲動並切走」）切回甲篇後，只用 `scrollTop` 等於 900 判斷還原完成（第 139–141 行）。
    2. 產品在切回後的**下一個畫格**（`EditorPage.tsx` 的 `requestAnimationFrame`）才把游標放回 11、再設捲動。但隱藏的分頁本來就保留著 `scrollTop = 900`，所以這個 poll 在那個畫格之前就成立了。
    3. 測試接著 `setSelectionRange(20, 20)`，然後還原的畫格才執行，把游標改回 11。
    4. `execCommand('insertText', 'Z')` 於是插在 11，游標變成 12。產品把 12 正確地存起來再還原，測試卻預期 21。
  - 產品行為是對的：切回分頁時把游標放回離開時的位置，並在切回後的第一個畫格完成。真人不可能在那一個畫格內點到別處。
  - 舊的 QC-054 失敗記錄（11-21 20:30，預期 11、實際 10）早於修正 `f037f04`（同日 21:26），和這次是不同的問題。
  - 為什麼這次比較常出現，沒有證據可以下結論。可能是 QC-084 讓切換後的第一個畫格變慢，讓這個空隙更容易被測試搶先。
- **建議修法（我沒有改，等總監決定）**：在第 141 行之後、`setSelectionRange(20, 20)` 之前，加一個等待游標還原的 poll，例如 `expect.poll(selectionStart).toBe(11)`。這是補一個等待條件，不加重試、不加長逾時、不放寬斷言。
- 這個失敗和 QC-084 的預覽功能沒有關係，也不影響打包版；但在修好之前，一般模式整套會偶發紅燈。

## 2. 打包版實測

- 對象：qc-release 打包的 `--mac dir` 未封裝版本，main `9f766be`。
  - 路徑：`qiu-creator-release/apps/mac/release/mac-arm64/qiu-creator.app`。
  - ad-hoc 簽名，codesign verify OK（qc-release 回報）；沒有安裝，沒有碰 `/Applications`，也沒有碰 launchd。
- 啟動方式：經 desktop fixture，設 `CREATORHUB_E2E_APP=<…/MacOS/qiu-creator>`。
  - 背景模式：視窗隱藏。臨時 `CREATORHUB_HOME`、臨時 userData。
  - AI 全部走本機假服務。
- 服務端：fixture 的測試服務（工作區原始碼，同一個 commit）。

| Spec | 內容 | 一般模式 | 動效開啟 |
| --- | --- | --- | --- |
| `editor-preview.spec.ts` | 三個畫面、原位編輯、跟隨原稿、AI 標題與封面、縮放、收合與寬度、互斥；超出正文上限、409、窄視窗、深色與三語 | 2 passed | 2 passed |
| `image-post.spec.ts` | 新建貼圖、加圖、上限、排序、封面、預覽分欄；檔案遺失、篩選、三語與深色 | 2 passed | 2 passed |
| `video-work.spec.ts` | 選視頻、截取封面、抖音文案、Gemini 理解；長視頻、超過 2 GB、失敗重試、上傳中鎖住；金鑰晚設定 | 3 passed | 3 passed |
| **合計** | | **7 passed，0 failed（共 7）** | **7 passed，0 failed（共 7）** |

- 負載：一般模式 4.01 → 3.75（25 秒），動效模式 3.75 → 5.20（27 秒）。
- 結束後打包版沒有殘留行程。

## 3. 截圖（打包版，一般模式，1600×960 隱藏視窗）

- 每個平台的三個畫面由一支只用來截圖的腳本產生：開一篇三張配圖、兩個標籤的文章，打開預覽，逐一切平台與畫面截圖。
  - 腳本不屬於整套 e2e，沒有提交；放在共用筆記資料夾 `qc084-rehearsal/qc084-shots.perf.ts`，用 perf 設定執行。
  - 第一次執行失敗：腳本在編輯器載入前就按 ⌘⇧P。這是腳本的錯，補上「等正文出現」後通過（1 passed）。
- 縮放與正文超出字數兩張來自 `editor-preview.spec.ts` 本身的 `QC084_SHOTS` 開關。
- 14 張都看過，畫面對應正確。

| 平台 | 發布編輯 | 刷到時 | 正文 |
| --- | --- | --- | --- |
| 小紅書 | [01](qc084-prerelease/01-xiaohongshu-publish.png) | [02](qc084-prerelease/02-xiaohongshu-feed.png) | [03](qc084-prerelease/03-xiaohongshu-body.png) |
| 公眾號 | [04](qc084-prerelease/04-wechat_mp-publish.png) | [05](qc084-prerelease/05-wechat_mp-feed.png) | [06](qc084-prerelease/06-wechat_mp-body.png) |
| 抖音 | [07](qc084-prerelease/07-douyin-publish.png) | [08](qc084-prerelease/08-douyin-feed.png) | [09](qc084-prerelease/09-douyin-body.png) |
| 視頻號 | [10](qc084-prerelease/10-wechat_channels-publish.png) | [11](qc084-prerelease/11-wechat_channels-feed.png) | [12](qc084-prerelease/12-wechat_channels-body.png) |

- [13 縮放 100%](qc084-prerelease/13-zoom-100.png)：小紅書正文，手機放大到 100%，跟隨中的段落高亮。
- [14 正文超出字數](qc084-prerelease/14-over-limit.png)：小紅書正文 1,254 字，截斷線「第 1,000 字・之後 256 字會被截斷」，「在原稿標出第 1,000 字」與「用 AI 縮寫」；平台分頁上小紅書、抖音、視頻號有橘點，公眾號沒有。

## 4. 舊資料遷移演練（f450731 → 9f766be，0019 → 0020）

全部在臨時目錄（session scratchpad 下的 `qc084-rehearsal/home`）裡做，`CREATORHUB_HOME` 指向它，權杖是當場產生的測試值。沒有碰真實的 `~/CreatorHub`，也沒有執行 `/Applications` 裡的已安裝版本。

### 步驟

1. **舊版建資料。** 用 detached worktree `f450731` 從原始碼啟動服務（`node --import tsx src/main.ts`，埠 7491），用 api-client 建四篇文章。每篇都有封面連結，並用舊版規則產生四個平台版本：
   - **A 沒改過**：只產生草稿。
   - **B 改標題封面**：小紅書、抖音兩個平台的標題與封面改掉（封面換成另一張圖）。
   - **C 另改正文**：小紅書、公眾號兩個平台的標題、封面、正文都改掉。
   - **D 原稿後改**：只產生草稿，之後改原稿正文（多一段）。這是額外加的對照組：版本內容和原稿不同，但原因是原稿後來改了，應該跟隨原稿。
   - 結果：資料庫在 0019，16 筆 `platform_variants`。我先存了一份快照。
2. **新版開啟。** 停掉舊版，用 `9f766be` 從原始碼在同一個 home 啟動（埠 7492）。
   - 啟動後是 0020，16 筆都是 `overrides_ready = 0`；轉換在第一次讀取時進行（`VariantService.backfill`）。
   - 用 api-client 讀每篇的四個平台，檢查每個欄位的來源；讀完後 16 筆都是 `overrides_ready = 1`。
3. **舊欄位不變。** 把 `platform_variants` 與 `platform_variant_revisions` 的所有舊欄位和快照逐行比對，完全相同（196 行）。
4. **回退。** 在 home 的複本上執行 `VARIANT_OVERRIDES_ROLLBACK_SQL`：
   - 舊欄位資料與表結構都和 0020 之前的快照完全相同，`schema_migrations` 回到 0019。
   - 用 `f450731` 開這份複本，C 的小紅書與公眾號仍讀到使用者改過的標題和正文。

### 結果（32 項檢查，0 失敗）

| 作品 | 平台 | 標題 | 封面 | 正文 | 標籤／配圖 |
| --- | --- | --- | --- | --- | --- |
| A 沒改過 | 四個平台 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 |
| B 改標題封面 | 小紅書、抖音 | **覆寫**（改過的值） | **覆寫**（換過的圖） | 跟隨原稿 | 跟隨原稿 |
| B 改標題封面 | 公眾號、視頻號 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 |
| C 另改正文 | 小紅書、公眾號 | **覆寫** | **覆寫** | **legacy**（`legacy_override`，使用者改寫的正文） | 跟隨原稿 |
| C 另改正文 | 抖音、視頻號 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿 |
| D 原稿後改 | 四個平台 | 跟隨原稿 | 跟隨原稿 | 跟隨原稿，含原稿後來加的段落 | 跟隨原稿 |

演練腳本（`seed-old.ts`、`verify-new.ts`、`rollback-sql.ts`）沒有提交，放在共用筆記資料夾 `qc084-rehearsal/`。

## 發現的問題（沒有修，交給前端）

1. **公眾號「發布編輯」的正文摘要露出 Markdown 原始語法**（P3，介面）。
   - 現象：截圖 [04](qc084-prerelease/04-wechat_mp-publish.png) 的正文框顯示「…改動最多的反而是光。 `![](assets/p0.png) ![](assets/p1.png)` …」，字數「214 / 20000」也把語法算進去。其他三個平台是純文字，沒有這個問題。
   - 根因：`apps/mac/src/renderer/preview/PhoneScreens.tsx:464` 的 `BodyMini` 直接把 `body.text` 交給 `excerpt()`。公眾號的 `body_format` 是 `markdown`，所以圖片、標題等語法原樣進了摘要。
   - 影響：只影響預覽裡的這個摘要框。「正文」畫面的排版正常（截圖 06），原稿與資料都沒有受影響。

## 觀察（不判定為缺陷，請前端或設計確認）

- 截圖 13（縮放 100%）：手機放大後，上方浮著的畫面分頁與「復原」提示蓋在手機內容上。看起來是浮層的設計，只是在 100% 下會遮住內容頂端。
- 截圖 14（超出字數）：左邊編輯器的三張圖在截圖當下還是虛線佔位框。spec 截圖時圖片可能還沒載入完，不影響斷言；其他截圖裡的圖都正常顯示。

## 沒有驗證的項目

- 真實螢幕上的顯示與 120 Hz 動效：`NOT_VERIFIED`（依規定視窗不上屏）。
- 安裝到 `/Applications`、launchd 常駐、0020 在使用者真實資料上的執行：不在本次範圍，由 qc-release 在安裝時處理。
  - 演練用的是從原始碼跑的舊版與新版服務，不是打包版。
- 真實雲端 AI：一律用假服務，沒有發出真實請求。
