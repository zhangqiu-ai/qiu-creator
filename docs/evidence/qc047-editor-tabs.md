# QC-047 驗收記錄：作品編輯多分頁

日期：2026-11-21　分支：`feat/qc047-editor-tabs`（從 origin/main `decf254` 開，已 rebase 到 `9ee4009`，含 QC-045／046 後端）
依據：原型 PT-20261121-001「v3 · 多分頁編輯」（`docs/design/prototype/changes.json` 的 `EditorTabs`／`EditorTabsDark` 狀態清單與 `openQuestions` 的決定）、決策記錄 2026-11-21「補齊貼圖、視頻創作，作品編輯改成多分頁」。
畫布（claude.ai artifact 第 41 版）在這個會話同樣讀不到（Artifact 讀取回 network error）。所以依 ledger 施工，畫布上 ledger 沒寫到的細節（尺寸、間距、選單排版）是我的判斷，列在下面「與原型的差異／待確認」。

## 做了什麼

- **分頁列**：在側欄右側、作品標頭上方。每個作品的 AI 面板、歷史或素材抽屜都屬於它自己的分頁。
  - 每個分頁顯示：
    - 類型圖示。
    - 截斷的標題，tooltip 顯示全名、狀態與 ⌘ 編號。
    - 未存點，懸停時變成關閉鈕。
    - 衝突紅三角、AI 候選星號。
    - 未載入的分頁標題用斜體。
  - 作用中的分頁頂端有強調色線，並和下方頁面接在一起。
- **溢出**：分頁保持固定寬度，不會擠扁；超出時可以橫向捲動，邊緣漸隱。
- **全部分頁選單「N ⌄」**：
  - 每列有搜尋、類型圖示、標題、狀態（未儲存、有衝突、AI 候選待確認、未載入）和 ⌘ 編號。
  - 可用 ↑↓ 移動、Enter 開啟、Esc 關閉。
  - 底部是「關閉其他分頁」，未存的分頁會保留。
- **拖曳排序**：拖曳時顯示插入線，放開後 ⌘ 編號照新順序。
- **重複開啟**：聚焦既有的分頁，分頁閃一下，提示「「X」已經開啟」。不會開第二個分頁，未存的草稿也還在。
- **切換時保留**：
  - 保留模式、草稿、游標、捲動位置和側欄面板（AI、歷史、素材）。
  - 背景分頁的編輯器只是隱藏、沒有卸載，所以也保留 AI 候選和 AI 分頁（改寫或標題）。
  - 切到作品庫或設定再回來，這些也都還在。
- **記憶體上限**：同時最多載入 8 個編輯器，其餘卸載成「未載入」，點選時再載入。
  - 卸載前先回報模式、游標、捲動和面板，再載入時還原。
  - 有未存修改、衝突、AI 候選或 AI 任務進行中的分頁不會被卸載，因為卸載會丟掉使用者還沒處理的東西。
- **關閉未存的分頁**：先試著儲存。仍然存不了時，才出現對話框：
  - 選項是「重試儲存／不儲存並關閉／取消」，預設聚焦「取消」。
  - 重試仍失敗時，對話框內提示，不會關閉分頁。
  - 關閉後提示「已關閉「X」」並附「重新開啟」。
  - 「不儲存並關閉」丟掉的修改會一起找回，回來後仍是未存狀態，照常自動儲存或進入衝突流程。
- **重開 App**：全部分頁都恢復，但只載入作用中的分頁。
  - 提示「已恢復上次的 N 個分頁」，附「全部關閉」。
  - 原始碼模式會還原。
  - 分頁資料存在主程序的 `preferences.json` 的 `tabs` 鍵，不在 localStorage。
- **快捷鍵**：
  - ⌘1–8 跳到對應分頁，⌘9 跳到最後一個。
  - ⌘⇧[ ⌘⇧] 切到上一個／下一個。
  - ⌘W 關閉分頁。
  - 分頁列上 ←→ 切換時焦點留在分頁列；Home／End 跳到頭尾；中鍵也能關閉分頁。
- **原生選單**：「檔案 → 關閉分頁 ⌘W」、「視窗 → 顯示上一個／下一個分頁、前往分頁 → 分頁 1–8、最後一個分頁」。三種語言都有。「關閉視窗」改成 ⌘⇧W；沒有分頁在前景時，⌘W 照舊關閉視窗。
- **多語言**：文案在 `packages/i18n` 的新區 `tabs`（29 個鍵），選單項目在 `main` 區，三種語言都有。英文的單複數用 `{one, other}`。沒有寫死的中文，`no-hardcoded-chinese` 測試通過。
- **可放不同類型的編輯器**：分頁的 `kind` 就是作品類型。QC-045／046 的貼圖、視頻編輯器只要放進 `TabPane`，就能用同一套分頁、保留與恢復機制。

## 審查後修正：切換語言時已開的編輯器內部文字沒有更新

- **現象**：總監審查時指出，English 截圖的編輯器工具列仍顯示繁體「段落樣式」。
- **原因**：MDXEditor 只在建立時讀一次 `translation`。之後每次 render，它只會呼叫各 plugin 的 `update`，而 core plugin 的 `update` 不包含 translation。分頁讓編輯器常駐不卸載，所以開著分頁時切換語言，工具列、對話框、tooltip、placeholder 都停在舊語言。QC-042 時也一樣，只是當時多半是先切語言、再開作品，不容易看到。
- **修正**：`markdown-editor-web` 加 `liveTranslationPlugin`。它在 `update` 裡把新的 translation 寫入 MDXEditor 的 `translation$`，所以已開的編輯器原地換文字，不重建。草稿、游標、復原歷史、捲動、模式都不受影響，也不會送出變更。程式碼區塊的語言名稱原本就由 codeMirror plugin 的 `update` 更新。
- **測試**：
  - 單元測試 `editor.test.tsx`：以 zh-Hant 開啟後改用 en 重新 render，工具列換成 English，編輯區是同一個 DOM 節點，沒有觸發 onChange，內容不變。拿掉這個 plugin 時，這個測試會失敗。
  - e2e「切換語言」：開兩個分頁，各自在視覺模式打字、留下草稿，然後切到 English。前景和背景分頁的工具列都變成 Paragraph、不再有「內文」，兩邊草稿都還在。接著繼續打字，字接在原本游標處。最後兩篇送到服務端的內容就是打的字。
- **截圖**：全部重拍。English 截圖的工具列現在顯示 Block style。
- **測試的等待**：e2e 第一個案例在「關閉其他」前，先等甲篇的自動儲存完成。追查後確認，那個案例從打字到這一步只花約 0.7 秒，還沒到 800ms 的自動儲存。依設計，未存的分頁在「關閉其他」時會保留，所以先等儲存是正確寫法，不是放寬斷言。

## 為了分頁做的行為調整（請留意）

- 分頁回到前景時重新讀取 AI 供應商。以前離開編輯頁就會卸載編輯器，回來時面板重新載入；現在編輯器不卸載，若不重讀，在設定改過金鑰或告知後，回來仍會看到舊狀態。這是 `new-api.spec` 抓到的回歸，已修正，斷言沒有改。
- 「關閉視窗」的快捷鍵從 ⌘W 改為 ⌘⇧W，和 Safari 相同。
- 編輯器回到前景時，若之前有游標，游標和焦點會回到正文。

## 異動檔案

| 檔案 | 用途 |
| --- | --- |
| `apps/mac/src/renderer/tabs.ts` | `TabsModel` 純狀態模型 |
| `apps/mac/src/shared/tabs.ts` | `PersistedTabs` 型別與 `parsePersistedTabs`（主程序與 renderer 共用） |
| `apps/mac/src/renderer/EditorTabs.tsx` | 分頁列、全部分頁選單、分頁內容、關閉對話框、提示、快捷鍵與選單命令 |
| `apps/mac/src/renderer/EditorPage.tsx` | `active`、`focusToken`、`initialView`、`initialDraft`、分頁狀態回報、保留與還原檢視、`EditorTabHandle` |
| `apps/mac/src/renderer/AiPanel.tsx` | `refreshToken`：回到前景時重讀供應商清單 |
| `apps/mac/src/renderer/App.tsx` | 編輯路由改由分頁驅動；恢復與儲存分頁 |
| `apps/mac/src/renderer/styles.css` | 分頁列、選單樣式 |
| `apps/mac/src/main/menu.ts`、`main.ts` | 分頁選單項目與 IPC |
| `apps/mac/src/main/preferences.ts` | `tabs` 偏好 |
| `apps/mac/src/shared/bridge.ts`、`preload/preload.ts` | `getTabs`、`setTabs`、`onTabCommand` |
| `packages/markdown-editor-web/src/MarkdownEditor.tsx`、`plugins.tsx` | `restoreSelection`；`liveTranslationPlugin`，切換語言時原地更新編輯器內部文字 |
| `packages/i18n/src/catalog/tabs.ts`、`main.ts`、`index.ts` | 三語文案 |
| `apps/mac/test/tabs.test.ts` | 模型、偏好、選單單元測試（21 個） |
| `e2e/specs/editor-tabs.spec.ts`、`e2e/fixtures/desktop.ts` | e2e 5 個；fixture 加 `relaunch()` |
| `docs/architecture.md` | 「編輯器多分頁（QC-047）」一節 |

## 驗證

- **rebase 到 `9ee4009` 並修正語言問題後重跑**（rebase 沒有衝突）：
  - **typecheck**（全部套件加 e2e）、`pnpm -r lint`：通過。
  - **根目錄 `eslint .` 與 `format:check`**：不通過的只有 main 上本來就有的檔案：
    - `docs/evidence/qc033-drill.mjs`、`qc033-sleepguard.mjs`。
    - `docs/design/prototype/changes.json`。
    - 總監已交給測試專員處理。
  - **全倉測試**：853 passed／0 failed／853 total。2026-11-21 08:21:11–08:21:38，負載 2.68→11.07，持有 `qc-fullsuite.lock`。各套件：
    - contracts 21、design-tokens 5、domain 34、i18n 29、installer 39、api-client 20。
    - markdown-editor-web 29（新增 1）、platform-preview 12、mac-server 393、apps/mac 265（QC-047 新增 21）、agent-sdk 6。
  - **e2e**：14 passed／0 failed／14 total（08:20，負載約 3），其中 QC-047 新增 5 個。
- rebase 前的第一次全跑，`new-api.spec` 抓到「回到前景要重讀 AI 供應商」的回歸，已修正。
- 單元測試：`apps/mac/test/tabs.test.ts` 共 21 個，涵蓋：
  - 開啟、重複開啟加閃一下、⌘1–9、上下一個。
  - 保留檢視。
  - 8 個上限與 LRU 卸載，不卸載有未存、衝突或 AI 狀態的分頁。
  - 關閉後選左右鄰、重新開啟連同草稿、關閉其他與全部關閉都保留未存。
  - 拖曳排序。
  - 恢復與 `persisted` 來回轉換。
  - 偏好驗證與讀寫。
  - 三語選單項目、快捷鍵與點選命令。
- e2e `editor-tabs.spec.ts`：
  1. 開三篇作品，⌘1、⌘⇧[ ] 切換：
     - 原始碼模式、草稿、游標（selectionStart）與捲動位置都還原。
     - 另一個分頁的歷史面板保持開啟。
     - 也驗證：⌘9、原生選單項目的標籤與點選、重複開啟的提示、分頁列 ←→、拖曳排序、全部分頁的搜尋與 Enter、關閉其他、⌘W 關閉最後一個後回到作品庫。
  2. 關閉未存：
     - 對話框預設聚焦「取消」；重試儲存失敗會提示；取消後分頁仍在。
     - 不儲存並關閉後服務端沒有變更；重新開啟後未存修改回來。
  3. 開 9 篇，第 1 篇被卸載成斜體；點選後改成卸載第 2 篇。之後：
     - `preferences.json` 寫入 9 個分頁與模式。
     - 重開 App 後恢復 9 個、只載入 1 個，原始碼模式還原，有提示；點選其他分頁會載入。
     - ⌘9 可用，「全部關閉」可用。
  4. 切換語言：兩個分頁的工具列都換成新語言，草稿與游標不變。
  5. 截圖：三種語言、深色、全部分頁選單、關閉未存對話框。

## 截圖

| 檔案 | 內容 |
| --- | --- |
| `qc047-zh-Hant-1-tabs.png` | 繁體：10 個分頁溢出漸隱，未載入（斜體）、AI 星號、未存點、作用中 |
| `qc047-zh-Hans-1-tabs.png` | 简体：同上 |
| `qc047-en-1-tabs.png` | English：同上 |
| `qc047-en-2-all-tabs.png` | English：全部分頁選單（狀態、⌘ 編號、關閉其他） |
| `qc047-en-3-tabs-dark.png` | English 深色 |
| `qc047-zh-Hant-4-close-unsaved-dark.png` | 繁體深色：關閉未存對話框，取消為預設焦點 |

## 與原型的差異／待確認

- 這個會話讀不到畫布，下列細節是依 ledger 自行決定的，請以畫布核對：
  - 分頁寬度固定 184px。
  - 分頁列高度 36px。
  - 「N ⌄」按鈕一直顯示，不只在溢出時顯示，因為「關閉其他」也從這裡進入。
  - 選單排版。
  - 閃一下的動畫是 0.9 秒淡出強調色。
- 「AI 面板開合」：目前的編輯器沒有收合 AI 面板的按鈕，側欄只會是 AI、歷史或素材三者之一。分頁保留的是這三者中哪一個在開。如果畫布上有收合鈕，需要另外補。
- ledger 的 `backendNeeds` 寫恢復時用 `GET /api/v1/works?ids=…` 一次取標題。這個 API 不存在，這張任務也沒有授權改後端。所以改成在偏好裡快取標題，並在載入分頁時更新。後果：作品在別處改名後，未載入分頁的標題要等點開才會更新。

## 已知缺口

- 卸載後再載入，視覺模式的游標只能還原到所在段落的開頭，因為視覺編輯器沒有原始碼位移。分頁沒卸載時，切換會還原精確的游標。
- 編輯器自己的提示（例如插入失敗）和分頁的提示（已關閉、已恢復）都在畫面底部置中，同時出現時會重疊。
- 「不儲存並關閉」後可以找回的草稿只保留最後關閉的一個，而且只在 App 執行期間有效，不寫入磁碟。

## NOT_VERIFIED

- 實機鍵盤（非 Playwright 注入）按 ⌘W、⌘1–9、⌘⇧[ ] 時，renderer 先處理並 `preventDefault`，所以原生選單的同一快捷鍵不會再觸發一次。這是根據 Chromium 在 macOS 上的按鍵分派順序推論，沒有在實機驗證。e2e 分別驗證了鍵盤路徑和選單點選路徑。
- 打包後的 App。
- 用 AI 任務實際跑到一半時切換分頁、卸載的行為：只有單元測試覆蓋「aiBusy 不卸載」。
- VoiceOver 朗讀分頁狀態（`aria-description`）。
- 很長的英文標題以外，其他頁面的版面沒有因這次改動重新檢查。
