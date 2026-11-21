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

### 第二次嘗試（同日，總監確認 7431 的測試實例已結束後）：同樣失敗

- 升級前確認：7431 沒有人在監聽；安裝資料夾下只有 launchd 的 7420 服務（pid 3419）。
- `upgrade --yes`：備份 `20261119T140716697Z-manual` 成功 → `launchctl bootstrap` 再次 `5: Input/output error` → 自動回滾到 0.1.0，exit 1。結果與第一次完全相同，所以**第一次失敗與 7431 的測試實例無關**。依「失敗並回滾就停下」沒有第三次。
- 回滾後：`/health` 回舊版 733350c，launchd running（pid 18346），`server.prev` 不在、`app.prev/` 為空；遷移 0012 沒套用。

### 原因：已由 launchd 日誌證實（第一次嘗試，06:05:21）

`log show` 的 launchd 記錄：

```
06:05:21.784 [gui/501/com.qiu-creator.mac-server [54518]] bootout initiated by: launchctl…
06:05:21.784 signaled service: Terminated: 15 / scheduling cleanup in 5 sec
06:05:21.795 bootout initiated by: launchctl…   ← 失敗後回滾流程的 bootout
06:05:21.795 service already stopped
06:05:21.807 exited due to exit(0), ran for 2051155ms → job state = removed
```

`launchctl bootout` 在送出 SIGTERM 後就回傳；服務要等行程結束（約 20 ms 後，這次 `exit(0)`）才真正從 launchd 移除。`ops.ts` 在 `bootout` 後立刻 `bootstrap`，落在這段空窗，所以回 EIO。第二次嘗試是同一個競態。回滾路徑成功，是因為它在 `bootstrap` 失敗之後才執行，此時服務已移除。

建議修法（交總監決定，屬 `packages/installer`）：`bootout` 後輪詢 `launchctl print gui/<uid>/<label>` 直到回非 0（有上限），再 `bootstrap`；`bootstrap` 遇到 5 時短暫重試。QC-032 的測試用假 launchctl 沒有這段延遲，要補一個「bootout 後 N 次 print 仍存在」的假 launchctl 測試。

## 升級到 bf3aaf8（2026-11-19）：成功

總監轉述使用者「Upgrade now」；QC-036 修好 `bootout` 後的競態（等 launchd 真的移除服務才 `bootstrap`）後重跑同一個升級。

- 建置：乾淨 worktree，bf3aaf8，`git status` 為空；服務 commit `bf3aaf8503a349acb518a5b60bdd769b4c8af942`（不帶 `-dirty`），built_at `2026-11-19T14:15:51.053Z`；.app ad-hoc 簽名驗證通過。安裝器用的是這個 worktree 裡含修正的版本。
- 升級前檢查（2026-11-19 06:16:34）：`lsof -nP -iTCP:7431 -sTCP:LISTEN` 0 筆；安裝資料夾下只有 launchd 的服務（pid 18346）。
- 乾跑：備份 → 暫存 → 停服務換位 → `bootstrap`，`nothing was changed`。
- `upgrade --yes`（06:16:39 → 06:16:43，約 4 秒）輸出：

```
backup 20261119T141639416Z-manual ok
stage new service and app
stop service and swap in the new build
launchctl bootstrap
upgraded 0.1.0 -> 0.1.0; previous build kept as server.prev; backup 20261119T141639416Z-manual
```

exit 0。升級前備份 id：**`20261119T141639416Z-manual`**（`~/CreatorHub/backups/` 有 `.json` 與 `.sqlite`）。

### 驗證

| 項目 | 結果 |
| --- | --- |
| `/health` | commit `bf3aaf8503a349acb518a5b60bdd769b4c8af942`，built_at `2026-11-19T14:15:51.053Z` |
| launchd | `state = running`，pid 58322 |
| 遷移 0012 | 已套用：`schema_migrations` 最新一列 `0012｜new_api_provider｜…｜2026-11-19T14:16:43.452Z`（以唯讀 `sqlite3 -readonly` 只查這張遷移表；沒讀權杖、沒讀使用者內容） |
| `server.prev` | 在，build-info commit `733350c`（舊版） |
| `app.prev/qiu-creator.app` | 在 |
| 日誌 | 沒有錯誤；服務正常處理請求 |
| /Applications 的 .app | `codesign` Identifier `com.qiu-creator.app`；使用者的 App 行程（1 個）沒有被我關閉或重開 |

### bootout 後有等待服務移除再 bootstrap（launchd 日誌）

```
06:16:39.669 bootout initiated by: launchctl…
06:16:39.684 exited due to exit(0) → job state = removed   (服務在 15 ms 後才真的移除)
06:16:39.783 launching: speculative                          (bootstrap 在移除之後約 100 ms，即輪詢間隔)
```

與第一次失敗（`bootstrap` 落在移除之前，EIO）對照：這次 `bootstrap` 發生在 `removed` 之後。

### 提醒

使用者的 App 是舊版的行程（升級換掉了 /Applications 裡的 .app，服務重啟過，連線會暫時中斷）。請使用者**自行關閉並重新開啟** qiu-creator 以載入新版；重新開啟後介面應顯示與 New API 中轉站相關的新設定。（後半句是依發版內容的預期，沒有開 App 驗證。）

## 升級到 47bfc32（2026-11-19，UI 批次 QC-037～QC-041）：成功

總監轉述使用者「你做好就發版並安裝」。本版含遷移 0013（QC-037，`asset_metadata_trash`）。

- 建置：乾淨 worktree，47bfc32，`git status` 為空；服務 commit `47bfc329772eab20c5981c4ba73ca8439aa5e00a`（不帶 `-dirty`），built_at `2026-11-20T00:40:39.601Z`，220 MB；.app 261 MB，ad-hoc 簽名驗證通過。
- 升級前檢查（16:40:31，另於 16:41:28 再查 7431）：7420 只有 launchd 的服務（pid 62355）；7431 沒有監聽；`/health` 為 bf3aaf8；唯讀查 `schema_migrations` 最新為 `0012｜new_api_provider`；`~/CreatorHub/backups/` 有最新備份 `20261119T142939218Z-manual`。
- 乾跑（16:41:28）：備份 → 暫存 → 停服務換位 → `bootstrap`，`nothing was changed`。
- `upgrade --yes`（16:41:30 → 16:41:32，約 2 秒）輸出：

```
backup 20261120T004130225Z-manual ok
stage new service and app
stop service and swap in the new build
launchctl bootstrap
upgraded 0.1.0 -> 0.1.0; previous build kept as server.prev; backup 20261120T004130225Z-manual
```

exit 0。升級前備份 id：**`20261120T004130225Z-manual`**（`.json`＋`.sqlite` 都在）。

### 驗證

| 項目 | 結果 |
| --- | --- |
| `/health` | `{"status":"ok","version":"0.1.0","commit":"47bfc329772eab20c5981c4ba73ca8439aa5e00a","built_at":"2026-11-20T00:40:39.601Z"}` |
| launchd | `state = running`，pid 87044 |
| 資料庫 schema | 最新一列 `0013｜asset_metadata_trash`（唯讀只查遷移表；沒讀權杖與使用者內容） |
| `server.prev` | 在，commit `bf3aaf8`（上一版） |
| `app.prev/qiu-creator.app` | 在 |
| 日誌 | 最近 4000 行沒有 error 等級（level 50）記錄 |
| 使用者的 App | 沒有被關閉或重開（行程還在） |

### 提醒

使用者的 App 仍是舊版行程，服務重啟時連線暫時中斷，/Applications 已是新版 .app：請**自行關閉並重新開啟** qiu-creator。沒有開 App 驗證 QC-037～QC-041 的介面。若新版有問題：`deploy/qc.sh rollback --yes`；回滾後舊版（0012）能否讀 0013 的資料庫未驗證，必要時從上面的升級前備份還原。

## 升級到 8355149（2026-11-21，介面語言 QC-042）：成功

總監轉述使用者「做好就直接發版安裝」（`docs/decisions.md` 2026-11-21）。

- 建置：乾淨 worktree，8355149，`git status` 為空；服務 commit `8355149c4d8e202303ee08ba79033da7f8358081`（不帶 `-dirty`）；.app ad-hoc 簽名 `codesign --verify --deep --strict` 通過。
  - 第一次建置時 PATH 沒有 pnpm（暫存的 shim 已被清掉），install 與 build 都沒跑；重建 shim 後重跑。打包完成前我用 `codesign --verify` 查過一次，得到 "code has no resources but signature indicates they must be present"：那是 electron-builder 還在簽名中途，等它結束後再驗就通過。
- 升級前檢查（2026-11-21 06:37:24；06:40:42 再查）：7420 只有 launchd 的服務（pid 884）；7431 沒有監聽；`/health` 為 47bfc32；最新備份 `20261121T141716735Z-daily`；schema 最新 `0013`；`preferences.json` **不存在**。
- 乾跑（06:40:42）：備份 → 暫存 → 停服務換位 → `bootstrap`，`nothing was changed`。
- `upgrade --yes`（06:40:50 → 06:41:26，約 36 秒；前幾次約 2～4 秒，這次較久，原因未查）輸出：

```
backup 20261121T144052039Z-manual ok
stage new service and app
stop service and swap in the new build
launchctl bootstrap
upgraded 0.1.0 -> 0.1.0; previous build kept as server.prev; backup 20261121T144052039Z-manual
```

exit 0。升級前備份 id：**`20261121T144052039Z-manual`**。

### 驗證

| 項目 | 結果 |
| --- | --- |
| `/health` | commit `8355149c4d8e202303ee08ba79033da7f8358081`，built_at `2026-11-21T14:38:54.323Z` |
| launchd | `state = running`，pid 38265 |
| schema | 最新仍為 `0013｜asset_metadata_trash`（本版沒有新遷移；唯讀只查遷移表） |
| `server.prev` | 在，commit `47bfc32`（上一版） |
| `app.prev/qiu-creator.app` | 在 |
| 日誌 | `level":50`（error）0 筆 |

### QC-042 的兩項檢查

- **打包內容**：`app.asar` 解開後只有 `dist/`、`dist-electron/`、`package.json`。`packages/i18n` 是 vite 內聯進渲染層的工作區套件，**不會**有獨立資料夾；實際確認方式是 `dist/assets/index-*.js` 內含 `zh-Hant` 與 `zh-Hans` 的字串（`packages/i18n/src` 的三種語言為 `en`、`zh-Hans`、`zh-Hant`）。我沒有逐條核對英文詞條，也沒有開 App 看介面。
- **偏好設定遷移**：`~/Library/Application Support/qiu-creator/preferences.json` 升級前不存在，升級後**仍不存在**，因為新版 App 還沒跑過：**awaiting user reopen**。目前沒有任何 qiu-creator App 行程在執行（使用者的 App 已關閉）。使用者重新開啟後，該檔的 `language` 預期為 `zh-Hant`；本會話只會檢查 `language` 這一個鍵，不開、不關使用者的 App。

### 提醒

/Applications 已是新版 .app，請使用者重新開啟 qiu-creator。若有問題：`deploy/qc.sh rollback --yes`（舊版仍是 schema 0013，沒有新遷移，風險較低）。

> **總監更正（2026-11-21 06:45）**：上面查的 `~/Library/Application Support/qiu-creator/` 是服務安裝目錄，不是 App 的 userData。App 的偏好檔實際在 `~/Library/Application Support/@qiu-creator/mac/preferences.json`。06:45 只讀了鍵名與 `language`：鍵為 `language`、`theme`，`language` 為 `zh-Hans`，檔案修改時間 06:43:21；此時使用者已從 /Applications 重開新版（pid 46004）。檔案原本就有 `theme`，表示是舊安裝。`zh-Hans` 應是使用者重開後自己在設定選的；若不是，代表遷移有誤，待使用者確認。

> **使用者確認（2026-11-21）**：`zh-Hans` 是使用者重開後自己在設定選的。升級遷移沒有問題。
