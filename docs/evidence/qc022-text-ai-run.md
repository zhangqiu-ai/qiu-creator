# QC-022 實機驗證記錄

- 日期：2026-11-17 16:04 PST；負載：2.88 2.99 3.00
- 分支：feat/qc022-text-candidates（基底 f9c782d，未提交變更）
- 服務：`buildServer`（Fastify 日誌開啟）跑在 `127.0.0.1:7420`，`CREATORHUB_HOME` 為臨時目錄；金鑰用記憶體實作，GPT 的 base URL 指向本機假伺服器。**沒有對任何真實第三方 API 發出請求。**

### 1. 四平台候選（只產生候選，不寫入）

```console
$ POST /api/v1/works/<id>/ai/suggestions {count:2}
{"status":"queued","action":"platform_variant","task":"platform_suggestions","platforms":["xiaohongshu","wechat_mp","douyin","wechat_channels"],"max_cost_usd":0.12428}
```
```console
$ GET /api/v1/ai/jobs/<id> → result.json
xiaohongshu
  標題 京都紅葉提早報到🍁
  標題 秋天就該去京都
  標籤 京都、紅葉、秋日旅行
wechat_mp
  標題 京都秋天：紅葉提早的一年
  標籤 京都、旅行
douyin
  標題 京都紅葉
  標籤 京都、紅葉、旅行、日本、秋天、賞楓  ⚠ 標籤共 6 個，超過參考上限 5 個
wechat_channels
  標題 京都紅葉提早報到，清水寺與嵐山實拍  ⚠ 標題共 17 字，超過參考上限 16 字
  標籤 京都
```
```console
$ 原稿未被寫入
作品版本數 1
```

### 2. 改寫候選 → 採用（ai_accepted，可恢復）

```console
$ 改寫候選（供應商輸出外包的程式碼圍欄已去掉）
source_revision = <uuid>
range = {"start":0,"end":35}
full_markdown = "# 京都秋天\n\n今年紅葉來得比往年早。\n\n清水寺擠滿遊客，嵐山則相對寧靜。\n"
```
```console
$ POST …/ai/jobs/<job>/accept {markdown: full_markdown}
"# 京都秋天\n\n今年紅葉來得比往年早。\n\n清水寺擠滿遊客，嵐山則相對寧靜。\n"
```
```console
$ 版本歷史
ai_accepted(ai_job) ← create
```
```console
$ 恢復到 AI 採用前的版本
"# 京都秋天\n\n今年的紅葉比往年早。\n\n清水寺人很多，嵐山比較安靜。\n"
```

### 3. 原稿已變 → 採用回 409

```console
$ 作品被改過之後採用縮寫候選
HTTP 409 revision_conflict
```

### 4. 停止生成與重試

```console
$ POST /api/v1/ai/jobs/<id>/cancel（生成中）
cancelled
```
```console
$ POST /api/v1/ai/jobs/<id>/retry
queued
```
```console
$ 重試完成
{"status":"succeeded","text":"擴寫後的全文"}
```

### 5. 日誌

```console
$ grep <server log>
日誌行數：50；含 /ai/ 的請求紀錄：17
原文片段「清水寺人很多」出現次數：0
改寫結果片段「擠滿遊客」出現次數：0
金鑰出現次數：0
```

收尾：服務與假伺服器已停止，臨時資料目錄已刪除；埠 7420 已釋放。

## 自動測試

`services/mac-server/test/ai-text.test.ts`（11），全部對本機假伺服器：

- 平台候選：提示詞含各平台上限與以 `<原文>` 包住的原文、system 說明原文是素材；請求不含金鑰；Schema 只含要求的平台與欄位；結果去空白、去重、裁數量、標籤去 `#`，超限附警告；產生時不寫作品或平台版本，並記下當時各平台版本號；候選經平台版本 API（帶 `base_revision`）套用；形狀不對記 `invalid_output`。
- 改寫：全文潤色去掉程式碼圍欄；採用寫成 `ai_accepted`、`ai_job_id` 與 `parent_revision_id` 正確、任務記 `accepted_revision_id`、事件帶 `ai_job_id`，可恢復；再次採用 409。原稿被改後採用回 409 `revision_conflict`，什麼都不寫。選取範圍改寫保留前後空白、拼接正確；部分採用時服務端照存前端組好的全文與標題。請求驗證（自訂缺指令、語氣缺語氣、空範圍、超出全文、只有空白、未知模式）回 400。只能採用同一作品、已成功的改寫任務。
- 停止生成中止請求；重試重送同一份提示詞，候選仍以原本版本為準，採用時因原稿已改而回 409。仍需金鑰與告知確認；超過 50 萬字回 413 且不建立任務；三個路由只限主權杖。
