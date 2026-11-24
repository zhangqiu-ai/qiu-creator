# QC-087 驗收記錄：MCP 基礎與唯讀工具

- 分支：`feat/qc087-mcp-readonly`（從 origin/main `61551fc` 開）。
- 規格：`docs/mcp-plan.md` 第 3、4、6 節；`.tasks/NEXT.md` QC-087；`docs/decisions.md` 2026-11-24。
- 設計說明：`docs/architecture.md`「MCP（QC-087）」，內含 Claude Code、Codex、Claude Desktop 設定範例。

## 實作

| 項目 | 位置 |
| --- | --- |
| `creatorhub mcp`（stdio）、`--toolsets`、`CREATORHUB_TOKEN`／`CREATORHUB_URL` | `packages/agent-sdk/src/cli.ts`、`mcp/stdio.ts` |
| 12 個唯讀工具 | `packages/agent-sdk/mcp/tools.ts` |
| 3 個 resources、伺服器 instructions | `mcp/server.ts` |
| 路由覆蓋表（`MCP_EXCLUDED`／`MCP_EXCLUDED_AREAS`／`MCP_PENDING`／`MCP_PENDING_AREAS`） | `mcp/coverage.ts` |
| `work_diff` 的行級 unified diff | `mcp/diff.ts` |
| 新路由 `GET /api/v1/changes`、`GET /api/v1/session`（新權限 `any`） | `services/mac-server/src/routes/session.ts`、`auth/scopes.ts`、`server.ts` |
| 實際註冊路由清單 `CreatorHubServer.routes`（`onRoute`）；匯出 `requiredAccess` | `services/mac-server/src/server.ts`、`index.ts` |
| 契約與 client：`ListChangesQuery/Response`、`SessionResponse`；`client.changes()`、`client.session()` | `packages/contracts`、`packages/api-client` |
| 依賴 `@modelcontextprotocol/sdk` ^1.32.2（MIT） | `docs/dependencies.md` |

**加兩條路由的理由：**

- `GET /api/v1/events` 是不會結束的 SSE，MCP 工具需要有界的 JSON，所以 `changes_since` 改走 `/changes`。
- 原本 Agent 權杖無法得知自己的權限範圍（`GET /tokens` 只限主權杖），所以 `server_status` 改走 `/session`。

## 自動測試

- `packages/agent-sdk/test/mcp-coverage.test.ts`（5 項）：
  - 以臨時 `CREATORHUB_HOME` 啟動服務，取 `onRoute` 記下的實際路由，共 127 個 `/api/v1` 路由與方法。
  - 每條路由都有歸類；表中沒有不存在的路由；每個前綴至少命中一條路由；同一路由不會有兩種歸類；原因都有寫。
  - 工具權限與 `requiredAccess` 一致。
  - 本任務沒有 import／write 工具。
- `packages/agent-sdk/test/mcp-client.test.ts`（9 項），用 SDK client 經 in-memory transport 連線，資料目錄一律是臨時的：
  - 工具清單與說明提醒；`--toolsets` 只開所選的領域。
  - `server_status` 回報 token 與各工具是否可用。
  - 搜尋：繁簡、拼音都找得到。
  - `work_get`（含與不含 Markdown）、版本列表與單一版本、`work_diff`、`changes_since`、work resource。
  - 素材、項目、平台版本、`platform_rules`、projects 與 rules resources。
  - 錯誤：403（import 權杖讀取）、404、400。
  - **真的子行程**：`node bin/creatorhub.js mcp` 經 stdio 連線，證明 stdout 只走協定。
  - CLI：`--toolsets` 的解析；未知 toolset 與缺少權杖會被拒絕。
- `services/mac-server/test/session-changes.test.ts`（3 項）：
  - 主權杖與三種 Agent 權杖的 session；沒有權杖回 401。
  - `changes` 分頁：`next_since`、`has_more`；limit 上限回 400。
  - import 權杖讀 `changes` 回 403。

## 範圍與 NOT_VERIFIED

- 沒有介面變更。
- 尚未用真正的 Claude Code／Codex／Claude Desktop 連線測試：**NOT_VERIFIED**，排在 QC-093。設定範例依各工具官方的 `mcpServers` 與 `[mcp_servers]` 格式撰寫。
- `variant_get` 原樣轉回目前 API 的平台版本形狀。QC-084 合併後，會自動改為覆寫值與推導正文的 `VariantView`；測試只斷言兩種形狀都有的欄位。

## 數字（2026-11-24）

- 全套 `pnpm -r --workspace-concurrency=1 --no-bail test`，開始時 1 分鐘負載 2.8：
  - 11 個套件全部通過，1250 passed，0 failed。
  - mac-server：525（43 個檔）；apps/mac：445；agent-sdk：26（CLI 12、MCP 覆蓋 5、MCP client 9）；其餘套件 254。
- typecheck：`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json`，全部通過。
- 根目錄 `pnpm lint`（`eslint .`，含 e2e）：0 錯誤。
- prettier：所有變更檔案都通過。
