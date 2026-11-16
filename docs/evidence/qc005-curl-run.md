# QC-005 實機驗證紀錄：素材上傳、背景任務與變更事件

- 日期：2026-11-16 07:39 PST；分支 `feat/qc005-assets-upload-events`；Node v24.14.0
- 啟動：`node --import tsx src/main.ts`，`CREATORHUB_HOME` 為臨時目錄，監聽 `127.0.0.1:7420`；權杖以 `<token>` 代替
- 測試素材全部在本機產生：ffmpeg 測試圖樣視頻（2 秒 320×240）、1200×800 純色 PNG、偽裝成 .jpg 的 ZIP、40 MiB 的 MP4 檔頭＋隨機資料
- ffprobe：本機 Homebrew ffprobe version 9.0.2（由服務自動找到）

### 1. SSE 沒帶權杖 → 401

```console
$ curl -s -i http://127.0.0.1:7420/api/v1/events
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer
content-type: application/json; charset=utf-8
content-length: 77
Date: Mon, 16 Nov 2026 15:39:51 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}
```

### 2. 直傳圖片 → 201；同內容再傳 → 200 去重

```console
$ curl -s -X POST 'http://127.0.0.1:7420/api/v1/assets/uploads?filename=封面.png' -H 'authorization: Bearer <token>' -H 'content-type: application/octet-stream' --data-binary @cover.png -w '\nHTTP %{http_code}\n'
{"asset":{"id":"9cfced29-6ec8-4da8-9a30-8e2d9fc16f87","kind":"image","path":"library/assets/9cfced29-6ec8-4da8-9a30-8e2d9fc16f87/封面.png","sha256":"a4640cbb3d172e3c37985239e50170e1189bb1ccfc1bed5240cd84ad8db8dea2","mime_type":"image/png","bytes":4622,"duration":null,"width":null,"height":null,"origin":"upload","created_at":"2026-11-16T15:39:51.151Z","original_name":"封面.png","codec":null,"metadata_status":"none","thumbnail_status":"pending","updated_at":"2026-11-16T15:39:51.151Z"},"deduplicated":false}
HTTP 201

```
```console
$ curl -s -X POST 'http://127.0.0.1:7420/api/v1/assets/uploads?filename=另一個名字.png' ... --data-binary @cover.png -w '\nHTTP %{http_code}\n'
{"asset":{"id":"9cfced29-6ec8-4da8-9a30-8e2d9fc16f87","kind":"image","path":"library/assets/9cfced29-6ec8-4da8-9a30-8e2d9fc16f87/封面.png","sha256":"a4640cbb3d172e3c37985239e50170e1189bb1ccfc1bed5240cd84ad8db8dea2","mime_type":"image/png","bytes":4622,"duration":null,"width":1200,"height":800,"origin":"upload","created_at":"2026-11-16T15:39:51.151Z","original_name":"封面.png","codec":null,"metadata_status":"none","thumbnail_status":"ready","updated_at":"2026-11-16T15:39:51.183Z"},"deduplicated":true}
HTTP 200

```

### 3. 拒絕：改名成 .jpg 的 ZIP → 415；直傳超過 32 MiB → 413

```console
$ curl -s -X POST 'http://127.0.0.1:7420/api/v1/assets/uploads?filename=photo.jpg' ... --data-binary @fake.jpg -w '\nHTTP %{http_code}\n'
{"error":{"code":"unsupported_media_type","message":"file content is application/zip, which is not an allowed media type"}}
HTTP 415

```
```console
$ curl -s -X POST 'http://127.0.0.1:7420/api/v1/assets/uploads?filename=big.png' ... --data-binary @too-big.bin（33 MiB） -w '\nHTTP %{http_code}\n'
{"error":{"code":"payload_too_large","message":"direct uploads are limited to 33554432 bytes; use /api/v1/assets/uploads/tus"}}
HTTP 413

```
```console
$ ls $CREATORHUB_HOME/data/incoming $CREATORHUB_HOME/library/assets
---
9cfced29-6ec8-4da8-9a30-8e2d9fc16f87

```

### 4. 視頻直傳 → ffprobe 背景任務取得時長／尺寸／編碼

```console
$ curl -s http://127.0.0.1:7420/api/v1/assets/42a78308-9b44-42c0-8871-a67322a573ea -H 'authorization: Bearer <token>'
{
 "kind": "video",
 "mime_type": "video/mp4",
 "bytes": 11401,
 "duration": 2,
 "width": 320,
 "height": 240,
 "codec": "h264",
 "metadata_status": "ready",
 "path": "library/assets/42a78308-9b44-42c0-8871-a67322a573ea/clip.mp4"
}

```

### 5. 縮圖：產生、刪掉 cache/ 後重建

```console
$ curl -s -o thumb.webp -w '%{http_code} %{content_type} %{size_download} bytes\n' http://127.0.0.1:7420/api/v1/assets/9cfced29-6ec8-4da8-9a30-8e2d9fc16f87/thumbnail
200 image/webp 404 bytes

```
```console
$ file thumb.webp; curl -s .../assets/9cfced29-6ec8-4da8-9a30-8e2d9fc16f87 | 寬高與縮圖狀態
P image, VP8 encoding, 512x341, Scaling: [none]x[none], YUV color, decoders should clamp
1200x800 ready

```
```console
$ rm -rf $CREATORHUB_HOME/cache && curl ... /thumbnail && ls $CREATORHUB_HOME/cache/thumbnails
200 404 bytes
9cfced29-6ec8-4da8-9a30-8e2d9fc16f87.webp

```

### 6. tus 可續傳上傳：傳到一半斷線，HEAD 取得斷點後續傳

建立上傳：`POST /api/v1/assets/uploads/tus`（Upload-Length 41943040）→ 201，Location `/api/v1/assets/uploads/tus/e4a12842f2b78cb786bba4c501c39e42`
```console
$ curl -s -X PATCH http://127.0.0.1:7420/api/v1/assets/uploads/tus/e4a12842f2b78cb786bba4c501c39e42 ... -H 'upload-offset: 0' --data-binary @big.mp4 --limit-rate 8M --max-time 2   # 2 秒後強制斷線
curl exit after 2.001947s, sent 16842752 bytes

```
```console
$ curl -s -I http://127.0.0.1:7420/api/v1/assets/uploads/tus/e4a12842f2b78cb786bba4c501c39e42 -H 'authorization: Bearer <token>' -H 'tus-resumable: 1.0.0'
HTTP/1.1 200 
upload-length: 41943040
upload-offset: 16842752

```
```console
$ tail -c +16842753 big.mp4 | curl -s -X PATCH http://127.0.0.1:7420/api/v1/assets/uploads/tus/e4a12842f2b78cb786bba4c501c39e42 ... -H 'upload-offset: 16842752' --data-binary @-
HTTP 200
{
 "deduplicated": false,
 "kind": "video",
 "bytes": 41943040,
 "sha256": "2279f3e30df304823a616e2d40d8b5eeb81aa1ac513881b6fe6daf1fdfde417d",
 "path": "library/assets/daeb63b2-20da-48fc-b353-50d5c4fd8738/旅行 vlog.mp4"
}

```
```console
$ shasum -a 256 big.mp4（原檔）
2279f3e30df304823a616e2d40d8b5eeb81aa1ac513881b6fe6daf1fdfde417d
--- data/uploads:

```

### 7. 作品與素材關聯：封面、正文、視頻與排序

已以 `POST /api/v1/works/:id/assets` 關聯：封面 = 封面.png，視頻 = clip.mp4、旅行 vlog.mp4。
```console
$ curl -s -X PUT http://127.0.0.1:7420/api/v1/works/26f69922-19d8-42a3-a950-db8dcdcd761b/assets/order ... -d '{"role":"video","asset_ids":["<vlog>","<clip>"]}'
cover  0 封面.png
video  0 旅行 vlog.mp4
video  1 clip.mp4

```

### 8. 中文全文搜尋（FTS5 trigram）

```console
$ curl -s 'http://127.0.0.1:7420/api/v1/works?q=紅葉比往年' -H 'authorization: Bearer <token>'
total 1 [ '京都秋天 vlog' ]

```
```console
$ curl -s 'http://127.0.0.1:7420/api/v1/works?q=大阪城' -H 'authorization: Bearer <token>'
total 0

```

### 9. 外部修改 source.md → work.external_revision 事件

用 shell 直接改寫 `library/works/26f69922-19d8-42a3-a950-db8dcdcd761b/source.md`（模擬 Typora／Finder），再讀取作品觸發對帳。

### 10. 這段期間 SSE 收到的事件

`curl -sN http://127.0.0.1:7420/api/v1/events -H 'authorization: Bearer <token>'` 的輸出（只列 event 行與第一筆完整事件）：
```text
retry: 3000
: connected seq=0

id: 1
event: asset.created
data: {"seq":1,"entity":"asset","entity_id":"9cfced29-6ec8-4da8-9a30-8e2d9fc16f87","action":"asset.created","data":{"kind":"image"},"created_at":"2026-11-16T15:39:51.151Z"}

id: 2
...
   4 event: work.assets_changed
   3 event: job.running
   3 event: job.queued
   3 event: asset.updated
   3 event: asset.created
   2 event: job.succeeded
   1 event: work.external_revision
   1 event: work.created
```

### 11. OpenAPI 路徑

```console
$ curl -s http://127.0.0.1:7420/docs/json | 路徑列表
GET            /health
POST,GET       /api/v1/works
GET,PATCH      /api/v1/works/{id}
GET            /api/v1/works/{id}/revisions
GET            /api/v1/assets/{id}/stream
POST           /api/v1/assets/uploads
GET            /api/v1/assets
GET            /api/v1/assets/{id}
GET            /api/v1/assets/{id}/thumbnail
GET,POST       /api/v1/works/{id}/assets
DELETE         /api/v1/works/{id}/assets/{assetId}
PUT            /api/v1/works/{id}/assets/order
GET            /api/v1/events

```

### 12. 收尾

- 埠 7420：已釋放
- 伺服器日誌 error 等級筆數：0
- 臨時資料目錄與測試檔：已刪除

### 備註

- 第 10 步 `job.queued` 3 筆、`job.succeeded` 2 筆是預期結果：40 MiB 的檔案只有 MP4 檔頭、內容是隨機資料，真的 ffprobe 無法解析，探測任務失敗後以退避重試（中間的重試不另發事件，最終失敗才發 `job.failed`）。上傳本身成功。
- 佇列「重啟後續跑」與「ffprobe 缺席降級」不在本紀錄中，由自動測試 `test/jobs.test.ts` 覆蓋。
- **一次未重現的失敗**：本腳本第一次執行時，第 6 步續傳的 PATCH 回 `HTTP 000`，之後的請求都沒有回應，伺服器日誌在清理時一併刪除，無法確認原因。之後完整重跑 11 次、單獨重跑「中斷＋續傳」12 次（不同速率與中斷時間）都正常。已在 `src/main.ts` 加上 `uncaughtException`／`unhandledRejection` 的 fatal 日誌，若再發生，日誌會留下堆疊；在 launchd 下行程會被重啟。狀態：`NOT_VERIFIED`（根因未知）。
