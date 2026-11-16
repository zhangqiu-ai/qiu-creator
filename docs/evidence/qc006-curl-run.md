# QC-006 實機驗證紀錄：URL 匯入、冪等鍵、Agent 權杖

- 日期：2026-11-16 08:20 PST；分支 `feat/qc006-url-import-jobs`；Node v24.14.0
- 伺服器：以實際的 `buildServer` 在 `127.0.0.1:7421` 啟動（7420 正被 QC-002 的開發伺服器使用），`CREATORHUB_HOME` 為臨時目錄。
- **不連外網**：啟動器（未提交的 scratchpad 腳本）注入假 DNS——`files.example.com` → 93.184.216.34、`internal.example.com` → 10.0.0.5、`mixed.example.com` → 93.184.216.34 + 192.168.1.20、`rebind.example.com` 第一次 93.184.216.34 之後 127.0.0.1——並把「已釘住的公網 IP」實際導向本機假上游 `127.0.0.1:7498`。SSRF 檢查照常作用在假 DNS 回傳的位址上。這是測試也在用的 `connectOverride` 接縫；正式程式不設定它。
- 權杖一律以 `<redacted>` 代替。

### 1. 主權杖建立 Agent 權杖（只匯入／只讀），列表只顯示前綴

`POST /api/v1/tokens` 回傳的明文權杖格式：`chk_…`（47 字元，只回傳這一次）。
```console
$ curl -s http://127.0.0.1:7421/api/v1/tokens -H 'authorization: Bearer <owner>'
{"name":"唯讀儀表板","prefix":"chk_6Ec-5Pm5","scopes":["read"],"revoked_at":null}
{"name":"Claude 匯入 Agent","prefix":"chk_XJWo0CQC","scopes":["import"],"revoked_at":null}
```
```console
$ sqlite3 creatorhub.sqlite 'SELECT name, prefix, token_hash FROM api_tokens'
Claude 匯入 Agent chk_XJWo0CQC 1380ac5c4c817441a1767788a770ee4b071e00d821d79986fb63d052ff7d5169
唯讀儀表板 chk_6Ec-5Pm5 056da5ccde979cb377a2c7fec45eba88a358dbc1e6f16090e3888a26fea49233
```

### 2. Agent 匯入 URL：沒帶 Idempotency-Key → 428；帶了 → 202，背景下載成功

```console
$ curl -s -X POST http://127.0.0.1:7421/api/v1/imports/urls -H 'authorization: Bearer <import token>' -d '{"url":"http://files.example.com/pic.png"}' -w '\nHTTP %{http_code}\n'
{"error":{"code":"precondition_required","message":"agent tokens must send an Idempotency-Key header on this endpoint"}}
HTTP 428
```
帶 `Idempotency-Key: agent-run-42-cover` 送出 → 202，任務 `3d48759b-f83a-4142-8153-6dca74d22370`。
```console
$ curl -s http://127.0.0.1:7421/api/v1/jobs/3d48759b-f83a-4142-8153-6dca74d22370 -H 'authorization: Bearer <read token>'
{
 "status": "succeeded",
 "url": "http://files.example.com/pic.png",
 "result_asset_id": "5ec4592d-148a-4b8a-aad8-8d3d0c31c21b",
 "idempotency_key": "agent-run-42-cover",
 "error": null
}
```
```console
$ curl -s http://127.0.0.1:7421/api/v1/assets/5ec4592d-148a-4b8a-aad8-8d3d0c31c21b -H 'authorization: Bearer <read token>'
{"kind":"image","mime_type":"image/png","origin":"url","original_name":"pic.png","bytes":2064,"path":"library/assets/5ec4592d-148a-4b8a-aad8-8d3d0c31c21b/pic.png"}
```

### 3. 冪等重送：同鍵同內容 → 原任務、不重新下載；同鍵不同內容 → 422

```console
$ curl -s -i -X POST .../imports/urls -H 'idempotency-key: agent-run-42-cover' -d '{"url":"http://files.example.com/pic.png"}'
HTTP/1.1 202 Accepted
idempotent-replayed: true
id 3d48759b-f83a-4142-8153-6dca74d22370 status succeeded
```
假上游收到 `/pic.png` 的次數：1（重送兩次都沒有再下載）。
```console
$ curl -s -X POST .../imports/urls -H 'idempotency-key: agent-run-42-cover' -d '{"url":"http://files.example.com/clip.png"}' -w '\nHTTP %{http_code}\n'
{"error":{"code":"idempotency_key_reused","message":"this Idempotency-Key was already used with a different request body"}}
HTTP 422
```
`POST /api/v1/works` 以同一個鍵送兩次：第一次 `404f3b26-165f-43ea-ae6f-4a4f2c2e7af6`，第二次 `404f3b26-165f-43ea-ae6f-4a4f2c2e7af6`；作品總數 1。

### 4. 權限範圍：匯入權杖不能讀、不能改、不能管理權杖；唯讀權杖不能建立

```console
$ 匯入權杖：GET /works、PATCH /works/:id、GET /tokens、GET /events
GET    /api/v1/works                                                → 403
PATCH  /api/v1/works/404f3b26-165f-43ea-ae6f-4a4f2c2e7af6           → 403
GET    /api/v1/tokens                                               → 403
GET    /api/v1/events                                               → 403
```
```console
$ 唯讀權杖：GET /works、POST /works、POST /tokens
GET  /api/v1/works  → 200
POST /api/v1/works  → {"error":{"code":"forbidden","message":"this token lacks the \"import\" permission","details":{"required":"import"}}}
POST /api/v1/tokens → 403
```

### 5. SSRF：送出時就擋下的網址 → 400

```console
$ for url in http://127.0.0.1:7420/... http://[::1]/ http://[::ffff:127.0.0.1]/ http://169.254.169.254/... http://100.100.100.100/ http://10.0.0.1/ http://localhost/ http://user:pw@files.example.com/ ftp://files.example.com/
http://127.0.0.1:7420/api/v1/tokens        → 400 url_rejected - blocked_address
http://[::1]/                              → 400 url_rejected - blocked_address
http://[::ffff:127.0.0.1]/                 → 400 url_rejected - blocked_address
http://169.254.169.254/latest/meta-data/   → 400 url_rejected - blocked_address
http://100.100.100.100/                    → 400 url_rejected - blocked_address
http://10.0.0.1/                           → 400 url_rejected - blocked_address
http://localhost/                          → 400 url_rejected - blocked_address
http://user:pw@files.example.com/x         → 400 url_rejected - url_rejected
ftp://files.example.com/x                  → 400 validation_error - request does not match the schema
```

### 6. SSRF：下載過程中才發現的（DNS、重定向、重綁定）

```text
http://internal.example.com/admin        → failed blocked_address internal.example.com resolves to non-public address 10.0.0.5
http://mixed.example.com/pic.png         → failed blocked_address mixed.example.com resolves to non-public address 192.168.1.20
http://files.example.com/to-loopback     → failed blocked_address address 127.0.0.1 is not publicly routable
http://files.example.com/to-mapped       → failed blocked_address address ::ffff:a9fe:a9fe is not publicly routable
http://rebind.example.com/pic.png        → succeeded  
http://rebind.example.com/pic.png        → failed blocked_address rebind.example.com resolves to non-public address 127.0.0.1
```

啟動器記錄的 DNS 查詢與連線（`connect pinned=` 是實際連線用的、已檢查過的 IP）：
```text
--- import http://internal.example.com/admin
dns internal.example.com -> 10.0.0.5
--- import http://mixed.example.com/pic.png
dns mixed.example.com -> 93.184.216.34,192.168.1.20
--- import http://files.example.com/to-loopback
dns files.example.com -> 93.184.216.34
connect pinned=93.184.216.34 -> local upstream
upstream GET /to-loopback host=files.example.com
--- import http://files.example.com/to-mapped
dns files.example.com -> 93.184.216.34
connect pinned=93.184.216.34 -> local upstream
upstream GET /to-mapped host=files.example.com
--- import http://rebind.example.com/pic.png
dns rebind.example.com -> 93.184.216.34
connect pinned=93.184.216.34 -> local upstream
upstream GET /pic.png host=rebind.example.com
--- import http://rebind.example.com/pic.png
dns rebind.example.com -> 127.0.0.1
```

### 7. 內容類型、大小、逾時都要失敗

```text
http://files.example.com/page          → failed unsupported_content_type | content type text/html; charset=utf-8 is not allowed
http://files.example.com/fake.jpg      → failed unsupported_media_type | file content is application/zip, which is not an allowed media type
http://files.example.com/huge.mp4      → failed payload_too_large | declared size 32212254720 exceeds 21474836480 bytes
http://files.example.com/stall.mp4     → failed timeout | no data from files.example.com in time
```
（`stall.mp4` 送出檔頭後不再送資料：每次 1.5 秒無資料逾時，屬暫時性錯誤，自動重試 3 次後才標成 failed。）

### 8. 失敗後手動重試

```console
$ curl -s http://127.0.0.1:7421/api/v1/jobs/4107387d-a5e7-46ad-951d-2b3d8081c96f   # 上游還沒有這個檔案
failed http_error server answered HTTP 404 retry_count=0
```
讓假上游開始提供 `/later.png` 後重試：
```console
$ curl -s -X POST http://127.0.0.1:7421/api/v1/jobs/4107387d-a5e7-46ad-951d-2b3d8081c96f/retry -w '\nHTTP %{http_code}\n'
HTTP 202 queued retry_count=1
```
```console
$ curl -s http://127.0.0.1:7421/api/v1/jobs/4107387d-a5e7-46ad-951d-2b3d8081c96f
succeeded asset 05968d59-ff37-4f78-8004-7eb634ccaabf retry_count=1
```
```console
$ curl -s -X POST http://127.0.0.1:7421/api/v1/jobs/4107387d-a5e7-46ad-951d-2b3d8081c96f/retry   # 已成功的任務不能重試
{"error":{"code":"job_not_retryable","message":"job is succeeded; only failed jobs can be retried","details":{"status":"succeeded"}}}
HTTP 409
```

### 9. 任務列表與篩選

```console
$ curl -s 'http://127.0.0.1:7421/api/v1/jobs?status=failed' | 每列 id／錯誤碼
total 9
timeout                  http://files.example.com/stall.mp4
payload_too_large        http://files.example.com/huge.mp4
unsupported_media_type   http://files.example.com/fake.jpg
unsupported_content_type http://files.example.com/page
blocked_address          http://rebind.example.com/pic.png
blocked_address          http://files.example.com/to-mapped
blocked_address          http://files.example.com/to-loopback
blocked_address          http://mixed.example.com/pic.png
blocked_address          http://internal.example.com/admin
```

### 10. creatorhub CLI

```console
$ CREATORHUB_TOKEN=<import token> creatorhub import url http://files.example.com/clip.png --wait --idempotency-key cli-demo-0001
job 05e906fb-635e-4a48-ae62-3260fd204836 succeeded asset 77d71e16-3ebe-4689-9562-812a69135407
```
匯入權杖沒有 read 權限，但可以查看自己建立的任務，所以 `--wait` 與 `jobs get` 都能用；別人的任務對它回 404：
```console
$ CREATORHUB_TOKEN=<import token> creatorhub jobs get 05e906fb-635e-4a48-ae62-3260fd204836
job 05e906fb-635e-4a48-ae62-3260fd204836 succeeded asset 77d71e16-3ebe-4689-9562-812a69135407
```
```console
$ CREATORHUB_TOKEN=<import token> creatorhub jobs get 3d48759b-f83a-4142-8153-6dca74d22370   # 同一權杖在第 2 步建立的任務
job 3d48759b-f83a-4142-8153-6dca74d22370 succeeded asset 5ec4592d-148a-4b8a-aad8-8d3d0c31c21b
```
```console
$ CREATORHUB_TOKEN=<import token> creatorhub jobs get 4107387d-a5e7-46ad-951d-2b3d8081c96f   # 主權杖建立的任務
error: 404 not_found job not found
```

### 11. 撤銷權杖後立即 401

```console
$ curl -s -X DELETE http://127.0.0.1:7421/api/v1/tokens/8bf84970-dea5-43d5-b365-9dd3f05913c5 -H 'authorization: Bearer <owner>'
Claude 匯入 Agent revoked_at 2026-11-16T16:20:15.273Z
```
```console
$ curl -s -X POST .../imports/urls -H 'authorization: Bearer <revoked import token>' -H 'idempotency-key: after-revoke-01' ... -w '\nHTTP %{http_code}\n'
{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}
HTTP 401
```

### 12. 收尾

- 埠 7421：已釋放
- 埠 7498：已釋放
- 臨時資料目錄與日誌：已刪除

### 備註

- 第 5 步 `ftp://` 回 400 `validation_error`：請求格式（Zod `url` 只接受 http／https）在進入服務前就擋下，與其他 `url_rejected` 同樣不會建立任務。
- 第 7 步 `huge.mp4` 依 `Content-Length` 直接拒絕，不會下載；上限取各類型中最大的 20 GiB，下載完成後再依實際類型套用個別上限（圖片 50 MiB 等）。
- 第 6 步的連線紀錄顯示：被擋的請求（內網名稱、混合解析、重綁定後的第二次）**沒有任何連線**；允許的請求只連到檢查過的 93.184.216.34，且 `Host` 仍是原主機名稱。
- 自動測試另外覆蓋了：IPv6／IPv4 對映／NAT64／6to4／Teredo 等 60 多種位址、重定向次數上限、串流超量（無 Content-Length）、整體逾時、5xx／429 自動重試、權杖分開的冪等鍵（`test/ssrf.test.ts`、`test/imports.test.ts`）。
