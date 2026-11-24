# QC-085 發版前檢查

- 日期：2026-11-23。執行者：qc-test。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。全程負載低於 15，各步驟的 1 分鐘負載寫在下面。
- 跑整套時持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`，跑其他 e2e 時持有 `qc-e2e.lock`，沒有和其他 e2e 重疊。
- 檢查分兩輪：
  - 第一輪在 `9baf141`，查出 new-api 偶發失敗的根因在產品端（第 4 節）。
  - 前端修正 `81b59c6`，合併成 `a121162` 後，第二輪重跑整份檢查（第 1–3 節）。

**結論（`a121162`）：通過。**

- 靜態檢查通過，單元測試 1233／0／1233。
- 整套 e2e：一般模式和動效模式都是 0 failed。
- new-api 在動效模式連跑 10 次都通過。探針確認，從設定頁回到作品時邊欄不再閃爍。
- 打包版五支 spec 在兩種模式下都是 14 passed、0 failed。截圖六張都看過。
- schema 仍是 `0020`。
- 有一項觀察，在第 5 節：1280 寬的視窗下，編輯欄只剩 560 px，頂列換行、工具列出現橫向捲軸。不算缺陷，請前端判斷。

## 1. 原始碼檢查（`a121162`）

用乾淨的 checkout：`qiu-creator-qc085-pre`。分支重定基到 `origin/main` 的 `a121162`，上面只多這份文件；接著跑 `pnpm install --frozen-lockfile`。探針只暫時放進工作樹，跑完就移走了，檢查時工作樹沒有其他改動。

### 靜態檢查（負載 5.5）

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Lint | 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過 |
| 型別 | `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| 格式 | `pnpm format:check` | 通過 |

### 單元測試（一次一個套件，負載 5.1 → 6.7）

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac | 50 | 445／0／445 |
| @qiu-creator/mac-server | 42 | 522／0／522 |
| @qiu-creator/markdown-editor-web | 6 | 62／0／62 |
| @qiu-creator/domain | 3 | 45／0／45 |
| @qiu-creator/installer | 2 | 39／0／39 |
| @qiu-creator/i18n | 3 | 30／0／30 |
| @qiu-creator/platform-preview | 4 | 27／0／27 |
| @qiu-creator/contracts | 3 | 23／0／23 |
| @qiu-creator/api-client | 2 | 22／0／22 |
| @qiu-creator/agent-sdk | 1 | 12／0／12 |
| @qiu-creator/design-tokens | 1 | 6／0／6 |
| **合計** | **117** | **1233／0／1233** |

`@qiu-creator/mac` 比第一輪多 2 個測試，是 `81b59c6` 加的邊欄量測測試。

### 整套 e2e（背景模式，開發建置）

| 輪次 | 負載（開始 → 結束） | 結果（68 支） | 時間 |
| --- | --- | --- | --- |
| 一般 | 6.70 → 3.87 | 58 passed，0 failed，10 skipped | 2.9 分 |
| `QC_E2E_MOTION=on` | 3.87 → 4.43 | 59 passed，0 failed，9 skipped | 4.0 分 |
| `QC_E2E_MOTION=on`，`--repeat-each=10 new-api` | 4.43 → 4.48 | 10 passed，0 failed | 28 秒 |

skipped 的是只在其中一種模式執行的 spec，和以往相同。

### 邊欄不再閃爍（探針）

探針用第一輪同一支（見第 4 節），在 1280 寬的視窗裡來回作品頁和設定頁 8 次。每次回到作品，都連續檢查 40 次 AI 分頁是否可見；同時逐畫格記錄編輯區寬度和邊欄的 class。

| 模式 | AI 分頁可見性（8 次×40 次） | 邊欄 class |
| --- | --- | --- |
| 一般 | 320／320 可見 | 每次回來都是 `side side--open`，沒有出現 `side--drawer` 或 `side--collapsed` |
| 動效 | 320／320 可見 | 同上 |

修正前回到作品時是 `side--open` → `side--collapsed side--drawer`，修正後不再這樣切換。編輯區仍是 1048 px，邊欄縮到 488 px 後停靠。

## 2. 打包版（`a121162`）

qc-release 在 `a121162` 建了 `--mac dir`：ad-hoc 簽名，`codesign --verify` 通過，**沒有安裝**。

測試透過 `CREATORHUB_E2E_APP=…/qiu-creator.app/Contents/MacOS/qiu-creator` 執行打包版，一律背景模式，home 和 userData 都是臨時目錄。

### 五支 spec

範圍：editor-preview、image-post（含 image-post-motion）、video-work、editor-tabs、new-api。

| 模式 | 負載（開始 → 結束） | 結果 |
| --- | --- | --- |
| 一般 | 4.07 → 4.18 | 14 passed，0 failed，1 skipped |
| `QC_E2E_MOTION=on` | 4.18 → 4.79 | 14 passed，0 failed，1 skipped |

skipped 的是 image-post-motion 的兩支之一，每種模式各跳過一支（一般模式不錄影，動效模式不跑非錄影版）。

### 截圖

截圖在打包版上拍，淺色模式。檔案在 `qc085-prerelease/`。

| 檔案 | 視窗 | 內容 |
| --- | --- | --- |
| `01-preview-tab.png` | 1600×960 | 邊欄停靠，預覽分頁：小紅書「刷到時」畫面，自己的筆記標在第一格 |
| `02-ai-tab.png` | 1600×960 | AI 分頁：改寫、Prompt、「尚未設定 AI 金鑰」提示 |
| `03-collapsed.png` | 1600×960 | 收合成 44 px 圖示列，編輯區撐滿。右上角的「展開側邊欄」提示是滑鼠停在收合鈕上留下的 |
| `04-docked-1280.png` | 1280×800 | 1280 寬時停靠（編輯區 1048 px、邊欄 488 px），預覽在旁邊 |
| `05-narrow-rail.png` | 1000×800 | 窄視窗：抽屜收著，只剩圖示列 |
| `06-narrow-drawer.png` | 1000×800 | 窄視窗：抽屜拉開，蓋在正文上面 |

## 3. schema

- 原始碼：從 `9baf141` 到 `a121162`，`services/` 和 `packages/contracts` 都沒有改動。最後一個遷移是 `0020`（`services/mac-server/src/db/migrations.ts:559`）。
- 執行：在臨時 `CREATORHUB_HOME` 用打包版附的伺服器（`services/mac-server/dist/server.mjs`，同一個 commit）建新資料庫。`schema_migrations` 最新兩筆是 `0020`、`0019`。用完已停掉伺服器並刪除目錄。

## 4. 第一輪（`9baf141`）：new-api 偶發失敗的根因

前端回報的症狀：動效模式下，從設定頁回到作品後，30 秒內找不到邊欄的「AI」分頁。

### 第一輪結果

- 靜態檢查通過，單元測試 1231／0／1231。
- 整套 e2e 一般模式一輪、動效模式兩輪，都是 0 failed。
- 動效模式 `--repeat-each=30 new-api`：30 passed。整支 spec 沒有直接重現。

### 根因：產品端的抽屜量測

1. e2e 視窗寬 1280，編輯區 `.tabs-area` 量到 1048 px，低於當時的停靠門檻 1080（`EDITOR_MIN` 560 加 `SIDE_DEFAULT` 520），所以邊欄是抽屜。
2. 進設定頁時 `.tabs-area` 被隱藏，`ResizeObserver` 回報 `measure(0)`。`isDrawer(0, …)` 回傳 false，`drawer` 被改成 false。
3. 回到作品時，第一個畫格邊欄以停靠、展開的狀態畫出，AI 分頁可見。約 15 ms 後 `measure(1048)` 改回 `drawer: true, drawerOpen: false`，邊欄收成圖示列，AI 分頁被隱藏。
4. `showSideTab`（`e2e/fixtures/side.ts:27`）只用一次 `isVisible()` 判斷要不要先點圖示列。如果剛好在那 15 ms 內檢查，就不點圖示列，直接 `tab.click()`；分頁隨即被隱藏，30 秒後逾時。

證據（逐畫格記錄，動效模式）：

```
926  area=0H   side=side side--open side--drawer      ← 進設定頁，編輯區隱藏
942  area=0H   side=side side--open                   ← measure(0)：drawer 被改成 false
1293 area=1048 side=side side--open                   ← 回到作品：停靠、展開（AI 分頁可見）
1308 area=1048 side=side side--collapsed side--drawer ← 15 ms 後收成抽屜圖示列
1359 area=1048 side=side side--open side--drawer      ← fixture 點了圖示列之後
```

時間窗探針：一般模式來回 8 次，有 2 次第一次檢查時 AI 分頁可見，下一次就隱藏（`V.......`）。

使用者也看得到：在 1280 寬的視窗，每次從設定頁回到作品，邊欄都會閃一下停靠展開的版面，然後收起，原本拉開的抽屜也會被收起。

### 處理

- 前端修正 `81b59c6`：
  - `measure(0)` 不改 `drawer` 和 `drawerOpen`。
  - 空間不夠時，邊欄先縮到最小 400，`.tabs-area` 小於 960 才改成抽屜。
- 測試端沒有加重試、延長逾時或放寬斷言。修正後的結果見第 1 節。
- 探針和截圖腳本沒有放進倉庫，在共用筆記資料夾 `qc085-prerelease/`（`qc085-probe-flash.spec.ts`、`qc085-shots.perf.ts`）。

## 5. 觀察（不算缺陷，請前端判斷）

1280 寬停靠時（`04-docked-1280.png`），編輯欄只剩 560 px：

- 頂列的「視覺／原始碼／插入」換到第二行。
- 格式工具列放不下，出現橫向捲軸。

這是新門檻允許的最窄停靠寬度。正文本身的行寬還可以讀。

## 尚未驗證（NOT_VERIFIED）

- 深色模式和其他語言下的邊欄截圖：這次只拍了淺色、繁中。e2e 的 editor-preview 已涵蓋深色和三語的斷言。
- 真實安裝、launchd 部署：照分工屬於 qc-release，不在這次範圍。
