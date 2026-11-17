# QC-018 追查紀錄：markdown-editor-web 測試在高負載下逾時

- 日期：2026-11-17；分支 `fix/qc018-editor-test-timeout`（基底 `origin/main` b6b0809）；Node 24.14.0；10 核心
- 負載用純 CPU 空轉迴圈（`while :; do :; done`）製造，數量標在各表；全部只在本機；沒有連外網
- **量測環境的限制：** 量測期間機器本身的 load average 就在 100–290（其他會話的 Electron、prisma 等），所以「外部空轉程式數」只是在這個底噪上再加壓，數字有明顯雜訊。結論看趨勢與對照，不看單一數字。

## 結論

**這不是邏輯競態，也不是缺陷，是 CPU 不足。** 該測試是 `editor.test.tsx` 的第一個測試，要承擔整個編輯器（jsdom、CodeMirror、Lexical、React 開發版）的冷啟動；後續測試只要幾到幾十毫秒。冷啟動約需 0.2–0.5 秒的 CPU，行程搶不到 CPU 時成比例變慢，慢到 10 倍以上就超過 vitest 預設的 5000 ms。

另有一個**自找的加壓來源**：`pnpm -r test` 預設同時跑 4 個套件，每個套件的 vitest 又各開約 9 個 worker，總共約 36 個行程搶 10 個核心。這個來源可以消除。

## 1. 重現與對照

### 1.1 套件並行（外部負載 20，整個倉庫 `-r --no-bail test`，每種各 4 輪交錯執行）

| 做法 | 編輯器測試逾時 | 該輪全部失敗的測試 |
| --- | --- | --- |
| A：預設（pnpm 同時跑 4 個套件） | **4／4**（6.0、6.8、6.3、7.4 秒） | 編輯器測試每輪都在；mac-server 另有 4 個（imports、mounts 驗證、uploads、variants） |
| B：`--workspace-concurrency=1`（一次一個套件） | **0／4** | mac-server 另在 2 輪失敗（見 3） |

### 1.2 只跑該套件（外部負載 40，各 15 輪）

| 做法 | 編輯器測試逾時 | 整次執行時間 |
| --- | --- | --- |
| 預設（3 個測試檔平行） | 2／15（5.4、9.3 秒） | 12–27 秒 |
| `--no-file-parallelism` | 2／15（6.6、6.3 秒） | 25–50 秒 |

關閉檔案平行**沒有**改善，只是更慢：問題不在套件內部平行，是這個測試本身的冷啟動 CPU 成本。

### 1.3 第一個測試的耗時隨負載變化（只跑 `editor.test.tsx`，每種 6 次，毫秒）

| 外部空轉程式 | 各次耗時 |
| --- | --- |
| 0（只有底噪） | 1398、1368、214、208、231、234 |
| 20 | 2265、6806、5208、2419、2735、5542 |
| 40 | 3678、3477、3935、4436、4869、6712 |
| 80 | 7383、7842、6845、5448、5403、7282 |

底噪低時約 0.2 秒；加壓後上升 10–35 倍，超過 5000 ms 的次數：20 個時 3／6、40 個時 1／6、80 個時 5／6。

### 1.4 冷啟動花在哪（CPU profile，冷啟動第一次掛載）

jsdom 約佔三分之一（CodeMirror 的 `style-mod` 注入 201 條樣式規則、React 開發版設定 `style`、Lexical 建立 MutationObserver 都觸發 jsdom 的樣式計算）、react-dom 開發版約五分之一、Lexical 約 7%。這些都是編輯器掛載本身的成本，測試沒有多做事；暖機後單次掛載只要約 250 ms CPU，後續測試只要幾毫秒。

## 2. 修正

`package.json` 的 `test` 改成 `pnpm -r --workspace-concurrency=1 test`（一次跑一個套件，套件內的 vitest 仍用滿所有核心），`README.md` 的檢查指令改成 `corepack pnpm test` 並說明原因。**沒有**加長逾時、加重試、放寬斷言，也沒有把冷啟動移到計時之外（不用 `beforeAll` 暖機：那只是把同樣的成本搬到另一個逾時裡，等於變相加長）。

修正後驗證（`pnpm -r --workspace-concurrency=1 --no-bail test`，量測當下 load average 約 50–290）：第一輪 markdown-editor-web 16／16 通過，mac-server 有 2 個失敗（見 3）；第二輪全數通過：**417 passed、0 failed、共 417**（contracts 11、design-tokens 5、domain 27、markdown-editor-web 16、api-client 15、platform-preview 12、mac-server 222、apps/mac 103、agent-sdk 6）。`pnpm lint`、`pnpm -r typecheck`、prettier 通過。

## 3. mac-server 在外部負載 40 下最常逾時的測試（範圍外，只列出，未修）

只跑 mac-server 一個套件，10 輪，其中 6 輪全過、4 輪有失敗，共 9 個失敗（5 個 `Test timed out in 5000ms`，其餘為斷言失敗）：

| 次數 | 測試 | 失敗型態 |
| --- | --- | --- |
| 3 | `mounts.test.ts` › watching › indexes a new file only after it stops changing (half-written files never enter) | 斷言失敗：測試靠「穩定等待時間的三分之一」的真實時間間隔寫檔，負載高時兩次寫入之間超過穩定視窗，檔案被提早索引 |
| 2 | `variants.test.ts` › rule-based drafts › generates all four platforms from the original without touching it | 逾時 |
| 1 | `work-media.test.ts` › managed work media › classifies every reference and resolves only safe files inside assets/ | 逾時 |
| 1 | `uploads.test.ts` › resumable (tus) upload › closes a PATCH whose client went silent and frees the upload for the resume | 逾時（QC-008 新增的測試，連線等待受真實時間影響） |
| 1 | `revisions-restore.test.ts` › GET /works/:id/revisions/:rid › returns the snapshot Markdown and title of any revision | 逾時 |
| 1 | `imports.test.ts` › URL import jobs › downloads into the asset library and links it to a work | 逾時 |

另一個對照（1.1，外部負載 20）中也出現過 `uploads`「stores an image…」、`mounts`「rejects relative, missing…」、`work-assets`、`work-media` 的另外幾個測試，每次不同。mac-server 的失敗分散、每次不同，是同一類「CPU 不足、5000 ms 不夠」，沒有單一壞測試；`mounts.test.ts` 的「寫一半」測試是唯一屬於時序假設（而非單純變慢）的一個，建議另開票處理。

## 4. `apps/mac` 有沒有「固定等待 SSE 連上」的寫法

沒有。`apps/mac/test` 只有兩處固定等待（`work-session.test.ts` 60 ms、`work-management.test.ts` 120 ms），都是「等一段時間後確認沒有寫入」的反向斷言，負載高時只會更容易通過；其餘都用 `vi.waitFor`，事件中繼測試（`event-relay.test.ts`）以假的訂閱函式驅動，不依賴真連線的時序。

## 5. 剩餘風險（照實寫）

這個修正只消除「自己造成的」加壓。外部負載夠高（本次量到約 20 個以上空轉程式再加底噪）時，編輯器冷啟動仍可能超過 5000 ms，單獨跑該套件在外部負載 40 時約 2／15。想要在極高負載下也穩定，只剩幾個取捨，都超出本任務的限制，留給總監決定：

1. 接受它：測試跑在機器不忙時（建議）。
2. 縮小該測試的冷啟動成本：例如不載入 CodeMirror 的程式碼區塊（會改變測試涵蓋範圍）。
3. 在 `setupFiles` 預先暖機（會讓冷啟動不再受逾時保護，我認為等同變相加長逾時，沒有做）。

## 6. 收尾

量測用的空轉程式、背景 vitest 都已清除（`pgrep` 確認）；沒有開伺服器、Electron、Simulator；暫存計時測試檔已刪除，倉庫只剩 `package.json`、`README.md` 與本文件的改動。
