# QC-043 驗收記錄：服務端產生的文字跟隨介面語言

日期：2026-11-21　分支：`feat/qc043-server-text`（從 `origin/main` e7d17c8 開）　worktree：`/Users/feature/code/qiu-creator-qc043`

依據：`docs/decisions.md` 2026-11-21「介面多語言」，以及 `docs/evidence/qc042-i18n.md`「已知差異與缺口」列出的服務端繁體文字。

全部使用臨時目錄與假服務：AI 用本機假供應商，備份失敗靠把臨時 home 的 `backups/` 設成唯讀來觸發。沒有碰真實的 `~/CreatorHub` 或 Keychain，也沒有對第三方發請求。

## 1. 做法

服務端不讀介面語言，只回傳穩定的代碼與參數；Mac App 用 `packages/i18n` 依目前語言組成文案。

| 原本的繁體文字 | 現在服務端回傳 | 介面顯示 |
| --- | --- | --- |
| 告知內文 `notice.text` | `notice.template`（`cloud_provider`／`relay`）＋ `notice.params`（`name`、`company`） | `ai.noticeCloudProvider`／`ai.noticeRelay` |
| 預算提醒 `budget.warning` | 既有數字：`over_budget`、`projected_usd`／`spent_usd`、`budget_usd` | `ai.budgetWarning` |
| AI 任務錯誤 `job.error` | 既有的 `error_code`，加上新的 `error_detail`（技術細節原文，已去除金鑰） | `error_code` 的類別句，下方是收起的「技術細節」 |
| 備份失敗 `detail`／`last_error` | `reason`（`disk_full`／`permission_denied`／`integrity_failed`／`io_error`／`unknown`），出現在 `details.reason`、`last_error_reason` 和 `backup.failed` 事件的 `data.reason` | 類別句單獨一行，下方是收起的「技術細節」 |

另外補上兩處：

- **New API 的公司名**：`company` 也是服務端的繁體字串（「你設定的 New API 中轉站」），會出現在設定頁「內容會送到 {company}」等三處。改由介面翻譯（`ai.relayCompany`）。
- **中轉站設定被更換**：原本用 `consent_required` 加上繁體說明，現在改用新的失敗碼 `credential_changed`，介面有對應的三語文案。

**舊欄位：全部保留。** `notice.text`、`budget.warning`、`job.error`、`last_error`、`details.detail` 照舊回傳。

- 理由：`/api/v1/ai/*` 和備份 API 是公開的 HTTP 介面，Agent 或其他用戶端可能讀這些欄位，所以只增不刪。
- Mac App 已不再顯示其中的繁體文字。`last_error` 與 `details.detail` 本來就是技術原文，現在只出現在「技術細節」裡。
- 舊版服務沒有 `template` 時，介面退回顯示 `notice.text`；沒有 `reason` 時，不顯示類別句，只顯示技術細節。

**技術細節**：共用元件 `TechnicalDetails`（`<details>`，預設收起）。

- 標題是「技術細節」／「技术细节」／「Technical details」，內文不翻譯。
- 服務端寫入前已去除金鑰（`sanitizeDetail` 加上用目前金鑰逐字遮蔽）。介面顯示前用 `redactSecrets` 再去除一次：`sk-…`、`AIza…`、`Bearer …`、`x-api-key…`、`key=`／`token=`／`secret=`，以及 40 字以上的連續識別字串。

**同意**：仍只綁告知的版本號與 `credential_id`。告知在三種語言的段落數和佔位符都相同，內容等價，所以切換語言不算改版，也不會再要求確認。

**字數用語**：英文統一用 **words**。原本編輯器標頭寫「16 words」，AI 面板的選取與長度變化寫「characters」。

- 理由：兩者是同一種算法（`countWords`），每個中日韓字算一個、每段拉丁字或數字算一個，和 Microsoft Word 的字數慣例相同。如果用 characters，英文內容的字數會被誤讀成字母數。
- 中文兩處本來都是「字」，不改。

## 2. 變更位置

| 範圍 | 檔案 |
| --- | --- |
| 契約（只增不改） | `packages/contracts/src/ai.ts`（`AiNoticeTemplateSchema`、`aiNoticeTemplate`、`credential_changed`、`error_detail`）、`backups.ts`（`BackupFailureReasonSchema`、`last_error_reason`）、`api.ts`（說明） |
| 服務端 | `ai/provider.ts`（`ProviderError.detail`）、`ai/ai-service.ts`、`backups/backup-service.ts`（`backupFailureReason`、`BackupIntegrityError`）、`routes/backups.ts`、migration `0014_ai_job_error_detail` |
| 文案 | `packages/i18n` 的 `ai`、`common`、`serviceSettings`：三語各新增 11 個鍵；英文兩處 characters 改成 words |
| Mac App | `server-text.ts`、`TechnicalDetails.tsx`、`AiPanel`、`AiWorkbenchPage`、`AiSettingsSection`、`BackupSection`、`ai-session`、`ai-video`、`backups.ts`、`styles.css` |
| 文件 | `docs/architecture.md`（新增「服務端文字與介面語言」一段、失敗碼表、遷移、備份） |

## 3. 測試

- **契約**（`packages/contracts/test/ai.test.ts`）：
  - 各供應商的告知範本。
  - 沒有 `template` 的舊回應仍能解析；不認識的範本名會被拒絕。
  - `credential_changed` 失敗碼與備份失敗的各種 reason。
- **服務端**（`services/mac-server/test/server-text.test.ts`，5 項）：
  - 四個供應商的範本與參數；版本號固定，`notice.text` 仍是繁體原文。
  - 假供應商回 401 且錯誤內文帶有金鑰：`error_code` 是 `invalid_key`，`error_detail` 以 `HTTP 401` 開頭，且 `error` 和 `error_detail` 都不含金鑰。
  - 重跑後 5xx：`provider_unavailable`，舊的細節被覆蓋。
  - `providerError` 的細節由 HTTP 狀態加上去除金鑰的文字組成。
  - errno 與 SQLite 錯誤碼對應到備份失敗的 reason。
  - 每日備份失敗：`last_error_reason`、`backup.failed` 事件；手動備份失敗：500 加 `details.reason`；之後成功一次，兩者都清空。
- **既有測試的斷言因行為改變而改寫**，都沒有放寬：
  - `ai.test.ts`：中轉站被更換時的失敗碼改成 `credential_changed`；另加 `error_detail` 只有 `HTTP 400`。
  - `backups.test.ts`：還原時 409 多驗 `details.reason`；`schema_version` 改成 `0014`。
  - `db-and-config.test.ts`：0013 的升級測試只套到 0013 為止。
  - Mac App 的 `backups.test.ts`：手動備份失敗會帶 `reason`，並加測舊版服務不帶 reason 的情況。
- **Mac App**（`apps/mac/test/server-text.test.ts`，8 項）：
  - 三語告知：繁體與服務端原文逐字相同；三語的段落數與佔位符相同；舊服務退回原文。
  - New API 公司名在三語下的顯示。
  - 三語預算提醒，以及沒超過時不顯示。
  - 備份 reason 的三語文案，不認識的值當成 unknown。
  - `TechnicalDetails` 在三語下都預設收起、標題正確、金鑰已去除；內容為空時不顯示。
  - 一般的技術文字原樣保留。
- **防止元件寫死中文**：`no-hardcoded-chinese` 測試通過，新元件沒有中文字。
- **e2e**（`e2e/specs/server-text.spec.ts`）：
  1. 以繁體確認 GPT 的告知後切到 English：設定頁 GPT 仍是「Keychain · on」，沒有確認按鈕，服務端的 consent 與切換前相同。
  2. English 下改寫全文，假供應商回 401：失敗卡顯示「Generation failed · The API key is invalid」，沒有任何中文；「Technical details」預設收起，展開後是 `HTTP 401`，不含金鑰。
  3. 切到简体中文，在備份資料夾唯讀時按「立即备份」：顯示「备份失败，没有生成副本」與「没有写入备份文件夹的权限。」，沒有繁體字；「技术细节」裡是 SQLite 的原文。

## 4. 截圖

- English，AI 失敗卡，技術細節已展開：`docs/evidence/qc043-en-ai-failure.png`。編輯器標頭與 AI 面板都寫「15 words」。
- 简体中文，手動備份失敗，類別句單獨一行，技術細節已展開：`docs/evidence/qc043-zh-Hans-backup-failure.png`。
- 第一次截圖發現類別句緊接在「备份失败，没有生成副本」後面、沒有斷句，已改成類別句單獨一行，並重新截圖。

## 5. 閘門

在 HEAD `606a5d4` 上執行：

| 閘門 | 結果 |
| --- | --- |
| `pnpm typecheck`（`pnpm -r typecheck` 加 e2e 的 tsc） | 通過 |
| `pnpm -r lint` | 通過 |
| `prettier --check`（本任務改動的檔案） | 通過 |
| `pnpm -r --workspace-concurrency=1 --no-bail test` | **805 passed／0 failed／805 total** |
| e2e（`playwright test`，全部 spec） | **9 passed／0 failed／9 total** |

- 全倉測試：2026-11-21 07:38:26–07:39:08（PST）執行，開始時 1 分鐘負載 14.06，結束時 18.40，持有全倉測試鎖。
- e2e：07:39:08–07:40:06 執行，開始時負載 18.40，持有 e2e 鎖。e2e 的規則沒有負載門檻，沒有加長逾時或重試。
- 兩個鎖跑完都已釋放。

| 套件 | passed／total |
| --- | --- |
| contracts | 18／18 |
| design-tokens | 5／5 |
| domain | 27／27 |
| i18n | 29／29 |
| installer | 39／39 |
| api-client | 19／19 |
| markdown-editor-web | 28／28 |
| platform-preview | 12／12 |
| mac-server | 378／378 |
| apps/mac | 244／244 |
| agent-sdk | 6／6 |

## 6. NOT_VERIFIED 與範圍外

- **事件當下產生的短暫訊息**：例如 toast，切換語言時如果還在畫面上，要等下一次動作才換語言。這是 QC-042 已記錄的缺口，不在本任務範圍。
- **匯入任務的錯誤**：`import_jobs` 的 `error` 欄位在匯入頁的 `reasonDetail` 原樣顯示，這部分不在總監列出的四項裡。
  - 已知差異：匯入錯誤本來就有 `error_code`，介面也用它顯示類別句；技術細節則照舊原樣顯示，沒有收進「技術細節」，也沒有再去除一次金鑰。
  - 建議另開小任務，統一改用 `TechnicalDetails`。
- 沒有跑真實的雲端 AI 或真實的磁碟滿；兩者都用假服務或權限模擬。
