## QC-082: 中轉站讀不到模型清單時，模型選單仍要能選 New API 已設定的模型

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

QC-075 前端回報：New API 中轉站的模型清單讀取失敗時，`/ai/models` 不列出 New API，模型選單就選不到它，使用者被卡住。改為：清單失敗時仍列出已設定的 New API 文字／圖片模型（標示「清單讀取失敗，使用已存模型」），並帶錯誤原因供前端顯示；有快取就用快取。補測試。併入 QC-074–079 同一版。

## QC-081: new-api.spec、settings-v4.spec 偶發失敗（發版前要清掉）

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-077、QC-078 的整套 e2e（動效關閉）各出現一次 `new-api.spec.ts` 等 30 秒找不到設定頁「AI 服務」按鈕，單跑 6 次全過、整套重跑 0 failed。查根因（測試時序或產品），不准加長逾時或重試。

- 2026-11-22 補充：qc-frontend 在未改動的 origin/main 上量到 `settings-v4.spec` 偶發失敗 5／20（機器較忙時）。這兩支要在 QC-074–079 發版前查清根因並修好；產品問題回報總監轉派，測試問題直接修，不准加逾時或重試。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
