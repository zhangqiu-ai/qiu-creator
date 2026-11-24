# QC-091 前端：Agent 提案收件匣、編輯頁「提案」分頁、設定 › Agent 與 MCP、歷史標示

日期：2026-11-24 · 會話：qc-frontend · 分支 `qc091-agent-ui`（從 origin/main 64df62a 開）

規格：
- 原型 PT-20261124-001，使用者核准，七個未決問題全部照推薦。
- `docs/decisions.md` 2026-11-24 的三條決策。
- 後端 API 用 QC-089 已合併的提案、權杖更新、活動記錄、版本 `agent` 欄位。

## 範圍（這次做的）

1. **側欄「Agent 提案」**：在「全部作品」「未分類」下方，有待處理時顯示藍底數字（`/proposals/counts`）。收到 `proposal.*`、`work.deleted`、`work.trashed` 事件時重新讀取；收合成圖示列時，數字在圖示角落。
2. **收件匣**（`ProposalsPage`）：
   - 頁首有「待處理／已處理」切換和 Agent 篩選。左欄是清單，右欄是詳情。
   - Agent 說明放在引號框裡，註明「這是 Agent 寫的文字，只作參考」。
   - 變更逐處列出，每處一個勾選框，可以部分採用；採用後的版本標示「採用 X 的提案」。捨棄的提案移到已處理。
   - 原稿已更新但沒有重疊時，顯示黃色提示，可以直接採用。
   - 有重疊時顯示紅色提示，重疊的變更預設不勾；勾了以後按鈕變成停用的「處理重疊後才能採用」。採用時服務回 409（`proposal_conflict` 或 `revision_conflict`），會重新載入提案並提示。
3. **三方對照**：原型只畫了入口，所以這次先做一個簡單、可用的三欄比對對話框。每段重疊一組，三欄分別是原本、你現在的版本、Agent 的提案。可以「不採用重疊的 N 處」，或「在編輯頁打開」自己合併。三欄目前只能看，不能逐行挑選；需要逐行合併時要另外設計。
4. **編輯頁右側邊欄「提案」分頁**：
   - 只在這個作品有待處理提案時出現，帶數字；文章、貼圖、視頻三種編輯器都有。
   - 從收件匣按「在編輯頁打開」，會直接停在這個分頁。
   - 有多個提案時可以上下切換。採用前會先儲存左邊的修改；存不了就停下來提示。
   - 文章在視覺模式下，左邊正文裡變更所在的段落會標亮（okSoft 底色加左側綠線）。原始碼模式，以及貼圖、視頻的文案，不標亮。
5. **設定 › Agent 與 MCP**：權杖從匯入任務頁搬過來，匯入任務頁留一張連結卡。
   - 權杖清單顯示範圍摘要、「可直接改正文」、「限 N 個項目」和最近使用。
   - 範圍 read、import、write、propose 逐項勾選並立即儲存，至少要留一項。畫面先更新，失敗時退回原狀。
   - 「允許直接修改正文」開關：打開前要確認。確認框說明後果、保護和範圍，勾「我了解」後紅色的「允許直接修改」才能按，焦點預設在「取消」。關掉不需確認。
   - 限定項目：可以選「所有作品」或「只限這些項目」，項目以膠囊列出，用選單加入。
   - 最近活動：
     - 每筆有類型圖示和作品名稱，被拒絕的寫明原因。
     - 權杖設定的變更改寫成文字，例如「允許直接修改正文：關 → 開」。
     - 直接修改的那筆有「恢復上一版」。只在作品之後沒再改過時才恢復；改過就提示到歷史處理。恢復用既有的 restore API，目標是版本 `agent.restore_to`。
   - 「複製 MCP 設定」複製 docs/architecture.md 的 `mcpServers` 片段，權杖處是佔位字。新建權杖後，對話框另外附上已填好權杖的設定。
6. **歷史版本**：依 revision 的 `agent` 欄位標出「Agent 直接修改」（warn）加「X 直接修改」，或「Agent 提案」（accent）加「採用 X 的提案」。

三種語言的文案在新的 `packages/i18n/src/catalog/agents.ts`。

**等 QC-092 交付後再做**：項目描述與規則的編輯和試算；作品卡上「由 Agent 歸入」的標示，以及「保留（改為手動）」「復原歸入」。

## 實作

| 項目 | 位置 |
| --- | --- |
| 計數 store、可採用判斷、變更在正文中的位置、頭像、版本名 | `apps/mac/src/renderer/proposals.ts` |
| 提案詳情、三方對照 | `ProposalView.tsx`、`proposals.css` |
| 收件匣 | `ProposalsPage.tsx` |
| 編輯頁「提案」分頁 | `ProposalsSideTab.tsx`；`editor-side.ts` 的 `SIDE_TABS` 加 `proposals`；`EditorSide` 的分頁數字 |
| 設定頁 | `AgentsSettings.tsx`、`agents-settings.ts`、`agents-settings.css`；`SettingsNav` 新分類 |
| 匯入任務頁的連結卡 | `ImportsPage.tsx`；刪除 `TokensPanel.tsx`（`sortTokens` 移到 `agents-settings.ts`） |
| 歷史標示 | `HistoryPanel.tsx` |
| 側欄列、路由、從收件匣打開時停在「提案」分頁 | `SidebarProjects.tsx`、`App.tsx`、`EditorTabs.tsx`（`sideAsk`） |
| 圖示 `agentInbox`、`robot` | `Icon.tsx` |

## 測試

- 單元測試：新增 `apps/mac/test/agents-ui.test.ts`，14 個測試。涵蓋：
  - 預設勾選與採用的條件；
  - 部分採用時才帶 `hunk_ids`；
  - 行數統計，以及行號與正文位置的對應（原稿移動後依文字找；找不到或重複就不標）；
  - 計數 store 不採用較舊的回應；
  - 權杖排序、範圍摘要與「至少留一項」；
  - MCP 設定的內容；
  - 活動的分類與文字，以及權杖設定變更的文字。
- 單元測試的更新：`settings-v2.test.ts` 的設定分類從 6 個改為 7 個（原型新增的分類），`tasks.test.ts` 改從新位置匯入 `sortTokens`。
- e2e `e2e/specs/agent-proposals.spec.ts`，兩個測試，Agent 都是測試服務上真的權杖：
  - 收件匣：數字徽章、Agent 說明的引號框、部分採用。採用後，版本的 `agent.via` 是 `proposal`，沒勾的那處保持原樣。
  - 重疊：不能採用、三方對照、「不採用重疊的 1 處」、捨棄後移到已處理，原稿不變。
  - 編輯頁：從收件匣打開時停在「提案」分頁，正文標亮一處；就地採用後分頁消失，歷史顯示「採用 Claude Code 的提案」。
  - 設定：從匯入任務頁的連結進來；範圍勾選立即儲存；限定項目。
  - 直接修改的確認：焦點在取消、按鈕是紅色、要勾「我了解」才能按。
  - Agent 直接修改後，從活動記錄恢復上一版，作品內容回到原文。
  - 三語與深色截圖。
- e2e 沒有按「複製 MCP 設定」，因為會改寫使用者真實的系統剪貼簿。複製的內容由單元測試涵蓋。

## 截圖（`docs/evidence/qc091/`，e2e `QC091_SHOTS`，背景模式）

| 檔案 | 內容 |
| --- | --- |
| qc091-inbox.png | 收件匣：清單、Agent 說明、三處變更 |
| qc091-inbox-conflict.png | 有重疊：紅色提示，採用停用 |
| qc091-three-way.png | 三方對照 |
| qc091-editor-proposal-tab.png | 編輯頁「提案」分頁，正文標亮 |
| qc091-tokens-direct-confirm.png | 直接修改的確認框 |
| qc091-tokens-direct-on.png | 已打開直接修改；活動有「恢復上一版」 |
| qc091-tokens.png、qc091-tokens-zh-Hans.png、qc091-tokens-en.png、qc091-tokens-en-dark.png | 設定頁三語與深色 |

## NOT_VERIFIED

- 「複製 MCP 設定」在 e2e 裡沒有實際寫入剪貼簿（理由見上）。
- MCP 設定裡的 CLI 路徑是文件中的範例路徑：打包後的 App 不知道 `creatorhub` CLI 裝在哪裡。要用真正的 Agent 連線驗證，排在 QC-093。
- 三方對照只能看、不能逐行挑選，是這次的簡化。
- 收件匣的深色與英文只截了設定頁；收件匣本身的深色沒有截圖。
