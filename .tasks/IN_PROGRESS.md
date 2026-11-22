## QC-065: 全面引入動效設計（Motion／Framer Motion、dnd-kit）

**Priority:** P1 | **Assignee:** qc-frontend（主）＋ qc-prototype（動效規格） | **Tags:** M3, frontend, prototype

使用者 2026-11-21 授權發版；後改為 QC-061、QC-062、QC-063、QC-065 合在**同一個版本**發（「三項發在一個版本中」），全部驗收合併後才安裝。
使用者 2026-11-21：「我先發現此項目很少用到動效來提升UI、UX質量，現在你要全面的引入動效設計，Framer Motion、dnd-kit 這是兩個動效庫，來大幅提升產品的優雅和舒適性。」

**步驟一：動效規格（寫進 DESIGN.md「動效」一節，總監核准）**
- 動效 tokens：時長（例如 120／180／240／320 ms）、曲線（標準、進入、離開、彈簧參數）、距離；macOS 的克制風格，避免花俏與彈跳過度。
- 每類互動的規則：頁面與分頁切換、側欄收合、彈出層／選單／對話框／抽屜、toast 堆疊、列表新增／刪除／重排（layout 動畫）、卡片 hover／選取、載入骨架到內容、狀態變化（儲存、測試連線、AI 任務進度）、拖放（拿起、經過目標、放下、取消）。
- 無障礙：尊重 `prefers-reduced-motion`（系統「減少動態效果」），改為淡入或無動畫；動畫不阻擋輸入、不延遲焦點；中文輸入法組字中不觸發會搶焦點的動畫。
- 效能：只動 transform／opacity；大量卡片時的 layout 動畫上限；120 Hz ProMotion 與低電量模式下的表現。
- 查 qiuge-design（`visual`、`feedback`、`navigation`、`data-display`），引用卡片。

**步驟一已完成（2026-11-21）**：DESIGN.md「動效」一節由總監代核准（tokens 放 `packages/design-tokens` 純資料、reduced-motion 保留轉圈）。互動示範在共用筆記 `qc065-motion-demo.html`。

**步驟二：基礎建設**
- 依賴：`motion`（Framer Motion 的現行套件名，MIT）、`@dnd-kit/core`／`@dnd-kit/sortable`（MIT）；寫進 `docs/dependencies.md`（授權、版本、替代方案、體積）。只放在 `apps/mac` 的 renderer；`packages/*` 不依賴它們（共用套件不綁死）。
- 共用動效元件與 hooks（例如 `<Presence>`、`<Reorder>`、`useReducedMotion` 封裝、tokens 常數），既有 CSS transition 統一改用 tokens。
- 拖放：統一用 dnd-kit（鍵盤拖放、觸控板、無障礙播報三語），取代目前各處自寫的拖曳。

**步驟三：分區落地（每區一個 commit，可分次合併）**
1. 殼層：側欄收合（QC-063 Logo 切換）、頁面切換、編輯分頁開關與重排（分頁可拖曳排序）。
2. 浮層：選單、右鍵選單、對話框、抽屜、toast。
3. 作品庫：卡片進出與篩選切換的 layout 動畫、多選、批量列、最近刪除。
4. 貼圖編輯：圖片格拖曳排序（dnd-kit sortable）、封面設定。
5. 設定與 AI：分頁切換、測試連線狀態、AI 工作台結果載入。
6. 項目（QC-062）：側欄項目排序、拖卡片到項目的放下回饋。

- 時序：與 QC-061、QC-062 同區域；先做步驟一、二與 1、2 區，作品庫與項目區等 QC-061／QC-062 合併後再做，避免衝突。
- 驗收：每區附前後對照錄影（GIF 或 mp4）、reduced-motion 截圖；e2e 背景模式（QC-064 後），測試要能關閉動畫（測試模式直接用 reduced motion）以免時序不穩。

## QC-062: 作品庫加「項目」分類

**Priority:** P1 | **Assignee:** qc-prototype（原型）→ qc-backend ＋ qc-frontend | **Tags:** M3, prototype, backend, frontend

使用者 2026-11-21 授權發版；後改為 QC-061、QC-062、QC-063、QC-065 合在**同一個版本**發（「三項發在一個版本中」），全部驗收合併後才安裝。
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

**後端已合併（2026-11-21，21c8158）**：migration 0017_projects（projects、work_projects，change_log 允許 entity project，回滾有測試）；項目 CRUD／排序／封存／軟刪除 30 天清除；作品 `project_ids`、`project_id`／`unassigned` 篩選；`POST /works/batch/projects`；`GET /assets?project_id=`；事件；CLI。全倉 1016／0／1016；e2e NOT_VERIFIED（QC-064 暫停中）。剩前端。

**步驟二：實作（核准後）**
- 後端：projects 表與 work_projects 多對多（可回滾 migration），CRUD、排序、封存；作品列表 `project_id`／`unassigned` 篩選；批量加入／移出；變更事件；contracts、api-client、agent-sdk CLI；不搬動作品檔案。
- 前端：照原型。與 QC-061（卡片縮圖）同一區域，等 QC-061 合併後再動卡片。

## QC-061: 作品庫卡片顯示真正的縮略圖

**Priority:** P1 | **Assignee:** qc-frontend（主）＋ qc-backend（需要時） | **Tags:** M3, frontend, backend

使用者 2026-11-21 授權發版；後改為 QC-061、QC-062、QC-063、QC-065 合在**同一個版本**發（「三項發在一個版本中」），全部驗收合併後才安裝。
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
