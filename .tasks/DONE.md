# Done

## QC-049: sidebar.spec 不穩定與貼圖預覽橫向捲軸

**Priority:** P3 | **Assignee:** qc-bugfix | **Tags:** M3, bug | **Done:** 2026-11-21

- sidebar.spec 所有「動作後立刻讀」改成等待式斷言，期望值不變、未加逾時或重試；一般負載與加壓各連跑 30 次全過。原本那次失敗無法重現，NOT_VERIFIED。
- 貼圖側欄 `.post__side` 寬 385 px，容納 340 px 手機模擬框加 padding 與捲軸，不再橫向溢出；新增 expectPreviewFits 回歸斷言（先紅後綠）。
- 全倉 871／0／871、e2e 16／16。證據 `docs/evidence/qc049-sidebar-flake-preview-scroll.md`。

## QC-045: 貼圖作品創作

**Priority:** P1 | **Assignee:** qc-backend + qc-frontend | **Tags:** M3, backend, frontend | **Done:** 2026-11-21

- 後端見 QC-045／046 後端合併。前端：新建選類型（⌘N，視頻在 QC-046 前停用）、類型篩選數量、卡片縮圖與張數、類型空狀態。貼圖編輯器放進分頁框架：3:4 圖片格、拖曳／⌥←→ 排序、⌫ 移除加復原、多種加圖方式、上傳中／失敗／檔案遺失重新指定、平台張數與字數 chip（只提示）、封面三種裁切、歷史、側邊預覽、外部掛載唯讀圖片。共用提示佇列（最多 2 則堆疊）、素材抽屜說明列固定底部。
- 全倉 871／0／871、e2e 16／16。證據 `docs/evidence/qc045-image-post.md`。

## QC-048: 匯入錯誤細節與平台版本警告的三語文案

**Priority:** P3 | **Assignee:** qc-frontend | **Tags:** M3, frontend | **Done:** 2026-11-21

- 匯入錯誤原文收進「技術細節」並去金鑰；平台版本警告依 code／limit／actual 組三語文案。與 QC-045 同分支。

## QC-047: 作品編輯多分頁

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend | **Done:** 2026-11-21

- 側欄右側的分頁列：類型圖示、未存點、衝突、AI 候選、溢出捲動與「全部分頁」選單（搜尋、狀態、⌘ 編號、關閉其他）、拖曳排序、重複開啟聚焦並閃一下。切換保留模式、草稿、游標、捲動與側欄面板。最多同時載入 8 個編輯器，有未存、衝突或 AI 狀態的不卸載。關閉未存：重試儲存／不儲存並關閉／取消，可重新開啟找回。重開 App 恢復全部、只載入作用中。⌘1–9、⌘⇧[ ]、⌘W，關閉視窗改 ⌘⇧W，原生選單三語。
- 順修：切換語言時已開的編輯器工具列原地更新文字（QC-042 遺漏，分頁常駐後變明顯）。
- 全倉 853／0／853、e2e 14／14。證據 `docs/evidence/qc047-editor-tabs.md`。畫布讀不到，依 ledger 施工。

## QC-043: 服務端產生的文字跟隨介面語言

**Priority:** P3 | **Assignee:** qc-backend | **Tags:** M3, backend | **Done:** 2026-11-21

- AI 首次使用告知、預算提醒、AI 任務錯誤、備份錯誤改由服務端回代碼與參數，介面依語言組句。技術細節收進共用的可展開元件，不翻譯；服務端與介面各去一次金鑰。遷移 0014 `ai_jobs.error_detail`。舊欄位保留相容。同意只綁版本與 credential_id，切換語言不需重新同意。New API 名稱與 `credential_changed` 也改由介面翻譯。英文字數統一用 words。
- 全倉 805／0／805、e2e 9／9。證據 `docs/evidence/qc043-server-text.md`。

## QC-044: 原型：貼圖／視頻創作與多分頁編輯

**Priority:** P1 | **Assignee:** qc-prototype | **Tags:** M3, prototype | **Done:** 2026-11-21

- PT-20261121-001，畫布第 41 版，9 張畫板（新建選類型、貼圖、視頻、多分頁、三語版面，及四張深色）。10 個待決問題由總監代為核准，決定記在 changes.json `decisions`。
- 核准時畫布因網路錯誤讀不到，依 ledger 核准；施工以畫布為準。

## QC-042: 介面多語言（简体中文／繁體中文／English）

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend | **Done:** 2026-11-21

- 新共用套件 `packages/i18n`（不依賴 Electron，約 1,230 鍵，三語缺鍵即 typecheck 失敗，`Intl` 格式化，用語表）。設定 → 外觀加語言卡（跟隨系統／简体／繁體／English），即時切換含原生選單、檔案面板標題、`<html lang>`，開窗前決定語言。
- 錯誤改依錯誤碼顯示文案。舊安裝升級寫入 `zh-Hant`，新安裝跟隨系統。AST 檢查禁止介面元件寫死中文（只允許平台預覽的平台自身文字）。
- 全倉 790／0／790、e2e 8／8。證據 `docs/evidence/qc042-i18n.md`。NOT_VERIFIED：實機改 macOS 語言後自動跟隨、打包版選單與首畫面、真實 preferences 遷移、素材庫／匯入／平台預覽／AI 工作台的英文逐頁截圖、VoiceOver。

## QC-039: 作品編輯插入素材與貼上圖片

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, ui, api | **Done:** 2026-11-19

- 新增 `POST /works/:id/media/attach`：把素材複製到託管作品自己的 `assets/`（同內容沿用、同名自動改名、絕不覆蓋、暫存檔加 link），建立連結；外部作品回 409 `attach_external_unsupported`，不寫外部資料夾；不寫 `.md`。
- 插入選單、`/` 斜線選單、素材抽屜（⌘⇧I）、Finder 拖入（插入線、固定在可視區的虛線框、靠邊自動捲動）、⌘V 貼上（上傳中／完成／失敗可重試或移除），視覺與原始碼模式都可用。貼上的暫存檔在成功、取消、移除時清掉，啟動與結束時再清一次。
- 素材引用回傳 `independent_copy`，QC-037 刪除確認框分別說明「獨立複本不受影響」與「真的會缺圖」的作品。順修 QC-010 媒體解析在 attach 後顯示「未儲存」佔位圖。
- 全倉 753／0／753、e2e 7／7。證據 `docs/evidence/qc039-editor-insert.md`。NOT_VERIFIED：真實 Finder 拖曳與系統剪貼簿、抽屜拖進文中（無 e2e）、大檔續傳、多掛載資料夾、VoiceOver。

## QC-037: 素材庫刪除與編輯

**Priority:** P1 | **Assignee:** qc-backend + qc-frontend | **Tags:** M3, ui, api | **Done:** 2026-11-19

- 後端：遷移 0013，PATCH／DELETE／restore／trash／references／batch API，30 天清除，外部原檔只在選擇時移到系統垃圾桶。
- 前端：全部／未引用／最近刪除三段；素材資訊可編輯（名稱、標籤、替代文字、備註），600 ms 自動儲存，409 逐欄重套、同欄衝突讓使用者選；刪除依引用與託管／外部分流，預設焦點在取消，附復原（⌘Z）；多選批次加標籤與移除；最近刪除可恢復、永久刪除、清空並提示缺圖作品。
- 全倉 713／0／713、e2e 5／5。證據 `docs/evidence/qc037-asset-api.md`、`qc037-assets-ui.md`。NOT_VERIFIED：介面觸發真實 `/usr/bin/trash`、`markdown_referrers` 提示與 `asset_file_missing` 只有單元測試、200 個以上素材、VoiceOver。

## QC-038: 設定頁重排與主題切換

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** M3, ui | **Done:** 2026-11-19

- 設定頁左側分類導覽（外觀、本機服務、備份與還原、AI 服務、資料夾、關於），內容欄獨立捲動並隨捲動標示分類。主題淺色／深色／跟隨系統卡片，預設跟隨系統，即時套用並存於主程序偏好、開窗前套用。深色對比 ≥ 6.89:1、淺色 ≥ 5.18:1。備份列表預設 3 份可展開。側欄與設定頁共用同一服務狀態來源。
- 全倉 697／0／697、e2e 4／4。證據 `docs/evidence/qc038-*`。NOT_VERIFIED：真實切換 macOS 外觀、打包後首次開窗不閃色、VoiceOver。

## QC-041: 側邊欄重設計與 App 圖示

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** M3, ui | **Done:** 2026-11-19

- 側欄分組（創作、素材、AI），設定固定左下；預設 232px，可拖曳／方向鍵調整 200–320，雙擊恢復；⌃⌘S 收成 56px 圖示列附 tooltip；寬度與收起狀態記住；窄於 900px 自動用圖示列。服務狀態點綠／紅（還原中琥珀），hover／聚焦顯示詳情浮層。
- App 圖示方案 B（q 字標），SVG 產出 icns／png，接入 electron-builder。
- 全倉 672／0／672、e2e 3／3（分支上）；合併後 apps/mac 185／185。證據 `docs/evidence/qc041-*`。

## QC-040: 編輯頁捲動時內容被遮擋

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, bug, ui | **Done:** 2026-11-19

- `.editor__body` 不再整體捲動；正文與側面板各自捲動，面板分頁列 sticky；窄於 820px 改上下排列、面板限高 45%。
- 新 e2e `editor-scroll.spec.ts`（修正前紅、修正後綠）；全倉 660／0／660；前後截圖在 `docs/evidence/qc040-*`。

## QC-036: 安裝器升級時 launchd bootout／bootstrap 競態

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M3, bug | **Done:** 2026-11-19

- `Run.bootout()` 送出後輪詢 `launchctl print` 直到服務移除（100 ms、最多 10 秒），一次套用到 upgrade、自動回滾、rollback、install 清理、uninstall；超時丟中文錯誤，不換版本。不加 bootstrap 重試。
- 假 launchctl 模擬延遲移除與虛擬時鐘，新增 7 項；修正前 7 failed，修正後 installer 39／39；全倉 660／0／660（負載 3.0，取鎖）。
- 範圍外：超時時舊服務已收到 SIGTERM，可能已停，訊息只說檔案在原位（記 QC-017）；`waitHealthy` 用真實時鐘。

## QC-035: 接入 New API 中轉站（文字 AI）

**Priority:** P2 | **Assignee:** Codex（使用者直接指派） | **Tags:** M2 | **Done:** 2026-11-19

- 新供應商 `new-api`：OpenAI 相容 Chat Completions，HTTPS、結尾 `/v1`、禁止重新導向；Base URL 與金鑰一起存 Keychain，唯寫。換憑證須重新確認告知，排隊中的舊任務不會送往新設定。遷移 0012（`ai_providers.credential_id`、`ai_jobs.credential_id`）。
- 設定頁新增 New API 列，編輯器 AI 面板可選文字供應商。新開發依賴 `@playwright/test` 與 e2e 測試。
- 總監驗收：typecheck、lint、prettier 通過；全倉 653／0／653（負載 9，取鎖）；e2e 1／1。結果仍為候選加 diff，不覆蓋原文。
- 未走原型核准（使用者直接指派）；未驗證：真實中轉站呼叫、遷移 0012 後回滾舊版。

## QC-032: 打包與安裝腳本

**Priority:** P1 | **Assignee:** qc-release | **Tags:** M3 | **Done:** 2026-11-18

- electron-builder 產出 ad-hoc 簽名 arm64 `qiu-creator.app`（262 MB；未簽名在 Apple Silicon 無法啟動，故用 `identity: '-'`）。
- 新套件 `packages/installer`，入口 `deploy/qc.sh <install|upgrade|rollback|uninstall>`：預設乾跑、`--yes` 才執行；只有真實 HOME 才碰 launchd；安裝前檢查埠、已載入服務、既有檔案；升級先備份（失敗中止），`/health` 驗新版，失敗自動回滾，保留 `server.prev`／`app.prev`；解除安裝不刪 `~/CreatorHub` 與日誌。
- 全倉 649／0／649（負載 4.57，取鎖）；試打包與臨時 HOME 冒煙全過。證據 `docs/evidence/qc032-packaging.md`。
- NOT_VERIFIED：真實 launchd、真實 /Applications 安裝、安裝後整合畫面、Gatekeeper，留給 QC-033。

## QC-034: ai-text 改寫接受測試的順序假設

**Priority:** P2 | **Assignee:** qc-test | **Tags:** backend

### 完成摘要

- 判定為測試的順序假設，不是產品缺陷：假服務依請求到達順序回應，AI 執行器並行 2 個任務，請求到達順序偶爾與建立順序不同。排除去重與結果寫錯（任務 id 不同、各只執行與請求一次）；對調排程可 3／3 確定性重現。
- 只改測試（+5／−1）：每個任務完成後才建立下一個，並斷言三個前提狀態；同類測試已檢查。低負載 30／30，全倉 617／617（基底即當時 main）。證據 `docs/evidence/qc034-ai-text-flake.md`。合併 2026-11-18。

## QC-031: 設定頁備份還原與建置版連線修正

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

### 完成摘要

- 設定頁「備份」區：清單（種類、大小、完整性）、上次與下次每日備份、最近錯誤、目錄與「在 Finder 顯示」、立即備份、還原二次確認（預設焦點在取消）。App 層 BackupSession 追蹤還原：等服務重載後全 App 重新取資料；處理 409 `backup_failed`（明確「未還原」）、503 `restoring`、`restart_required`、逾時「再等一次」。顯示服務版本。
- 建置版 renderer 改由 `qc-app://renderer` 提供，CSP 依實際服務位址產生（QC-017 該條）；副作用：作品庫格狀／清單偏好首次回預設。
- 使用者 2026-11-18 核准原型缺口提案 15 項。Electron 實機對真實服務 33／33。NOT_VERIFIED：60 秒「再等一次」與外部還原事件只有單元測試、Finder 點擊、asar 打包後載入、launchd 自動重啟、VoiceOver。證據 `docs/evidence/qc031-*`。

## QC-020: mounts 「寫一半的檔案」測試依賴真實時間間隔

**Priority:** P3 | **Assignee:** qc-test | **Tags:** backend

### 完成摘要

- 根因：chokidar 寫入穩定判斷用真實時鐘，事件迴圈在負載下停頓超過穩定視窗就提早索引。MountService 加可注入 `Scheduler`（僅供測試，預設不變，+16／−4），測試改手動時鐘、事件驅動。突變檢查有效；壓力 30／30、低負載 20／20。證據 `docs/evidence/qc020-mounts-clock.md`。

QC-020、QC-031 一起合併後全部閘門通過，617／0／617（負載 13.7）。第一次合併驗證 tus「went silent」測試在負載升到 37 時失敗 1 次，單獨重跑 8／8 通過，不算數；再出現就開單。合併 2026-11-18。

## QC-030: 服務建置產物、SQLite 備份還原與睡眠保護

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

### 完成摘要

- 建置：esbuild 打包加原生模組，產物內附 Node（約 110 MB），可複製到任意目錄獨立執行；`/health` 回 commit 與 built_at（可選）。launchd 範本改指向安裝目錄；日誌由服務輪替（10 MB × 5）。
- 備份：每日線上備份與手動備份，三種（daily／manual／pre_restore）各留 14 份，完整性檢查；還原先做 pre_restore 安全備份（失敗回 409 `backup_failed`、不改任何東西），寫標記後在同一行程重建服務，開庫前替換資料庫，事件序號接續；無法重載時回 `restart_required`。還原期間寫入回 503 `restoring`。全部 owner-only。
- 崩潰恢復：SIGKILL 後重啟持久測試；防閒置睡眠用 `caffeinate -i -w`，有長任務才持有。
- NOT_VERIFIED（留 QC-033）：launchd 實機載入、合蓋與電源、真實睡眠喚醒。證據 `docs/evidence/qc030-ops.md`。
- 總監合併後全部閘門通過，586／0／586（負載 14.8）。合併 2026-11-18。

## QC-029: AI 任務的重啟沿用遠端檔與文字任務去重

**Priority:** P2 | **Assignee:** qc-backend | **Tags:** M3, backend

### 完成摘要

- 根因：服務關閉的中止被當成使用者取消，刪了遠端檔。改為關閉時保留 `remote_state`，重啟後先查遠端檔：處理中或可用且離到期 1 小時以上就沿用，否則刪舊檔重傳；未傳完的上傳同一根因，一併保留續傳。
- 改寫與平台候選：支援 `Idempotency-Key`；相同參數與 source_revision 的排隊或執行中任務直接回傳（`in_progress: true`），不重複計費。前端沿用回傳的任務即可，無需改動。
- 持久測試補在 `ai-video.test.ts`、`ai-text.test.ts`。總監合併後全部閘門通過，566／0／566（負載約 3）。合併 2026-11-18。

## QC-026: M3 驗收記錄

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M3

### 完成摘要

- 驗收四項全過：視頻原檔直接上傳、結果保存並跨重啟沿用；AI 不覆蓋原文（候選、409、可恢復、平台候選不寫入）；防重複（快取不計費、reanalyze 才計費、6 並行只 1 任務 1 上傳、冪等鍵）；任務狀態與失敗原因可見（429、金鑰無效、拒答、缺金鑰、未確認告知、處理失敗、取消重試、SIGKILL 重啟續跑）。
- 另測：金鑰不出現在回應、SSE、資料庫、資料夾、畫面與 web storage；所有 /ai 路由對 Agent 權杖 403；撤回告知或刪金鑰後排隊任務不送出；月度提醒不阻擋。API 層持久測試 23 項，Electron 實機 62／62 連續 4 次。
- 兩個觀察開為 QC-029。NOT_VERIFIED：真實 Gemini／Claude／GPT 呼叫與真實 Keychain（待使用者同意並自行存金鑰）、建置產物、本地模型。證據 `docs/evidence/qc026-acceptance.md`。
- 總監合併後全部閘門通過，557／0／557（負載約 4）。合併 2026-11-17。**M3 完成。**

## QC-027: 編輯器衝突對話框的版本號顯示相同

**Priority:** P2 | **Assignee:** qc-frontend | **Tags:** M3, frontend

### 完成摘要

- 根因：衝突對話框用 `baseRevision` 當「你的修改基於」，但收到遠端新版本或 409 後它已指向伺服器版本。改為記錄衝突開始時草稿的基準（`conflictBase`／`draftBase`），AI 採用帶候選的 `source_revision`。一般編輯的 409 同一根因，一併修。
- 持久測試 `conflict-base.test.ts`，Electron 4／4 附截圖。總監合併後 534／0／534。合併 2026-11-17。

## QC-025: AI 工作台頁與設定頁 AI 金鑰

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

### 完成摘要

- AI 工作台：選視頻對話框、送出前確認（告知與費用分兩區，consent 成功才送出）、低解析度、重複分析提示（重新分析會計費）、上傳位元組進度與階段進度、取消、失敗重試、結果五區（時間點標需核驗與超出片長，點擊跳素材檢視器該秒播放）、月度用量與最近任務。
- 設定頁 AI 服務：每家金鑰 password 輸入，只在元件局部狀態、送出即清空、錯誤遮蔽；刪除與撤回告知二次確認；文字／視頻模型選擇；月度提醒金額；本地模型停用註明延後。QC-024「前往設定」直接捲到 AI 區。
- 15 項原型缺口依總監核可實作；與原型不同：拿掉範本選擇、「加入候選」改「複製」、拿掉「此服務不再詢問」。截圖在 `docs/evidence/qc025-acceptance.md`。Electron 實機 45／45。
- 總監合併後全部閘門通過，測試 529／0／529（負載約 3–7）。合併 2026-11-17。

## PT-20261117-002: QC-024 編輯器 AI 面板 8 個補充狀態

**Priority:** P2 | **Assignee:** qc-prototype | **Tags:** M3, prototype

### 完成摘要

- 照實作畫進 MacEditor（畫布第 33 版 1794963039-364c），帳本 approved（總監小型狀態補充授權）。畫布渲染 NOT_VERIFIED。回報的原型與實作不一致開為 QC-027、QC-028。合併 2026-11-17。

## QC-024: 編輯器 AI 改寫與平台標題候選介面

**Priority:** P1 | **Assignee:** qc-frontend | **Tags:** M3, frontend

### 完成摘要

- 編輯頁右側 AI 面板（`ai-session.ts` 邏輯、`AiPanel.tsx` 畫面）：改寫候選依句子 diff 逐處勾選、採用（⌘↩）／插入／重試／捨棄、生成中與停止、失敗重試、無候選、補充指令（組字中不觸發）、採用後復原（新 revision）；採用 409 轉為草稿並開衝突對話框。四平台標題候選，寫入時逐平台帶 base_revision，無版本先從原稿建立並列出新建平台。
- 原型未畫的 8 項依總監核可實作（金鑰／告知提示、供應商自動選擇、語氣輸入、標題分頁狀態、新建版本、復原後提示、409 草稿、選取擴展成段落），截圖在 `docs/evidence/qc024-acceptance.md`，待 qc-prototype 補登畫布。
- 與 QC-023 合併後補兩個錯誤碼訊息（`fix/qc024-ai-error-codes`）。Electron 實機 39／39。合併 2026-11-17。

## QC-023: Gemini 原生視頻理解

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

### 完成摘要

- `POST /assets/:id/ai/video-understanding`（只收素材 id）與 `…/estimate`：官方文件查證（2026-11-17）寫進 architecture，2 GB、時長、格式超限在送出前回 413／400／415，不在本機轉檔。
- 可續傳上傳自行實作（SDK 無進度與續傳），8 MiB 分段，進度事件；取消、429／逾時重試續傳，結束後刪遠端檔。結構化結果每個時間點標需核驗。
- 快取鍵 = 檔案雜湊＋任務類型＋提示詞版本＋模型＋解析度；命中不送不計費，`reanalyze` 才重送；進行中不重複。遷移 0010。
- 與 QC-024 一起合併後複跑：全部閘門通過，測試 515／0／515（負載約 30，無失敗）。證據 `docs/evidence/qc023-gemini-video-run.md`。合併 2026-11-17。

## QC-022: 文字 AI：標題／簡介／標籤候選與文章改寫候選

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

### 完成摘要

- 平台候選 `POST /works/:id/ai/suggestions`：一次呼叫產生四平台標題／簡介／標籤各 3 個，依 `PLATFORM_LIMITS` 附上限警告；不寫入，記下各平台版本號供前端帶 `base_revision` 採用。簡介暫用正文上限檢查。
- 改寫 `POST /works/:id/ai/rewrite`（潤色、縮寫、擴寫、語氣、自訂指令，全文或選取範圍）；採用 `POST /works/:id/ai/jobs/:jobId/accept` 由前端送最終全文，以 `source_revision` 為 base，過期回 409；新版本來源 `ai_accepted` 並記 `ai_job_id`，可恢復。停止與重試沿用 QC-021 的 cancel／retry。
- 原文以「素材非指令」包裝進提示詞；日誌中原文、結果、金鑰出現 0 次。遷移 0009，contracts 只增不改。
- 總監合併後複跑全部閘門通過，測試 476／0／476（負載約 3）。證據 `docs/evidence/qc022-text-ai-run.md`。合併 2026-11-17。

## QC-021: AI 任務基礎：供應商介面、Keychain 金鑰、任務佇列與用量記錄

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M3, backend

### 完成摘要

- Gemini、Claude、GPT 三家 adapter 用官方 SDK（`@google/genai`、`@anthropic-ai/sdk`、`openai`），base URL 可注入，SDK 自帶重試關閉；本機假伺服器測通文字、結構化 JSON、拒答與安全攔截。Claude 預設開啟伺服器端拒答備援（`fallbacks: "default"`），總監已對照 Claude API 指引核實。
- 金鑰用 `@napi-rs/keyring` 存 Keychain，API 只能存刪不回傳，測試環境碰 Keychain 直接丟錯；帶版本號的首次使用告知，缺金鑰或未確認回 409。
- 獨立 AI 任務執行器（並行 2）：取消、重跑、冪等、SSE、重啟續跑，429／逾時／故障最多重試 3 次。費用：送出前估算、完成後估算實際、月度超額提醒不擋。`/api/v1/ai/*` 只限 owner。
- 總監合併後複跑 typecheck／lint／format 通過，測試 465／0／465（負載約 3）。證據 `docs/evidence/qc021-ai-foundation-run.md`。合併 2026-11-17。

## QC-018: markdown-editor-web 測試在高負載下逾時

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M2, frontend

### 完成摘要

- 根因：第一個測試承擔 jsdom／CodeMirror／Lexical 冷啟動，pnpm 預設 4 套件並行造成約 36 行程搶 10 核。外部負載 20 對照：預設並行 4／4 逾時，一次一個套件 0／4。
- 修法：根目錄 `test` 改為 `pnpm -r --workspace-concurrency=1 test`，README 與 AGENTS.md 同步；未動逾時、斷言、重試。剩餘風險：外部負載 40 時單獨跑約 2／15 逾時（接受，於負載低時驗收）。證據 `docs/evidence/qc018-editor-test-timeout.md`。合併 2026-11-17。

## QC-019: 平台版本刪除後重建，版本號重用導致靜默覆蓋

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 平台版本 revision 單調遞增：刪除留墓碑列並佔一個 revision、歷史保留，讀取與列表對墓碑回 404，重建從 max+1 起算；整數 If-Match 不變，前端不用改。
- 回歸測試加上 QC-014 的 `it.fails` 轉為一般通過測試。驗收：總監合併後複跑 441／0／441。合併 2026-11-17。

## QC-014: M2 三方衝突與平台版本驗收

**Priority:** P1 | **Assignee:** qc-bugfix | **Tags:** M2

### 完成摘要

- API 層持久測試 `m2-three-party.test.ts`：托管與外部掛載作品的三方矩陣、六種先後順序、10 個並行存檔恰好 1 勝、恢復舊 base 409、檔案消失 409 `source_missing`、四平台互不串改。
- Electron 實機 38／38（連跑 5 次），腳本 `docs/evidence/qc014-run.sh`，紀錄 `docs/evidence/qc014-acceptance.md`。發現唯一缺陷即 QC-019。NOT_VERIFIED：建置產物啟動、極小時間窗跨行程寫入、FSEvents 延遲量化。合併 2026-11-17。

## QC-016: SSE external_revision 測試在高負載下逾時

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M2, backend

### 完成摘要

- 根因：測試輔助 `collect` 訂閱 SSE 後只固定等 50 ms，高負載時連線晚於事件而漏收；伺服器行為正確未改。
- 修法：訂閱前取 `feed.latestSeq()` 當 Last-Event-ID、移除固定等待；新增延遲連線回歸測試（先紅後綠）。負載 25 對照：舊版 4／60 失敗、新版 0／60。證據 `docs/evidence/qc016-sse-external-flake.md`。合併 2026-11-17。

## QC-013: 四平台模擬預覽（M2 前端 3/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- `packages/platform-preview`：純 TS 的 `buildPreviewModel()` 加四個模擬模板，畫面元件在 `./react`，不綁死 Electron；全部標「模擬」、無官方標誌。
- 平台預覽頁：各平台獨立 revision、自動儲存（組字中不存）、從原稿建立／重新產生（先確認）、即時超限警告；409 時由使用者選「載入最新」或明確「以我的修改覆蓋」（舊版留在歷史）。
- 驗收：總監合併後複跑 417／0／417（含 QC-016）；Electron 實機 20/20，證據 `docs/evidence/qc013-acceptance.md`。NOT_VERIFIED：實體輸入法、VoiceOver、雙實機視窗、上限是否符合真實平台、影片預覽、建置版。合併 2026-11-17。

## QC-009: 平台版本 API（M2 後端 2/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 四平台 PlatformVariant 存 SQLite（只追加歷史表做快照，單一交易），整數 revision；寫入需 base_revision 或 If-Match（缺 428、過期 409 附目前版本）。
- 規則草稿（不呼叫 AI）、單平台重新產生、刪除；`PLATFORM_LIMITS` 參考值放 contracts，超限照存並回 `warnings`，`checkVariantLimits()` 純函式供前端共用；SSE 事件；`client.variants`。
- 測試涵蓋四平台互不串改與並發 409。驗收：總監合併後複跑 397／0／397。範圍外：平台版本恢復 API、AI 產生平台版本（M3）。合併 2026-11-17。

## QC-011: Mac 作品管理與編輯完整化（M2 前端 2/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- 作品庫即時刷新；外部修改提示（有未存修改或組字中暫停自動儲存，可比對合併）；版本恢復（diff 加確認，409 不覆蓋）；狀態與標籤走同一儲存佇列；檔案遺失唯讀與自動恢復；外部來源標示；Markdown 圖片走簽名網址（不載入外部 http 圖片）；素材引用。
- 驗收：總監合併後複跑 397／0／397；Electron 實機 31/31，證據 `docs/evidence/qc011-acceptance.md`。NOT_VERIFIED：實體鍵盤輸入法、VoiceOver、Finder 實開、簽名網址實機換新、外接硬碟拔除、建置版啟動。合併 2026-11-17。

## QC-010: 版本恢復、作品中繼資料與 Markdown 圖片解析（M2 後端 1/2）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M2, backend

### 完成摘要

- 讀單一歷史版本、恢復為新 revision（帶 base_revision，衝突 409，不改寫歷史）；狀態與標籤 PATCH 補齊。
- `/works/:id/media` 解析托管與外部作品的相對圖片路徑（防穿越、不跟隨符號連結，外部圖片只登記不搬移）；`GET /assets/:id/works` 反查引用作品。
- `POST /api/v1/media/signed-urls`：HMAC 簽名網址綁定路徑、到期（1 小時）與權杖主體，撤銷權杖即失效；Bearer 路由不接受簽名，Range 行為一致。
- 驗收：總監合併後複跑 323／0／323。合併 2026-11-17。

## QC-012: Mac 素材庫、匯入任務與設定頁（M2 前端 1/3）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M2, frontend

### 完成摘要

- 素材庫（列表、檢視器、原圖與影音播放）、上傳（直傳與 tus）、URL 匯入、任務列表（進度、原列重試）、掛載管理、Agent 權杖（明文只顯示一次）；設定頁含服務狀態與托管目錄。
- 主程序 SSE 經 IPC 推給 renderer（共用通道）；媒體經 `assetMediaUrl()` 走主程序代理 `qc-asset://`（白名單 thumbnail／stream 加 UUID，Range 直通）。
- 原型中缺 API 的控制項不顯示，排入 QC-015、QC-004。驗收：總監合併 QC-010 後複跑 355／0／355；Electron 播放器實機 6/6。合併 2026-11-17。

## PT-20261117-001: M2 補充狀態（原型）

畫布第 31 版：外部檔案遺失、版本恢復確認、外部掛載來源標示、平台上限警告。總監依小型修改權限核准 2026-11-17；畫布實際渲染 NOT_VERIFIED。

## QC-007: 外部目錄掛載與資料夾監控（M1 後端 3/3）

**Priority:** P1 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- `/api/v1/mounts`（管理限主權杖）與 CLI；外部 `.md` 只索引不搬移，拒絕 9 類不安全路徑（穿越、符號連結逃逸、CREATORHUB_HOME 等），符號連結一律不跟隨。
- Chokidar 監控（正式用 FSEvents，測試用 polling 後端避免系統事件延遲）；寫一半的檔案等寫完才索引；自身寫入不回授；啟動與每 10 分鐘重掃補漏。
- 改名以內容雜湊接回同一作品；刪除只標 missing（寫入回 409 `source_missing`），放回即恢復；卸載不動檔案。寫回外部檔前核對 revision，快照存在 library 內；原子寫入保留原檔權限位元。
- 驗收：總監合併後複跑全倉 276／0／276，typecheck、lint、format 通過；證據 `docs/evidence/qc007-mount-run.md`。範圍外：外部資料夾的圖片未索引；「檔案已遺失」介面待 M2。合併 2026-11-16。

## QC-006: URL 匯入、匯入任務與冪等（M1 後端 2/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- `POST /api/v1/imports/urls`、`GET /api/v1/jobs/:id`、`POST /api/v1/jobs/:id/retry`；下載完走 QC-005 素材登記。
- SSRF：每跳只解析一次且全部須為公網位址，連線釘在已檢查的 IP（防 DNS 重綁定）；重定向最多 5 次逐跳重驗；擋回環／私網／鏈路本地／CGNAT／IPv4 對映 IPv6／NAT64／6to4／Teredo；Content-Type 白名單、大小與三段逾時。
- 冪等鍵（`works` 建立與 URL 匯入，每權杖一組；同鍵異內容 422；Agent 權杖未帶 428）。Agent 權杖分 `read`／`import`／`write`，未列路由預設只限主權杖，只存 sha256；`import` 權杖可查自己的任務。CLI `import url`、`jobs get`。
- 驗收：總監合併後複跑 200／0／200，typecheck、lint 通過；證據 `docs/evidence/qc006-curl-run.md`（只用本機假上游）。合併 2026-11-16。

## QC-002: Electron Mac 最小工程與編輯器（M0 前端）

**Priority:** P0 | **Assignee:** qc-frontend | **Tags:** M0, frontend

### 完成摘要

- `apps/mac`（Electron + React + Vite，只走 api-client）、`packages/markdown-editor-web`（MDXEditor，可視／原始碼切換、IME 安全）、`packages/platform-preview` 骨架、`packages/design-tokens`（核准的「暖白克制」token，Inter 隨附）。
- 作品庫（網格／列表、篩選、窄視窗）、編輯器（自動儲存、revision、歷史）、409 衝突對話框（查看差異、保留雙方、手動合併）、服務離線與重連、深色模式；關窗後服務照常。
- 驗收：總監合併後複跑全倉 262／0／262（含 apps/mac 40、markdown-editor-web 15），typecheck、lint、format 通過；證據 `docs/evidence/qc002-acceptance.md` 與 18 張截圖。
- NOT_VERIFIED：實體鍵盤系統輸入法、圖片顯示（待素材 URL 對應）、VoiceOver、與畫布並排比對、打包後執行。合併 2026-11-16。

## QC-008: 追查 tus 續傳偶發卡死（QC-005 遺留）

**Priority:** P2 | **Assignee:** qc-bugfix | **Tags:** M1

### 完成摘要

- 原始卡死 270 次壓力嘗試未重現（NOT_VERIFIED，推論為 tsx watch 重啟或舊 FileStore 非同步 mkdir）。
- 另修無聲斷線佔鎖：tus PATCH 加 60 s socket 閒置逾時（`tusIdleTimeoutMs` 可調），先紅後綠回歸測試；壓力腳本 `scripts/tus-stress.ts`。
- 驗收：總監複跑 114／0／114。合併 2026-11-16。

## QC-005: 素材庫、上傳與變更事件（M1 後端 1/3）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M1, backend

### 完成摘要

- 素材 API；小檔直傳（≤32 MiB）與 tus 1.0 續傳；magic bytes 類型判斷、分類大小上限、sha256 去重；素材存 `library/assets/<id>/`，作品–素材關聯與排序。
- SQLite 持久任務佇列（重啟續跑、退避重試）：Sharp 縮圖（`cache/` 可重建）、ffprobe 元資料（缺席時降級，不打包 GPL 元件）。
- SSE `/api/v1/events`（header 鑑權、`Last-Event-ID` 補發）、FTS5 中文搜尋。
- 驗收：總監複跑 111／0／111，typecheck、lint 通過；curl 證據 `docs/evidence/qc005-curl-run.md`。偶發 tus 卡死未重現，另開 QC-008。合併 2026-11-16。

## PT-20261116-001: Mac 原型 v0.1 與視覺基線

使用者 2026-11-16 核准畫布第 24 版（8 張 Mac 畫板），視覺基線「暖白克制」已寫入 DESIGN.md。

## QC-001: 搭建 monorepo 骨架與 Mac 服務最小主鏈路（M0 後端）

**Priority:** P0 | **Assignee:** qc-backend | **Tags:** M0, backend

### 完成摘要

- pnpm 12 workspace、TS 5.9（typescript-eslint 尚不支援 7.x）、ESLint／Prettier／Vitest；contracts（Zod 4，第三章全部實體與作品 API DTO）、domain、api-client、agent-sdk（`creatorhub works create/list`）。
- mac-server：Fastify 5 + better-sqlite3（WAL、FTS5 trigram），只新增式遷移；Bearer 權杖（未設時建立 0600 權杖檔）；作品建立／列表／讀取／修改，原子寫入、每版不可變快照、`base_revision`／`If-Match` 衝突回 409、外部修改自動記為 `external` 版本；Range 視頻流；`/docs` OpenAPI；launchd plist 範本（未安裝）。
- 驗收：總監複跑 typecheck、lint 通過，測試 69／0／69；curl 證據 `docs/evidence/qc001-curl-run.md`。冪等鍵只有資料表唯一鍵，M1 匯入中心再強制。合併 2026-11-16。

