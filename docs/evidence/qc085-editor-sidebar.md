# QC-085 前端：作品編輯頁全高右側邊欄（PT-20261123-002 A）驗收記錄

日期：2026-11-23 · 會話：qc-frontend · 分支 `qc085-sidebar`（從 origin/main 0784176 開）

## 範圍

照使用者核准的原型 PT-20261123-002 A 案（未決問題全部採用推薦），把作品編輯頁改成「左欄編輯、右側全高邊欄」。文章、貼圖、視頻三種編輯器都改。

- **版面**：分頁區改成兩欄格線。左欄是作品分頁列加編輯器；右欄是邊欄，從視窗頂端到底。每個分頁窗格用 `display: contents`，所以各自的編輯器與邊欄落在兩欄裡；背景分頁的邊欄隱藏但不卸載，草稿與面板狀態保留。
- **邊欄分頁**：預覽、AI、歷史、素材，加最右的收合鈕。
  - 分頁列 36px，高度與底線都和作品分頁列對齊。
  - 分頁表是 `editor-side.ts` 的 `SIDE_TABS` 清單；編輯器只列出自己有的分頁。貼圖沒有 AI；視頻的 AI 是影片理解。視窗記住的分頁不在時，顯示第一個。
  - 看過的分頁切走時保留狀態。「預覽」一直掛載，因為收合時的橘點要靠它。
- **預覽**：沿用 QC-084 的三畫面預覽，拿掉它自己的寬度、收合、關閉與窄視窗邏輯。縮放移到畫面分頁那一列的右側。「模擬」在舞台右上角，「復原」在左上角，都在手機上方的留白裡。
- **左欄**：頭部第一列是返回、標題、r 與字數、視覺｜原始碼、插入；第二列是狀態、標籤、項目。「預覽」「歷史」按鈕已拿掉。
- **寬度**：拖曳左緣在 400–760 之間調整，雙擊回 520，焦點在把手上時 ←／→ 每次 16。拖到 320 以下直接收合，並保留拖曳開始時的寬度。分頁、寬度、開或收合存在 `localStorage` 的 `qc.editorSide.v1`，所有作品共用。
- **收合**：44px 圖示欄（開關、預覽、AI、歷史、素材），滑過或鍵盤焦點顯示名稱。有平台超出上限時，「預覽」帶橘點。
- **快捷鍵與選單**：
  - ⌥⌘0 開關邊欄，記住上次的分頁。
  - ⌘⇧P 打開預覽，已在預覽時收合。
  - ⌘⇧I 打開素材並把游標放進搜尋，已在素材時收合。
  - 選單列「顯示方式」加了三個項目，id 是 `tab-side-toggle`、`tab-side-preview`、`tab-side-assets`。
  - 原本在各編輯器裡的 ⌘⇧P、⌘⇧I 處理拿掉，統一由分頁區處理。
- **窄視窗**：編輯欄會小於 560px 時，邊欄改成抽屜。平常只有 44px 圖示欄；打開時從右側滑入，蓋在編輯欄上，正文寬度不變。Esc 或點正文收起。抽屜的開關不寫入記住的偏好。
- **其他調整**：
  - 歷史面板與素材抽屜拿掉自己的關閉鈕和 Esc 關閉，改由邊欄收合。
  - `TabView.panel` 拿掉，因為邊欄分頁屬於視窗，不屬於作品。
  - `PreviewPrefs` 拿掉 `width`、`collapsed`。
  - `STAGE_PAD` 改成上 44、下 36。

## 測試

- 單元測試：
  - 新增 `apps/mac/test/editor-side.test.ts`，8 個測試，涵蓋偏好、⌘⇧P 切換、拖過頭收合、抽屜、分頁退回、橘點通知。
  - 更新 `preview-stage.test.ts`（舞台留白與偏好）和 `tabs.test.ts`（拿掉 `panel`）。
- e2e：
  - `editor-preview.spec.ts` 重寫成兩個測試：
    - 全高與分頁列對齊、無預覽／歷史按鈕、縮放在手機上方。
    - 分頁切換與 ←／→、⌘⇧P、⌘⇧I、選單項目。
    - 收合與圖示欄、拖曳 760／744／雙擊 520／拖過頭收合。
    - 橘點（展開與收合都有）、409。
    - 窄視窗抽屜：正文寬度不變、Esc 與點正文收起。
    - 深色與三語的分頁名稱。
  - 新增 `e2e/fixtures/side.ts`，提供 `showSideTab`、`collapseSide` 與 locator。
  - 受影響的 spec 改用邊欄分頁：
    - image-post、video-work、editor-tabs（邊欄分頁跨作品共用）
    - overlays-motion、editor-scroll（窄視窗改驗抽屜）
    - ai-image-editor、ai-language-model-prompt、ai-model-fallback、new-api、server-text
  - 沒有放寬斷言、加重試或延長逾時。`ai-image-editor` 的一個 `page.getByText` 改成限定在正文裡，因為預覽常駐後同一句話也在手機畫面裡。

## 截圖（`docs/evidence/qc085/`，e2e `QC085_SHOTS`，背景模式）

| 檔案 | 內容 |
| --- | --- |
| qc085-side-preview-feed.png | 預設：邊欄開在預覽（小紅書刷到時），全高，縮放在畫面分頁右側 |
| qc085-side-ai.png | AI 分頁（改寫／圖片） |
| qc085-side-collapsed.png | 收合：44px 圖示欄，滑過顯示「歷史」 |
| qc085-side-zoom-100.png | 100%：手機頂端在留白下方，縮放選單向下展開 |
| qc085-side-over-limit.png | 超出上限：預覽分頁與平台分頁橘點、截斷線 |
| qc085-side-narrow-drawer.png | 1024×768：抽屜蓋在編輯欄上，正文寬度不變 |
| qc085-side-dark-feed.png | 深色 |
| qc085-side-zh-Hans-*.png、qc085-side-en-*.png | 简体中文與 English |
| qc085-2 … qc085-9 | QC-084 的預覽內容在邊欄裡（跟隨、自訂、AI 標題、封面、409） |

## 與原型的差異

- 動效簡化：邊欄展開時，內容 translateX 24px 加淡入（`moderate`／`out`），編輯欄直接取得新寬度；沒有做編輯欄的 `layout="position"` 平移。窄視窗抽屜同樣是滑入加淡入。DESIGN.md 動效表已照實作寫。
- 「記在每個視窗」：App 只有一個主視窗，偏好存在 `localStorage`，重開後保留。若之後有多視窗，各視窗會共用同一份偏好。

## NOT_VERIFIED

- 真實觸控板的拖曳手感，以及選單列快捷鍵在實機 macOS 上的觸發（e2e 用 `Menu.getMenuItemById().click()` 與鍵盤事件驗證）。
- 減少動態效果下的實際觀感：e2e 只驗功能，沒有看動畫。
- 第一輪全套 `QC_E2E_MOTION=on` 時，`new-api.spec.ts` 失敗一次。症狀：從設定回到作品後，30 秒內都找不到邊欄的「AI」分頁。之後無法重現：單獨在動效模式連跑 8 次全過，第二輪全套兩種模式也都 0 failed。根因未查明，可能和回到編輯區時 `ResizeObserver` 重新量寬度的時機有關。同一輪的 `settings-ai-motion.spec.ts`（只在動效模式跑）失敗是確定的缺漏，已補上切到 AI 分頁。

## 數字（最後一輪，負載 3–10）

- typecheck 0（含 e2e）、lint 0、format 0。
- 單元測試逐一套件跑，全過，共 1,231：mac 443、mac-server 522、markdown-editor-web 62、domain 45、installer 39、i18n 30、platform-preview 27、contracts 23、api-client 22、agent-sdk 12、design-tokens 6。
- e2e 一般模式 58 passed／10 skipped，0 failed；`QC_E2E_MOTION=on` 59 passed／9 skipped，0 failed；截圖執行 0 failed。

## 發版前修正（2026-11-23，分支 `qc085-fix`，從 origin/main 9baf141 開）

1. **從設定回來時邊欄閃一下、抽屜被收起（競態，qc-test 查出根因）**：設定頁把分頁區隱藏，`ResizeObserver` 送出 `measure(0)`。`isDrawer(0)` 是 false，結果 drawer 被設成 false；回到作品約 15ms 後 `measure(1048)` 又改回抽屜並收起。修法：`SideStore.measure` 收到 0 時直接忽略，drawer、drawerOpen 與顯示寬度都保留最後一次的版面。`new-api.spec` 在動效模式偶發的「找不到 AI 分頁」就是這個原因。
2. **抽屜門檻太嚴**：原本編輯欄不到「560＋記住的寬度」就改成抽屜，1280 寬的視窗（編輯區 1048）預設就看不到停靠的邊欄。改成先縮邊欄顯示寬度到最小 400（新增 `shownWidth`，不改記住的寬度，空間恢復就回去），只有編輯區小於 960 才改成抽屜。

測試：
- 單元測試新增 2 個，修改 1 個：先縮再抽屜、記住的寬度回來、拖得比空間寬時記住但照可用空間畫，以及量到 0 時 drawer、drawerOpen 與寬度都不變且不通知。
- e2e `editor-preview.spec`：
  - 1280 寬時編輯欄剛好 560，邊欄約 488、停靠、沒有圖示欄。
  - 1024 寬時抽屜打開後，去設定再回到作品，6 個畫格後抽屜仍然開著。
- 截圖：`qc085/qc085-side-1280-docked.png`。

數字（`qc085-fix`，負載 3.6–6.9）：
- typecheck 0（含 e2e）、lint 0、format 0。
- 單元測試逐一套件跑，全過，共 1,233：mac 445、mac-server 522、markdown-editor-web 62、domain 45、installer 39、i18n 30、platform-preview 27、contracts 23、api-client 22、agent-sdk 12、design-tokens 6。
- e2e 一般模式 58 passed／10 skipped，0 failed；`QC_E2E_MOTION=on` 59 passed／9 skipped，0 failed。
- `new-api.spec` 在動效模式連跑 10 次：10 passed。
- 截圖執行 0 failed。

過程中的發現：第一輪檢查時，拖過頭收合後再打開，邊欄停在 400。原因是收合時恢復了記住的寬度，卻沒有重算顯示寬度。已修，單元測試也補上這個斷言。

觀察（不在這次範圍）：編輯欄只有 560 時，頭部的「視覺｜原始碼」與「插入」會換到第二行，格式工具列需要左右捲動。這是編輯欄窄時本來就有的行為。
