# QC-012 驗收記錄：Mac 素材庫、匯入任務與設定頁

- 日期：2026-11-17
- 執行者：qc-frontend
- 基線：已核准原型 PT-20261116-001 的 MacAssets、MacImports、MacSettings 畫板（畫布第 24 版的檔案，透過 Artifact 讀取原始碼對照，沒有複製 HTML）
- 環境：macOS、Electron 45（開發模式）、mac-server 跑在臨時 `CREATORHUB_HOME`，資料由 [qc012-seed.mjs](qc012-seed.mjs) 建立。沒有任何對外網路請求；URL 匯入只用私有位址測試阻擋。

## 自動測試

| 範圍 | 結果 |
| --- | --- |
| `corepack pnpm -r test` | 308 passed／0 failed／308 total（apps/mac 72，其中本任務新增 32） |
| `corepack pnpm -r typecheck` | 9／9 套件通過 |
| `corepack pnpm lint` | 0 錯誤 |
| `corepack pnpm format:check` | 通過 |

新增的測試：

- `apps/mac/test/event-relay.test.ts`：SSE 解析；重連帶 `Last-Event-ID`、同一 `seq` 不重複；以服務回報的 seq 為起點；沒有權杖時退避；**對真實 mac-server**：收到即時事件，服務關閉再啟動後補收停機期間的變更；錯誤權杖；靜默連線逾時。
- `apps/mac/test/uploads.test.ts`（對真實 mac-server）：小檔單次上傳；大檔 tus 分塊與進度；中途斷線後重試，從已確認的偏移續傳（偏移 0 只送一次）；取消後繼續；相同內容沿用原素材；拒收的檔案類型；略過資料夾與不存在的路徑；沒有權杖時不連線。
- `apps/mac/test/tasks.test.ts`：任務列的狀態、原因、進度、重複沿用、合併排序與計數；縮圖 URL 只接受 UUID；Finder 路徑不得跳出 `CREATORHUB_HOME`；URL 驗證與阻擋說明；掛載錯誤訊息；權杖與掛載排序。
- `apps/mac/test/format.test.ts`：檔案大小、時長、尺寸、雜湊縮寫、檔名。

## Electron 實機（等級 2，CDP 驅動真實視窗）

[qc012-verify.mjs](qc012-verify.mjs) 在全新種子資料上跑完：**40／40 通過**（[qc012-verify-results.json](qc012-verify-results.json)）。電腦操控缺「螢幕錄製」權限，所以跟 QC-002 一樣用 CDP 驅動。

| 項目 | 截圖 |
| --- | --- |
| 素材網格、縮圖經 `qc-asset://` 載入、檢視器（尺寸、編碼、大小、雜湊與複製、位置、來源、加入時間） | [01](qc012-01-assets-viewer.png) |
| 類型篩選無結果與清除篩選 | [02](qc012-02-assets-filter-empty.png) |
| 拖放上傳的覆蓋提示 | [03](qc012-03-drop-overlay.png) |
| 1 GB 檔案以 tus 上傳中，有進度條與導航徽章 | [04](qc012-04-imports-uploading.png) |
| 取消後可繼續、拒收檔案顯示原因、相同內容「已存在」可沿用原素材 | [05](qc012-05-imports-states.png) |
| URL 對話框：組字中按 Enter 不送出；私有位址當場說明已阻擋 | [06](qc012-06-url-blocked.png) |
| 新增權杖、明文只顯示一次（Esc 不會關掉）、撤銷先確認 | [07](qc012-07-token-create.png)、[08](qc012-08-token-secret.png)、[09](qc012-09-token-revoke.png)、[10](qc012-10-imports-tokens.png) |
| 設定：服務、即時更新、托管目錄、外部掛載 | [11](qc012-11-settings.png) |
| 掛載資料夾被移走後重新掃描顯示「找不到資料夾」；放回再掃描恢復「監控中」 | [12](qc012-12-settings-mount-missing.png) |
| 卸載說明「磁碟上的檔案不會被移動或刪除」，卸載後可重新掛載 | [13](qc012-13-settings-unmount.png) |
| 深色模式 | [14](qc012-14-assets-dark.png)、[15](qc012-15-imports-dark.png)、[16](qc012-16-settings-dark.png) |
| 窄視窗：1000px 圖示列、760px 導航疊到上方 | [17](qc012-17-imports-narrow.png)、[18](qc012-18-assets-stacked.png) |
| 服務停止時設定頁顯示「重新連線中」 | [19](qc012-19-settings-reconnecting.png) |

檢視器播放器（[qc012-player-verify.mjs](qc012-player-verify.mjs)，**6／6 通過**，[qc012-player-results.json](qc012-player-results.json)）：原圖經 `assetMediaUrl` 載入（2400px 原尺寸，不是縮圖）；H.264 影片載入、跳到 0:15（Range 經主程序代理轉送）並播放；音訊播放器；HEVC `.mov` 在這台 Mac 的 Electron 也能播放（不能解碼的格式會改顯示圖示加「這個格式無法在 App 內播放」）。截圖 [20](qc012-20-viewer-video.png)、[21](qc012-21-viewer-audio.png)、[22](qc012-22-viewer-hevc.png)。測試影片由本機 ffmpeg 產生。

另外手動確認：

- 停掉服務後顯示「重新連線中」；重啟服務並在 App 重連前上傳一張圖，App 自動回到「已連線」，素材庫裡看得到這張圖。這一步的切頁本來也會重新載入列表，所以「依 `Last-Event-ID` 補收」是由上面的整合測試證明，不是這一步。
- App 外上傳的素材，沒有重新整理就出現在素材網格（SSE `asset.created`）。
- renderer 沒有 Node 存取；沒有遠端字型請求。

## 刻意偏差

- **素材分區**：原型分「托管／外部掛載」兩區。目前所有素材都是托管的，掛載只索引 Markdown 作品，所以只有托管一區。
- **檢視器的「引用」**：服務沒有「素材 → 作品」的反查，所以顯示「引用的作品要等本機服務提供反查後才能顯示」，不在前端逐篇作品去查。後端在 QC-010 補上，前端在 QC-011 接。
- **媒體 URL**：`GET /api/v1/assets/:id/stream` 已支援 Range，但 `<img>`／`<video>` 無法帶 Authorization 標頭。所有媒體 URL 都由 `assetMediaUrl()`（`src/shared/bridge.ts`）產生，目前實作是主程序代理 `qc-asset://stream/<id>`（加權杖、只轉送單一 bytes range、不緩衝）。QC-010 決定簽名 URL 或其他做法後，只要換掉這個函式。
- **移到回收、移出索引**：沒有刪除 API，不做（總監已開 QC-015）。
- **任務取消**（QC-015）：服務端任務沒有取消 API，只有本次上傳可以取消與繼續。「取消後重試」只適用於上傳。
- **監控資料夾**（匯入任務右欄下半，QC-015）：沒有 API，所以不做。
- **設定頁**：只做服務狀態、即時更新連線、托管目錄、外部掛載。服務啟停、開機啟動、防睡眠、備份還原屬 QC-004；AI 金鑰是 M3；Tailscale 和裝置配對是第二期。這些區塊都直接不顯示，不放假按鈕。
- **導航**：AI 工作台、平台預覽、發布中心等到各自的任務再加。
- **新增**：素材庫加了檔名搜尋，類型篩選加了「音訊」「其他」，對應 API 已有的 `q` 與 kind。

## NOT_VERIFIED

- NOT_VERIFIED：URL 匯入下載成功與下載失敗（逾時、HTTP 錯誤）的任務列。要真的連外網，依規則不做；這些狀態只有單元測試。私有 IP 會當場被拒，所以「已阻擋」也只在對話框裡實測，任務列上的「已阻擋」只有單元測試。
- NOT_VERIFIED：系統檔案選擇器與資料夾選擇器（原生對話框，CDP 驅動不了）。上傳改用拖放實測，掛載用種子腳本與「重新掛載」實測。
- NOT_VERIFIED：「在 Finder 顯示」實際打開 Finder（原生行為）；路徑檢查有單元測試。
- NOT_VERIFIED：複製到系統剪貼簿的內容（只驗證了按鈕回饋）。
- NOT_VERIFIED：實體鍵盤加 macOS 輸入法打字（組字由 CDP `Input.imeSetComposition` 模擬）。
- NOT_VERIFIED：VoiceOver 實際朗讀。
- NOT_VERIFIED：睡眠喚醒後的重連（只用 45 秒無資料逾時的單元測試覆蓋）。
- NOT_VERIFIED：App 重啟後未完成的上傳不會保留（上傳清單只在記憶體裡）；服務端會保留 tus 暫存 7 天，但 App 沒有恢復入口。
- NOT_VERIFIED：用建置產物啟動。

## 清理

mac-server、Vite、Electron 都已關閉，7420、5180、9333 埠已釋放；臨時資料目錄、掛載資料夾、1 GB 測試檔都已刪除；e2e 鎖已釋放。
