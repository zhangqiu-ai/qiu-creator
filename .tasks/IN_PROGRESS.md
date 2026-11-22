## QC-064: e2e 視窗完全不出現在螢幕上（QC-060 不足）

**Priority:** P0 | **Assignee:** qc-test | **Tags:** M3

使用者 2026-11-21 再次回報（截圖：一個灰色標題列、未取得焦點的 qiu-creator 測試視窗蓋在畫面上，空作品庫）：「為什麼現在自動化測試還是會跑到前台來干擾我，沒有辦法解決嗎？」
- 原因：QC-060 只做到「不搶焦點、不進 Dock」，`showInactive()` 仍把視窗畫在螢幕上，會蓋住使用者正在用的視窗。QC-060 的驗收只量了「前景 App」，沒量「螢幕上有沒有出現視窗」，驗收標準錯了。
- 目標：背景模式下測試視窗**完全不出現在任何螢幕上**，也不攔截使用者的滑鼠。
- 方向（評估後選一個並說明）：視窗維持隱藏（`show: false`）＋`webPreferences.backgroundThrottling: false`＋`paintWhenInitiallyHidden: true`，Playwright 經 CDP 操作與截圖；需要 focus／visibility 的測試用 CDP `Emulation.setFocusEmulationEnabled` 等模擬。或移到所有螢幕範圍外（注意 macOS 會把視窗夾回螢幕，需實測）。不可用透明度 0（仍會攔截點擊）。
- 驗收：整套 e2e 期間用 `CGWindowListCopyWindowInfo`（或 `osascript`／`screencapture` 比對）證明沒有任何 qiu-creator／Electron 測試視窗出現在螢幕上；前景 App 不變；全部 e2e 通過，不放寬斷言、不加逾時。
- 修好前：各子會話**暫停整套 e2e**，只在必要時跑最少的單一 spec。

## QC-063: 側欄收合按鈕併入 Logo（hover 切換）

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M3, frontend

使用者 2026-11-21（截圖箭頭指向側欄頂部的 Logo 與右側收合按鈕）：「這個側邊欄控制按鈕可以簡化設計，比如放到LOGO上，使用鼠標HOVER來控制切換。」
- 移除 Logo 列右側獨立的收合按鈕。滑鼠移到 Logo 上時，Logo 圖示換成「收合／展開側欄」圖示（帶 tooltip 與快捷鍵提示），點擊切換；移開恢復 Logo。參考 ChatGPT、Claude 桌面版的做法（查 qiuge-design `navigation`）。
- 收合狀態下同一位置仍可 hover 展開；鍵盤可聚焦（focus-visible 時同樣顯示切換圖示）、VoiceOver 名稱為「收合側欄／展開側欄」；保留既有快捷鍵與選單項，沒有就加 ⌘⌥S 或依 macOS 慣例並說明。
- 服務狀態綠點保留在原位。三語 tooltip；淺／深色；動畫克制。
- 與 QC-062（側欄加項目）同區域：先做這張、改動只限 Logo 列，盡快合併。
- 補 e2e（背景模式）：hover 顯示切換、點擊收合與展開、鍵盤操作。附截圖。
- 屬既有元件的小改，不另開原型。使用者授權做完與 QC-061 一起發版（若 QC-061 先好就先發，這張下次跟上）。

## QC-062: 作品庫加「項目」分類

**Priority:** P1 | **Assignee:** qc-prototype（原型）→ qc-backend ＋ qc-frontend | **Tags:** M3, prototype, backend, frontend

使用者 2026-11-21 授權：完成驗收後直接發版安裝（「做完直接發版」）。
使用者 2026-11-21：「作品庫目前是全部內容堆積到一個頁面中，我希望能增加項目分類，這樣能根據項目來管理各種內容！」決策見 `docs/decisions.md`：作品可屬多個項目；先只分作品，素材共用但項目內可看用到的素材；原型由總監代核准。

**步驟一：原型（qc-prototype，新 PT）**
- 項目在哪裡：建議側欄「作品庫」下方列出項目（可收合、可拖曳排序），點項目後作品庫只顯示該項目；另有「全部作品」「未分類」。項目可有名稱、顏色或圖示、描述（可選）。
- 項目管理：新建、改名（原地雙擊，沿用 QC-052）、改顏色、排序、封存、刪除（刪除項目不刪作品，確認框說清楚）。
- 作品與項目：新建作品時預設進目前所在的項目；卡片右鍵「加入項目／移出項目」（多選子選單，可勾多個）；多選批量加入／移出（沿用 QC-052 批量列）；拖曳卡片到側欄項目即加入。卡片上顯示所屬項目（小色點或標籤，多個時摺疊）。編輯頁頂部可看、可改所屬項目。
- 項目頁：作品格狀／列表（沿用 QC-052、QC-061 縮圖卡）、篩選（類型、狀態）沿用；項目概覽（作品數、各狀態數、最近更新）；「這個項目用到的素材」入口（跳到素材庫並篩選）。
- 與「最近刪除」：刪除的作品不計入項目；還原後回到原本的項目。
- 空狀態：沒有項目、項目內沒有作品。三語文案長度；淺／深色。
- 查 qiuge-design（`navigation`、`data-display`、`content-editing`、`empty-states`），引用卡片。

**原型已核准（2026-11-21）**：PT-20261121-003 由總監代核准（依帳本，畫布未上傳），openQuestions 全採建議。

**步驟二：實作（核准後）**
- 後端：projects 表與 work_projects 多對多（可回滾 migration），CRUD、排序、封存；作品列表 `project_id`／`unassigned` 篩選；批量加入／移出；變更事件；contracts、api-client、agent-sdk CLI；不搬動作品檔案。
- 前端：照原型。與 QC-061（卡片縮圖）同一區域，等 QC-061 合併後再動卡片。

## QC-061: 作品庫卡片顯示真正的縮略圖

**Priority:** P1 | **Assignee:** qc-frontend（主）＋ qc-backend（需要時） | **Tags:** M3, frontend, backend

使用者 2026-11-21 授權：完成驗收後直接發版安裝（「做完直接發版」）。
使用者 2026-11-21（附已安裝版 272c754 作品庫截圖）：「作品庫的卡片中要顯示縮略圖，目前只有一個圖標在上面，不是很直觀！」截圖：視頻卡只有「0:51 · 竖屏」徽章、封面區空白；貼圖卡與四張文章卡都只顯示類型圖示。

**後端已合併（2026-11-21，6b41b56）**：列表帶 `card_image.url`（簽名、整點對齊）與 `excerpt`（120 字）；`/works/:id/thumbnail` 有 ffmpeg 用 ffmpeg，沒有則 `needs_frame` 由 App 截幀 `PUT thumbnail-frame`（2 MiB、sharp 解碼驗證、version 防舊幀）；全倉 1004／0／1004；最終版 e2e NOT_VERIFIED（QC-064 暫停中），前端合併前補跑。

總監初查（待證實）：
- `apps/mac/src/renderer/WorkCover.tsx` 只在 `thumbnail.asset_id` 有值時才顯示圖；視頻用 `<video preload="metadata" #t=…>` 取幀，安裝版顯示空白（可能是 `qc-asset://` 在打包 App 的載入／CORS，或 metadata 預載不畫幀，QC-046 時列為 NOT_VERIFIED）。
- 後端 `typed-media.ts` 的 `thumbnail` 對文章一律為 null；`asset_id` 只在檔案對得上素材庫時才有，作品自己 `assets/` 內的檔案可能沒有 asset_id（應改走 `path` 加作品檔案路由）。
- 貼圖卡要確認那個作品是真的沒圖，還是有圖卻沒 asset_id。

要做：
1. **視頻**：卡片顯示封面幀。建議後端在選定封面或匯入視頻時產生並快取靜態縮圖（WebP，最長邊 512，放可重建的 `cache/`），卡片只載圖片，不在列表裡開 `<video>`。
2. **貼圖**：封面或第一張圖；`asset_id` 為空時用作品檔案路由。
3. **文章**：正文第一張圖（Markdown 圖片或 front matter cover）；沒有圖時用「文字預覽」卡面（標題＋前幾行摘要，排版要好看），不是只放圖示。
4. 圖片載入失敗、檔案遺失：顯示類型圖示＋既有「缺少媒體」徽章，不留空白。
5. 效能：縮圖延遲載入、快取；上百張卡捲動順暢。
6. 必須在**打包後的 App**驗證（不只 dev），附截圖；e2e 用背景模式。
不改原稿；縮圖是可重建快取。三語文案進 i18n。

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
