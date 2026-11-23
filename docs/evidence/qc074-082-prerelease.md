# QC-074–082 發版前檢查

- 日期：2026-11-22。執行者：qc-test。
- 對象：main `84a29a0`（chore: close QC-082）。
  - 用乾淨的 detached checkout：`qiu-creator-qc082-pre`，`pnpm install --frozen-lockfile`，工作樹沒有改動。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。
- 全程負載都低於 15。各步驟的 1 分鐘負載寫在下面。
- 跑整套時持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`，跑打包版時持有 `qc-e2e.lock`，沒有和其他 e2e 重疊。

**結論：全部通過，沒有失敗。**

## 1. 原始碼檢查（`84a29a0`）

### 靜態檢查（負載 4.3–5.0）

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Lint | 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過，0 錯誤 |
| 型別 | `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json` | 通過 |
| 格式 | `pnpm format:check`（`prettier --check .`） | 通過 |

### 單元測試（一次一個套件，負載 4.1–4.3）

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| `@qiu-creator/mac` | 47 | 425／0／425 |
| `@qiu-creator/mac-server` | 41 | 516／0／516 |
| `@qiu-creator/markdown-editor-web` | 6 | 62／0／62 |
| `@qiu-creator/domain` | 3 | 45／0／45 |
| `@qiu-creator/installer` | 2 | 39／0／39 |
| `@qiu-creator/i18n` | 3 | 30／0／30 |
| `@qiu-creator/contracts` | 3 | 23／0／23 |
| `@qiu-creator/api-client` | 2 | 22／0／22 |
| `@qiu-creator/agent-sdk` | 1 | 12／0／12 |
| `@qiu-creator/platform-preview` | 3 | 12／0／12 |
| `@qiu-creator/design-tokens` | 1 | 6／0／6 |
| **合計** | 112 | **1192／0／1192** |

### 整套 e2e（工作區 Electron，背景模式，視窗不上屏）

先 `pnpm --filter @qiu-creator/mac build`，再跑 `playwright test --config=e2e/playwright.config.ts`。

| 模式 | 開始／結束負載 | passed | failed | skipped | total | 用時 |
| --- | --- | --- | --- | --- | --- | --- |
| 一般 | 6.11 → 4.70 | 58 | **0** | 10 | 68 | 3.0 分 |
| `QC_E2E_MOTION=on` | 4.70 → 3.26 | 59 | **0** | 9 | 68 | 3.9 分 |

- skipped 都是設計上的模式分工，不是跳過失敗：
  - 一般模式跳過只在 `QC_E2E_MOTION=on` 才錄影的動效測試。
  - 動效模式跳過已由錄影那支以正常速度涵蓋的測試。
  - 依據是各 spec 裡的 `test.skip(motionOn …)` 與 `test.skip(!motionOn …)`。
- 沒有 flaky，也沒有重試（設定裡沒有 retries）。

## 2. 打包版指定 spec

- 對象：qc-release 打包的 `--mac dir` 未封裝版本，main `84a29a0`，含遷移 0019。
  - 路徑：`qiu-creator-release/apps/mac/release/mac-arm64/qiu-creator.app`。
  - ad-hoc 簽名，codesign verify OK，沒有安裝，沒有碰 `/Applications`，也沒有碰 launchd。
- 啟動方式：經 desktop fixture，設 `CREATORHUB_E2E_APP=<…/MacOS/qiu-creator>`。
  - 背景模式：視窗隱藏。
  - 臨時 `CREATORHUB_HOME`、臨時 userData。
  - AI 全部走本機假服務。
- 服務端：fixture 的測試服務（工作區原始碼，同一個 commit）。

| Spec | 內容 | 一般模式 | 動效開啟 |
| --- | --- | --- | --- |
| `ai-image-editor.spec.ts` | 選取浮動工具列、原位候選、配圖與封面；沒有圖片模型與三語；動效錄影 | 2 passed，1 skipped（錄影只在動效模式） | 3 passed |
| `prompts-page.spec.ts`（Prompt 頁） | 內建唯讀與複製、自訂指令、排序、搜尋高亮、刪除；AI 建議 diff；匯出匯入；淺深色與 English | 4 passed | 4 passed |
| `editor-preview.spec.ts`（編輯頁內預覽） | 平台切換、版本表單、AI 標題與封面、互斥；窄視窗、深色與三語 | 2 passed | 2 passed |
| `library-paging.spec.ts` | 超過一頁時捲到底載入全部、計數是全體、⌘A 選取篩選下的全部 | 1 passed | 1 passed |
| `search-highlight.spec.ts`（含拼音） | 卡片、列表、摘要與素材的即時標記，輸入法組字中不標；拼音首字母與全拼（QC-079） | 2 passed | 2 passed |
| `asset-lightbox.spec.ts` | 素材庫大圖預覽：開關、切換、縮放、平移、視頻、焦點 | 1 passed | 1 passed |
| `ai-model-fallback.spec.ts` | 中轉站清單讀取失敗時仍列出已存模型，並提示原因（QC-082） | 1 passed | 1 passed |
| **合計** | | **13 passed，0 failed，1 skipped（共 14）** | **14 passed，0 failed（共 14）** |

- 負載：一般模式 2.70 → 2.06（1.1 分），動效模式 1.82 → 2.24（1.1 分）。
- 結束後打包版沒有殘留行程。已通知 qc-release 可以刪除打包用的 worktree。

## 3. 截圖（打包版，一般模式）

截圖由 spec 本身的截圖開關產生（`QC076_SHOTS`、`QC075_SHOTS`、`QC079_SHOTS`），尺寸是 1440×900 或 1600×960 的隱藏視窗。

1. **編輯頁打開預覽分欄**：[`qc074-082-prerelease/1-editor-preview.png`](qc074-082-prerelease/1-editor-preview.png)
   - 小紅書版本：標題 16／20、正文、封面 3:4、標籤；右側手機模擬。
   - 頂部有四個平台切換；左側原稿不受影響。
2. **Prompt 頁**：[`qc074-082-prerelease/2-prompt-page.png`](qc074-082-prerelease/2-prompt-page.png)
   - 6 個內建（唯讀、帶鎖）、2 個自訂。
   - 自訂指令「小紅書口吻」：變數膠囊、用在、預設模型、輸出語言、「請 AI 改寫這條指令」。
3. **拼音搜尋**：[`qc074-082-prerelease/3-pinyin-search.png`](qc074-082-prerelease/3-pinyin-search.png)
   - 輸入首字母 `cy`，兩張卡片標題的「常用」以黃色高亮標出。
   - 計數「2 個結果 · 共 3 個」。

## 沒有驗證的項目

- 真實螢幕上的顯示與 120 Hz 動效：`NOT_VERIFIED`（依規定視窗不上屏）。
- 安裝到 `/Applications`、launchd 常駐、遷移 0019 在使用者真實資料上的執行：不在本次範圍，由 qc-release 在安裝時處理。
- 真實雲端 AI（New API、GPT 等）：一律用假服務，沒有發出真實請求。
