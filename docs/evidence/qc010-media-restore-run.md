# QC-010 實機驗證記錄

- 日期：2026-11-17 04:20 PST
- 分支：feat/qc010-restore-images（1ae5f70 + 未提交變更）
- 服務：`node --import tsx src/main.ts`，`CREATORHUB_PORT=7420`，`CREATORHUB_HOME` 為臨時目錄；外部資料夾也是臨時目錄。未連外網。

### 1. 建立作品並修改兩次

```console
$ PATCH status=in_review, tags=[" 旅行 ","美食","旅行"]（去空白、去重）
{"rev":"<v3>","status":"in_review","tags":["旅行","美食"]}
```
```console
$ GET /api/v1/works/<id>/revisions/<v1>
{"source":"create","title":"初稿","markdown":"# v1\n"}
```

### 2. 恢復 v1：舊 base 回 409、不帶 base 回 428、正確 base 成功

```console
$ POST …/restore base_revision=<v2>（過期）
revision_conflict current_revision = <v3>（與步驟 1 的版本相同）
```
```console
$ POST …/restore {}（沒有前置條件）
HTTP 428
```
```console
$ POST …/restore If-Match: "<v3>"
{"title":"初稿","markdown":"# v1\n","status":"in_review","tags":["旅行","美食"]}
```
```console
$ 回應 ETag
etag: "<new-rev>"
```
```console
$ cat <home>/library/works/<id>/source.md
# v1
```
```console
$ 版本歷史（新到舊）
restore ← edit ← edit ← create
```
```console
$ 最後一個 SSE work.updated 事件的 data
{"revision_id":"<uuid>","source":"restore","restored_from":"<uuid>","fields":["title","markdown"]}
```

### 3. 托管作品的圖片解析與簽名網址

```console
$ GET /api/v1/works/<id>/media
resolved    ./assets/cover.png → assets/cover.png
resolved    assets/%E5%9C%96.png → assets/圖.png
rejected    ../other/x.png 
rejected    source.md 
unsupported assets/evil.svg → assets/evil.svg
rejected    assets/link.png → assets/link.png
remote      https://example.com/a.png 
```
```console
$ 簽名網址形式（權杖不在網址裡）
/media/v1/works/<id>/files/assets/cover.png?exp=<exp>&p=owner&sig=<sig>
```
```console
$ curl <signed url>（不帶 Authorization）
HTTP/1.1 200 OK
cache-control: private, max-age=300
x-content-type-options: nosniff
referrer-policy: no-referrer
content-security-policy: default-src 'none'; sandbox
content-type: image/png
content-length: 195
```
```console
$ curl -H 'range: bytes=0-7' <signed url>
HTTP/1.1 206 Partial Content
content-range: bytes 0-7/195
```
```console
$ 竄改與挪用簽名
竄改 sig：HTTP 403
改成別的檔案：HTTP 403
拿掉簽名：HTTP 403
```
```console
$ Bearer 路由 /api/v1/works/<id>/files/*
assets/cover.png → HTTP 200
source.md → HTTP 403
assets/link.png → HTTP 403
assets/evil.svg → HTTP 415
assets/..%2F..%2F..%2Fdata%2Fcreatorhub.sqlite → HTTP 403
```

### 4. 外部資料夾作品：相對路徑、不出掛載、不跟隨連結、原地登記素材

```console
$ GET /api/v1/works/<external>/media
resolved  ../images/cover.png → images/cover.png asset ✓
resolved  ./pic.png → notes/pic.png asset ✓
rejected  link.png → notes/link.png 
rejected  ../../outside.png  
```
```console
$ GET /api/v1/assets/<asset>
{"origin":"folder","mount_id":"<mount>","path":"images/cover.png","kind":"image","mime_type":"image/png"}
```
```console
$ GET /api/v1/works/<external>/assets
body images/cover.png
body notes/pic.png
```
```console
$ 比對掛載前後的資料夾指紋
資料夾內容與掛載前完全相同（4 個項目）
```

### 5. Agent 權杖撤銷後，它取得的簽名網址立即失效

```console
$ Agent 簽名網址
撤銷前：HTTP 200
撤銷後：HTTP 403
```

### 6. 日誌不含簽名

```console
$ grep sig= <server log>
遮蔽過的 sig 筆數：6
未遮蔽的 sig 筆數：0
```

收尾：服務已停止，臨時資料目錄與資料夾已刪除；埠 7420 已釋放。

## 自動測試

- `services/mac-server/test/revisions-restore.test.ts`（15）：讀單一版本、跨作品 404、恢復寫新 revision 且舊歷史不變、`If-Match`／409／428、恢復目前版本、連續恢復、權限範圍、外部作品寫回與 `source_missing`、狀態與標籤驗證與事件。
- `services/mac-server/test/work-media.test.ts`（11）：托管與外部的引用分類、Range、簽名竄改／挪用／過期／權杖撤銷、Bearer 路由、外部素材原地登記與冪等、檔案變更重新雜湊、上傳不去重到外部素材、卸載後失效、登記後被換成符號連結。
- `services/mac-server/test/media-units.test.ts`（18）：路徑正規化、Markdown 引用抽取、簽名驗證、金鑰檔權限、日誌遮蔽。
- `packages/api-client/test/client.test.ts`：`works.restore` 與 `media.absoluteUrl`。
