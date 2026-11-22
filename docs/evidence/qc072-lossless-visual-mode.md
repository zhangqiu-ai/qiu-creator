# QC-072 視覺模式無損保留特殊語法

- 切到視覺不再詢問，文件預設以視覺開啟（原本含 HTML 等語法的文件開在原始碼）。
- 做法：進視覺前把 HTML（區塊／行內）、腳註、參照式連結與定義、特殊表格、`$$` 數學、`:::` 指令換成佔位標籤 `<qc-raw n="i" />`；視覺編輯器以唯讀節點顯示原文（`<img>` 顯示成圖片，含寬高），可點選、Backspace／Delete 刪除；存回時把佔位換回原文。未動到的部分逐位元組相同（`packages/markdown-editor-web/src/raw.ts`、`raw-nodes.tsx`）。
- 仍無法處理（文件本身含 `<qc-raw` 或解析失敗）時留在原始碼模式，並以通知說明；文字不被改動。
- 測試：`packages/markdown-editor-web/test/raw.test.tsx`（11 類 × 3）、`editor.test.tsx`；e2e `e2e/specs/raw-syntax.spec.ts`（背景模式）。截圖 `docs/evidence/qc072/`。
