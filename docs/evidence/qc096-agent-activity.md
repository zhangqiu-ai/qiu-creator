# QC-096 驗收記錄：Agent 即時狀態（後端與 MCP）

依據：

- 原型 PT-20261125-001 的 `dataSource`（`docs/design/prototype/changes.json`）。
- [決策記錄](../decisions.md) 2026-11-25 的七點。

設計細節見 `docs/architecture.md` 的「Agent 即時狀態（QC-096）」一節。

## 提交

- `9fc8859`：contracts 契約。先提交，已轉給 qc-frontend（QC-097）。
- 第二個提交：服務、路由、SSE、api-client、MCP 工具、測試與文件。

## API 形狀

- `GET /api/v1/agents/activity?work_ids=a,b`（只限主權杖）。
  - 回 `{items: AgentActivity[], counts, now}`。
  - `AgentActivity` 的欄位：`token_id`、`agent_name`、`work_id`、`state`、`reason`、`step`、`last_active_at`、`expires_at`。
  - `counts` 的形狀：`{all: {agents, works}, projects: [{project_id, agents, works}]}`。
- `POST /api/v1/agents/status`：
  - 請求：`{work_ids, state, step?, ttl_seconds?}`。
  - 回 `{items: AgentActivity[]}`。
- SSE：`GET /api/v1/events` 上的 `event: agent.activity` 區塊，沒有 `id`，`data` 是 `{type, activity, counts, at}`。只推給主權杖的串流。
- MCP `agent_status_report`：參數 `work_id` 或 `work_ids`、`state`、`step?`、`ttl_seconds?`。屬於 core，永遠開啟。

## 取捨

- **權限 `report`**：有 `import`、`write`、`propose` 任一個即可（照推薦）。主權杖回 403，只有 `read` 的權杖也回 403。
- **只放記憶體**：
  - 不建表，也不寫進 change_log：避免大量短命的列，不影響 `changes_since` 與 `Last-Event-ID`。
  - 重啟後回到 idle。待審提案從資料庫推導，所以仍然是 needs_attention。
- **60 秒到 2 分鐘之間沒有回報時仍是 working**：決策寫的是「2 分鐘沒有動作才轉可能已停止」。60 秒這個門檻的作用是：60 秒內的操作優先於「需要你處理」與「出錯」。
- **操作從 change feed 推導**：只要事件的 `actor` 是 Agent 權杖、實體是作品，就算一次操作。之後新增的寫入路由不必再維護清單。
- **成功的回報不寫進活動記錄**，避免洗版；被拒絕的照常記錄。

## 自動測試

| 測試 | 驗證什麼 |
| --- | --- |
| `packages/contracts/test/agent-activity.test.ts`（3 項） | `work_ids` 解析、去重與上限，TTL 預設值與上下限，事件形狀 |
| `services/mac-server/test/agent-activity.test.ts`（15 項） | 用可控時鐘驗證：<br>- 60 秒、2 分鐘、10 分鐘三個門檻。<br>- 主權杖的操作不算。<br>- 待審提案（使用者捨棄後消失）。<br>- 失敗的匯入（成功後消失）。<br>- 側欄計數。<br>- TTL 到期轉 stale 再轉 idle。<br>- done 保留 8 秒，並結束之前的工作。<br>- 權限：主權杖、唯讀、限定項目、不存在的作品、參數錯誤。<br>- 活動記錄只記被拒絕的回報；撤銷的權杖消失。<br>- GET 只限主權杖。<br>- SSE 只推給主權杖、沒有 `id`、結束時推 idle。<br>- 計時器自動推送。<br>- `step` 的清理。 |
| `packages/agent-sdk/test/mcp-agent-status.test.ts`（2 項，stdio 端到端） | 用真正的 `creatorhub mcp` 二進位、經 stdio：<br>- 回報 working 時，`step` 去掉了連結、標記與路徑。<br>- App 看到 working 和計數；之後回報 done。<br>- 唯讀權杖回 forbidden，限定項目外的作品回 not_found，沒給作品時回錯誤。 |
| `packages/agent-sdk/test/mcp-coverage.test.ts`、`mcp-client.test.ts` | 路由覆蓋，`report` 權限與服務端一致，工具清單與 `readOnlyHint` |

## 驗證數字

- 全套 test（每次一個套件，負載約 3）：11 個套件，1344 passed，0 failed，1344 total。受影響的套件：mac-server 562、agent-sdk 43、contracts 26、apps/mac 466（只受型別影響），都是 0 failed。
- `pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json` 通過；root `eslint .` 0 錯誤；`prettier --check .` 通過。

## NOT_VERIFIED

- App 端的顯示（QC-097 由 qc-frontend 負責）。
- 在真的 Claude Code 裡呼叫 `agent_status_report`（stdio 協定已由上面的端到端測試驗證）。
