# QC-031 交付（qc-frontend，2026-11-18）：實作、實機驗收、全倉驗證完成

> **最終狀態**：
>
> - **分支**：`feat/qc031-backup-ui`，基底是 `796dae6`，也就是 origin/main（已含 QC-030）。未推送。
> - **commit**：`4be96c0` 功能、`f83fe1a` 交付說明、`0b2ae1f` 錯誤碼調整、`ad3fe85` 交付說明、`290f2d6` 驗收修正與證據，以及本說明的最後一筆。
> - **實機驗收**：33／33，見 `docs/evidence/qc031-acceptance.md`。
> - **全倉測試**：617／0／617。
>
> 下面「做了什麼」以前的段落，寫於 QC-030 合併之前。

- **分支與 commit**：`feat/qc031-backup-ui` 的 `d54342a`，基底是 `4432736`（QC-030 契約）。未推送。
- **worktree**：`/Users/feature/code/qiu-creator-qc031`
- **目前卡在哪裡**：`4432736` 只有契約，服務端還沒實作備份 API，`/health` 也還沒回傳 `commit`／`built_at`。所以 App 用新契約連不上這個基底的服務。
  - 實機截圖驗收（含深色、窄視窗）與全倉測試，要等 QC-030 合併、rebase 之後再跑。
  - 這段時間可以先把下面的缺口提案轉給使用者核准。

## 做了什麼

1. **設定 →「備份」區**（位置在「服務」之後、「AI 服務」之前，與原型左欄順序相同）：
   - 最近備份：時間、大小、種類。按「立即備份」時顯示「備份中」，完成後顯示「已備份 · 時間」，失敗時顯示原因。
   - 每日自動備份：上次與下次的時間、每種保留份數，並註明「只備份資料庫；原稿與媒體請用 Time Machine」。`last_error` 會以紅字顯示。
   - 備份位置：顯示路徑，可以「在 Finder 顯示」（主程序新增 reveal 目標 `backups`，只開 `<CREATORHUB_HOME>/backups`）。
   - 備份清單：時間、大小、種類 chip、結構版本、完整性 chip、「還原」按鈕。完整性失敗的備份按鈕停用並附說明。預設顯示 5 份，超過時可以「顯示全部」。
   - 還原確認對話框：
     - 說明哪些資料會回到備份時間。
     - 粗體寫明「還原前會先自動備份目前的狀態」。
     - 說明原稿與媒體不變，服務會重新載入幾秒。
     - 預設焦點在「取消」；危險按鈕寫「備份目前狀態並還原」。
2. **還原流程**：由 App 層的 `BackupSession` 負責（`apps/mac/src/renderer/backups.ts`），離開設定頁後仍會繼續追蹤。
   - 送出後顯示「還原中」卡片，加上不確定進度條；側欄底部變成黃點「還原中」。
   - 服務先回應、再重新載入，所以 `/health` 正常不足以證明已換上還原的資料庫。判定完成的條件：看過一次 `/health` 失敗後又恢復，或收到 `backup.restored`。
   - 每次輪詢都叫醒事件流，主程序的 relay 會帶 Last-Event-ID 接續。
   - 完成後把 `dataEpoch` 加 1：
     - 作品庫、素材庫、匯入、AI 工作台、平台預覽重新掛載並重新抓資料。
     - 匯入任務的徽章重新計數。
     - 設定頁重新抓健康狀態、掛載和 AI 設定。
     - 備份清單重新整理。
   - 60 秒內沒有回來：顯示失敗原因，按「再等一次」會再等一輪。
   - `restart_required`：黃色提示「需要重新啟動本機服務」，說明在那之前資料不會改變，並列出安全備份。不會輪詢，也不會觸發重新抓資料。
   - 被拒絕：依錯誤碼顯示中文原因，下方附服務的原始訊息。沒有收到回應時明說「無法確定是否已還原」。
3. **SSE**：監聽 `system/database` 的四個事件。
   - `backup.created` 與 `backup.failed`：重新整理清單。
   - 其他人發起的 `restore_started`：顯示外部還原提示，同時停用備份與還原按鈕。
   - 其他人發起的 `restored`：觸發全 App 重新抓資料。
4. **服務版本**：例如「0.1.0 · a1b2c3d · 建置於 今天 06:00」。只有其中一個是 null 時省略那一項；兩者都是 null 時顯示「從原始碼執行」。
5. **建置版 CSP**：
   - 建置後的 renderer 改由主程序用 `qc-app://renderer/` 提供（只服務 `dist/` 內的檔案，有防路徑穿越）。
   - 每個回應都帶依實際服務位址產生的 CSP 標頭。vite 建置不再寫入 meta 標籤，因為兩條 CSP 會同時生效，寫死 7420 的那條就會擋圖。
   - IPC 信任來源從 `file://` 改成 `qc-app://renderer/`。
   - `docs/architecture.md` 已同步更新。

## 已驗證

- `apps/mac` typecheck：只剩基底的既有錯誤（`services/mac-server/src/server.ts:294` 的 `/health` 缺 `commit`／`built_at`），等 QC-030 補上。
- `apps/mac` lint：0 錯誤。prettier：全倉通過。
- 新增測試 20 個：`test/backups.test.ts` 15 個（含 4 個 helper 測試），`test/app-protocol.test.ts` 5 個。
  - 還原時舊服務仍回應不算完成；`backup.restored`；逾時後再等；`restart_required`；拒絕原因；完整性失敗不送出；重複送出；外部還原；事件過濾。
  - 路徑穿越（含 `%2F`、`%00`）、CSP 跟隨埠、IPC 來源、vite 不寫 CSP。
- apps/mac 全套 160／162 通過。失敗的 2 個是 `work-session.test.ts > connect`，原因同上：服務的 `/health` 被新契約拒絕。這是基底的問題，與本次改動無關。當時 load average 約 20，數字不作為交付依據。
- 建置版冒煙測試（`pnpm build`，Electron 直接載入 dist，`CREATORHUB_PORT=7555`）：
  - 頁面來自 `qc-app://renderer/index.html`，React 正常渲染（module script 可用），bridge 可用。
  - 畫面顯示「127.0.0.1:7555 未回應」。
  - dist 的 index.html 沒有 CSP meta。

## 原型缺口提案（請轉使用者核准）

原型 MacSettings 畫板的備份部分只有：最近備份與立即備份、每日自動備份開關（03:00 · 保留 14 份）、從備份還原（下拉選擇加一行後果說明、還原按鈕、「已還原」chip）。

**與原型不同**：

1. **每日自動備份**：沒有開關，也沒有固定的 03:00。API 不能關閉自動備份，也沒有固定時間，所以改顯示上次與下次的時間、保留份數，以及「開啟」或「失敗」chip。
2. **還原**：原型是下拉選單；改成完整的備份清單，每列一個「還原」按鈕，再加確認對話框。這是總監要求的清單加二次確認，也能顯示種類、大小和完整性。
3. **後果說明**：
   - 原型只有一句「索引與版本記錄會回到該時間；原稿檔案不變。」
   - 改為對話框中的三段：會回到備份時間的資料、先自動備份目前狀態、原稿與媒體不變且服務會短暫重新載入。

**原型未畫、依推薦實作**：

4. 還原中卡片（不確定進度），加上側欄底部「還原中」黃點。
5. 還原完成卡片：「已還原到 X 的備份」，附安全備份的時間，以及「知道了」。
6. `restart_required` 黃色提示卡。
7. 還原失敗卡：
   - 被拒絕：中文原因加原始訊息。
   - 沒有回應：寫明「無法確定是否已還原」。
   - 服務 60 秒沒回來：提供「再等一次」。
8. 其他視窗或工具發起的還原：提示卡，並停用按鈕。
9. 空清單：「還沒有可以還原的備份」，說明第一份每日備份的時間，或按「立即備份」。
10. 清單載入失敗加「重試」；載入中用骨架。
11. 完整性未通過：紅色 chip，還原按鈕停用並附說明。
12. 立即備份的成功與失敗回饋；自動備份 `last_error` 的紅字。
13. 備份位置與「在 Finder 顯示」。
14. 超過 5 份時「顯示全部」。
15. 服務版本含 commit 與建置時間；沒有資料時顯示「從原始碼執行」。

原型的服務啟動／停止、開機自動啟動、防止睡眠仍然不做（沒有 API）。

## 錯誤碼調整（c8081e9）

- **還原收到 409 `backup_failed`**：結果是確定的，介面寫「無法先備份目前的資料，所以沒有還原；資料沒有變更」，原因取 `details.detail`。不會再出現「無法確定是否已還原」。
- **409 `backup_not_restorable`**：文字改為「未通過完整性檢查，或來自較新的版本」。
- **手動備份收到 500 `backup_failed`**：介面寫「備份失敗，沒有產生副本」，附 `details.detail`。
- **503 `restoring`**，以及還原或備份時收到的 409 `restore_in_progress`：
  - 不當成失敗，改為顯示「本機服務正在還原資料庫」，側欄底部也變成「還原中」。
  - 輪詢 `/health`；看到失敗後又恢復，或收到 `backup.restored`，就結束並全 App 重新抓資料。60 秒後即使都沒看到也會結束，並重新抓一次。
- **其他頁面的寫入**：所有經由 bridge 的回應只要是 503 `restoring`，App 都會進入上述等待狀態。
  - 存檔、平台版本、AI、匯入、掛載的錯誤文字改為「服務正在還原資料庫，請稍候再試」。
  - 編輯器的修改仍保留在視窗內。
- **`/health` 的 `commit` 與 `built_at`**：可能沒有這兩個欄位，舊版服務會這樣；兩者都沒有時顯示「從原始碼執行」。
- **測試**：`backups.test.ts` 新增 6 個情境（409 `backup_failed`、還原遇 503、立即備份遇 503、從其他頁面得知還原、外部還原逾時、自己的還原不算外部），版本缺欄位的斷言併入既有的版本測試。另新增 `restoring.test.ts` 3 個。
- **apps/mac 範圍**：
  - typecheck 與 lint 都是 0 錯誤，prettier 通過。
  - 受影響的 3 個測試檔：29／0／29。
  - 全套：160／11／171，當時 load average 110～133（機器負載極高）。失敗的 11 個都是 8～20 秒的伺服器整合測試逾時；`work-session` 與 `ai-workbench` 單獨重跑是 26／26。依規則這次全套結果不算數，等負載降下來重跑。

## 需要後端（QC-030）留意（已由 6c4e138 處理）

- 服務端用的錯誤碼 `restore_in_progress`、`backup_not_restorable`、`backup_failed` 不在 `ErrorCodeSchema` 裡。api-client 的 `ErrorResponseSchema.safeParse` 會失敗，`ApiError.code` 變成 undefined，介面只能退回通用文字。`backup_failed` 若是 5xx，還會被誤報成「無法確定是否已還原」。
  - 建議在 QC-030 把這三個碼加進契約。我這邊已經依這三個碼寫好對應文字和測試。

## 副作用

- 打包版 renderer 的來源從 `file://` 改成 `qc-app://renderer`，localStorage 換了一個 origin。目前唯一受影響的是作品庫的格狀／清單偏好，第一次啟動會回到預設。

## 最終驗證

在 `/Users/feature/code/qiu-creator-qc031` 執行：

| 閘門 | 結果 |
| --- | --- |
| `pnpm -r --workspace-concurrency=1 typecheck` | 通過 |
| `pnpm -r --workspace-concurrency=1 lint` 與根目錄 `pnpm lint` | 0 錯誤 |
| `pnpm format:check`（prettier，全倉） | 通過 |
| `pnpm -r --workspace-concurrency=1 --no-bail test` | **617 passed／0 failed／617 total** |

全倉測試在 2026-11-18 08:54:01–08:54:48（PST）執行。開始時負載 11.79（1 分鐘平均），結束時 19.78。執行期間持有 `/private/tmp/claude-501/qc-fullsuite.lock`，跑完已釋放。

| 套件 | passed／total |
| --- | --- |
| contracts | 16／16 |
| design-tokens | 5／5 |
| domain | 27／27 |
| markdown-editor-web | 22／22 |
| api-client | 16／16 |
| platform-preview | 12／12 |
| mac-server | 340／340 |
| apps/mac | 173／173（本任務新增 31 個） |
| agent-sdk | 6／6 |

**實機驗收**：33／33。

- 環境：真實的 QC-030 服務跑在 7555 埠，App 是建置後用 `qc-app://` 載入的 Electron。
- 涵蓋：
  - 淺色、深色、窄視窗。
  - 立即備份、SSE 即時更新、完整性失敗。
  - 還原全流程，含全 App 重新抓資料。
  - 409 `backup_not_restorable`、409 `backup_failed`、500 `backup_failed`、每日備份失敗。
  - `restart_required`；編輯器存檔收到 503 `restoring`，以及服務回來後自動離開「還原中」。
  - 改埠後圖片正常顯示，第三方圖片與 fetch 被 CSP 擋下。
- 驗收中修了三個小問題（舊的備份失敗訊息不會消失、到期的「下次」顯示過去時間、窄視窗被截斷），都補了單元測試。
- 詳見 `qc031-acceptance.md`。

## NOT_VERIFIED

- **App 端 60 秒逾時的「再等一次」**：只有單元測試。
- **其他視窗或工具發起的還原，收到 `backup.restore_started` 事件的路徑**：只有單元測試。實機驗的是 503 `restoring` 那條路徑，兩者共用同一套等待邏輯。
- **「在 Finder 顯示」備份位置**：沒有實機點擊。
- **打包成 .app（asar）後用 `qc-app://` 載入**：屬於發版會話的範圍，這次只驗了直接載入 `dist`。
- **launchd 自動重啟服務時的 `restart_required` 流程**：這次用手動重啟服務模擬。
- **VoiceOver 朗讀與完整的鍵盤 Tab 順序**：只確認了對話框的初始焦點落在「取消」。

## 範圍外發現（未處理）

- 驗收時看到 MDXEditor 的圖片工具列（刪除、設定圖示）蓋在圖片右上角，見截圖 10、17。這是既有的編輯器行為，與本任務無關。

## 設計參考

- `/Users/feature/code/qiuge-design/cases/agent-risk-confirmation-button-semantics/case.md`（concept）：危險操作用具體動詞說明對象與後果，預設焦點放在取消。還原按鈕寫「備份目前狀態並還原」，預設焦點在「取消」，危險按鈕用實心紅色。
- `/Users/feature/code/qiuge-design/cases/kubai-999-017-waiting-states/case.md`（concept）：進度只用可信的數據，並定義逾時、重試與回退。還原沒有可信的百分比，所以用不確定進度條加階段文字；有 60 秒逾時和「再等一次」，並一律列出安全備份作為回退。
- `/Users/feature/code/qiuge-design/cases/nowdex-error-recovery-next-action/case.md`（concept）：錯誤與下一步放在一起，並依責任分流。拒絕時寫明資料沒有變更；沒有回應時寫明無法確定；服務沒回來時提供「再等一次」；`restart_required` 說明下一步是重新啟動服務。
- `/Users/feature/code/qiuge-design/cases/kubai-empty-state-svg/case.md`（product）：先定義空狀態與可執行的動作。空清單說明何時會有第一份備份，並指向「立即備份」。只借鑑結構，不加插圖。
- `/Users/feature/code/qiuge-design/cases/kubai-999-016-toast-vs-notification/case.md`（concept）：失敗與修復留在原元件。備份成功與失敗都留在該列，不用 toast；還原狀態固定在備份區頂部，不會自動消失。
