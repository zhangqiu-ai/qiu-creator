# QC-033 真實安裝 證據

日期 2026-11-19。使用者同意本機真實安裝（總監轉述原話「Approve install」）。範圍只有安裝；重開機、`kill -9`、備份還原演練由 qc-test 接手。

## 建置

- 乾淨 worktree，origin/main `733350c`，`git status` 為空；`pnpm install --frozen-lockfile`。
- 服務建置 `services/mac-server/dist`：220 MB，`build-info.json` 的 commit 為 `733350cc28d680d1549e648629c8ae109aa9db19`（**不帶 `-dirty`**），built_at `2026-11-19T13:08:04.938Z`。
- `qiu-creator.app`：261 MB，ad-hoc 簽名，`codesign --verify --deep --strict` 通過。
- 注意：第一次在這個 worktree 跑 `pnpm package` 時，electron-builder 卡了 6 分鐘以上沒有輸出（無子行程），砍掉後單獨重跑 `electron-builder` 約 20 秒完成。原因未查；詳細日誌顯示它在簽名前會用 `security` 列出鑰匙圈裡的簽章身分（本次設定是 ad-hoc，不使用它們）。列為觀察，沒有修。

## 乾跑與安裝

`deploy/qc.sh install`（乾跑）輸出四個步驟：複製服務到 `~/Library/Application Support/qiu-creator/server`、複製 .app 到 `/Applications/qiu-creator.app`、寫入 `~/Library/LaunchAgents/com.qiu-creator.mac-server.plist`、`launchctl bootstrap`；最後 `dry run finished; nothing was changed`。

`deploy/qc.sh install --yes` 輸出：

```
copy service 0.1.0 (733350cc28d680d1549e648629c8ae109aa9db19) -> …/server
copy app -> /Applications/qiu-creator.app
write …/LaunchAgents/com.qiu-creator.mac-server.plist
launchctl bootstrap
installed 0.1.0; /health ok
```

exit 0。安裝前檢查（埠 7420 空、無 plist、無 /Applications/qiu-creator.app、`~/CreatorHub` 不存在）都通過。

## 驗證

| 項目 | 結果 |
| --- | --- |
| `launchctl print gui/501/com.qiu-creator.mac-server` | `state = running`，`runs = 1`，`last exit code = (never exited)`，`properties = keepalive \| runatload`，program 是安裝資料夾裡的 `bin/node` |
| `/health` | `{"status":"ok","version":"0.1.0","commit":"733350cc28d680d1549e648629c8ae109aa9db19","built_at":"2026-11-19T13:08:04.938Z"}`，與建置一致 |
| plist | `plutil -lint` OK |
| 日誌 | `~/Library/Logs/qiu-creator/mac-server.log`（0600，JSON 行）有內容，`mac-server.err.log` 為 0 位元組 |
| `~/CreatorHub` | 服務第一次啟動自建 `cache/`、`data/`、`library/`；`data/api-token` 權限 0600（內容沒有讀出） |
| `/Applications/qiu-creator.app` | `codesign` 驗證通過；以 `open` 開啟後行程在執行 |
| App 連上服務 | 開啟後服務日誌出現 App 的請求：`/api/v1/events`、`/mounts`、`/works`、`/jobs` 等，全部 200（`/api/v1/*` 需要權杖，所以是帶權杖的真實連線） |

## 後續活動（不是本會話做的）

安裝與開啟 App 之後，服務日誌還出現我沒有發出的請求：建立作品（201）、上傳素材（201）、草稿（201）、`/ai/*`、`/backups`、`/tokens` 的讀取。推測是使用者或 qc-test 在使用 App。本會話沒有碰 `~/CreatorHub` 內容，也沒有發 AI 請求；這些資料不要當成乾淨安裝狀態。

## NOT_VERIFIED

- **截圖**：`screencapture` 回 `could not create image from display`（沒有螢幕錄製權限），computer-use 授權沒有取得；改以服務日誌證明 App 連線。沒有 App 視窗截圖。
- 以 App 介面確認「服務未運行」提示在服務停止時的行為、開機自啟、崩潰重啟、合蓋：留給 qc-test／QC-033。
- Gatekeeper 對網路下載複本的行為。

## 收尾

- 臨時 worktree 與建置產物已刪；服務保持由 launchd 執行，沒有卸載。
- App 視窗：**沒有關閉**。開啟後有人在使用它（見上），關閉可能丟失未存的編輯；請總監或使用者決定。

## 升級到 e8aefb1（2026-11-19）：失敗，已自動回滾

使用者要求升級（總監轉述原話「Upgrade now」）。新版含 QC-035 與資料庫遷移 0012。

- 建置：乾淨 worktree，e8aefb1，`git status` 為空；服務 commit `e8aefb182bbcd1cb814a48070ebe4b5fc1d2e202`（不帶 `-dirty`），built_at `2026-11-19T14:04:28.724Z`；.app ad-hoc 簽名驗證通過。
- 乾跑 `deploy/qc.sh upgrade`：備份 → 暫存 → 停服務換位 → `bootstrap`，`nothing was changed`。
- `deploy/qc.sh upgrade --yes` 輸出：

```
backup 20261119T140521518Z-manual ok
stage new service and app
stop service and swap in the new build
launchctl bootstrap
upgrade failed: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error
…; rolling back
升級失敗，已回到 0.1.0。升級前備份：20261119T140521518Z-manual。
```

exit 1。依總監指示，失敗並自動回滾後**沒有再試一次**。

### 回滾後狀態（唯讀檢查）

| 項目 | 結果 |
| --- | --- |
| `/health` | 舊版：commit `733350cc28d680d1549e648629c8ae109aa9db19`，built_at `2026-11-19T13:08:04.938Z`，服務可用 |
| launchd | `state = running`（pid 3419），keepalive |
| 安裝資料夾 | `server/` 與（空的）`app.prev/`；`server.prev` 已按設計清掉 |
| 升級前備份 | `20261119T140521518Z-manual`（`~/CreatorHub/backups/` 有 `.json` 與 `.sqlite`），`integrity: ok`（升級才會繼續） |
| 遷移 0012 | **沒有套用**：新版從未啟動；日誌沒有遷移記錄；資料庫仍由舊版使用 |
| 權杖、`~/CreatorHub` 內容 | 沒有讀出、沒有改動 |

### 觀察（未驗證的推測）

`launchctl bootstrap` 回 `5: Input/output error`，發生在 `bootout` 之後立刻 `bootstrap`。macOS 上這常見於服務還在被卸載時搶著重新載入。安裝器 `ops.ts` 的 `bootout` 之後沒有等服務確實消失就 `bootstrap`，也沒有重試；QC-032 的測試用假 launchctl，不會出現這個競態。**這是推測，沒有重現、沒有抓到更多錯誤訊息**（launchctl 提示「用 root 才有更多錯誤資訊」）。若要修，屬於 `packages/installer` 的缺陷，交回總監。

### 提醒

- 使用者的 App 沒有被我關閉或重開；升級已回滾，/Applications 裡是舊版 .app。
- 升級前備份 `20261119T140521518Z-manual` 已存在，不影響任何資料。
