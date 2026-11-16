# QC-008 追查紀錄：tus 續傳偶發卡死

- 日期：2026-11-16；分支 `fix/qc008-tus-resume-hang`（基底 `origin/main` f6a2324）；Node v24.14.0；`@tus/server` 2.4.7、`@tus/file-store` 2.1.2、srvx 0.11.22、Fastify 5.12.8
- 全部只連 `127.0.0.1` 隨機埠；`CREATORHUB_HOME` 為 `mktemp` 臨時目錄，跑完即刪；測試檔為隨機位元組加 MP4 檔頭，本機產生

## 結論

1. **原始現象（續傳 PATCH 回 `HTTP 000`，之後伺服器整個不回應）：未重現。** 共 270 次嘗試（修正前 210 次、修正後 60 次）、0 次失敗、0 次卡住、0 次伺服器崩潰（明細見下表）。判定為 `NOT_VERIFIED`：沒有原始日誌，無法證明根因。
2. **壓測中找到一個相關、可穩定重現的缺陷，已修：** 用戶端無聲消失（網路斷、Mac 或手機睡眠，socket 沒有收到 FIN／RST）時，伺服器會**無限期**保留那個 PATCH 連線和該上傳的鎖。實測 80 秒後連線仍開著，之後對同一上傳的每個 `HEAD`／`PATCH` 都要先等 tus 的 3 秒鎖釋放（`lockDrainTimeout`）。這不會讓整個伺服器停擺，但會洩漏連線與寫入串流，續傳每次多等 3 秒。

## 1. 壓力重現

工具（已提交）：

- `services/mac-server/scripts/tus-stress.ts`：以子行程啟動真正的 `src/main.ts`，用原始 socket 控制速率與中斷方式；每次試驗都檢查最終 sha256、所有請求 90 秒內有回應（超過 tus 鎖逾時 30 秒＋釋放 3 秒），並在試驗期間每 250 ms 打一個無關請求（`GET /api/v1/assets`，5 秒逾時）偵測事件迴圈卡住；結束後檢查伺服器行程仍存活。`--seed` 可重放。
- `services/mac-server/scripts/tus-curl-replay.sh`：逐字重放 QC-005 證據第 6 節的 curl 序列（40 MiB、`--limit-rate 8M --max-time 2` 強制斷線、`curl -I` 取 offset、`tail -c | curl --data-binary @-` 續傳）。

變換的條件：

| 維度 | 取值 |
| --- | --- |
| 檔案大小 | 40 MiB、96 MiB、256 MiB、1 GiB |
| 首次 PATCH 速率 | 不限速、32 MiB/s、8 MiB/s、2 MiB/s |
| 中斷點 | 檔案 5%–95% 隨機；另每輪固定一次「40 MiB、8 MiB/s、16,842,752 位元組處斷線」的原始情境 |
| 中斷方式 | `destroy`（FIN，等同 curl `--max-time`）、`reset`（RST）、`stall`（停止傳送但不關 socket） |
| 續傳時機 | 立刻、20 ms、200 ms、1.5 s、3 s、4 s |
| 情境 | 斷線後續傳；2–4 個並行續傳搶同一 offset；重送 offset 0 的重複 PATCH；舊連線還掛著時從新連線續傳；伺服器 SIGTERM／SIGKILL 重啟後續傳；api-client 式 8 MiB 分塊、約 35% 分塊被隨機切斷 |

結果：

| 批次 | 程式版本 | 種子 | 次數 | 失敗 | 備註 |
| --- | --- | --- | --- | --- | --- |
| stress 一般 12 輪 | 修正前 | 20261116 | 120 | 0 | 每種情境 12 次，cut-resume 60 次（含 12 次原始情境） |
| stress 大檔 2 輪 | 修正前¹ | 7 | 20 | 0 | 其中 8 次 1 GiB |
| curl 逐字重放，立即續傳 | 修正前 | — | 40 | 0 | 每次斷在 16,777,216 |
| curl 逐字重放，延遲 3 s 續傳 | 修正前 | — | 20 | 0 | |
| stress 一般 6 輪 | 修正後 | 424242 | 60 | 0 | 回歸確認 |
| 修正前試跑（調整腳本用） | 修正前 | 1 | 10 | 0 | 腳本自身 bug 修正後的結果 |

¹ 大檔批次在修正寫入前啟動；批次內重啟情境啟動的新伺服器行程可能已載入修正後的程式。修正只影響「連線無聲超過 60 秒」，此批沒有任何情境會觸發，不影響結論。

過程中觀察到、屬於預期行為的現象（不是缺陷）：

- 斷線後**立即** `HEAD`，常見約 3 秒才回：舊 PATCH 還持有鎖，`HEAD` 要求釋放後 tus 等 `lockDrainTimeout`（3 s）。
- RST 斷線時，`HEAD` 回的 offset 可能比用戶端送出的少幾十 KB：在途資料被丟棄，續傳從伺服器實際寫入的位置接上，sha256 全部正確。
- 並行續傳時，一個拿到 204（被下一個請求要求釋放鎖、3 秒後中止並保存已收資料），其餘回 409（offset 已變），依 tus 協定 `HEAD` 後再續傳即可完成。

## 2. 找到的缺陷：無聲斷線的 PATCH 永不關閉

重現（修正前，臨時腳本，跑完已刪）：建立 1,000,000 位元組的上傳，PATCH 宣告完整長度、只送 1,000 位元組後不再送也不關 socket。

```console
open after 80000 ms: true tus files: [ '<id>', '<id>.json' ]
stalled PATCH got response 204 after 83039      ← 是被下面的 HEAD 搶鎖才結束
stalled socket closed after 83040
HEAD 200 1000 took 3037
```

原因：Fastify 預設 `connectionTimeout` 與 `requestTimeout` 都是 0，Node `server.timeout` 也是 0，所以一個不再傳資料的請求本體沒有任何逾時；tus 只有在別的請求來搶鎖時才中止它。

修正（`services/mac-server/src/routes/assets.ts`）：tus 的 PATCH 請求設定 socket 閒置逾時（預設 60 秒，`buildServer({ tusIdleTimeoutMs })` 可調）。沒有 `timeout` 監聽器時，Node HTTP 伺服器會在閒置到期時銷毀 socket，tus 隨即中止寫入、保存已收資料並釋放鎖；回應結束後 Node 會把同一 socket 的計時改回 keep-alive 逾時，不影響後續請求。**只看閒置，不限總時長**：慢但持續傳送的大檔不受影響。

回歸測試（`services/mac-server/test/uploads.test.ts`）：

- `closes a PATCH whose client went silent and frees the upload for the resume`：閒置上限 300 ms，送 64 KiB 後沉默；斷言伺服器 3 秒內關閉連線、`HEAD` 1 秒內回 offset = 65,536（不必等 3 秒鎖釋放）、續傳後 sha256 正確。
- `keeps a slow PATCH open while bytes keep arriving`：閒置上限 300 ms，8 段每 150 ms 一段、總共 1.05 秒，斷言最後回 200。
- `leaves the keep-alive socket usable after a PATCH completes`：閒置上限 300 ms，PATCH 完成後同一 keep-alive socket 閒置 800 ms，再發 `GET` 仍回 200 且沿用同一 socket。

修正前（紅）：

```console
 FAIL  test/uploads.test.ts > resumable (tus) upload > closes a PATCH whose client went silent and frees the upload for the resume
AssertionError: expected 'still open' to be 'closed' // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 16 skipped (17)
```

修正後：前兩個新測試連跑 20 次，20／0／20；`test/uploads.test.ts` 18／0／18。

## 3. 原始現象的可能原因（推論，未證實）

- 原始失敗時伺服器若以 `pnpm dev`（`tsx watch`）執行，同時修改原始碼會讓 watch 重啟行程：進行中的 PATCH 得到 `HTTP 000`，若新程式啟動失敗，watch 會停著等下一次修改，看起來就是「整個不回應」。無日誌可證。
- 當時 `@tus/file-store` 建構子中的非同步 `mkdir` 回呼在出錯時會丟出未捕捉例外並讓行程結束（後端已用 `UploadFileStore` 子類別改為同步建立）。若當時上傳目錄不存在或被清掉，會是「`HTTP 000`、之後連不上」。無日誌可證。
- 本次修的無聲連線問題只會讓同一上傳多等 3 秒，不會讓整個伺服器停擺，**不是**原始現象的充分解釋。

後端已在 `main.ts` 加上 fatal 日誌；若再發生，launchd 或終端的日誌會留下原因，屆時另開任務。
