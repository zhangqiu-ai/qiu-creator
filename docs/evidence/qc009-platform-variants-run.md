# QC-009 實機驗證記錄

- 日期：2026-11-17 05:27 PST
- 分支：feat/qc009-platform-variants（5452019 + 未提交變更）
- 服務：`node --import tsx src/main.ts`，`CREATORHUB_PORT=7420`，`CREATORHUB_HOME` 為臨時目錄。沒有呼叫任何 AI 或外部服務。

### 1. 從原文產生四個平台的規則草稿

```console
$ POST /api/v1/works/<id>/variants {}
xiaohongshu      rev 1 | "今年的紅葉比往年更早轉紅，地圖在這。\n\n行程\n\n• 清水寺\n• 嵐山"
wechat_mp        rev 1 | "今年的**紅葉**比往年更早轉紅，[地圖](https://example.com)在這。\n\n## 行程\n\n- 清水寺\n- 嵐山"
douyin           rev 1 | "今年的紅葉比往年更早轉紅，地圖在這。\n\n行程\n\n• 清水寺\n• 嵐山"
wechat_channels  rev 1 | "今年的紅葉比往年更早轉紅，地圖在這。\n\n行程\n\n• 清水寺\n• 嵐山"
```
```console
$ 再產生一次（已存在的不動）
{"created":[],"skipped":["douyin"]}
```

### 2. 四平台各自修改，互不串改

```console
$ GET /api/v1/works/<id>/variants
xiaohongshu      rev 2 xiaohongshu 專用標題 ["xiaohongshu"]
wechat_mp        rev 2 wechat_mp 專用標題 ["wechat_mp"]
douyin           rev 2 douyin 專用標題 ["douyin"]
wechat_channels  rev 2 wechat_channels 專用標題 ["wechat_channels"]
```
```console
$ 原文不受影響：GET /api/v1/works/<id>
{"title":"京都秋天","tags":["旅行","京都"]}
```

### 3. 並發修改同一個平台：一個成功，其餘 409

```console
$ 三個請求同時以 base_revision=2 修改小紅書
甲 → HTTP 409 {"current_revision":3,"base_revision":"2"}
乙 → HTTP 200 rev 3
丙 → HTTP 409 {"current_revision":3,"base_revision":"2"}
```
```console
$ 小紅書版本歷史
3:edit:乙  2:edit:xiaohongshu 專用標題  1:draft:京都秋天
```
```console
$ 不帶 base（428）
HTTP 428
```
```console
$ GET 抖音版本的 ETag
etag: "2"
```

### 4. 超出參考上限只警告不阻擋

```console
$ PATCH 視頻號標題 19 字（上限 16）
rev 3 已儲存
title_too_long 標題共 19 字，超過參考上限 16 字
```

### 5. 從修改後的原文重新產生草稿（保留歷史）

```console
$ POST …/variants/douyin/draft base_revision=2
rev 3 "改過的原文。"
```
```console
$ 抖音版本歷史
3:draft  2:edit  1:draft
```

### 6. SSE 事件

```console
$ curl /api/v1/events?since=0 | grep variant
   4 event: work.variant_created
   7 event: work.variant_updated
```

收尾：服務已停止，臨時資料目錄已刪除；埠 7420 已釋放。

## 自動測試

- `services/mac-server/test/variants.test.ts`（13）：規則草稿（純文字／Markdown、front matter、標題行、圖片順序與封面）、產生時不動原文且略過已有平台、四平台逐一修改互不串改、不同作品互不影響、四個同 base 並發 PATCH 恰好一個 200 其餘 409、`If-Match`／428／body 與 header 不一致、歷史與重新產生、刪除、超限警告照存（含 emoji 計數）、素材驗證、事件、Agent 權杖權限。
- `packages/contracts/test/variants.test.ts`（5）：上限設定涵蓋四平台、字數計算、警告邊界、可替換上限、PATCH 至少一個欄位。
- `packages/api-client/test/client.test.ts`：`variants.patch` 送 `If-Match: "3"`，409 時 `currentVariantRevision` 為整數。
