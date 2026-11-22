# QC-063 側欄開關併進 LOGO

日期：2026-11-21　分支：`feat/qc063-logo-sidebar-toggle`（從 main `edac9c0` 開）
使用者原話（2026-11-21）：「這個側邊欄控制按鈕可以簡化設計，比如放到LOGO上，使用鼠標HOVER來控制切換」。

## 設計參考

查了 qiuge-design 的 `navigation`、側欄、收合相關卡片，只有一張可借：`/Users/feature/code/qiuge-design/cases/splash-icon-rail-hover/case.md`（`kind: concept`，未經上線驗證）。

- **借鑑**：窄欄只放圖示，文字放在懸停層，節省寬度；移植時要保留可存取名稱與鍵盤焦點，觸控與鍵盤使用者要拿到同等資訊。
- **本專案的調整**：
  - 懸停與 `:focus-visible` 顯示同一個換圖示與提示；按鈕本身有 `aria-label` 和 `aria-keyshortcuts`。
  - 提示沿用圖示列既有的 `data-tip` 做法，並寫出 ⌃⌘S。
  - 這張卡沒有 LOGO 換圖示的案例，換圖示的做法是我自己的設計，沒有卡片依據。

## 做了什麼

只動 LOGO 這一列（`apps/mac/src/renderer/Sidebar.tsx`、`styles.css`）：

- 移除獨立的收合按鈕（原 `.sb__toggle`）。
- LOGO 本身是按鈕 `.sb__logo`：
  - 懸停或鍵盤焦點時，LOGO 換成側欄圖示，樣式和側欄項目懸停相同；底色不透明，不會透出 LOGO。
  - 下方出現提示，例如「收起側欄（⌃⌘S）」；點擊或 Enter 切換。
  - 圖示列狀態相同：提示是「展開側欄（⌃⌘S）」。
  - 視窗太窄時固定為圖示列：按鈕停用，不換圖示，提示是「視窗較窄時固定為圖示列」。
- 無障礙名稱沿用現有文案：「收起側欄」「展開側欄」（導演訊息寫的是「收合側欄」，目錄裡原本就是「收起」，我沒有改文案）。三語提示沿用原本的 `shell.*SidebarTip`。
- 服務狀態點不動。

## 驗證（2026-11-21，負載約 4–5）

- e2e `sidebar-logo-toggle.spec.ts`（背景模式）：沒有獨立按鈕、懸停換圖示與提示、點擊收合與展開、鍵盤焦點與 Enter、⌃⌘S、窄視窗停用、簡體、English、深色。連跑 5 次通過。
- 既有 `sidebar.spec` 沒改，照樣通過（它用「展開側欄」按鈕名稱和停用狀態）。
- 全部 e2e：26 passed／0 failed／26 total。
- `pnpm -r typecheck`、e2e `tsc`、`pnpm -r lint`、prettier：通過。
- 全倉測試：991 passed／0 failed。

## 截圖（`docs/evidence/qc063/`）

| 檔案 | 內容 |
| --- | --- |
| `qc063-zh-Hant-1-hover.png` | 繁體，懸停 |
| `qc063-zh-Hant-2-rail-hover.png` | 圖示列，懸停 |
| `qc063-zh-Hant-3-focus.png` | 鍵盤焦點 |
| `qc063-zh-Hans-4-hover.png`、`qc063-en-5-hover.png` | 简体、English |
| `qc063-en-6-hover-dark.png`、`qc063-en-7-rail-hover-dark.png` | 深色，展開與圖示列 |

## 備註

- 提示出現在 LOGO 下方，會短暫蓋住第一個分組標題（「創作」）。
- NOT_VERIFIED：真人滑鼠的懸停延遲手感、VoiceOver 實際朗讀。
