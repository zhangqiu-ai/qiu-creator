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

## QC-033: Mac 生產可用實機驗收

**Priority:** P1 | **Assignee:** qc-test | **Tags:** M3

QC-004 的驗收本體，依賴 QC-030–032。實機安裝後：重開機自啟、`kill -9` 自動恢復、備份還原演練、原稿保護抽查、MacBook 合蓋／接電源／電池下服務與長任務行為（使用者親自合蓋）、使用者在 App 設定頁親自輸入金鑰後 Gemini／Claude／GPT 各真實呼叫一次並記錄費用（子會話不碰金鑰）、日常使用一輪的問題清單。證據 `docs/evidence/qc033-*`。

**Started:** 2026-11-19（使用者「Approve install」同意真實安裝；qc-release 安裝，qc-test 驗收。安裝時 `~/CreatorHub` 尚不存在，為全新安裝）

**Status（2026-11-19）:** U0 備份通過；U2、U3 使用者豁免（未驗證）；U4 New API 真實呼叫通過，Gemini／Claude／GPT 使用者豁免（未驗證）。U1 已通過（2026-11-21 03:14 系統自行重開，服務開機後 119 秒自啟）。剩 U5 日常使用一輪。證據在分支 `test/qc033-acceptance`（未合併）。此卡在開 QC-036 時被誤刪，2026-11-19 補回。
