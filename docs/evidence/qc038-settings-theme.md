# QC-038 驗收記錄：設定頁重排與主題切換

日期：2026-11-19　分支：`feat/qc038-settings-theme`（從 origin/main `cdc880f` 開；QC-041 尚未合併，合併後再 rebase）
原型：PT-20261119-001，畫板「v2 · 設定」與「v2 · 設定（深色）」，畫布第 39 版。

## 做了什麼

**版面**：

- 左側是 220px 的分類導覽：外觀、本機服務、備份與還原、AI 服務、資料夾、關於。
- 右側是最寬 680px 的單欄內容，獨立捲動；捲動時分類導覽不動。
- 點分類會捲到該段並把焦點移到標題。捲動時，目前段落會跟著標示（`aria-current`）。
- 「本機服務」分類旁有綠／紅狀態點。窄視窗（小於 1000px）時，分類導覽縮成 168px。

**外觀**：

- 三張卡片「淺色」「深色」「跟隨系統」，屬於 `radiogroup`，可用方向鍵切換。卡片內的小視窗直接用兩套 token 的實際顏色繪製。
- 預設跟隨系統；選中時顯示目前是淺色還是深色。
- 主程序把選擇存在 `<userData>/preferences.json`，存檔時先寫暫存檔再原子替換，並設定 Electron 的 `nativeTheme.themeSource`：
  - 這會同時影響 `prefers-color-scheme`、原生控制項與捲軸。
  - 下次啟動在第一個視窗繪製前就套用，不會先閃成另一種顏色。
- renderer 另外在 `<html>` 上釘 `data-theme`，讓 token 立即切換。
- 儲存失敗時顯示原因，介面仍會先套用新選擇。

**深色 token 對比度**：

- `design-tokens` 的 WCAG 測試原本涵蓋文字色在三種底色上，以及狀態色在各自淺底上。這次加上強調色與成功／警告／錯誤色當作文字、在 bg、surface、sunken 上的對比。
- 淺色與深色都至少 5.18:1，深色至少 6.89:1，全部達到 AA，不需要改 token。

**本機服務**：狀態加重新檢查、即時更新、開機自動啟動、防止睡眠。

**備份與還原**：

- 沿用 QC-031，標題改成「備份與還原」並加一行說明。
- 還原清單預設顯示 **3 份**，按「全部 N 份」展開、「收起」收合。

**AI 服務**：沿用 QC-025，加上說明「金鑰只存在這台 Mac 的鑰匙圈。」

**資料夾**：與原本相同。

**關於**：App 名稱與服務版本（含 commit 與建置時間）。

## 原型沒畫清楚、我選的做法

- **開機自動啟動、防止睡眠**：原型畫的是開關，但這兩件事沒有 API。開機啟動由安裝時的 launchd 決定，防止睡眠由服務在有任務時自動處理（QC-030）。所以改成說明列，不放按了也沒作用的開關。
- **「開放原始碼授權 · 查看」**：目前沒有授權頁可以開，所以「關於」暫時不放這一列，需要時另開任務。
- **主題儲存位置**：放在主程序的偏好檔，而不是 localStorage，才能在視窗出現前套用。
- **跟隨系統的「目前淺色／深色」**：只在選中「跟隨系統」時顯示。選了固定主題時，Chromium 回報的是固定後的外觀，不是系統實際的外觀，顯示出來會不準。
- **備份的「每日自動備份」**：維持 QC-031 已核准的唯讀做法，不畫開關。

## 自動測試

- **單元測試**：
  - `apps/mac/test/settings-v2.test.ts`（6 個）：
    - 預設跟隨系統、偏好檔讀寫（含損壞與未知值，並確認不留下暫存檔）。
    - `data-theme` 的設定與清除、實際外觀的判斷。
    - 六個分類、捲動時標示哪一段、備份預設 3 份。
  - `packages/design-tokens/test/tokens.test.ts`：對比度測試加上強調色與狀態色作文字的組合。
- **e2e**：`e2e/specs/settings-theme.spec.ts`（真的 Electron 加真的服務）。
  - 六個分類與預設狀態、選深色後整頁背景立刻變深。
  - 重新載入後仍是深色。
  - 方向鍵切換到跟隨系統、再切到淺色。
  - 分類導覽捲到段落並聚焦標題；捲動時導覽位置不動；捲回頂部時標示「外觀」。
  - 5 份備份預設只顯示 3 份，展開與收起。
  - 深色與窄視窗截圖。
  - 停止服務後，分類上的狀態點變紅。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc038-01-settings-light.png` | 淺色，外觀與本機服務 |
| `qc038-02-settings-dark.png` | 選深色後立即套用 |
| `qc038-03-backups-expanded-light.png` | 備份清單展開到 5 份 |
| `qc038-04-backups-dark.png` | 深色，備份預設 3 份與「全部 5 份」 |
| `qc038-05-ai-dark.png` | 深色，AI 服務 |
| `qc038-06-narrow-dark.png` | 900 寬，深色 |
| `qc038-07-narrow-light.png` | 900 寬，淺色 |
| `qc038-08-service-down-light.png` | 服務停止：分類紅點、狀態「未回應」 |

## 驗證

- `pnpm -r typecheck`、`tsc -p e2e/tsconfig.json`：通過。
- `pnpm -r lint` 與根目錄 `pnpm lint`：0 錯誤。`pnpm format:check`：通過。
- `pnpm test:e2e`：3 passed／0 failed／3 total（`editor-scroll`、`new-api`、`settings-theme`），期間持有 e2e 鎖。這個分支還不含 QC-041 的 `sidebar` spec。
- 全倉 `pnpm -r --workspace-concurrency=1 --no-bail test`：**685 passed／0 failed／685 total**。
  - 執行時間 2026-11-19 07:51:52–07:52:31。負載開始 13.55、結束 12.81，期間持有全倉測試鎖。
  - 各套件：contracts 16、design-tokens 5、domain 27、installer 39、markdown-editor-web 22、api-client 18、platform-preview 12、mac-server 361、apps/mac 179（本任務新增 6 個）、agent-sdk 6。

## NOT_VERIFIED

- macOS 系統外觀實際切換時，「跟隨系統」是否跟著變：e2e 用 `emulateMedia` 與 `nativeTheme`，沒有真的去改系統設定。
- 打包後的 App 第一次開窗不閃色：只在開發建置驗證了偏好會在視窗建立前套用。
- VoiceOver 朗讀 radiogroup。
