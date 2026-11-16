# QC-001 實機驗證紀錄：curl 主鏈路

- 日期：2026-11-16 06:32 PST
- 分支：`chore/qc001-monorepo-skeleton`；Node v24.14.0
- 啟動方式：`node --import tsx src/main.ts`（與 launchd 範本相同的命令），`CREATORHUB_HOME` 為臨時目錄 `/private/tmp/claude-501/qc001-home.LhxAxP`，監聽 `127.0.0.1:7420`
- 權杖：服務自動產生於 `$CREATORHUB_HOME/data/api-token`（權限 600），下方輸出以 `<token>` 代替

### 1. 健康檢查（不需權杖）

```console
$ curl -s http://127.0.0.1:7420/health
{"status":"ok","service":"creatorhub-mac-server","version":"0.0.0"}
```

### 2. 沒帶權杖 → 401

```console
$ curl -s -i http://127.0.0.1:7420/api/v1/works
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer
content-type: application/json; charset=utf-8
content-length: 77
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}
```

### 3. 建立作品

```console
$ curl -s -i -X POST http://127.0.0.1:7420/api/v1/works -H 'authorization: Bearer <token>' -H 'content-type: application/json' -d '{"title":"第一篇：京都楓葉","markdown":"# 京都楓葉\n\n第一版正文。\n","tags":["旅行","草稿"],"source":"curl"}'
HTTP/1.1 201 Created
etag: "c9a4e130-479f-4a0d-87d5-376fea1e735d"
content-type: application/json; charset=utf-8
content-length: 378
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"id":"318fe66b-2feb-40f8-9eac-7929336471a3","title":"第一篇：京都楓葉","type":"article","status":"drafting","tags":["旅行","草稿"],"source":"curl","storage_mode":"managed","current_revision_id":"c9a4e130-479f-4a0d-87d5-376fea1e735d","created_at":"2026-11-16T14:32:49.330Z","updated_at":"2026-11-16T14:32:49.330Z","markdown":"# 京都楓葉\n\n第一版正文。\n"}
```
作品 ID `318fe66b-2feb-40f8-9eac-7929336471a3`，revision `c9a4e130-479f-4a0d-87d5-376fea1e735d`。Finder 路徑上的實體檔：
```console
$ ls -la $CREATORHUB_HOME/library/works/318fe66b-2feb-40f8-9eac-7929336471a3 && cat .../source.md
/private/tmp/claude-501/qc001-home.LhxAxP/library/works/318fe66b-2feb-40f8-9eac-7929336471a3:
total 8
drwxr-xr-x@ 5 feature  wheel  160 Nov 16 06:32 .
drwx------@ 3 feature  wheel   96 Nov 16 06:32 ..
drwxr-xr-x@ 2 feature  wheel   64 Nov 16 06:32 assets
drwxr-xr-x@ 3 feature  wheel   96 Nov 16 06:32 revisions
-rw-r--r--@ 1 feature  wheel   35 Nov 16 06:32 source.md

/private/tmp/claude-501/qc001-home.LhxAxP/library/works/318fe66b-2feb-40f8-9eac-7929336471a3/revisions:
total 8
drwxr-xr-x@ 3 feature  wheel   96 Nov 16 06:32 .
drwxr-xr-x@ 5 feature  wheel  160 Nov 16 06:32 ..
-rw-r--r--@ 1 feature  wheel   35 Nov 16 06:32 c9a4e130-479f-4a0d-87d5-376fea1e735d.md
--- source.md
# 京都楓葉

第一版正文。

```

### 4. 讀取作品

```console
$ curl -s -i http://127.0.0.1:7420/api/v1/works/318fe66b-2feb-40f8-9eac-7929336471a3 -H 'authorization: Bearer <token>'
HTTP/1.1 200 OK
etag: "c9a4e130-479f-4a0d-87d5-376fea1e735d"
content-type: application/json; charset=utf-8
content-length: 378
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"id":"318fe66b-2feb-40f8-9eac-7929336471a3","title":"第一篇：京都楓葉","type":"article","status":"drafting","tags":["旅行","草稿"],"source":"curl","storage_mode":"managed","current_revision_id":"c9a4e130-479f-4a0d-87d5-376fea1e735d","created_at":"2026-11-16T14:32:49.330Z","updated_at":"2026-11-16T14:32:49.330Z","markdown":"# 京都楓葉\n\n第一版正文。\n"}
```

### 5. PATCH（base_revision 正確）→ 200，新 revision 與快照

```console
$ curl -s -i -X PATCH http://127.0.0.1:7420/api/v1/works/318fe66b-2feb-40f8-9eac-7929336471a3 -H 'authorization: Bearer <token>' -H 'content-type: application/json' -d '{"base_revision":"c9a4e130-479f-4a0d-87d5-376fea1e735d","markdown":"# 京都楓葉\n\n第二版正文：從 iPhone 修改。\n"}'
HTTP/1.1 200 OK
etag: "2423fdc2-d726-405f-bead-2046eba7d823"
content-type: application/json; charset=utf-8
content-length: 398
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"id":"318fe66b-2feb-40f8-9eac-7929336471a3","title":"第一篇：京都楓葉","type":"article","status":"drafting","tags":["旅行","草稿"],"source":"curl","storage_mode":"managed","current_revision_id":"2423fdc2-d726-405f-bead-2046eba7d823","created_at":"2026-11-16T14:32:49.330Z","updated_at":"2026-11-16T14:32:49.512Z","markdown":"# 京都楓葉\n\n第二版正文：從 iPhone 修改。\n"}
```
```console
$ ls $CREATORHUB_HOME/library/works/318fe66b-2feb-40f8-9eac-7929336471a3/revisions && cat .../source.md
2423fdc2-d726-405f-bead-2046eba7d823.md
c9a4e130-479f-4a0d-87d5-376fea1e735d.md
--- source.md
# 京都楓葉

第二版正文：從 iPhone 修改。

```

### 6. PATCH 用舊 revision → 409，檔案未被覆蓋

```console
$ curl -s -i -X PATCH http://127.0.0.1:7420/api/v1/works/318fe66b-2feb-40f8-9eac-7929336471a3 -H 'authorization: Bearer <token>' -H 'content-type: application/json' -d '{"base_revision":"c9a4e130-479f-4a0d-87d5-376fea1e735d","markdown":"這段不應寫入"}'
HTTP/1.1 409 Conflict
content-type: application/json; charset=utf-8
content-length: 244
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"error":{"code":"revision_conflict","message":"work was changed since base_revision; reload and merge before saving","details":{"current_revision":"2423fdc2-d726-405f-bead-2046eba7d823","base_revision":"c9a4e130-479f-4a0d-87d5-376fea1e735d"}}}
```
```console
$ cat $CREATORHUB_HOME/library/works/318fe66b-2feb-40f8-9eac-7929336471a3/source.md
# 京都楓葉

第二版正文：從 iPhone 修改。

```

### 7. If-Match 舊 ETag → 409；不帶前置條件 → 428

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X PATCH ... -H 'if-match: "c9a4e130-479f-4a0d-87d5-376fea1e735d"' -d '{"title":"x"}'
409

```
```console
$ curl -s -X PATCH ... -d '{"title":"x"}'
{"error":{"code":"precondition_required","message":"base_revision or If-Match is required to edit a work","details":{"current_revision":"2423fdc2-d726-405f-bead-2046eba7d823"}}}
```

### 8. 版本歷史

```console
$ curl -s http://127.0.0.1:7420/api/v1/works/318fe66b-2feb-40f8-9eac-7929336471a3/revisions -H 'authorization: Bearer <token>'
{"items":[{"work_id":"318fe66b-2feb-40f8-9eac-7929336471a3","revision_id":"2423fdc2-d726-405f-bead-2046eba7d823","parent_revision_id":"c9a4e130-479f-4a0d-87d5-376fea1e735d","content_hash":"61acd7bd00c67d1ac6bac59679774c8a13593b35a19403b31429b23e911b937c","created_at":"2026-11-16T14:32:49.512Z","source":"edit"},{"work_id":"318fe66b-2feb-40f8-9eac-7929336471a3","revision_id":"c9a4e130-479f-4a0d-87d5-376fea1e735d","parent_revision_id":null,"content_hash":"37fc446b75cb0548f3858897608f953ed9073c74f0963fd5fb6534153974db00","created_at":"2026-11-16T14:32:49.330Z","source":"create"}]}
```

### 9. 視頻 Range 串流

以開發腳本 `scripts/register-asset.ts` 登記 1 MiB 測試檔為素材 `43037388-ebcc-4e6a-90da-957302a97757`（M1 才有正式上傳／URL 匯入）。
```console
$ curl -s -D - -o /dev/null http://127.0.0.1:7420/api/v1/assets/43037388-ebcc-4e6a-90da-957302a97757/stream -H 'range: bytes=0-1023'
HTTP/1.1 206 Partial Content
accept-ranges: bytes
content-type: video/mp4
content-range: bytes 0-1023/1048576
content-length: 1024
Date: Mon, 16 Nov 2026 14:32:49 GMT
Connection: keep-alive
Keep-Alive: timeout=72


```
```console
$ curl -s -H 'range: bytes=1000-1999' .../stream | wc -c ; 與原檔同區段比對 sha256
1dffd71af81242cb9906ac7ac96fa39a935e7dd6b30423736652d08bc61a1900  -
1dffd71af81242cb9906ac7ac96fa39a935e7dd6b30423736652d08bc61a1900  -
    1000

```
```console
$ curl -s -D - http://127.0.0.1:7420/api/v1/assets/43037388-ebcc-4e6a-90da-957302a97757/stream -H 'range: bytes=2000000-'
HTTP/1.1 416 Range Not Satisfiable
accept-ranges: bytes
content-type: application/json; charset=utf-8
content-range: bytes */1048576
content-length: 90
Date: Mon, 16 Nov 2026 14:32:50 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"error":{"code":"range_not_satisfiable","message":"requested range is outside the file"}}
```
```console
$ curl -s -D - -o /dev/null http://127.0.0.1:7420/api/v1/assets/43037388-ebcc-4e6a-90da-957302a97757/stream   # 不帶 Range
HTTP/1.1 200 OK
accept-ranges: bytes
content-type: video/mp4
content-length: 1048576
Date: Mon, 16 Nov 2026 14:32:50 GMT
Connection: keep-alive
Keep-Alive: timeout=72


```

### 10. creatorhub CLI（走 api-client）

```console
$ CREATORHUB_TOKEN=<token> creatorhub works create --title 'Agent 匯入' --file agent.md --tags ai
created 1ebaa14f-a70e-4c2b-93f6-160bece95dfd revision f705f742-cc7d-433b-9415-99a829f87809

```
```console
$ CREATORHUB_TOKEN=<token> creatorhub works list
1ebaa14f-a70e-4c2b-93f6-160bece95dfd	drafting	2026-11-16T14:32:50.244Z	Agent 匯入
318fe66b-2feb-40f8-9eac-7929336471a3	drafting	2026-11-16T14:32:49.512Z	第一篇：京都楓葉
2 of 2

```
```console
$ creatorhub works list --q 京都楓
318fe66b-2feb-40f8-9eac-7929336471a3	drafting	2026-11-16T14:32:49.512Z	第一篇：京都楓葉
1 of 1

```

### 11. OpenAPI

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/docs/  &&  curl -s http://127.0.0.1:7420/docs/json | 路徑列表
200
3.0.3
GET          /health
POST,GET     /api/v1/works
GET,PATCH    /api/v1/works/{id}
GET          /api/v1/works/{id}/revisions
GET          /api/v1/assets/{id}/stream

```

### 12. 收尾

- 埠 7420：已釋放（`lsof -iTCP:7420 -sTCP:LISTEN` 無結果）
- 伺服器日誌最後幾行：
```
{"level":30,"time":1794839570673,"pid":61858,"hostname":"<redacted>","reqId":"req-m","req":{"method":"GET","url":"/docs/json","host":"127.0.0.1:7420","remoteAddress":"127.0.0.1","remotePort":53133},"msg":"incoming request"}
{"level":30,"time":1794839570683,"pid":61858,"hostname":"<redacted>","reqId":"req-m","res":{"statusCode":200},"responseTime":10.021749999999884,"msg":"request completed"}
{"level":30,"time":1794839570700,"pid":61858,"hostname":"<redacted>","signal":"SIGTERM","msg":"shutting down"}
```
- 臨時目錄 `/private/tmp/claude-501/qc001-home.LhxAxP` 與測試檔：已刪除
