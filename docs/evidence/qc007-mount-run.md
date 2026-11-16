# QC-007 實機驗證紀錄：外部資料夾掛載與監控

- 日期：2026-11-16 15:43 PST；分支 `feat/qc007-external-folders`；Node v24.14.0；macOS 27.0.1
- 啟動：`node --import tsx src/main.ts`（正式啟動方式），監聽 `127.0.0.1:7420`；**監控用原生後端（macOS FSEvents）**、寫入穩定時間 2 秒（預設值）。
- 全部使用臨時資料夾：`<home>` = 臨時 `CREATORHUB_HOME`，`<notes>` = 模擬使用者的筆記資料夾，`<outside>` = 掛載範圍外的資料夾。沒有碰 `~/CreatorHub` 或任何真實資料夾。權杖以 `<token>` 代替。

### 1. 掛載前的筆記資料夾

```console
$ find <notes>（含隱藏檔、node_modules、純文字檔、指向外部的符號連結）
./.obsidian/workspace.md 8e9e5e78e1b729ba
./node_modules/pkg/README.md e280c1627d305de4
./todo.txt c30a92f9ef889c07
./外部資料夾 -> link
./捷徑.md -> link
./旅行/京都/紅葉.md cf68daff392ede9d
./隨手記.markdown cd4d633695d6e763
```

### 2. 不安全的掛載路徑一律拒絕

```console
$ POST /api/v1/mounts 各種路徑
notes/relative                                   → 400 mount_rejected - path must be an absolute folder path
/                                                → 400 mount_rejected - the filesystem root cannot be mounted
/Users/feature                                   → 400 mount_rejected - mount a specific folder, not the whole home folder
<home>        → 400 mount_rejected - folders inside or containing the CreatorHub data folder cannot be mounted
<home>/library → 400 mount_rejected - folders inside or containing the CreatorHub data folder cannot be mounted
/private/tmp/claude-501                          → 400 mount_rejected - folders inside or containing the CreatorHub data folder cannot be mounted
<notes>/../qc007-home.Gb1gTi → 400 mount_rejected - folders inside or containing the CreatorHub data folder cannot be mounted
/no/such/folder                                  → 400 mount_rejected - path is not a readable folder
<notes>/todo.txt → 400 mount_rejected - path is not a readable folder
```

### 3. 掛載筆記資料夾 → 背景掃描建立索引

（掃描完成：0.0 秒）
```console
$ curl -s http://127.0.0.1:7420/api/v1/mounts/c9a25b22-efa9-400c-968e-cab01de7df2f
{
 "name": "我的筆記",
 "root_path": "<notes>",
 "status": "active",
 "work_count": 2
}
```
```console
$ curl -s http://127.0.0.1:7420/api/v1/works | 外部作品
隨手記.markdown           | 隨手記        | external present
旅行/京都/紅葉.md            | 京都秋天       | external present
```
```console
$ curl -s 'http://127.0.0.1:7420/api/v1/works?q=紅葉比往年'
total 1 [ '京都秋天' ]
```
符號連結 `捷徑.md` 與 `外部資料夾/` 沒有被跟隨；`.obsidian`、`node_modules`、`todo.txt` 沒有被索引。
掃描後重新計算整個資料夾的雜湊：**與掛載前完全相同**。

### 4. 寫一半的檔案不會被索引

寫入第一段 → 0.8 秒後追加第二段 → 再 0.8 秒時查詢：
```console
$ curl -s http://127.0.0.1:7420/api/v1/works | 有沒有 草稿.md
尚未索引（檔案仍在變化）
```
（最後一次寫入後到出現在作品庫：2.2 秒）
```console
$ curl -s http://127.0.0.1:7420/api/v1/works/<草稿> 與版本數
"# 新草稿\n\n第一段\n\n第二段\n\n完。\n"
revisions: create
```

### 5. 外部編輯器修改 → external revision

（外部修改被記錄：0.0 秒）
```console
$ curl -s http://127.0.0.1:7420/api/v1/works/<紅葉>/revisions
external ← create
```

### 6. App 寫回外部檔案：先核對 revision、留快照、原子替換、保留權限，且不回授

```console
$ curl -s -X PATCH http://127.0.0.1:7420/api/v1/works/<紅葉> -d '{"base_revision":"<目前>","markdown":"…App 修改…"}' -w ' HTTP %{http_code}'
HTTP 200
```
```console
$ cat <notes>/旅行/京都/紅葉.md; stat -f '%Sp' …; ls -A <notes>/旅行/京都
# 京都秋天

（由 CreatorHub 修改）
mode -rw-------
紅葉.md
```
```console
$ （等 4 秒，讓監控看到這次寫入）curl -s .../revisions
edit ← external ← create
```
最新一筆是 `edit`，沒有因為自己的寫入多出 `external`。
```console
$ 用舊的 base_revision 再改一次 → 409，檔案不動
{"error":{"code":"revision_conflict","message":"work was changed since base_revision; reload and merge before saving"}} HTTP 409
# 京都秋天

（由 CreatorHub 修改）
```

### 7. 改名：同一作品跟著走，不產生重複

（改名被追上：2.1 秒）
```console
$ curl -s http://127.0.0.1:7420/api/v1/works | 路徑與狀態
76151245 每日隨手記.markdown         present
05117108 旅行/京都/紅葉.md            present
4072bf1a 草稿.md                  present
```

### 8. 刪除：只標記 missing，保留內容與歷史，拒絕寫入；檔案回來就恢復

（刪除被標記：0.0 秒）
```console
$ curl -s http://127.0.0.1:7420/api/v1/works/<草稿>
state: missing | markdown: "# 新草稿\n\n第一段\n\n第二段\n\n完。\n"
revisions: 1
```
```console
$ PATCH 遺失的外部作品
{"error":{"code":"source_missing","message":"the external file is missing or its folder is not mounted; nothing was written","details":{"external_state":"missing","path":"草稿.md"}}} HTTP 409
0
```
（檔案放回原處後恢復：0.0 秒）

### 9. 卸載與重新掛載

```console
$ curl -s -X DELETE http://127.0.0.1:7420/api/v1/mounts/c9a25b22-efa9-400c-968e-cab01de7df2f
removed 3 works
unmounted,unmounted,unmounted
```
```console
$ ls <notes>（卸載不動檔案）
.obsidian
node_modules
todo.txt
外部資料夾
捷徑.md
旅行
每日隨手記.markdown
草稿.md
```
```console
$ 重新掛載同一資料夾
same mount id: true
```
（重新掃描後恢復 present：0.0 秒）

### 10. creatorhub CLI

```console
$ creatorhub mounts list
c9a25b22-efa9-400c-968e-cab01de7df2f	active	3 works	<notes>
```

### 11. SSE 收到的事件

```text
   5 work.source_restored
   5 work.source_missing
   3 work.created
   1 work.updated
   1 work.external_revision
---
work.source_missing {"path":"隨手記.markdown"}
work.source_restored {"from":"隨手記.markdown","to":"每日隨手記.markdown","reason":"moved"}
work.source_missing {"path":"草稿.md"}
work.source_restored {"path":"草稿.md"}
work.source_missing {"state":"unmounted"}
work.source_missing {"state":"unmounted"}
work.source_missing {"state":"unmounted"}
work.source_restored {"path":"旅行/京都/紅葉.md"}
work.source_restored {"path":"每日隨手記.markdown"}
work.source_restored {"path":"草稿.md"}
```

### 12. 收尾

- 資料夾中只有本次測試自己改過的 `紅葉.md`、改名的 `每日隨手記.markdown` 與重建的 `草稿.md` 有變化；符號連結與被忽略的檔案原封不動：
```text
6,7c6,8
< ./旅行/京都/紅葉.md cf68daff392ede9d
< ./隨手記.markdown cd4d633695d6e763
---
> ./旅行/京都/紅葉.md 33b9f7465f1b361d
> ./每日隨手記.markdown cd4d633695d6e763
> ./草稿.md 57ddbfa52ef88cca
```
- 埠 7420：已釋放
- 伺服器日誌 error／fatal 筆數：0
- 臨時資料夾（home、筆記、外部）與日誌：已刪除

### 備註

- **時間怎麼讀**：第 4、7 步的 2.2／2.1 秒是監控（FSEvents＋2 秒寫入穩定時間）實際反應的時間。第 5、8 步顯示 0.0 秒，是因為讀取作品時本身就會與磁碟對帳（`GET /works/:id`、`/revisions`），所以查詢當下就看到變化；監控隨後收到同一變化時內容雜湊相同，不會重複記錄（第 11 步 `work.external_revision` 只有 1 筆）。
- 第 11 步 `work.source_missing {"state":"unmounted"}` ×3 是卸載時三個作品的狀態通知；重新掛載後的 `work.source_restored` ×3 是重掃恢復。
- 自動測試（`test/mounts.test.ts`，13 項）用 chokidar 的 polling 後端：在多個測試檔並行時，FSEvents 曾延遲 12–14 秒才送達事件，polling 讓測試結果穩定；原生後端由本紀錄驗證。正式環境另有每 10 分鐘與啟動時的完整重掃作為保險。
