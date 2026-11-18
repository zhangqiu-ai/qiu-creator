# In Progress

## QC-034: ai-text 改寫接受測試的順序假設

**Priority:** P2 | **Assignee:** qc-test | **Tags:** backend | **Started:** 2026-11-18

QC-020 交付時回報：`ai-text.test.ts`「only accepts a succeeded rewrite of the same work」低負載 10 次失敗 1 次。診斷（40 輪重現 1 次）：兩個 AI 任務並行時，預期失敗的任務與另一作品的任務拿反了假服務的排程回應；是測試的順序假設，不是產品缺陷。修法：每個任務完成後再建立下一個。

