# QC-019 實機驗證記錄

- 日期：2026-11-17 08:11 PST
- 分支：fix/qc019-variant-revision-reuse（基底 7ffa32a）
- 服務：`node --import tsx src/main.ts`，`CREATORHUB_PORT=7420`，`CREATORHUB_HOME` 為臨時目錄。照 QC-014 的重現步驟。

```console
$ 1. 產生小紅書草稿
rev 1
```
```console
$ 2. App 讀取（記下 r1）
etag: "1"
```
```console
$ 3a. Agent 以 If-Match "1" 刪除
HTTP 204
```
```console
$     刪除後讀取（墓碑）
HTTP 404
```
```console
$ 3b. Agent 重新產生
rev 3
```
```console
$ 4. App 以 base_revision 1 修改（修正前回 200）
HTTP 409 {"current_revision":3,"base_revision":"1"}
```
```console
$ 新草稿未被覆蓋
rev 3 title 京都
```
```console
$ 歷史（r2 是墓碑，不列入）
3:draft  1:draft
```

收尾：服務已停止，臨時資料目錄已刪除；埠 7420 已釋放。

## 自動測試

- `services/mac-server/test/variants.test.ts` 新增回歸測試「a client holding a pre-delete revision gets 409 after delete and recreate (QC-019)」：App 持有 r1，Agent 刪除並重新產生後，App 以 body 或 `If-Match` 寫入都回 409，過期的重新產生與刪除也回 409，新草稿不變；連續三次刪除重建，版本號都不重複。
- 這個測試在修正前的 `variant-service.ts` 上會失敗（`expected 1 to be greater than 1`），修正後通過。
- 原有的刪除測試改為驗證墓碑行為：刪除後讀取與歷史回 404，重建從 r3 起算，歷史保留 r1。
- 依總監指示 rebase 到 QC-014 的 `7ffa32a`，並移除 `m2-three-party.test.ts` 中「refuses a stale variant save made against a version that was deleted and recreated」的 `it.fails`，現為一般的通過測試。
