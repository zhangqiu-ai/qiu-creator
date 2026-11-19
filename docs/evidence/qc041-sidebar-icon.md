# QC-041 驗收記錄：側欄 v2 與 App 圖示

日期：2026-11-19　分支：`feat/qc041-sidebar-icon`（從 origin/main `01b65e6` 開）
原型：PT-20261119-001，畫板「v2 · 側欄狀態」「v2 · App 圖示」，畫布第 39 版。

## 做了什麼

**側欄**：`apps/mac/src/renderer/Sidebar.tsx`，邏輯在 `sidebar-prefs.ts`。

- **分組**：
  - 「創作」：作品庫、平台預覽。
  - 「素材」：素材庫、匯入任務（顯示進行中數量）。
  - 「AI」：AI 工作台。
  - 設定固定在左下；不顯示發布中心。
- **寬度**：
  - 預設 232，拖曳右緣可在 200–320 間調整；碰到上下限時把手變成警示色，並顯示「最小 200」「最大 320」。
  - 雙擊把手恢復 232。
  - 鍵盤聚焦把手後，←／→ 每次 16，Home／End 跳到上下限。把手是 `role="separator"`，帶 `aria-valuenow`。
- **收起**：
  - ⌃⌘S（輸入法組字時不觸發）或標頭按鈕切換成 56 圖示列。
  - 圖示列的項目在滑過或鍵盤聚焦時顯示名稱 tooltip，按鈕的可及名稱保留。
- **記住狀態**：寬度與收起狀態存在 localStorage（`qc.sidebar.width`、`qc.sidebar.collapsed`）。讀寫失敗時使用預設值。
- **服務狀態點**：
  - 放在 App 名稱旁。本機服務、即時更新、Agent API 都正常時為綠；任一異常變紅；還原備份期間為黃（沿用 QC-031）。
  - 滑過或鍵盤聚焦時顯示浮層：本機服務位址、即時更新、Agent API、版本（含 commit），異常時另附「重新檢查」「服務設定」。
  - 健康檢查在連線時、每 30 秒、即時更新中斷時各做一次。
- **品牌**：側欄標頭用 App 圖示的 q 字標。

**App 圖示**：方案 B「q 字標」。

- 原稿：`apps/mac/build/icon.svg`。採 macOS 圖示網格：1024 畫布，本體 824，加系統風格陰影；深色底上有一圈淡色邊，與原型深色版相同。
- 產生：`node apps/mac/scripts/build-icon.mjs`，用服務端已有的 sharp 加 macOS `iconutil`，輸出 `build/icon.icns`（16–1024，@1x 與 @2x）與 `build/icon.png`。
- `electron-builder.yml` 的 `mac.icon` 指向 `build/icon.icns`。開發模式由主程序把 Dock 圖示設成同一張圖。

## 原型沒畫清楚、我選的做法

- **窄視窗**：原型沒畫。視窗寬度小於 900px 時固定為 56 圖示列，收合按鈕停用（提示「視窗較窄時固定為圖示列」），不改寫已記住的偏好，視窗變寬就恢復。
  - 原本「800–1180 自動收成 60 圖示列」與「小於 800 疊到內容上方」都拿掉，DESIGN.md 已同步更新。
- **還原中**：狀態點用黃色（原型只畫了綠和紅），沿用 QC-031「還原中」的語意。
- **「Agent API」狀態**：Agent API 就是同一個本機服務的 API，所以服務回應時為「可用」，否則為「無法使用」。這裡不檢查權杖是否存在。
- **側欄項目高度**：照原型的 32px（舊版是 34），DESIGN.md 已同步更新。

## 自動測試

- **單元測試**：
  - `apps/mac/test/sidebar.test.ts`（10 個）：上下限、方向鍵與 Home／End、極限提示、偏好的讀寫（含損壞值與會拋錯的 storage）、⌃⌘S 判斷（含組字中）、狀態點三色與文案。
  - `apps/mac/test/app-icon.test.ts`（2 個）：icns 含 16–1024 全部 10 個尺寸、builder 設定指向它、png 是 1024×1024。
- **e2e**：`e2e/specs/sidebar.spec.ts`（真的 Electron 加真的服務）。
  - 分組與順序、沒有發布中心、設定在底部、預設 232。
  - 拖到 200 與 320 會停住並顯示提示；雙擊回到 232；方向鍵調到 248。
  - ⌃⌘S 收成 56，鍵盤聚焦時 tooltip 出現，圖示列不出現捲軸。
  - 重新載入後保持收起；展開後維持 248，再重新載入仍是 248。
  - 860 寬時固定為圖示列且按鈕停用，回到 1440 恢復。
  - 狀態點正常時聚焦，浮層顯示各項狀態。
  - 深色截圖。
  - 停止服務後狀態點變紅，浮層寫「本機服務未回應」「已中斷」「無法使用」，並有「重新檢查」。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc041-01-expanded-light.png` | 淺色，展開 232 |
| `qc041-02-max-320.png` | 拖到最大 320 |
| `qc041-03-rail-tooltip.png` | 收起 56，鍵盤聚焦顯示 tooltip |
| `qc041-04-service-popover.png` | 狀態點浮層（正常） |
| `qc041-05-expanded-dark.png` | 深色，展開 |
| `qc041-06-rail-dark.png` | 深色，圖示列 |
| `qc041-07-service-down-dark.png` | 深色，服務停止：紅點與浮層 |
| `qc041-08-service-down-light.png` | 淺色，服務停止 |
| `qc041-09-app-icon-sizes.png` | App 圖示 256／128／64／32／16，淺色與深色背景 |

## 驗證

- `pnpm -r typecheck`、`tsc -p e2e/tsconfig.json`：通過。
- `pnpm -r lint` 與根目錄 `pnpm lint`：0 錯誤。`pnpm format:check`：通過。
- `pnpm test:e2e`：3 passed／0 failed／3 total（`editor-scroll`、`new-api`、`sidebar`），期間持有 e2e 鎖。
- 全倉 `pnpm -r --workspace-concurrency=1 --no-bail test`：**672 passed／0 failed／672 total**。
  - 執行時間 2026-11-19 07:34:21–07:34:42。負載開始 9.99、結束 9.01，期間持有全倉測試鎖。
  - apps/mac 185 個（本任務新增 12 個），其餘套件與 QC-040 時相同。

## NOT_VERIFIED

- **打包後 .app 在 Finder 與 Dock 的實際圖示**：要跑 electron-builder，屬於發版會話的範圍。這次只驗證了 icns 的內容與 builder 設定。
- **觸控板拖曳把手**：只用滑鼠事件驗證。
- **VoiceOver 朗讀分組名稱**：沒有實際驗證。
