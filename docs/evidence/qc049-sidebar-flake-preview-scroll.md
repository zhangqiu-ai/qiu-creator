# QC-049 記錄：sidebar.spec 讀取時機與貼圖預覽面板橫向捲軸

- 日期：2026-11-21；分支 `fix/qc049-sidebar-flake-preview-scroll`（基底 `origin/main` aa6b6ab）；Node 24.14.0；Electron 45.3.2（開發模式，從本機快取解壓）；執行者 qc-bugfix
- e2e 都持有 `qc-e2e.lock`；全倉閘門持有 `qc-fullsuite.lock`；全部只用本機服務與假 AI 服務

## 結論

1. **sidebar.spec 的不穩定：沒有在本機重現，原因只能從程式結構推論。** 依 QC-045 的紀錄，失敗點是拖曳時讀提示文字：`dragHandle` 在 `mouse.move` 一回來就用 `count()` 讀 `.sb__handle-tip`，沒有等待。這個提示是 React 依 `dragging` 與寬度狀態畫出來的（`Sidebar.tsx`），所以這個讀法沒有任何機制保證渲染已完成。已把整個 spec 裡「動作後立刻讀一次」的斷言全部改成等待式，期望值一個都沒變，也沒有加長逾時或加重試。修好後連跑 30 次通過，加壓下再連跑 30 次通過。
2. **貼圖編輯器右側預覽面板的橫向捲軸：已找到原因、已修正、有會失敗的回歸斷言。** 手機模擬框固定 340 px 寬，面板內容寬只有 296 px，所以橫向溢出。

## 1. sidebar.spec

### 修正前：重現嘗試（全部沒有讀到過早的狀態）

| 嘗試 | 次數 | 結果 |
| --- | --- | --- |
| 原 spec 連跑，外部加壓 14 個空轉程式（load average 升到 33） | 30 | 30／30 通過 |
| 在同一個視窗反覆做「拖曳後立刻 `count()`」（原讀法），閒置 | 150 | 0 次讀到 `null` |
| 同上，加壓 14 個空轉程式 | 150 | 0 次 |
| 同上，CDP CPU 節流 4 倍、10 倍（20 倍時視窗被拖到無法回應） | 各 100 | 0 次、0 次 |
| 同上，延遲 React 排程器（`MessagePort.postMessage`）30 ms、100 ms | 各 20 | 0 次；等待式斷言 20／20 都成立 |

結論：我**無法重現**QC-045 分支上那次失敗，也無法證明「`count()` 讀得太早」是唯一原因。能確定的是：這個讀法沒有任何同步保證；這個畫面樹上渲染會在下一次查詢之前完成，所以在本機看不到，但負載更高或畫面樹更重（QC-045 分支多了分頁與編輯器）時可能讀到渲染前的狀態。這部分標 `NOT_VERIFIED`。

### 改了什麼（`e2e/specs/sidebar.spec.ts`）

- `dragHandle(page, dx, limit)`：放開前改用 `await expect(tip).toHaveText(limit)` 等提示出現且是預期的文字，不再讀一次 `count()` 與 `textContent()`。
- 所有 `expect(await navWidth(page)).toBe(N)`（拖曳後、雙擊後、方向鍵後、⌃⌘S 收起後、重新載入後、展開後，共 10 處）改成 `expectNavWidth(page, N)` = `expect.poll(...)`。寬度是在 React 渲染之後才套用的，原本都是動作後立刻讀。
- 收起圖示列後的 `getComputedStyle(...).overflowX` 改成 `expect.poll`；`data-tip` 的讀取改成 `toHaveAttribute`。
- 期望值全部不變，沒有加長逾時（`expect` 沿用預設 5 秒），沒有加重試。

### 修正後（`e2e` 連跑，`--repeat-each=30`）

| 條件 | 結果 | 負載（load average，開跑前→結束） |
| --- | --- | --- |
| 一般 | **30／30 通過**（1.3 分鐘） | 4.50 → 5.36 |
| 加壓 14 個空轉程式 | **30／30 通過**（6.2 分鐘） | 4.28 → 峰值約 100 |

## 2. 貼圖編輯器預覽面板的橫向捲軸

### 原因

- `.pp-phone`（`packages/platform-preview`）固定 `width: 340px; flex: none`。
- 貼圖編輯器的側欄 `.post__side` 沿用 `.panel`（`flex: 1 1 340px`、`overflow: auto`），實際外寬 340 px；扣掉垂直捲軸（手機框高 720 px，面板本來就會垂直捲）後可視寬 324 px；`.post__preview` 左右各 14 px padding，內容寬只剩 296 px。
- 量測（修正前，1440×900）：面板外寬 340.4、`clientWidth` 324、`scrollWidth` 332、手機框 340。所以出現橫向捲軸，而且手機框右緣被裁掉（`qc045-en-2` 截圖就是這個狀態）。

### 修正（`apps/mac/src/renderer/styles.css`）

`.post__side` 加 `flex-basis: calc(340px + 2 * 14px + 16px + 1px)`（手機框、預覽左右 padding、垂直捲軸、邊框），只影響貼圖編輯器的側欄，不動共用的 `.panel`，也不改 `.pp-phone`（模擬框尺寸維持原型的 340）。受 `.panel` 的 `max-width: 400px` 限制。

### 回歸斷言（`e2e/specs/image-post.spec.ts` 的 `expectPreviewFits`）

預覽面板不可橫向捲動、手機框右緣不可超出面板可視區。

- 修正前（紅）：`scrollsSideways: true`、`phoneClipped: true`，`image-post.spec` 1 failed。
- 修正後（綠）：`image-post.spec` 2／2 通過。

### 截圖

- 修正前：[qc049-en-2-editor-before.png](qc049-en-2-editor-before.png)（與 `qc045-en-2-editor.png` 相同狀態，由這個分支未修正的程式重新產生）：右側底部有橫向捲軸、手機框右緣被裁。
- 修正後：[qc049-en-2-editor-after.png](qc049-en-2-editor-after.png)：手機框完整，底部沒有橫向捲軸。
- 較窄視窗（面板固定 385 px、左欄隨之變窄）：[1100](qc049-width-1100-after.png)；1000 px 以下仍是原本的上下堆疊（面板滿寬）：[1000](qc049-width-1000-after.png)。1440、1200、1100、1000、900 各寬度都沒有橫向捲動（面板與主欄皆是）。

## 3. 閘門

| 項目 | 結果 | 負載（開跑前→結束） |
| --- | --- | --- |
| `pnpm -r typecheck`、`tsc -p e2e/tsconfig.json` | 通過 | — |
| `pnpm lint`、`pnpm format:check` | 通過 | — |
| `pnpm test`（持 `qc-fullsuite.lock`，一次跑一個套件） | **871 passed、0 failed、共 871**（contracts 21、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20、markdown-editor-web 29、platform-preview 12、mac-server 393、apps/mac 283、agent-sdk 6） | 13.69 → 14.40 |
| e2e 全部 | **16／16 通過**（44.6 秒） | 65.6（先前加壓的 1 分鐘平均尚未衰減，實際負載已降）→ 33 |

## 4. 範圍外觀察

- 貼圖編輯器的右側面板從 340 變 385 px，兩欄的比例因此改變（1440 寬時圖片格仍是 5 欄，每格從約 150 px 變成約 141 px，見 before／after 截圖）。如果原型要求面板維持 340，就得縮放手機模擬框，這是設計取捨，我選了不動模擬框。
- 預覽面板在高度不足時仍然垂直捲動（手機框高 720 px），這是預期行為，不在本任務範圍。

## 5. NOT_VERIFIED

- QC-045 分支上 `sidebar.spec` 那次失敗的確切原因：無法在本機重現，見第 1 節。
- 英文以外的語言下面板寬度：版面寬度與語言無關（固定像素），只用 `zh-Hant` 與 `en` 的截圖確認。

## 6. 收尾

沒有留下伺服器、Electron、加壓程式（`pgrep` 確認 0 個）；`e2e` 與全倉兩把鎖都已釋放；暫存探針 spec 已刪除；沒有 `tmp/playwright` 以外的暫存檔進入提交。
