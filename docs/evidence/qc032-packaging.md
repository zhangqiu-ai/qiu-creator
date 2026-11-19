# QC-032 打包與安裝腳本 證據

日期 2026-11-18，分支 `release/qc032-packaging`（基底 origin/main f5f3656）。

## 交付

| 項目 | 位置 |
| --- | --- |
| electron-builder 設定 | `apps/mac/electron-builder.yml`；`pnpm --filter @qiu-creator/mac package` 產出 `apps/mac/release/mac-arm64/qiu-creator.app`（`release/` 已加入 .gitignore） |
| 安裝器（純函式＋流程） | `packages/installer/src/{lib,ops,cli}.ts`，入口 `deploy/qc.sh <install\|upgrade\|rollback\|uninstall>` |
| plist 範本 | `deploy/launchd/com.qiu-creator.mac-server.plist` 新增 `__PORT__` 佔位符 |
| 操作說明 | `deploy/launchd/README.md`「安裝、升級、回滾」 |
| 依賴記錄 | `docs/dependencies.md`「打包：electron-builder」 |

## 設計取捨

- 沒加 `--yes` 一律乾跑；只有 `--home` 是真實 HOME 才碰 launchd，其他 HOME 只複製檔案（測試與乾跑安全）。
- 升級：備份（201＋`integrity: ok`）→ 暫存新版 → 換位保留 `server.prev`、`app.prev/` → `bootstrap` → `/health` 必須回報新版的 version、commit、built_at；失敗自動回滾。備份失敗、沒有權杖、服務沒回應都在改動任何東西之前中止。
- `rollback` 是 current／prev 互換，再跑一次換回新版。
- 安裝前檢查：埠被佔用、launchd 已載入、plist／server／.app 已存在、建置產物缺檔，各給明確訊息，不覆蓋。
- 解除安裝不刪 `~/CreatorHub`，也不刪日誌。
- `.app` 用 ad-hoc 簽名（`identity: '-'`）。第一次試打包用 `identity: null`：`codesign --verify --deep --strict` 失敗（"code has no resources but signature indicates they must be present"），Apple Silicon 無法啟動；改 ad-hoc 後通過。

## 試打包結果（全部在 `/private/tmp/claude-501` 臨時目錄，已刪）

| 項目 | 結果 |
| --- | --- |
| `qiu-creator.app` | 262 MB（Electron 45.3.2 arm64；`app.asar` 不含 node_modules） |
| `codesign --verify --deep --strict` | 通過；`Signature=adhoc`，`Identifier=com.qiu-creator.app` |
| `spctl -a` | rejected（預期：沒有 Developer ID、沒公證） |
| 啟動 .app（臨時 `CREATORHUB_HOME`、埠 7498） | 6 秒後仍在執行、出現視窗「qiu-creator」，日誌沒有錯誤；已關閉 |
| 服務建置（`build --out` 臨時目錄） | 220 MB（其中 `bin/node` 128 MB、`node_modules` 63 MB）；`ditto` 複製後的安裝資料夾 `du` 為 199 MB（差異原因未查） |
| 臨時 HOME 真跑 `qc.sh install --yes` | 檔案、plist（`plutil -lint` OK，含 `7499`）、.app 就位；launchd 依規則略過；手動以 `bin/node server.mjs` 啟動後 `/health` 回報剛裝的版本，install 結束 exit 0 |
| 臨時 HOME 真跑 `upgrade --yes` | 對真實打包服務呼叫備份 API 成功（`…-manual` 備份檔存在）→ 換位 → 新 built_at 通過 → exit 0；`server.prev`、`app.prev` 在 |
| `rollback --yes` | built_at 換回上一版 |
| `uninstall --yes` | plist、server*、app、`app.prev` 清掉；`CreatorHub/works/a.md`、備份、日誌都還在 |
| 乾跑 | 只印計畫，不改任何東西 |

建置的 `commit` 帶 `-dirty`（當時工作目錄有未提交修改）；正式發版要從乾淨 worktree 建置。

## 驗證數字

- `pnpm -r typecheck`：通過（0 錯誤）。
- `pnpm lint`：通過（0 問題）。
- `pnpm format:check`：通過。
- 全倉測試（`qc-fullsuite.lock`，起跑負載 4.57，結束 6.31，遠低於 15）：**649 passed／0 failed／649 total**（含新套件 `packages/installer` 32 個：純函式 `lib.test.ts` 與用臨時 HOME、假 launchctl、假服務跑完整流程的 `ops.test.ts`，涵蓋安裝前檢查、備份失敗中止、自動回滾、手動回滾來回、解除安裝保留資料）。

## NOT_VERIFIED

- 真實 `launchctl bootstrap`／`bootout`（對使用者網域）：沒有執行，只用假 launchctl 與跳過 launchd 的臨時 HOME 驗證；開機自啟與崩潰重啟留給 QC-033。
- 安裝到真實 `/Applications` 與真實 `~/Library/Application Support/qiu-creator`、碰真實 `~/CreatorHub`：沒做，需使用者另行確認。
- 以安裝後 .app 連上由 launchd 管理的服務的整合畫面：沒做（只確認 .app 能啟動、視窗出現）。
- 從網路下載的 .app 被 Gatekeeper 阻擋的行為：只在文件說明，沒實測。
- 沒做 dmg、公證、自動更新（範圍外）。
- 新版若遷移過資料庫導致舊版讀不了的回滾情境：只寫入說明（從升級前備份還原），沒有實測。

## 範圍外發現

- 服務建置產物 220 MB，比派工時說的約 110 MB 大，主要是 `bin/node`（128 MB）；是否要用較小的 Node 版本留給總監決定。
- `pnpm test`／`pnpm -r` 在沒有 pnpm 在 PATH 的環境會 exit 127（用 `corepack pnpm` 呼叫時子行程找不到 pnpm）；本會話以 `corepack enable --install-directory` 放進臨時 PATH 解決，不改倉庫。
