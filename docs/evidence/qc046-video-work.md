# QC-046 驗收記錄（前端）：視頻作品

日期：2026-11-21　分支：`feat/qc046-video-work`（從 main `aa6b6ab` 開，已 rebase 到 `f98adac`，含 QC-049）
依據：原型 PT-20261121-001 的 VideoWork、VideoWorkDark 畫板（`docs/design/prototype/changes.json` 的狀態清單與 `decisions`），以及 `docs/evidence/qc045-046-backend.md` 第 5 節。
畫布仍然讀不到，所以以 ledger 為準。ledger 沒寫到的細節是我的判斷，列在「與原型的差異／待確認」。
所有測試都用假服務：Gemini 是本機的 `FakeGeminiVideo`，沒有對 Google 發出任何請求。

## 做了什麼

### 視頻與播放器

- **新建選單**：「視頻」已啟用，說明文字改成「圍繞一支視頻組稿：封面、文案、AI 理解」。
- **尚未選視頻**：顯示「從素材庫選」與「上傳視頻」。素材抽屜只列出視頻，縮圖用 `<video>` 的第一格。
- **上傳中**：顯示進度與「上傳完成前，封面與 AI 理解暫停使用」，可以取消。這段期間封面按鈕停用，AI 面板也顯示暫停。
- **播放器**：
  - 直式視頻置中。
  - 時間軸上的點是重點時間點，點選會跳過去。
  - 焦點在播放器上時，←→ 前後 5 秒。
  - 視頻資訊列出時長、直式或橫式、檔案大小。
  - 可以更換視頻。

### 封面

- **App 截圖**：照 decisions，由 App 從播放器截取，不打包 ffmpeg。
- **選幀**：8 格幀條平均取點，點一格就設成封面；也可以按「用目前畫面」。
  - 取到的畫面是原尺寸 JPEG，名稱例如 `cover-0m03s.jpg`。
  - 經主程序上傳成圖片素材，再寫入作品的 `cover`。
- **另外上傳**一張圖片當封面。
- **裁切預覽**：抖音 3:4、視頻號 6:7。
- **安全**：主程序的 `qc-asset://` 只對本 App 的 origin 回 `Access-Control-Allow-Origin`，所以 canvas 不會被污染，其他來源讀不到視頻內容。

### 文案：共用加平台覆寫

- **三個分頁**：共用、抖音、視頻號。
- **共用分頁**：
  - 標題下方顯示「抖音 n/30」「視頻號 n/16」。
  - 簡介下方顯示兩個平台的字數。
  - 狀態列旁顯示話題數，例如「抖音 n/5」。
- **平台分頁**：
  - 預設勾選「沿用共用文案」，欄位唯讀，顯示共用內容與該平台的字數。
  - 取消勾選時，先從作品建立該平台的版本，再設 `inherit: false`，之後可以單獨改寫標題、簡介、話題。分頁上標「自訂」。
  - 重新勾選時改回共用，平台自己的文字由服務端保留。
- **預覽分頁**：抖音、視頻號的模擬預覽，使用各平台實際會用的文案與封面。
- **側欄寬度**：沿用 QC-049 的 `.post__side` 規則，`.vw__side` 的 `flex-basis` 是手機寬 340px、左右內距、捲軸加邊框。手機模擬與 AI 結果都不會出現橫向捲軸。

### Gemini 理解

- **先預估再送出**：「分析視頻」開啟確認框，顯示時長、模型、tokens、最多花費、本月累計。
  - 多了一個勾選框「我了解視頻會上傳到 Google，並可能產生最多 $X 的費用」，勾選前送出按鈕停用。
  - 首次使用時，同一個框裡也確認使用告知。
- **長視頻**（超過 1 小時）：面板提示「預設用低解析度分析全片」，確認框裡的低解析度已勾選。
- **大檔案**（超過 2 GB）或超過 3 小時：呼叫服務前就說明無法分析，也不顯示「分析視頻」。
- **進度與失敗**：
  - 分析中顯示上傳或分析進度，可以取消。
  - 失敗時顯示原因與技術細節，可以重試；有上次結果時可以查看。
- **結果**：
  - 摘要。
  - 重點時間點：每點都標「待核驗」，超出片長的另外標「超出片長」並停用跳轉。
  - 標題、簡介、封面建議。
  - 說明文字用介面自己的三語文案。
- **採用前先看差異**：
  - 標題、簡介用句子 diff 顯示刪改；封面並列「目前」與「建議」兩張。
  - 採用會用 `ai_job_id` 寫成一個 `ai_accepted` 版本，提示附「復原」，會恢復採用前的版本。
  - 封面建議會先從播放器截取該秒畫面，上傳後再採用。

## 順手修的同根問題

**自己的 SSE 回音被當成別處修改**：

- **原因**：
  - 寫入請求還在進行時，服務的 SSE 可能先送回這個新版本。
  - `WorkSession.exclusive` 在請求結束的 `finally` 裡就立刻檢查這個版本，那時呼叫端還沒來得及採用回傳的版本，所以這個版本被當成「已在別處修改」。
  - 結果是「已在別處修改」的橫幅出現，之後的復原也被擋住。
- **影響範圍**：恢復版本、文章的 AI 採用（QC-024），以及這次的採用建議，三者是同一個順序問題。
- **修正**：
  - 改在下一個 task 才檢查，讓呼叫端先採用。
  - 新增單元測試，讓 SSE 回音在請求回應前送到。拿掉修正時，這個測試必定失敗。
  - 視頻 e2e 的「採用後復原」原本因為這個問題失敗，修正後通過。

## 為了視頻做的其他調整

- **AI 工作台的確認框**：改成匯出並加 `requireAck` 選項。工作台本身不傳這個選項，行為不變。
- **QC-045 的 e2e**：原本檢查新建選單的「視頻」停用、「新建視頻」停用；現在改成檢查兩者都已啟用。這是這張任務本來就要的改變。
- **e2e fixture**：加入 `FakeGeminiVideo`，Gemini 的請求都導到它。目前沒有 e2e 使用 Gemini 文字。
- **測試用視頻**：新增 `e2e/fixtures/media/portrait-8s.webm`，是 360×640、8 秒、VP9、120 KB 的測試圖案。
  - 用 ffmpeg 產生一次後提交進倉庫，測試只讀這個檔案，不會執行 ffmpeg。
  - 產生指令寫在 spec 開頭。

## 異動檔案

| 檔案 | 用途 |
| --- | --- |
| `apps/mac/src/renderer/VideoWorkEditor.tsx`（新） | 視頻作品編輯器 |
| `apps/mac/src/renderer/video-work.ts`（新） | 幀時間、←→、分析前阻擋、長視頻、方向、文案字數 |
| `apps/mac/src/renderer/frames.ts`（新） | `FrameGrabber`：從視頻截取畫面 |
| `apps/mac/src/renderer/upload-wait.ts`（新） | 上傳 blob 或檔案，並等待素材 |
| `apps/mac/src/renderer/work-session.ts` | 草稿 `video`；`acceptSuggestion`；SSE 回音順序修正 |
| `apps/mac/src/renderer/ai-video.ts` | `VideoSession` 帶 `work_id` |
| `apps/mac/src/renderer/variant-session.ts` | `setInherit` |
| `apps/mac/src/renderer/AiWorkbenchPage.tsx` | 匯出確認框，加 `requireAck` |
| `apps/mac/src/renderer/InsertUI.tsx` | 素材抽屜 `kind="video"` |
| `apps/mac/src/renderer/EditorTabs.tsx`、`LibraryPage.tsx` | 分頁路由；啟用新建視頻 |
| `apps/mac/src/main/main.ts`、`app-protocol.ts` | `qc-asset://` 的 CORS 只對本 App 的 origin |
| `apps/mac/src/renderer/styles.css` | 視頻編輯器樣式；`.vw__side` 沿用 QC-049 的寬度規則 |
| `packages/i18n/src/catalog/videoWork.ts`（新）、`library.ts`、`index.ts` | 三語文案 |
| `apps/mac/test/video-work.test.ts`（新）、`image-post.test.ts` | 單元測試 |
| `e2e/specs/video-work.spec.ts`（新）、`image-post.spec.ts`、`e2e/fixtures/desktop.ts`、`e2e/fixtures/media/portrait-8s.webm`（新） | e2e |
| `docs/architecture.md` | 「視頻作品編輯器（QC-046 前端）」一節 |

## 驗證

- **rebase 到 `f98adac` 之後重跑**（rebase 沒有衝突）：
  - typecheck（全部套件加 e2e）、`pnpm -r lint`、根目錄 `eslint .`、`format:check`：全部通過。
  - 全倉測試：885 passed／0 failed／885 total。2026-11-21 09:37:29–09:37:44，負載 3.23→3.25，持有 `qc-fullsuite.lock`。各套件：
    - contracts 21、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20。
    - markdown-editor-web 29、platform-preview 12、mac-server 393、apps/mac 297（新增 14）、agent-sdk 6。
  - e2e：18 passed／0 failed／18 total（09:36，1 分鐘負載約 3）。
- **rebase 前**：e2e 曾在負載短暫升到 30 時失敗 2 個，都是 QC-045 檢查「視頻停用」的斷言，與負載無關，已照「其他調整」一節更新。
- **側欄寬度檢查**：e2e 在 AI 結果與預覽兩個分頁都檢查 `.vw__side` 沒有橫向捲動，手機也沒被裁掉，作法同 QC-049。拿掉 `flex-basis` 時，這項檢查會失敗（橫向捲動、手機被裁），已實際確認。
- **單元測試 `video-work.test.ts`**（14 個）：
  - 純規則：
    - 幀時間：8 格平均，不取開頭與結尾。
    - ←→ 在片長內移動；時間軸百分比；時間標籤。
    - 分析前阻擋：上傳中、超過 2 GB、超過 3 小時。
    - 長視頻判斷；直式或橫式。
    - 抖音與視頻號的標題、簡介、話題上限。
    - 新建選單已啟用視頻。
  - `rendererOrigin`：只放行 App origin 與開發伺服器。
  - 真服務加 `FakeGeminiVideo`：
    - 存視頻、截取的封面與簡介。
    - 分析後採用標題建議：產生 `ai_accepted` 版本，前一版可以恢復，job 屬於這個作品。
    - 有未存修改時不採用。
    - 平台版本：取消沿用時會建立版本並設 `inherit: false`，可以自己改寫；改回沿用時顯示共用文案；再取消時，自己的文字還在。
    - 沒有版本時改回沿用，什麼都不做。
    - SSE 回音競態：拿掉修正時必定失敗。
- **e2e `video-work.spec.ts`**：
  1. 主流程：
     - ⌘N 按 3 建立視頻作品，畫面是「尚未選視頻」。
     - 從素材庫選視頻；8 格幀條出現；←→ 移動到 5 秒再回到 0 秒。
     - 點 0:03 那格當封面：服務端的封面是 `cover-0m03s.jpg`，360×640 的圖片素材；兩種裁切都顯示。
     - 共用標題的視頻號字數是「18/16」。抖音預設沿用且唯讀；取消後改寫，服務端版本 `inherit: false`、標題正確，分頁標「自訂」。
     - 分析視頻：先顯示最多花費；勾選前送出按鈕停用，送出前 Gemini 假服務收到 0 次上傳。
     - 結果有摘要，並有「待核驗」「超出片長」；點 0:03 竹林入口，播放器跳到 3 秒。
     - 採用標題建議：diff 顯示新增內容，標題更新，版本來源是 `ai_accepted`；按「復原」後標題回到原本。
     - 三語與深色截圖。
  2. 狀態：
     - 長視頻提示，確認框已勾選低解析度。
     - 超過 2 GB：說明無法分析，沒有「分析視頻」。
     - 分析失敗：顯示原因、技術細節與重試，重試後成功。
     - 上傳中：用 120 MB 檔案經 tus 上傳，顯示進度、鎖定說明，「用目前畫面」停用；取消後回到「尚未選視頻」。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc046-zh-Hant-1-empty.png` | 尚未選視頻 |
| `qc046-zh-Hant-2-editor.png` | 編輯器：播放器、時間軸、幀條、裁切、文案、AI 結果，採用後的「復原」提示 |
| `qc046-zh-Hans-2-editor.png`、`qc046-en-2-editor.png` | 简体、English |
| `qc046-zh-Hant-3-confirm.png` | 確認框：告知、預估、低解析度、同意勾選，送出按鈕停用 |
| `qc046-zh-Hant-4-adopt-diff.png` | 採用標題建議的 diff |
| `qc046-en-5-editor-dark.png`、`qc046-zh-Hant-5-editor-dark.png` | 深色 |
| `qc046-zh-Hant-6-long.png` | 長視頻：預設低解析度 |
| `qc046-zh-Hant-7-too-large.png` | 超過 2 GB |
| `qc046-zh-Hant-8-failed.png` | 分析失敗 |
| `qc046-zh-Hant-9-uploading.png` | 上傳中 |
| `qc046-zh-Hant-10-preview.png` | 預覽分頁：抖音模擬，側欄沒有橫向捲軸 |

## 與原型的差異／待確認

- **畫布讀不到，下列細節是自行決定**：
  - 播放器用原生控制列，再加一條自己畫的時間軸放重點時間點；原生控制列沒有辦法加標記。
  - AI 理解與預覽放在右側兩個分頁。
  - 封面建議要按「查看並採用」才會截圖上傳。
- **時間軸上的封面標記沒有做**：封面是截取後的圖片素材，沒有記錄它來自哪一秒（服務端只存素材）。如果需要，前端可以在截取時把秒數寫進素材名稱以外的欄位，但目前沒有欄位可用。
- **建議的處理方式**：沒有「全部採用」，每個建議個別確認並採用，各自可以復原。
- **平台版本的封面**：預覽沿用作品封面；平台各自的封面沒有做介面，畫板沒列這個狀態。
- **「重新分析」**：沿用工作台的流程。有快取結果時先問「沿用結果」，選擇重新分析才會計費。

## 已知缺口

- **AI 的輸出不翻譯**：摘要、時間點標籤、建議都照模型原文顯示，這是 QC-042 的規則。英文介面下會看到中文的 AI 結果。
- **語言切換前的提示**：切換語言前已經出現的提示，保持原語言（QC-042 已記錄）。
- **平台版本不即時同步**：平台版本在別的視窗或 Agent 改了之後，編輯器要重新開啟才會看到；這次沒有訂閱版本的 SSE。
- **外部掛載的視頻作品**：視頻與封面只能在 Finder 調整，介面停用這些操作；文字可以改。

## NOT_VERIFIED

- 真的 Gemini（依規定不發真實請求）。
- GB 級視頻的播放與截圖。大檔案的狀態是用資料庫把大小改成 3 GB 模擬的。
- 長視頻的實際播放：長度是用資料庫把時長改成 2 小時模擬的。
- H.264 等其他編碼在 Electron 的播放與截圖：e2e 用的是 VP9 webm。
- 打包後的 App 的 `qc-asset://` CORS。
- VoiceOver。
