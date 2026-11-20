# QC-039 驗收記錄：編輯器插入素材與貼上圖片

日期：2026-11-19　分支：`feat/qc039-editor-insert`（從 origin/main `ea0c446` 開）
原型：PT-20261119-001，畫板「v2 · 編輯器：插入素材」與深色版，畫布第 39 版。後端 attach 依總監 2026-11-19 的決定在本任務內完成（選項 1）。

## 請總監審閱：attach 複製的是獨立的檔案

- `POST /api/v1/works/:id/media/attach` 會把素材的檔案**複製**到作品自己的 `library/works/<id>/assets/`，Markdown 寫的是這份複本的路徑（例如 `assets/kyoto.png`）。
- 這份複本與素材庫裡的原檔各自獨立：
  - 之後在素材庫把這個素材移到最近刪除，甚至永久刪除，**已經插進文章的圖片不受影響**，文章照常顯示。持久測試 `is an independent copy` 驗證了這點：刪除、清空素材後，作品的圖片仍存在、仍能解析。
  - 反過來，在素材庫編輯這個素材的名稱、標籤、替代文字，也不會改到文章裡已插入的圖片；替代文字只在插入的那一刻帶進 `![alt]`。
  - 代價是佔用兩份磁碟空間。同一作品重複插入同樣內容時不會再複製一份。
- attach 同時建立作品與素材的連結，所以在 QC-037 的刪除規則裡，這個素材算「被引用」：刪除時會列出作品並要求確認。確認框的文案已依總監審閱改成精確描述，見下方「審閱後修正」第 3 點。

## 審閱後修正（總監 2026-11-19 審閱）

### 1. Finder 拖入的虛線框位置

- **原因**：框是編輯區捲動容器裡 `inset: 0` 的絕對定位元素，跟著內容捲動，捲動後只蓋住內容頂部。
- **修正**：`dropFrame()`（`InsertUI.tsx`）依捲動容器當下的 `scrollTop`、`clientWidth`、`clientHeight` 與工具列底緣計算框的位置，框固定在可見範圍：工具列下方，四邊各留 8px。容器捲動時（`onScroll`）重新計算。
  - 沒有改用 `position: fixed`：`.editor` 是 inline-size container，會成為 fixed 元素的定位基準。
- **自動捲動**：指標在框上下緣 48px 內時，每次 dragover 捲動，越靠近邊緣越快（最多 24px）。插入線依捲動後的位置重算。
- **同一根因一起修**：放開時原本用 React state 裡上一次 dragover 的位置，最後一次 dragover 還沒重繪就放開時會插錯位置（e2e 在自動捲動後放開時重現）。現在依放開當下的指標位置計算。
- **測試**：
  - e2e：捲動後（`scrollTop > 0`）框的 bounding box 等於可見範圍（工具列下方、四邊 8px）；在上緣 dragover 會往上捲、在下緣會往下捲，框始終等於可見範圍；放開後仍插在指定段落之前。
  - 單元：`dropScrollStep` 的方向、速度與中間不捲動。
  - 重拍 `qc039-05-finder-drop.png`。

### 2. 貼上暫存檔的清理

- 暫存檔改由 `PasteFiles`（`apps/mac/src/main/paste-files.ts`）管理，放在 `userData/qiu-creator-paste/<uuid>/`。
  - 不放系統共用暫存目錄，避免第二個實例啟動時清掉另一個實例的檔案。
- **何時刪除**：
  - 上傳成功或取消：刪除。
  - 上傳失敗：保留，讓「重試」能再讀同一個檔案。
  - 失敗卡按「移除」（`dismissUpload`）：刪除。
  - App 啟動與結束（`before-quit`）：清掉整個 `qiu-creator-paste`。
- 只刪自己資料夾裡的檔案；對不在資料夾內的路徑不動作。
- **單元測試**：`paste-files.test.ts`，5 個測試，涵蓋檔名清理、成功與取消時刪除、失敗時保留與移除時刪除、啟動或結束時全清與大小限制、不刪資料夾外的檔案。

### 3. 刪除確認框的文案

- **實際行為**（依 link role 檢查）：
  - attach 插入的正文圖片：作品 `assets/` 裡是獨立複本，刪除素材後文章照常顯示。
  - 封面、影片：直接指向素材檔，會缺圖。
  - 舊路徑 `POST /works/:id/assets` 建立的正文連結：不複製，Markdown 直接指向素材檔，會缺圖。
  - 平台版本的封面與圖片：會缺圖。
- **後端**：`GET /assets/:id/references` 的作品連結加上 `independent_copy`。
  - 正文連結、託管作品，而且作品的 `assets/` 裡有同大小、同 sha256 的另一個檔案時為 true；素材自己的檔案不算。
  - 外部作品一律 false。
  - 判斷與 attach 共用 `findSameContent`。
- **文案**：
  - 只有複本：「文章中的圖片是獨立複本，不受影響；這件作品（多件時：這些作品）的素材清單會移除此項，30 天內恢復即補回。」完成提示：「已移到最近刪除 · 文章中的圖片不受影響」。
  - 有會缺圖的：「「A」、「B」 會顯示為缺圖，30 天內恢復即自動補回。」若同時有複本，補一句「「X」 中的圖片是獨立複本，不受影響。」並分兩組列出作品。完成提示：「已移到最近刪除 · 部分作品顯示為缺圖」。
  - 批次移除也用同樣的判斷。
- **測試**：
  - 後端：attach 後 references 為 `independent_copy: true`；直接連結的封面與正文為 false，attach 後只有正文變 true。
  - 前端：4 個文案測試。
  - e2e：
    - `editor-insert`：插入後刪除 kyoto，確認框寫「獨立複本」，沒有「缺圖」，截圖 `qc039-09`。
    - `assets`：直接連結的素材，確認框寫「會顯示為缺圖」。

## 後端（`services/mac-server/src/media/attach.ts`）

- **路由**：`POST /api/v1/works/:id/media/attach`，送 `{ asset_id }`，回 `{ src, copied, asset }`。屬於寫入路由（`scopes.ts`），擁有寫入權限的 Agent 權杖也能呼叫。
- **契約**：`AttachWorkMediaRequestSchema`、`AttachWorkMediaResponseSchema`、錯誤碼 `attach_external_unsupported`；api-client 新增 `works.attachMedia(id, assetId)`。
- **錯誤**：
  - 作品或素材不存在：404。
  - 素材在最近刪除：409 `asset_in_trash`。
  - 素材檔案不在磁碟上：409 `asset_file_missing`。
  - 外部（掛載）作品：409 `attach_external_unsupported`，不寫進使用者的外部資料夾。
- **來源**：託管素材，以及掛載資料夾中可以讀到的外部素材（經 `openContainedFile`，不跟隨符號連結）。
- **寫入**：
  - 先寫成同目錄下的 `.attach-<uuid>.tmp`，核對 sha256 並 fsync。
  - 再用 `link` 放到正式名稱：`link` 在目標已存在時會失敗，所以絕不覆蓋。
  - 最後刪除暫存檔。
- **去重與同名**：
  - 作品 `assets/` 裡已有同樣大小、同樣 sha256 的檔案時，直接沿用（`copied: false`）。
  - 不同內容但同名時，自動改名為 `name-2.png`、`name-3.png`。
- **檔名**：取原檔名的最後一段，換掉控制字元、路徑分隔字元與會弄壞 `![](…)` 的字元（`()[]<>#?%"'` 等），長度上限 120；清理後是空的就改用 `image.<副檔名>`。
- **範圍**：目標路徑檢查一定在 `library/works/<id>/assets/` 內；`assets` 是符號連結時拒絕。
- **冪等**：同一素材再次 attach，回傳同一個 `src`，連結只有一筆；同一作品的 attach 依序執行，避免同名競爭。
- **不寫 Markdown**：作品的 `.md` 與 revision 都不變，插入的連結由編輯器照一般 `base_revision`／409 的流程存檔。

## 前端

- **編輯器套件**（`packages/markdown-editor-web`）：
  - `insert.ts`：在區塊邊界插入獨立區塊，前後各留一個空行。游標在段落中間時插在該段之後，不會把段落切開。
  - `MarkdownEditorHandle` 新增兩個方法：
    - `insertBlock(markdown, 'caret' | 'end' | { beforeBlock })`：插入一個區塊，視覺與原始碼兩種模式都可用。
    - `boundaryAt(y)`：視覺模式下，取得畫面上某個 y 座標最近的區塊邊界，用來畫插入線。
  - 編輯器失焦時記下游標位置，所以焦點移到抽屜後，插入的位置仍正確。
- **App**：
  - `editor-insert.ts`（`InsertSession`）：追蹤每個待插入的檔案，處理上傳、attach、插入，以及失敗後的重試與移除。
  - `InsertUI.tsx`：插入選單、斜線選單、素材抽屜、上傳卡片、插入線。
  - `EditorPage` 負責串接；主程序新增 `insertFiles`、`insertBytes` 兩個 IPC，`UploadManager.addWithIds` 回傳 id。
- **入口**：
  - 標頭「插入」選單：從素材庫（⌘⇧I）、上傳圖片（⌘⇧U），另附其他方式的提示。
  - 空行輸入 `/`：從素材庫插入圖片、上傳圖片、分隔線。可輸入文字篩選，↑↓ 選擇、↩ 插入、esc 關閉，組字中不觸發。
  - 素材抽屜（⌘⇧I）：取代右側 AI 面板，按「回到 AI」或 esc 關閉；可搜尋，分「全部圖片」與「本作品」；點選、方向鍵加 ↩，或拖進文中。
  - 從 Finder 拖入：正文出現虛線框、插入線與「放開以插入 N 個檔案 · 同時加入素材庫」，放開後插在插入線所指的區塊之前。
  - ⌘V 貼上剪貼簿圖片：檔名是「貼上的圖片 HH.MM.png」。
- **狀態卡**：
  - 上傳中：縮圖、百分比、取消。
  - 插入中：顯示「插入中」。
  - 完成：卡片消失，提示「已插入「…」，同時加入素材庫」。
  - 失敗：紅色「上傳失敗 · 原因」與「圖片暫存在此視窗」，可重試或移除。如果上傳已完成、只有 attach 失敗，重試只重做 attach。
- **外部作品與唯讀**：插入選單停用並說明原因；貼上與拖入不會寫進外部資料夾。

## 順便修的同一根因缺陷（QC-010 的媒體解析）

- **問題**：插入的圖片在編輯器裡一直顯示「未儲存」佔位圖。
- **原因**：attach 會觸發 `work.assets_changed`，讓媒體快取失效；這時 `WorkMediaResolver` 直接重新讀取，沒有先存檔，新圖片的 `src` 還不在伺服器上。
- **修法**：
  - 不認得某個 `src` 時一律先存檔。
  - 第一次讀取仍然找不到時，再存一次並重讀。
  - 存檔後不沿用存檔前就已開始的讀取。
- **測試**：`qc011-helpers.test.ts` 新增 3 個；原有測試維持不變並通過。

## 原型沒畫清楚、我選的做法

- **素材抽屜**：原型是側面板頂端「素材 | AI」兩個分頁。這裡改成抽屜取代 AI 面板，附「回到 AI」，因為 AI 面板自己已有「改寫 | 標題」分頁，不想做成兩層分頁。⌘⇧I 可以切換。
- **只插入圖片**：原型斜線選單有「從素材庫插入視頻」，但編輯器的視覺模式無法顯示 `![](video)`，所以這次只插入圖片。拖入非圖片檔案時，會提示「目前只能插入圖片；其他檔案請到素材庫上傳」。
- **待上傳卡片的位置**：原型畫在正文中將要插入的位置，這裡改成固定在正文頂端，因為編輯器內部不能放任意的 React 卡片。完成後仍插在記下的位置。
- **插入後的復原 toast**：原型有，這裡不做。插入後可以用一般的版本記錄恢復；原始碼模式也可以直接刪除那一行。
- **「上傳檔案…」**：原型寫上傳檔案，這裡改成「上傳圖片…」，只接受圖片。

## 自動測試

- **後端**：`services/mac-server/test/work-media-attach.test.ts`，11 個測試。
  - 託管作品插入：檔案內容、沒有殘留暫存檔、連結、Markdown 與 revision 不變，存檔後能解析。
  - 冪等，並在 QC-037 中算被引用（`asset_in_use`）。
  - 同內容換名沿用；同名不同內容依序改名為 `-3`，原檔不被覆蓋。
  - 不安全的檔名留在作品資料夾內。
  - 獨立複本：刪除並永久刪除素材後，文章圖片仍在。
  - 錯誤情況：最近刪除 409、素材不存在 404、作品不存在 404。
  - 5 個並發請求只產生一份複本。
  - 外部作品 409，外部資料夾的檔案完全不變。
  - 從外部素材複製到託管作品，原檔仍在原處。
  - `attachName` 的清理規則。
- **api-client**：新增 1 個，驗證 attachMedia 的請求，以及錯誤碼 `attach_external_unsupported` 原樣保留。
- **編輯器套件**：`insert.test.ts`，6 個測試，涵蓋區塊插入、開頭與結尾、空行收斂、游標與拖放位置、圖片語法的安全處理。
- **App**：
  - `editor-insert.test.ts`，8 個測試。
    - 插入素材庫圖片；外部作品失敗時說明原因。
    - 貼上：進度、完成後插入到指定位置、預覽回收。
    - 上傳失敗後重試與移除；attach 失敗時只重試 attach；上傳中取消。
  - `qc011-helpers.test.ts` 新增 3 個。
- **e2e**：`e2e/specs/editor-insert.spec.ts`，2 個測試。服務端核對真實的檔案與 Markdown。
  - 插入選單。
  - 素材抽屜：插在游標所在段落之後，作品的 `assets/kyoto.png` 存在，編輯器顯示圖片。
  - 斜線選單：篩選後插入分隔線，位置正確。
  - ⌘V 貼上：Markdown 出現 `assets/貼上的圖片-HH.MM.png`，作品資料夾只有一份，素材庫也有。
  - 貼上壞檔：上傳失敗卡片，移除後 Markdown 不變。
  - Finder 拖入：插入線與提示，放開後插在指定段落之前；作品資料夾有複本，原檔仍在。
  - 原始碼模式：斜線與貼上都能用。
  - 深色截圖。
  - 外部作品：插入選單停用並說明，貼上後外部資料夾只有原本的 `.md`。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc039-01-insert-menu.png` | 插入選單 |
| `qc039-02-drawer-inserted.png` | 素材抽屜，點選後插入 |
| `qc039-03-slash.png` | 斜線選單 |
| `qc039-04-paste-failed.png` | 貼上失敗：重試／移除 |
| `qc039-05-finder-drop.png` | Finder 拖入：捲動後虛線框蓋住可見範圍，插入線與提示（審閱後重拍） |
| `qc039-06-source-mode.png` | 原始碼模式：斜線與貼上後的 Markdown |
| `qc039-07-drawer-dark.png` | 深色，素材抽屜 |
| `qc039-08-insert-menu-dark.png` | 深色，插入選單 |
| `qc039-09-delete-copy-wording.png` | 刪除已插入的素材：確認框說明文章中的圖片是獨立複本 |

## 驗證

- `pnpm -r typecheck`、`tsc -p e2e/tsconfig.json`：通過。
- `pnpm -r lint` 與根目錄 `pnpm lint`：0 錯誤。`pnpm format:check`：通過。
- `pnpm test:e2e`（審閱後修正後重跑）：7 passed／0 failed／7 total（`assets`、`editor-insert` ×2、`editor-scroll`、`new-api`、`settings-theme`、`sidebar`），期間持有 e2e 鎖。
- 全倉 `pnpm -r --workspace-concurrency=1 --no-bail test`（審閱後修正後重跑）：**753 passed／0 failed／753 total**。
  - 執行時間 2026-11-19 16:37:11–16:37:26。負載開始 4.10、結束 4.47，期間持有全倉測試鎖。
  - 各套件：contracts 16、design-tokens 5、domain 27、installer 39、markdown-editor-web 28（+6）、api-client 19（+1）、platform-preview 12、mac-server 373（+12）、apps/mac 228（+21）、agent-sdk 6。
  - 比第一次交付的 742 多 11 個：mac-server 1 個（`independent_copy`），apps/mac 10 個（暫存檔 5、刪除文案 4、自動捲動 1）。

## NOT_VERIFIED

- **真實的 Finder 拖曳與系統剪貼簿**：e2e 用帶實際路徑的 `File` 合成拖放事件，用 `ClipboardEvent` 合成貼上，沒有操作 Finder 或系統剪貼簿。
- **素材抽屜拖進文中**：沒有寫 e2e，HTML5 拖放無法穩定合成。Finder 拖入共用同一套插入線與放開處理，抽屜拖曳另有單元測試路徑。
- **大檔（tus 續傳）**：沒有實機驗證；貼上與拖入走既有的上傳管理員。
- **外部素材**：多個掛載資料夾的情況沒有驗證。
- **VoiceOver 朗讀**：斜線選單與抽屜的 listbox 沒有驗證。
