# QC-071 儲存狀態 chip

- 平常不顯示；未儲存淡色「未儲存」；儲存超過 150ms 才「儲存中」；存好後「已儲存」約 2 秒，淡出（`fast`）；失敗、衝突持續顯示、醒目（粗體加外框）且可點擊／Enter。唯讀 chip 維持。
- `.save-status` 為固定寬度槽位，版本號與字數不因 chip 出現／消失而移動（e2e 比對字數 x 座標）。
- 測試：`apps/mac/test/save-chip.test.ts`（5）、`e2e/specs/save-chip.spec.ts`（2，背景模式）。
- 截圖：`docs/evidence/qc071/`（01 閒置、02 已儲存、03 消失、04 衝突）。
