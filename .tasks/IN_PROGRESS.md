## QC-042: 介面多語言（简体中文／繁體中文／English）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

使用者 2026-11-21 提出。範圍與規則見決策記錄 2026-11-21「介面多語言」。共用文案目錄套件、設定 → 外觀加語言選項（跟隨系統預設）、即時切換含原生選單、錯誤碼對應文案、`Intl` 格式化；三語鍵值完整性測試與「介面元件內不得寫死中文」檢查。

**Started:** 2026-11-21

### Plan

分支 `feat/qc042-i18n`（從 origin/main `273bea8`，含 3e4c0aa）。預設語言照總監決定 (C)：舊安裝升級寫入 `zh-Hant`，新安裝跟隨系統。

| 檔案 | 用途 |
| --- | --- |
| `packages/i18n/`（新） | 不綁 Electron 的共用套件：`locale.ts` 系統語言對應、`define.ts` 三語目錄型別（缺鍵 typecheck 失敗）、`translator.ts` 佔位符與英文複數、`format.ts` `Intl` 日期／數字／大小／相對時間、`catalog/*.ts` 各區文案（common、errors、shell、settings、main、format、assets、ai、serviceSettings、editor、library）、`GLOSSARY.md` 三語用語表；測試：鍵完整、非空、佔位符一致、英文無中文、简体無繁體字、系統語言對應、格式化 |
| `apps/mac/src/main/language.ts`、`menu.ts`（新） | 主程序語言狀態（偏好＋`app.getPreferredSystemLanguages()`）、原生選單範本（切換時重建） |
| `apps/mac/src/main/preferences.ts` | 偏好加 `language`；`migrateLanguage` 升級時寫入 `zh-Hant`，保留其他鍵 |
| `apps/mac/src/main/main.ts`、`uploads.ts` | 開窗前套用語言與選單；IPC `getLanguage`／`setLanguage`／`languageChanged`；系統語言變更通知與聚焦時重查；檔案選擇器與上傳錯誤文案 |
| `apps/mac/src/shared/bridge.ts`、`preload/preload.ts` | `LanguageState` 與橋接 |
| `apps/mac/src/renderer/i18n.ts`（新） | `t`、`useLocale`、`setLocale`（含 `<html lang>`）、`errorText`／`codeText`（錯誤碼對應文案）、`Intl` 格式化 |
| `apps/mac/src/renderer/main.tsx`、`App.tsx` | 首次渲染前套用語言；根元件訂閱語言，原地重繪不丟草稿 |
| `apps/mac/src/renderer/AppearanceSection.tsx`、`theme.ts`、`styles.css` | 外觀加「語言」四張卡（沿用主題卡樣式） |
| 其餘 renderer 頁面與 `format.ts`、`Sidebar.tsx`、`SettingsNav.tsx` 等 | 文案改為目錄鍵 |
| `packages/markdown-editor-web`、`packages/platform-preview` | 編輯器工具列與預覽外框文案依語言；平台自身介面文字不翻 |
| `apps/mac/test/no-hardcoded-chinese.test.ts`（新） | 掃描 app 與 UI 套件字串、模板、JSX 文字，有中文即失敗（僅允許平台介面文字檔） |
| `apps/mac/test/language.test.ts`（新） | 升級遷移兩條路徑、語言控制器、選單三語 |
| `e2e/fixtures/desktop.ts`、`e2e/specs/i18n.spec.ts`（新） | 既有 e2e 固定繁體；新 e2e 即時切三語並檢查側欄、設定頁、原生選單，拍 10 張截圖 |
| `docs/dependencies.md`、`docs/architecture.md`、`docs/evidence/qc042-i18n.md` | 新套件記錄（未引入第三方庫）、架構說明、驗收記錄 |

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。剩 U1 重開機、U5 日常使用一輪，使用者之後抽空做。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
