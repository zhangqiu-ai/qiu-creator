# QC-078 「最近刪除」改名為「回收站」

- 全部介面文案（作品與素材）：繁體／简体「回收站」、English「Trash」。含「移到回收站／Move to Trash」、「清空回收站／Empty Trash」、確認框、toast、空狀態、無障礙名稱、快捷鍵提示。
- 只改文案與註解；API、資料欄位（`trash`、`deleted_at`）、CLI 參數不變。已更新 GLOSSARY、DESIGN.md、README、docs/architecture.md 與 e2e／單元測試的定位字串。系統垃圾桶（Finder）仍叫垃圾桶／废纸篓，GLOSSARY 註明與 App 的「Trash」不同物。
- 歷史記錄（`docs/decisions.md`、`docs/evidence/` 舊檔、`.tasks/`）保留原文，不回改。
- 鎖定測試：`packages/i18n/test/catalog.test.ts` 新增一則，三語任何字串含 最近刪除／最近删除／Recently Deleted 即失敗。

## 驗證
- typecheck 0 錯誤、lint、prettier 通過。
- 全套單元：105 檔、1137 測試，passed 1137／failed 0／total 1137（負載 5–8）。
- 全套 e2e，動效關閉：passed 47／failed 0／skipped 9／total 56（負載 2–3）。
- 全套 e2e，`QC_E2E_MOTION=on`：passed 47／failed 0／skipped 9／total 56（負載 3–5）。
- 說明：動效關閉的第一輪（負載 5–8）有 1 個失敗 `new-api.spec.ts`（等 30 秒找不到設定頁「AI 服務」按鈕）；單獨重複跑 6 次全過，整套重跑為 0 failed。與改名無關（該 spec 不含相關字串），QC-077 的整套 e2e 也出現過同一個，疑為間歇性，已交由總監判斷是否開單。
