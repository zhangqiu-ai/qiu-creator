# QC-094 驗收記錄：安裝時附帶 `creatorhub` CLI

## 結果

- 服務建置產物多了兩個檔案：
  - `creatorhub.mjs`：esbuild 打包的 CLI 與 MCP 伺服器，約 1.7 MB。
  - `bin/creatorhub`：shell 啟動器，用同一份 `bin/node` 執行上面那個檔案。
- installer 把整個 `server/` 資料夾換新或換回，所以 CLI 和服務一起升級、一起回滾。
- 安裝後 CLI 的路徑固定為：

  ```text
  ~/Library/Application Support/qiu-creator/server/bin/creatorhub
  ```

- install、upgrade、rollback 的報告都會印出這條路徑和完整的 MCP 設定。回滾到 QC-094 之前的建置時，報告會說明那一版沒有附帶 CLI。
- 少了 `creatorhub.mjs` 或 `bin/creatorhub` 的建置，installer 拒絕安裝，什麼都不改。
- App 的「設定 › Agent 與 MCP › 複製 MCP 設定」，以及建立權杖後顯示的設定，都改用服務在 `GET /api/v1/session` 回報的 `cli`：
  - 已安裝：`command` 是上面的路徑，`args` 是 `["mcp"]`，`env` 含 `CREATORHUB_URL` 與權杖。
  - 開發模式：`command` 是服務用的 Node，`args` 是 repo 的 `creatorhub.js` 加 `mcp`。設定下方和複製提示都會標明「開發模式」。
  - 服務沒有回報：退回範例路徑，並提示使用者改成實際位置。

## 路徑由誰提供：選服務的 `/api/v1/session`

理由：

1. **服務知道自己從哪裡執行。** 啟動器就放在 `server.mjs` 旁邊，服務用 `import.meta.url` 找到它，回報的就是正在跑的那一版的 CLI，升級或回滾後不會指錯。主程序只能推算安裝位置；用 `--home` 安裝到別處，或開發時服務跑在 repo，推算就會錯。
2. **開發模式也能給出可用的路徑。** 從原始碼執行時，服務能定位到 repo 的 `packages/agent-sdk/bin/creatorhub.js`，以及它自己用的 Node 絕對路徑。
3. **埠也一起給。** `server_url` 取自請求實際進來的埠，用 `--port` 安裝在非預設埠也能連上。
4. **不必改 preload 或 IPC。** 介面原本就有主權杖的 API client。

隱私：路徑含使用者名稱，所以只有主權杖拿得到 `cli`，Agent 權杖拿到 `null`。`/health` 不需權杖，不放這項資訊。

## API 形狀（`GET /api/v1/session`，新增欄位）

```jsonc
{
  "kind": "owner",
  "name": null,
  "scopes": ["read", "import", "write", "propose"],
  "allow_direct_body_edit": false,
  "project_ids": null,
  "cli": {
    "command": "/Users/<你>/Library/Application Support/qiu-creator/server/bin/creatorhub",
    "args": [],
    "source": "installed", // 或 "source"（從原始碼執行）
    "server_url": "http://127.0.0.1:7420"
  } // Agent 權杖，或找不到 CLI 時為 null
}
```

MCP 設定的組法：`command` 用 `cli.command`，`args` 用 `[...cli.args, "mcp"]`，`env` 放 `CREATORHUB_URL`（取 `cli.server_url`）和 `CREATORHUB_TOKEN`。

## 自動測試

| 測試 | 驗證什麼 |
| --- | --- |
| `services/mac-server/test/build-artifact.test.ts` | 建置後把產物複製到 repo 外（`…/Application Support/qiu-creator/server`），在沒有 Node PATH、沒有 tsx 的環境啟動服務，接著驗證：<br>- `session.cli` 是安裝位置的 `bin/creatorhub`，`source` 為 `installed`。<br>- 從這支啟動器跑 `creatorhub mcp`，用 stdio JSON-RPC `initialize`，`tools/list` 列出工具，`tools/call server_status` 回到正確的 commit 與 Agent 權杖。<br>全程使用臨時 HOME 和 `CREATORHUB_HOME`，不碰 launchd。 |
| `services/mac-server/test/session-changes.test.ts` | 主權杖從原始碼執行時拿到 `source`，指向 repo CLI 和服務用的 Node。注入已安裝的位置時拿到 `installed`。Agent 權杖拿到 `null`；找不到 CLI 時為 `null`。`locateCli` 優先用服務旁邊的啟動器，其次用 repo 的 CLI。 |
| `packages/installer/test/ops.test.ts` | 安裝後產物齊全、路徑正確，報告印出路徑和 MCP 設定。缺 CLI 的建置被拒絕。升級時 CLI 換新、舊版留在 `server.prev`。自動回滾和手動回滾都換回對應版本的 CLI。回滾到沒有 CLI 的舊建置時會說明。 |
| `packages/installer/test/lib.test.ts` | `computePaths().cli` 的路徑。 |
| `apps/mac/test/agents-ui.test.ts` | 已安裝、開發模式、範例三種情況下的 MCP 設定內容、說明文字與複製提示。 |
| `packages/agent-sdk/test/mcp-client.test.ts` | `server_status` 對 Agent 權杖的 `cli` 為 `null`。 |

## 驗證數字

- 全套 test（每次一個套件，開始時負載約 31）：11 個套件，1324 passed，0 failed。
- typecheck：`pnpm -r typecheck` 加 `tsc -p e2e/tsconfig.json` 全部通過。root `eslint .` 0 錯誤，prettier 通過。
- e2e 一般模式：61 passed，0 failed，10 skipped。`QC_E2E_MOTION=on`：62 passed，0 failed，9 skipped。

## NOT_VERIFIED

- 真正用 installer 裝到真實 HOME，以及 launchd 載入（依規定留給 qc-release）。
- 在真實的 Claude Code 或 Claude Desktop 裡貼上設定後連線。stdio 協定已由上面的自動測試從安裝產物實際驗證。
