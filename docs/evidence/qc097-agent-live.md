# QC-097 前端：Agent 工作中即時狀態（介面與動效）

日期：2026-11-25 · 會話：qc-frontend · 分支 `qc097-agent-live`（從 origin/main 34ae5e7 開）

規格：
- 原型 PT-20261125-001，使用者核准；照它的 boards、decisions、motion 三節做。
- `docs/decisions.md` 2026-11-25 的七點。

## 資料層（等 QC-096 接上）

- `agent-live.ts`：
  - 紀錄的形狀照原型的 dataSource：`state`、`agents`（權杖 id 與名稱，可以多個）、`step`、`updated_at`、`counts`。另外有兩個選填欄位 `work_title` 與 `project_ids`，讓彈出框與項目計數不必另外查。
  - 純函式 `liveView` 負責逾時：工作中 2 分鐘轉「可能已停止」，10 分鐘回閒置；剛完成停 8 秒。
  - `cleanStep` 把步驟整理成單行、去掉控制字元、最多 24 字。
  - `snapshotOf` 算出全部與各項目「工作中的 Agent 數」、彈出框清單，以及同時工作中的件數（12 件的上限用這個判斷）。
- `AgentLiveStore` 依時間自動重新推導，剛完成淡出、Agent 逾時都不需要事件；資料來源可以抽換（`LiveSource`：`load()` 加 `watch()`）。
  - 目前用 `NO_SOURCE`，正式環境什麼都不顯示。
  - QC-096 提供服務端來源（`GET /api/v1/agents/activity` 加 `agent.activity` 事件）後，只要寫一個 `LiveSource` 再呼叫 `liveStore.use(...)`。
- e2e 專用：`AppInfo.e2e`（`CREATORHUB_E2E_BACKGROUND`）為真時，App 改用 `FixedSource`，並開放 `window.qcAgentLive.set(records)`。一般執行不會出現這個入口。

## 介面

1. **作品卡**：
   - 封面左上角 Agent 標籤：頭像疊放、「X 等 N 個」、三點加步驟。其他狀態換成 ✓、收件匣加 +N −N、⚠、時鐘加「N 分鐘沒有回報」。
   - 外框：工作中時有光繞行，2.4 秒一圈。做法是在環形遮罩裡用 transform 旋轉 conic-gradient，不觸發重排。
   - 剛完成：綠框一次。
   - 提案待審：黃框加「審閱提案」，開 Agent 提案頁。
   - 出錯：紅框加「重試」或「重試 N 項」，開匯入任務頁。
   - 可能已停止：虛線框。
   - Agent 還在新建、沒有封面時顯示骨架。
2. **列表**：左緣 3px 狀態條（`tr[data-live]`，工作中在動效開時流動），標題右側多一欄「Agent」。
3. **側欄與頁首**：
   - 「全部作品」與各項目旁的「● N」可以點開，彈出框列出 Agent、件數、作品，以及「Agent 活動記錄 ›」。
   - 頁首顯示「● N 個 Agent 工作中」，依目前範圍計算。
4. **編輯頁**：
   - 分頁圖示換成呼吸點。
   - 頁首下方提示條寫「X 正在處理這件作品」加上步驟，並說明只能提案的 Agent 不會直接改正文。
   - 可直接改正文的 Agent 用黃色提示條；你同時有未儲存的修改時，說明你的修改會先留著、之後對照合併，並附「看它改了什麼」（打開歷史分頁）。合併沿用既有的 409 流程。
   - 是否可直接改正文，從主權杖讀權杖清單判斷；設定頁改了權杖會清掉快取。
5. **動效**：
   - 循環動效只在三個條件都成立時執行：完整動效、元素在畫面內（IntersectionObserver）、同時工作中不超過 12 件。
   - 減少動態效果與測試模式不跑任何循環，CSS 也另外擋住。
   - 剛完成的綠框淡出是一次性過渡，1.6 秒。

三種語言的文案在 `packages/i18n/src/catalog/live.ts`。

## 測試

- 單元測試 `apps/mac/test/agent-live.test.ts`，8 個測試，涵蓋：
  - 逾時：2 分鐘、10 分鐘、剛完成 8 秒；待處理與出錯不會逾時。
  - 閒置與沒有 Agent 的紀錄不顯示。
  - 步驟整理，以及「X 等 N 個」。
  - 計數：重複的 Agent、項目、「可能已停止」不算進工作中。
  - store 在來源變更與時間經過時重新推導。
- e2e `e2e/specs/agent-live.spec.ts`，一般模式與 `QC_E2E_MOTION=on` 都跑，涵蓋：
  - 作品卡：七種狀態的標籤與外框；骨架只出現在沒有封面的工作中作品。
  - 測試模式下完全沒有循環動效；動效模式下畫面內工作中的卡片會繞行，需要你處理的卡片不動。
  - 剛完成實際在 8 秒後消失。
  - 頁首與側欄：「● N」與彈出框，以及活動記錄連結。
  - 列表：`data-live` 與 Agent 欄。
  - 「審閱提案」開提案頁，「重試」開匯入任務。
  - 編輯頁：分頁呼吸點與提示條。可直接改正文的 Agent 工作中、你同時打字時，黃色提醒和「看它改了什麼」都出現。
  - 13 件同時工作時沒有任何繞行。
  - 深色與英文截圖。

## 截圖（`docs/evidence/qc097/`）

| 檔案 | 內容 |
| --- | --- |
| qc097-grid.png | 作品卡各狀態（動效模式截圖） |
| qc097-grid-dark.png、qc097-grid-en.png | 深色、English |
| qc097-list.png | 列表：狀態條與 Agent 欄 |
| qc097-sidebar-popover.png | 側欄「● N」彈出框與頁首 |
| qc097-editor-propose.png | 編輯頁：兩個只能提案的 Agent |
| qc097-editor-direct-typing.png | 可直接改正文的 Agent 工作中、你同時打字 |

## 沒做與 NOT_VERIFIED

- **圖片佔位上的 Agent 步驟（編輯頁）沒做。** 原型 dataSource 沒有「Agent 在正文哪個位置配圖」的資料，只有作品層級的狀態，所以沒有可靠的位置可以標。等 QC-096 的回報帶位置（例如區塊序號或佔位 id）後補上。
- 真實資料來源要等 QC-096，目前全部用 e2e 注入的假資料驗證：**NOT_VERIFIED**。
- 大量卡片同時動畫的實際耗能與幀率沒有量測，只依 12 件上限與「只動畫畫面內」的規則實作：**NOT_VERIFIED**。
- 「重試」目前打開匯入任務頁，由使用者在那裡重試；如果 QC-096 提供 job id，可以改成就地重試。
