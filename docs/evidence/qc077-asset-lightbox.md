# QC-077 素材庫大圖預覽

- 開啟：雙擊卡片、選取後空白鍵（卡片上或頁面任何非輸入處）、詳情預覽圖點擊（Enter 亦可）。關閉：Esc、空白鍵、點遮罩、關閉鈕；焦點回到目前素材的卡片。
- 圖片適應視窗（不放大超過 100%），⌘= ⌘- ⌘0、觸控板捏合（ctrl+wheel）、雙擊在適應與 100% 間切換、拖曳平移（限制在溢出範圍內）；視頻、音訊在預覽中播放；其他類型顯示圖示與「在 Finder 顯示」。←→ 依格線順序切換，頭尾停住。頂部：檔名、尺寸、序號。
- 先顯示縮圖，原圖載入後換上（`data-original`）。完整動效：從縮圖位置放大（moderate、out）；減少動態效果、lite 與測試模式：只淡入。關閉：淡出（`useExitFade`）。
- 檔案：`Lightbox.tsx`（共用檢視器，不綁素材庫）、`lightbox-math.ts`、`AssetsPage.tsx` 接線、i18n 三語。
- 範圍外：作品編輯中的圖片候選、貼圖圖片格尚未接，檢視器已通用，之後只需提供 items。

## 驗證（負載與範圍）
- typecheck 0 錯誤、lint、prettier 通過。
- 全套單元測試（`pnpm test`，逐套件）：105 檔、1136 測試，passed 1136／failed 0／total 1136。含新增 `lightbox-math.test.ts`（6）。
- 全套 e2e，動效關閉（預設）：passed 47／failed 0／skipped 9／total 56（2.3 分，負載 5–7）。第一次因另有會話拉高負載（升到 28）出現 2 個逾時失敗（new-api、settings-v4），不計；負載降到 5–7 後整套重跑為 0 failed。
- 全套 e2e，`QC_E2E_MOTION=on`：passed 47／failed 0／skipped 9／total 56（3.7 分；跑時負載 13–28，結果為通過）。
- 新 e2e：`e2e/specs/asset-lightbox.spec.ts`，兩種模式皆通過。截圖 `docs/evidence/qc077/`（開啟、100% 縮放、視頻、減少動態效果）。
