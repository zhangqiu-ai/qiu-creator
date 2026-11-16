# 原型

規則見 [DESIGN.md](../../../DESIGN.md) 的「原型流程」一節。本資料夾只放原型與帳本。

## 位置

- 原型 v0.1：Design 畫布 <https://claude.ai/artifact/GdTFo6sWag1CLMaGhTJqD1>（私有，需分享後才能開啟）。
- 帳本：[changes.json](changes.json)，每批改動一個條目。
- DESIGN.md 指定的單一 HTML `qiu-creator-prototype.html` 尚未建立；要匯出到 repo，還是改指向畫布，由總監決定。

## 流程

1. 總監分配條目 ID（`PT-YYYYMMDD-NNN`）與範圍。
2. 動手前先查 qiuge-design 參考庫，把引用的卡片記進條目的 `references`。
3. 只由 Claude 模型設計，`model` 欄記錄實際使用的模型。
4. 改原型，同時在帳本新增或更新條目，`status` 一律寫 `pending`。
5. 使用者核准後才改成 `approved`，並填 `approvedBy`、`approvedAt`。總監只能核准既有方向內的小改動，並在條目註明。被新條目取代時改成 `superseded`。
6. 沒驗證到的項目寫進 `notVerified`，前面標 `NOT_VERIFIED`。

## 條目欄位

`id`、`title`、`date`、`status`、`model`、`requestedBy`、`userRequest`、`approvedBy`、`approvedAt`、`canvas`、`scope`、`tweaks`、`boards`（檔名、標題、狀態）、`visualDirection`、`adjustmentsFromBrief`、`keyboard`、`references`、`notVerified`、`openQuestions`。

## 期別

依 [決策記錄](../../decisions.md)（2026-11-16），第一期只做 Mac 畫面。iPhone／iPad 原型等第二期開工後再加。
