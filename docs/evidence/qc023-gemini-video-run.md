# QC-023 實機驗證記錄

- 日期：2026-11-17 16:18 PST；負載：4.44 9.48 8.13
- 分支：feat/qc023-gemini-video（基底 156d610，未提交變更）
- 服務：`buildServer`（Fastify 日誌開啟）跑在 `127.0.0.1:7420`，`CREATORHUB_HOME` 為臨時目錄；金鑰用記憶體實作；Gemini 的 base URL 指向本機假 Files API 伺服器（`test/fake-gemini-video.ts`），上傳分段設為 1 MiB。假伺服器設定：第 2 段上傳時切斷連線、第一次 `generateContent` 回 429。**沒有對任何真實第三方 API 發出請求。**

### 1. 送出前估算（無時長資訊，依檔案大小推估）

```console
$ POST /api/v1/assets/<id>/ai/video-understanding/estimate
{"size_bytes":3145728,"duration_seconds":5.0331648,"duration_source":"size_guess","model":"gemini-3.8-flash","resolution":"default","input_tokens":1973,"max_cost_usd":0.01683975,"cached_job_id":null}
```

### 2. 分析：上傳中斷續傳、429 重試

```console
$ POST /api/v1/assets/<id>/ai/video-understanding {}
HTTP 202 {"cached":false,"in_progress":false,"status":"queued"}
```
```console
$ GET /api/v1/ai/jobs/<id>
{"status":"succeeded","attempts":3,"usage":{"input_tokens":9200,"output_tokens":400},"cost_usd":0.0084,"progress":{"phase":"analyzing","uploaded_bytes":3145728,"total_bytes":3145728}}
```
```console
$ 假 Gemini 伺服器看到的請求
start 次數 1 | query 回報已收 [1572864] | 各段 offset [0,1048576,1572864,2621440] | generateContent 次數 2 | 刪除遠端檔 1
```
```console
$ SSE ai_job.* 事件（依序）
ai_job.queued     
ai_job.running    
ai_job.progress   uploading 0/3145728
ai_job.progress   uploading 1048576/3145728
ai_job.queued     
ai_job.running    
ai_job.progress   uploading 1572864/3145728
ai_job.progress   uploading 2621440/3145728
ai_job.progress   uploading 3145728/3145728
ai_job.progress   processing 3145728/3145728
ai_job.progress   analyzing 3145728/3145728
ai_job.queued     
ai_job.running    
ai_job.progress   analyzing 3145728/3145728
ai_job.succeeded  
```
```console
$ 結果（result.json）
時間點、轉寫與內容描述由 AI 產生，可能有誤，請對照影片核驗後再使用。
摘要： 京都嵐山竹林的清晨散步，人很少，最後到渡月橋。
  3s 竹林入口 待核驗=true 片長內=未知（無時長）
  25s 渡月橋 待核驗=true 片長內=未知（無時長）
  95s 超出長度 待核驗=true 片長內=未知（無時長）
標題： 清晨的嵐山竹林 / 京都人少的時段
封面： 12s 竹林中央，光線最好。
```

### 3. 快取命中與重新分析

```console
$ 再送一次（未帶 reanalyze）
HTTP 200 {"cached":true,"same_job":true}
```
```console
$ 假伺服器：沒有新的上傳或分析
start 次數 1 | generateContent 次數 2
```
```console
$ reanalyze: true
HTTP 202 {"cached":false,"status":"queued"}
```
```console
$ 假伺服器：重新上傳並分析一次
start 次數 2 | generateContent 次數 3
```

### 4. 處理中取消

```console
$ 等到 Gemini 處理中
取消前階段：processing
```
```console
$ POST /api/v1/ai/jobs/<id>/cancel
cancelled
```
```console
$ 假伺服器：遠端檔已刪除
刪除遠端檔累計 3
```

### 5. 上限檢查與日誌

```console
$ 圖片素材送視頻分析
unsupported_media_type HTTP 415
```
```console
$ grep <server log>
日誌行數：48；含 video-understanding 的請求紀錄：6
金鑰出現次數：0
```

收尾：服務與假伺服器已停止，臨時資料目錄已刪除；埠 7420 已釋放。

## 自動測試

`services/mac-server/test/ai-video.test.ts`（13），全部對本機假 Gemini Files API 伺服器（`test/fake-gemini-video.ts`）：

- 送出前估算（時長、token、最多花費、無可沿用結果）；以 256 KiB 分段上傳、只有最後一段 finalize、上傳位元組與原檔一致；標頭帶金鑰與可續傳協定、請求內容不含金鑰；等到 ACTIVE 才分析；成功後刪掉遠端檔；結果的時間點依時間排序、全部標待核驗、超出片長標 `false`、片長未知標 `null`；進度事件依序為 uploading（每段）→ processing → analyzing → succeeded。
- 快取命中回舊任務且不上傳不分析；不同解析度是不同快取鍵；`reanalyze` 才重新上傳與計費，之後快取指向最新結果；同一分析進行中時不重複送出；相同內容的另一次上傳去重後也命中快取。
- 第 2 段上傳時連線中斷：重試以 `query` 取得已收位元組並從那裡續傳，只 start 一次；伺服器不支援 `query` 時重新上傳，結果仍正確。
- Gemini 處理失敗記 `file_processing_failed`、不重試、刪掉遠端檔；`generateContent` 回 429 時重試且不重新上傳；處理中取消會中止並刪掉遠端檔；素材檔不見記 `source_unavailable`。
- 上限：非視頻 415、預設解析度超過約 60 分鐘 400（訊息提示可改低解析度）、超過 2 GB 413、不支援的格式 415、無時長時依大小推估；路由只限主權杖、仍需告知確認、素材 id 必須是 UUID。
