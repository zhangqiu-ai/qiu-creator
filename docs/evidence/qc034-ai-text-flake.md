# QC-034 紀錄：ai-text「只接受成功且同一作品的改寫」偶發失敗

- 日期：2026-11-18。分支 `test/qc034-ai-text-flake`，基底 `origin/main` e8593a3。環境：Node 24.14.0，10 核心。
- 全部只在本機執行。AI 服務一律用測試的假服務（`test/fake-ai.ts`），沒有連外網。

## 結論

**判定：(a) 測試的順序假設，不是產品缺陷。**

- 被錯誤接受的任務，實際上就是拿到了成功回應而真的成功了。服務的狀態寫入與接受端核對都正確。
- 只改測試：每個任務完成後才建立下一個，並斷言測試依賴的各任務狀態。

## 1. 現象

- 測試：`services/mac-server/test/ai-text.test.ts` › rewrite candidates and accepting them › only accepts a succeeded rewrite of the same work。
- 低負載（load 11–12）只跑該檔 10 次，失敗 1 次：`AssertionError: expected { …(14) } to be an instance of ApiError`。
- 意思是：`accept` 應該被拒絕，卻成功了。

## 2. 機制

原測試依序做了這些事，最後才一次 `drain()`：

1. 對假服務排 suggest 的回應，建立 suggest 任務。
2. 排 `fail(400)`，建立本作品的改寫任務（預期失敗）。
3. 排 `ok`，建立另一篇作品的改寫任務。

相關事實：

- 假服務每個 provider 一個先進先出佇列，依**請求到達順序**取回應（`fake-ai.ts`，`queues[provider].shift()`）。
- AI 任務執行器同時跑 2 個任務（`ai-service.ts`，`concurrency` 預設 2）。任務一建立就可能被取走執行。
- 所以兩個改寫任務的 HTTP 請求，誰先到假服務並不固定。另一篇先到時，它拿走 `fail(400)`，預期失敗的任務拿到 `ok`。

## 3. 證據

### 3.1 診斷副本 40 輪（記錄請求到達順序與最終狀態）

- 診斷副本未提交、已刪除。
- 依請求內容辨認是哪個任務：含「紅葉」與 `douyin` 的是 suggest，含「紅葉」的是本作品改寫，其他是另一篇。
- 39 輪通過，到達順序都是 `suggest,rewrite,other`。

失敗的那 1 輪：

```
order=suggest,other,rewrite
suggest=succeeded/1   failedJob=succeeded/1（建立於 …221Z）   otherJob=failed/1（建立於 …233Z）
```

- 預期失敗的任務比較早建立，但它的請求比較晚到假服務。
- 於是它拿到 `ok`、狀態是 `succeeded`；另一篇拿到 `fail(400)`、狀態是 `failed`。
- 接受一個「同作品、狀態 succeeded」的改寫，本來就應該成功。產品行為正確。

另一次重現時，傾印 `accept` 的回傳：被接受的是預期失敗的那個任務，回傳作品內容 `markdown: "x"`。

### 3.2 確定性重現

- 把原測試兩個改寫回應的排程對調（`ok` 先、`fail(400)` 後），模擬「另一篇先到」。
- 3／3 失敗，錯誤與偶發時相同：`expected { …(14) } to be an instance of ApiError`。
- 副本未提交、已刪除。

### 3.3 排除 (b)

這三點同時排除了「把兩個請求合成一個任務」與「結果寫錯」：

- 三個任務的 id 都不同。
- 每個任務 `attempts` 都是 1。
- 每個請求只送出一次（`fake.for('openai')` 有 3 筆）。

另外，接受端拒絕「非 succeeded」與「別篇作品」的任務：修正後的測試對 suggest、失敗的改寫、別篇改寫三者都斷言 `ai_job_not_acceptable`，全部通過。

## 4. 修正（`services/mac-server/test/ai-text.test.ts`，+5／−1）

- 每建立一個任務，就用 `finished()` 等它結束，再排下一個回應、建立下一個任務。這樣同一時間只有一個任務在跑，每個回應只屬於一個任務。
- 新增斷言：suggest 是 `succeeded`，本作品改寫是 `failed`，別篇改寫是 `succeeded`。測試依賴的前提若被破壞，會直接在這裡失敗，不會跑到後面的 `accept`。
- 沒有放寬斷言、加長逾時或加重試。

### 同類檢查

逐一看過所有用到假服務排程（`fake.script`）的測試：`ai.test.ts`、`ai-text.test.ts`、`m3-acceptance.test.ts`。

- 其他測試不是一次只跑一個任務，就是只數請求數、不看哪個任務拿到哪個回應：
  - `ai.test.ts` 的取消測試，在執行器啟動前就取消了第一個任務。
  - QC-029 的「不同參數」測試只比對請求數。
- 沒有其他同根因的測試。

## 5. 驗證

| 項目 | 結果 | 負載（1 分鐘 load average） |
| --- | --- | --- |
| 該測試單獨重複 30 輪 | **30／30 通過** | 11.6–13.0 |
| `ai-text.test.ts` 整檔 | 15／15 通過 | — |
| mac-server `typecheck`、`lint`；改動檔案 `prettier --check` | 通過 | — |
| 全倉測試，加 `--no-bail`，持 `qc-fullsuite.lock` | **617／617 通過，0 失敗** | 開始 11.8，結束 16.8 |

全倉測試各套件結果：

| 套件 | 通過／總數 |
| --- | --- |
| contracts | 16／16 |
| design-tokens | 5／5 |
| domain | 27／27 |
| markdown-editor-web | 22／22 |
| api-client | 16／16 |
| platform-preview | 12／12 |
| mac-server | 340／340 |
| apps/mac | 173／173 |
| agent-sdk | 6／6 |

總監提醒留意的 `uploads.test.ts`「closes a PATCH whose client went silent and frees the upload for the resume」，這次沒有出現。
