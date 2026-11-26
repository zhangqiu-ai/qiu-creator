# QC-109 前端：作品文字字體設定介面

日期：2026-11-26 · 會話：qc-frontend · 分支 `qc109-text-script`（從 origin/main d1d81ff 開）

規格：
- 開發總監的派工：接 QC-103 的 API，在既有的設定頁和項目設定裡加欄位，不是新頁面，不需要原型。
- `docs/decisions.md`「2026-11-26 · Agent 寫入作品的文字統一字體（QC-103）」。

## 做了什麼

- **設定 › Agent 與 MCP › 作品文字字體**（`TextScriptSetting.tsx`）：
  - 位置在權杖清單上方。
  - 一列「Agent 寫入作品的文字」，用分段控制選「簡體／繁體」。
  - 讀取用 `client.settings.textScript()`。`updated_at` 是 null 時，標註「預設值」（zh-Hans）。
  - 一選就用 `setTextScript({script})` 儲存，做法和「語言」一樣：畫面先切過去；成功時跳出提示「作品文字字體改為繁體」。
  - 儲存還在途中又改選時，每次選擇都依序送出，最後一次的選擇為準，只顯示最後一次的結果；失敗時回到服務端最後確認的值，並顯示錯誤。
    - 第一版在儲存途中會忽略新的選擇，全套 e2e 抓到了這個問題，已經修好。
  - 方向鍵可以切換選項。
- **項目設定 › 作品文字字體**（`ProjectRulesDialog.tsx`）：
  - 三個選項：「跟隨全域（簡體／繁體）」「簡體」「繁體」，對應 `text_script` 的 null、zh-Hans、zh-Hant。
  - 跟隨全域會帶出目前的全域字體；讀不到全域設定時只寫「跟隨全域」。
  - 和描述、規則一起按「儲存」才寫入，只有改了才送 `text_script`。
  - 409 衝突時重新讀取，字體也一起回到最新值。
- **說明文字**：兩處都附同一句「只影響 Agent 送來的新內容；你自己寫的字和已有作品不會被轉換。」，三語齊全（`agents.script*` 鍵）。
- **共用**：
  - `radioKeys` 從 `AppearanceSection.tsx` 搬到 `radio-keys.ts`，外觀頁和這兩處共用。
  - 選項與標籤的換算放在 `text-script-ui.ts`。
  - `ProjectsStore.patch` 多收 `text_script`，另外新增 `globalTextScript()`。
- 沒有新增或修改 `/api/v1` 路由，所以 MCP 不需要同步。

## 截圖（`docs/evidence/qc109/`，1440×900，e2e 背景視窗）

| 檔案 | 內容 |
| --- | --- |
| `qc109-1-settings-default.png` | 設定：預設簡體，標註「預設值」，附說明 |
| `qc109-2-settings-hant.png` | 選繁體之後 |
| `qc109-3-project-hans.png` | 項目設定：跟隨全域（繁體）／簡體／繁體，附說明 |
| `qc109-4-settings-dark.png` | 深色 |

## 自動測試

- `apps/mac/test/text-script-ui.test.ts`：選項、null 和缺欄位都算跟隨、選項與值互轉、標籤、實際字體。
- `e2e/specs/text-script.spec.ts`：
  - 預設簡體與「預設值」標註；選繁體立即寫入，`updated_at` 不再是 null。
  - 方向鍵切換；快速連續改選時以最後一次為準；重新載入後讀回服務端的值。
  - 項目：跟隨全域（繁體）改簡體，儲存前沒寫入，儲存後是 zh-Hans；再改回跟隨，變成 null。
  - 只改描述時，不動項目原本的字體。

## NOT_VERIFIED

- 英文與簡體介面的版面寬度：鍵已齊全，但沒有截圖。
- VoiceOver 實際朗讀。
