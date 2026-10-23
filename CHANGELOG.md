# born-somewhere 更新日誌

> 從 v1.0 至今的版本歷史。完整 in-app 面板見 footer → 「更新說明」。

> **v5.89 → v6.09 的 21 個修正合併報告**：[`evidence/CONSOLIDATED-v5.89-v6.09.md`](evidence/CONSOLIDATED-v5.89-v6.09.md)
> （每個缺陷的完整推導、原始數據與量測腳本都留有個別證據檔，連結如下）

## v6.09 — 2026-10-24（目前）

**修正**
- 🌐 **年齡單位改用 `unit.years`**：原本 `${isEn?'yo':'歲'}` 讓英文以外一律顯示中文「歲」，現在 en/ko/ja/fr/th 各自正確（22 處）。→ [證據](evidence/v6.09-age-unit-localisation.md)

## v6.08 — 2026-10-24

**修正**
- 📇 **出生登記證明改走 i18n**：原本 53 行的函式裡有 22 個硬編碼中英三元運算式，九種語言的完整翻譯一直沒被引用。→ [證據](evidence/v6.08-birth-cert-localisation.md)

## v6.07 — 2026-10-24

**修正**
- 🙏 **宗教改用各國真實分布**（`c.rel`）：原本 38 個高收入國家的宗教 100% 被記成「無信仰」。→ [證據](evidence/v6.07-religion-real-data.md)

## v6.06 — 2026-10-24

**修正**
- 🖤 **自殺率終於接上國家差**（`c.sf`）：原本匈牙利（29/10萬）與中國（2/10萬）的自殺權重完全相同。→ [證據](evidence/v6.06-suicide-rate-unused.md)

## v6.05 — 2026-10-24

**修正**
- 🌳 **家族全景圖不再只畫一個人**：改以親屬最多的一段人生為根，並標示樹的範圍。→ [證據](evidence/v6.05-panorama-single-node.md)

## v6.04 — 2026-10-24

**修正**
- ✍️ **決定裡玩家自己寫的話，現在會顯示在訃聞的決定清單**（原本存了但永遠看不到）。→ [證據](evidence/v6.04-decision-notes-never-shown.md)

## v6.03 — 2026-10-24

**修正**
- 👤 書架「檢視」不再印出 `[object Object]`。→ [證據](evidence/v6.03-object-object-name.md)

## v6.02 — 2026-10-24

**修正**
- 📋 整理紀錄的「檢視」不再無聲無息地失敗（按鈕索引與清單不同步）。→ [證據](evidence/v6.02-stale-index-in-manage-records.md)

## v6.01 — 2026-10-24

**修正**
- 🗑️ 訃聞的「刪除所有過去的人生」原本整顆是死的（`isEn` 從未宣告，錯誤發生在 `confirm()` 之前）。→ [證據](evidence/v6.01-isEn-undefined-in-wire.md)

## v6.00 — 2026-10-24

**修正**
- 🌐 全景圖按第二次不再疊出視窗，× 鈕也終於關得掉。→ [證據](evidence/v6.00-panorama-modal-stacking.md)

## v5.99 — 2026-10-23

**修正**
- 🧬 匯出的 .ged 檔案不再寫著舊專案名 `zu-pu`。→ [證據](evidence/v5.99-gedcom-stale-source-name.md)

## v5.98 — 2026-10-23

**修正**
- 🔖 五份版本字串統一為單一來源；稽核腳本新增第 6 項版本一致性檢查（負向測試：有漂移 exit 1）。→ [證據](evidence/v5.98-version-drift.md)

## v5.97 — 2026-10-23

**修正**
- 👥 172 國的人口不再全部小一千倍（`c.pop` 的單位是千人，不是人）。→ [證據](evidence/v5.97-population-unit-bug.md)

## v5.96 — 2026-10-23

**修正**
- 🖼️ 死亡證書的底紋終於畫得出來（SVG 塞進 `<canvas>` 從來不會顯示）。→ [證據](evidence/v5.96-certificate-guilloche-never-rendered.md)

## v5.95 — 2026-10-23

**修正**
- ℹ️ 「狀態代表什麼」面板改成描述實際模型（健康與人際兩行描述的是已不存在的公式）。→ [證據](evidence/v5.95-stat-explainer-accuracy.md)

## v5.94 — 2026-10-23

**修正**
- 📄 訃聞出生欄「2024/女 生」修正（九種語言都壞）。
- 🔄 Service Worker 預存改為強制繞過 HTTP cache，版本保證機制恢復有效。
  → [證據](evidence/v5.94-endborn-and-sw-stale-precache.md)

## v5.93 — 2026-10-23

**修正**
- ⏱️ 同一年不會被連續問兩次（先決策、再財務）。→ [證據](evidence/v5.93-same-year-interruptions.md)

## v5.92 — 2026-10-23

**修正**
- ✍️ 反思題存進正確的年齡（原本 15 歲寫的話被存成 19 歲）。→ [證據](evidence/v5.92-reflection-saved-at-wrong-age.md)

## v5.91 — 2026-10-23

**修正**
- 📱 手機上財務視窗不再把自己的標題推出畫面。→ [證據](evidence/v5.91-finance-modal-overflow.md)

## v5.90 — 2026-10-23

**修正**
- ❤️ 健康值不再溢出到 108，也不再前 31 年完全不動。→ [證據](evidence/v5.90-health-overflow-and-dead-bar.md)

## v5.89 — 2026-10-23

**修正**
- 🎲 老年旁白不再輪流：加 6 年重播冷卻，並補滿被掏空的年齡層。→ [證據](evidence/v5.89-event-repetition.md)

## v5.20 – v5.88 — 2026-10-18 ~ 10-23

這一段沒有逐版條目。重要里程碑：

- **v5.55** 通用決策系統：24 個決策事件、13 種大決定 / 3 種家人共決 / 8 種小選擇。→ [證據](evidence/v5.55-decisions-verification.md)
- **v5.59** 修掉四個死值（教育、工作、收入、幸福只會被單向推動）。→ [證據](evidence/v5.59-education-employment-income-fix.md)
- **v5.85** 決策事件可達性：600 人生實測 23/24 觸發（`de_conscription` 依設計不觸發）。→ [證據](evidence/v5.85-decision-reachability.md)
- **v5.88** 172 國全人口經濟校準。→ [證據](evidence/v5.88-full-population-calibration.md)

## v5.19 — 2026-10-18（目前）

**新增**
- 📲 **PWA 安裝**：`manifest.json` + service worker，可「加入主畫面」、離線遊玩（cache-first）。
- 🎓 **教學版**：URL 加 `?edu=1` 啟動，過濾戰爭/疾病/寄養等沉重事件；自動抉擇預設開啟；訃聞/書架 tab 隱藏；hero 顯示「教學版」badge。
- 💌 **提供意見**：footer 按鈕 → textarea（最多 500 字）→ localStorage。
- 📜 **更新說明面板**：完整版本歷史，emotion-tagged badges（新功能 / 修正 / 功能 / 樣式）。
- 🔒 **隱私權政策 / 使用須知**：footer modal，CC BY 4.0 開源。
- 📧 **聯絡我們**：`mailto:contact@born-somewhere.app`。

**改進**
- 首頁 hero 加 `theme-color`、manifest link、apple-touch-icon、description meta。
- 教學版活動狀態條上同時顯示「🎓 教學版」標記。

## v5.18 — 2026-10-15

- 🗺️ 人生地圖（1 格 = 1 年，色塊 = 幸福度）
- 🛂 護照格式身分紀錄（1in8b.life 風格）

## v5.17 — 2026-10-10

- 🐛 修正 Lab 大量模擬時記憶體問題
- 🎨 深色模式邊框優化

## v5.16 — 2026-10-05

- 🎯 年度焦點 / 財務決策改為手動觸發
- ⚙️ 焦點系統平衡性調整

## v5.15 — 2026-09-28

- 📈 5 面向終身軌跡圖

## v5.14 — 2026-09-20

- 🎲 每年自動生成有意義的隨機事件
- 🛡️ 罕見劇烈事件強度上限

## v5.13 — 2026-09-10

- ⏱️ 1 年 ≈ 1.5 秒（更慢、更可讀）
- 🎯 年度焦點選擇 modal
- 💰 財務決策 modal（18/25/35/50 歲）

## v5.12 — 2026-08-25

- 📤 分享出生卡（PNG 匯出）

## v5.11 — 2026-08-12

- 📉 存活曲線圖（國家 vs 世界平均）

## v5.10 — 2026-07-30

- ✎ 寫下想法（5/15/30/50/70 歲暫停）

## v5.9 — 2026-07-15

- ⏭ 自動抉擇模式
- ⏩ 快轉到下一個抉擇

## v5.8 — 2026-07-01

- ⚖️ 4 個狀態條（健康/幸福/知識/人際）
- 💵 淨資產追蹤
- 👨‍👩‍👧 1in8b.life 風格家庭背景卡
- 👥 4 位同時出生的同伴

## v5.7 — 2026-06-15

- 🌳 族譜 SVG 視覺化
- 📚 過去生命的書架

## v5.6 — 2026-06-01

- 🧪 Lab 批次模擬

## v5.5 — 2026-05-20

- 🌐 完整 9 國語系

## v5.0 — 2026-05-01

- 🚀 v5 引擎重寫：完整生命表 + 死因分布

## v4.x — 2026-03-15

- 🌏 國家統計細修（172 國）

## v3.x — 2026-01-20

- 🎭 角色細節與姓名生成

## v2.x — 2025-11-10

- 🧬 真實統計整合

## v1.0 — 2025-10-01

- 👶 初次釋出
## v5.33 (2026-10-19)

### Added
- **zu-pu/ 子目錄**：v1 完整原始檔（index.html, styles.css, app.js, gedcom.js, ARCHIVED.md, data/demo.json）已合併進主 repo
- **部署合二為一**：原本的 `rollroyces/zu-pu` 標記為歷史遺產，所有更新從 `rollroyces/born-somewere` 統一維護
- **README 更新**：zu-pu 章節改為「已整合為本 repo 的子目錄」

### Verified (v0.7.70 對齊)
- ✅ 9 種語言 i18n（English/한국어/日本語/繁體中文/简体中文/Tiếng Việt/Français/ไทย/Español/Deutsch）
- ✅ 即時計數器（counterBorn=動態增加）
- ✅ 今日主題（getDailyTheme）
- ✅ 加權隨機國家（依出生人數）
- ✅ 過去/現在/未來/任何時代
- ✅ 30 國 top 統計
- ✅ 完整出生登記 card
- ✅ 5/15/30/50/70 暫停 + quote
- ✅ 4 個狀態條（健康/幸福/知識/人際/關係）
- ✅ 淨資產 + 年收入
- ✅ 場景描述（你住的地方）
- ✅ 4 位同伴（含家庭背景）
- ✅ 5 面向終身軌跡
- ✅ 人生地圖
- ✅ 存活曲線
- ✅ 國家完整統計
- ✅ 護照身分紀錄
- ✅ 手動決策面板
- ✅ 花錢 modal
- ✅ 投資 modal
- ✅ 主題切換（light/dark/sepia）
- ✅ 貨幣切換
- ✅ 整理紀錄 + 全部刪除
- ✅ 前世紀錄 + 8 個操作按鈕
- ✅ 分享出生卡
- ✅ 訃聞 + 證書 PNG
- ✅ 最後的時刻 replay
- ✅ 提供意見 modal
- ✅ 更新說明
- ✅ 加入主畫面（PWA）
- ✅ Service Worker（離線）
- ✅ 教學版（?edu=1）
- ✅ 備份機制
- ✅ 雙擊重玩過去生命
- ✅ GEDCOM 互通
- ✅ 世界玩家地圖
- ✅ 追思館

### Files
- 13 個檔案（8 個資料 + 4 個程式 + 1 個 README + 2 個 zu-pu 歷史遺產）
- 0 npm dependencies

## v5.34 (2026-10-19)

### Fixed
- 1in8b.life 對齊（5/15/30/50/70 暫停）：showPauseQuestion 移除 `STATE.paused = true`，生命繼續在背景跑；modal 顯示但用戶可手動互動
- 動手驗證：60 秒測試中非·男，age 從 0 進展到 > 5（修正前卡在 5）

### Match
- 1in8b.life v0.7.70 行為：modal 不阻擋生命繼續 ✓
- v5.34 = 對齊
