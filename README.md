# qiu-creator
Local-first AI content management, editing, preview and publishing for macOS, iPhone and iPad.

## 開發啟動

需求：Node 24（見 `.nvmrc`）、corepack（Node 內建）。pnpm 版本由 `packageManager` 鎖定，用 `corepack pnpm` 執行，不必另外安裝。

```sh
corepack pnpm install
```

### 啟動 Mac 服務

開發一律使用臨時資料目錄，不碰真實的 `~/CreatorHub`（沒設定 `CREATORHUB_HOME` 時 `dev` 會拒絕啟動）：

```sh
export CREATORHUB_HOME="$(mktemp -d)"
corepack pnpm dev                       # http://127.0.0.1:7420，修改原始碼自動重啟
curl -s http://127.0.0.1:7420/health
cat "$CREATORHUB_HOME/data/api-token"   # 自動產生的 API 權杖
```

API 文件：<http://127.0.0.1:7420/docs>。

### 啟動 Mac App（Electron）

先照上一節啟動服務，再在另一個終端機用**同一個** `CREATORHUB_HOME`：

```sh
export CREATORHUB_HOME=<與服務相同的臨時目錄>
corepack pnpm --filter @qiu-creator/mac dev     # Vite 5180 + Electron
```

App 只透過 HTTP API 連 `127.0.0.1:7420`；服務沒開時顯示「服務未運行」，可按重試。關閉視窗或結束 App 不會停止服務。

### creatorhub CLI

```sh
export CREATORHUB_TOKEN="$(cat "$CREATORHUB_HOME/data/api-token")"
node packages/agent-sdk/bin/creatorhub.js works create --title "第一篇" --file ./note.md
node packages/agent-sdk/bin/creatorhub.js works list
node packages/agent-sdk/bin/creatorhub.js import url https://example.com/clip.mp4 --wait
node packages/agent-sdk/bin/creatorhub.js jobs get <job-id>
```

給外部 Agent 用時，請用主權杖建立權限受限、可撤銷的 Agent 權杖（`POST /api/v1/tokens`，`scopes` 為 `read`／`import`／`write`），不要把主權杖交給 Agent。Agent 權杖建立作品或匯入 URL 時必須帶 `Idempotency-Key`；CLI 預設每次產生新的鍵，要安全重試時用 `--idempotency-key` 指定同一個鍵。

### 檢查

```sh
corepack pnpm -r typecheck
corepack pnpm -r lint
corepack pnpm -r test
corepack pnpm format:check
```

## 文件

- [AGENTS.md](AGENTS.md)：倉庫規則與任務路由
- [docs/architecture.md](docs/architecture.md)：拓撲、目錄、資料流
- [docs/dependencies.md](docs/dependencies.md)：依賴、授權與選型理由
- [deploy/launchd/README.md](deploy/launchd/README.md)：常駐服務範本（只在發版時安裝）
