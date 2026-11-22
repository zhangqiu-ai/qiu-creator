# QC-059 editor-tabs 游標還原偶發失敗：判定為產品競態

- 日期：2026-11-21。執行者：qc-test。版本：`3e3b250`（origin/main）。
- 失敗紀錄：`e2e/specs/editor-tabs.spec.ts:121`，2026-11-21 20:30，負載 5.21。切回分頁後 `selectionStart` 期望 11，5 秒內一直是 10。

## 結論

**是產品缺陷，不是測試時序問題。** 測試期望 11 是正確的；沒有改測試。

## 原因（`apps/mac/src/renderer/EditorPage.tsx`）

- 分頁在前景時，游標只靠 `document` 的 `selectionchange` 事件記進 `where.current.selection`（約 517–536 行）。
- `selectionchange` 是**非同步排入佇列**的事件。輸入後到事件觸發之間，`where` 裡還是舊的游標。
- 分頁轉到背景時，`active` 變成 false，effect 清理會移除監聽，`reportView()` 交出的是舊值。之後就算事件觸發，也已經沒人接收。
- 捲動位置有同樣的問題，但產品已處理：離開前景的 layout cleanup 會**同步從 DOM 讀 `scrollTop`**（561–570 行，註解寫明「in case the last scroll event has not fired yet」），測試也有一段專門驗證（126–140 行）。**游標沒有對應的同步讀取。**
- 回到前景時，rAF 用舊的 `where.current.selection` 還原（10）。還原本身也會觸發 `selectionchange`，把 10 再記一次，所以會一直停在 10。這和失敗紀錄「5 秒內一直是 10」相符。

## 穩定重現（第二實例 e2e，臨時 spec，未提交）

- 腳本：共用筆記資料夾 `qc059-repro.spec.ts`（不在倉庫）。
- 流程：
  1. 原始碼模式，游標設在 10。
  2. 在**同一個任務**裡用 `execCommand('insertText', 'Q')` 輸入，再派送 ⌘⇧] 的 keydown。
  3. 用 ⌘⇧[ 切回，等 500 ms 後讀游標。
- 對照組：輸入後先等 50 ms 讓 `selectionchange` 觸發，再切換。
- 負載 4.82，`--repeat-each=3`：

| 情況 | 切換前收到的 `selectionchange` | 切回後游標 | 結果 |
| --- | --- | --- | --- |
| 先等 `selectionchange` | `[11]` | 11 | 3／3 通過 |
| 輸入後立刻切換 | `[]` | **10** | **3／3 失敗**（Expected 11, Received 10） |

- 兩組在輸入後的 `selectionStart` 都是 11，所以 DOM 是對的，丟掉的是記錄。

## 為什麼原測試只是偶發

- 原測試先用真實按鍵輸入 Q，接著做兩次 `evaluate` 設捲動，再按 ⌘⇧]。
- 平常 `selectionchange` 會在這段時間內觸發，所以會通過。
- 高負載時，`selectionchange` 可能晚於 ⌘⇧] 的 keydown 才執行，就會失敗。**推論**：Chromium 排程器優先處理輸入事件。這點沒有直接驗證。
- 真實使用者情境：輸入後馬上按 ⌘⇧] 或 ⌘數字，而且機器忙的時候，游標可能回到輸入前的位置。草稿內容不受影響。

## 修正方向（交總監判斷，qc-test 沒有改產品碼）

- 比照捲動，在離開前景的 layout cleanup 裡同步讀一次選取：
  - 原始碼模式：`selectionStart`／`selectionEnd`。
  - 視覺模式：`getSelectionRange()` 和 DOM range。
- 修好後，上述「輸入後立刻切換」可以直接改寫成持久的 e2e 測試，和現有「捲動後立刻切換」那段並列。

## 驗證範圍

- 只跑了臨時重現 spec（6 次）。原 `editor-tabs.spec.ts` 沒有改，這次沒有重跑整套。
- 視覺模式是否有同樣的競態：沒有重現，`NOT_VERIFIED`。從程式碼看，它走的是同一條 `selectionchange` 路徑。
