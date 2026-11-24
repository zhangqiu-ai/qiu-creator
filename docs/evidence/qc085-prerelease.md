# QC-085 發版前檢查（草稿）

> **草稿，沒有結論。** 這輪檢查查出 new-api 偶發失敗的根因在產品端（邊欄抽屜量測），總監決定先修再重跑。前端修好後會在新的 main 重跑整份發版前檢查，並重建打包版。這份文件只記錄 `9baf141` 這一輪的事實。

- 日期：2026-11-23。執行者：qc-test。
- 對象：main `9baf141`（chore: QC-085 merged, awaiting release decision）。
  - 用乾淨的 checkout：`qiu-creator-qc085-pre`，從 `origin/main` 開，`pnpm install --frozen-lockfile`。檢查時工作樹沒有改動；探針只暫時放進去，跑完就移走了。
- 機器：Mac17,4（Apple M5，10 核），macOS 27.0.1。全程負載低於 15，各步驟的 1 分鐘負載寫在下面。
- 跑整套時持有 `qc-fullsuite.lock` 和 `qc-e2e.lock`，跑重複和探針時持有 `qc-e2e.lock`，沒有和其他 e2e 重疊。

## 1. 原始碼檢查（`9baf141`）

### 靜態檢查（負載 3.1）

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Lint | 根目錄 `pnpm lint`（`eslint .`，含 `e2e/`） | 通過 |
| 型別 | `pnpm -r typecheck`＋`tsc -p e2e/tsconfig.json --noEmit` | 通過 |
| 格式 | `pnpm format:check` | 通過 |

### 單元測試（一次一個套件，結束時負載 8.4）

| 套件 | 檔案 | passed／failed／total |
| --- | --- | --- |
| @qiu-creator/mac | 50 | 443／0／443 |
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
| **合計** | **117** | **1231／0／1231** |

### 整套 e2e（背景模式，開發建置）

| 輪次 | 開始 → 結束負載 | 結果（68 支） | 時間 |
| --- | --- | --- | --- |
| 一般 | 3.76 → 4.38 | 58 passed，0 failed，10 skipped | 2.9 分 |
| `QC_E2E_MOTION=on` | 4.38 → 4.15 | 59 passed，0 failed，9 skipped | 4.3 分 |
| `QC_E2E_MOTION=on`（加跑一輪） | 4.15 → 4.03 | 59 passed，0 failed，9 skipped | 4.0 分 |

skipped 是兩種模式各自限定的 spec，和以往相同。

### schema

`9f766be`（QC-084 發版前檢查的對象）到 `9baf141` 之間，`services/mac-server/src/db` 沒有任何改動。最後一個遷移仍是 `0020`（`services/mac-server/src/db/migrations.ts:559`），沒有新的遷移。

## 2. new-api.spec 偶發失敗

前端回報的症狀：動效模式下，從設定頁回到作品後，30 秒內找不到邊欄的「AI」分頁。

### 重現嘗試

| 嘗試 | 負載 | 結果 |
| --- | --- | --- |
| 動效模式 `--repeat-each=30 new-api` | 6.26 → 4.72 | 30 passed，0 failed |
| 動效模式整套兩輪（上表） | 4.4–4.0 | new-api 兩次都通過 |
| 時間窗探針（見下），一般模式 8 次 | 約 4 | **2 次抓到時間窗** |
| 時間窗探針，動效模式 8 次 | 約 4 | 0 次 |

整支 spec 沒有直接重現，但探針證明了造成這個症狀的時間窗確實存在。

### 根因：產品端的抽屜量測

1. e2e 視窗寬 1280，編輯區 `.tabs-area` 量到 **1048 px**。這低於停靠門檻 1080（`EDITOR_MIN` 560 加 `SIDE_DEFAULT` 520，`apps/mac/src/renderer/editor-side.ts`），所以邊欄是抽屜。
2. 進設定頁時 `.tabs-area` 被隱藏，`ResizeObserver`（`EditorTabs.tsx:132`）回報 `measure(0)`。`isDrawer(0, …)` 因為 `areaWidth > 0` 這個條件回傳 false，於是 `drawer` 被改成 false。
3. 回到作品時，第一個畫格邊欄以停靠、展開的狀態畫出，AI 分頁可見。約 15 ms 後 `measure(1048)` 改回 `drawer: true, drawerOpen: false`，邊欄收成圖示列，AI 分頁被隱藏。
4. `showSideTab`（`e2e/fixtures/side.ts:27`）只用一次 `isVisible()` 判斷要不要先點圖示列。如果剛好在那 15 ms 內檢查，它看到可見、不點圖示列，直接 `tab.click()`。分頁隨即被隱藏，之後不會再出現，30 秒後逾時，與回報的症狀一致。

### 證據

逐畫格記錄的探針（動效模式，一次回到作品），格式是「毫秒 編輯區寬度 邊欄 class」：

```
926  area=0H   side=side side--open side--drawer   ← 進設定頁，編輯區隱藏
942  area=0H   side=side side--open                ← measure(0)：drawer 被改成 false
1293 area=1048 side=side side--open                ← 回到作品：停靠、展開（AI 分頁可見）
1308 area=1048 side=side side--collapsed side--drawer ← 15 ms 後收成抽屜圖示列
1359 area=1048 side=side side--open side--drawer   ← fixture 點了圖示列之後
```

時間窗探針：回到作品後連續 40 次 `isVisible()`（`V` 是可見，`.` 是不可見）。一般模式 8 次中有 2 次是 `V.......…`，也就是第一次看到 AI 分頁可見、下一次就隱藏。`showSideTab` 在這種情況下會走錯分支。

探針腳本沒有放進倉庫，在共用筆記資料夾 `qc085-prerelease/`（`qc085-probe-flash.spec.ts`、`qc085-shots.perf.ts`）。

### 對使用者的影響

在預設 1280 寬的視窗，每次從設定頁回到作品，邊欄都會閃一下停靠展開的版面，然後收起；使用者原本拉開的抽屜也會被收起。

### 處理

- 總監已接受根因，交給前端修兩件事：
  - `measure(0)` 不改 `drawer` 和 `drawerOpen`。
  - 抽屜門檻：空間不夠時先把邊欄縮到 400，`.tabs-area` 小於 960 才改成抽屜。
- 測試端沒有加重試、延長逾時或放寬斷言。

## 3. 打包版

qc-release 已在 `9baf141` 建好 `--mac dir`（ad-hoc 簽名，沒有安裝）。總監決定先修再重建，所以**這份建置沒有跑任何 spec，也沒有截圖**。

## 尚未驗證（NOT_VERIFIED）

- 打包版：editor-preview、image-post、video-work、editor-tabs 兩種模式。
- 截圖：預覽分頁、AI 分頁、收合、窄視窗抽屜。
- 修正後的整份發版前檢查。

以上都等前端修正、在新的 main 上重跑。
