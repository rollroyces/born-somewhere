# born-somewhere v6.10

172 國真實統計人生模擬遊戲。從 1in8b.life（原作 v0.7.68 beta）的功能完整移植並擴充，**融合了 zu-pu 的族譜模組**（GEDCOM 5.5.1 雙向互通）。

> **v5.33**：zu-pu 原始 v1 已整合為本 repo 的 `zu-pu/` 子目錄（30 人張氏範例家族 + gedcom.js + index.html）。兩個部署合二為一，統一從 `rollroyces/born-somewhere` 維護。

## 部署

https://qcm8a40uzgrkv.space.mcode.cn

## 與 1in8b.life 的功能對齊

| 1in8b.life 功能 | born-somewhere 對應 | 狀態 |
|---|---|---|
| 隨機出生（含加權與人口加權）| `chooseCountry(mode)` | ✅ v4.0 |
| 9 種語言 | 9 種 i18n（含繁中/簡中/英/日/韓/越/法/泰/西） | ✅ v4.0 |
| 真實時計數器（出生/死亡）| `startRealtimeCounters()` | ✅ v5.19 |
| 推測用戶國家（依瀏覽器語言）| `guessUserCountry()` | ✅ v5.19 |
| 今日主題 | `getDailyTheme()` | ✅ v5.19 |
| 完整出生登記卡 | `buildBirthCertCard()` + `showBirthCertModal()` | ✅ v5.19 |
| 「如果你現在出生」比較表 | `renderIfBornToday()` | ✅ v5.19 |
| 國家完整統計面板（20 指標）| `renderCountryStats()` | ✅ v5.9 |
| 4 位同伴 | `generateCompanions()` | ✅ v5.8 |
| 家庭背景卡 | `renderLifeFamilyDetail()` | ✅ v5.8 |
| 完整姓名 + 出生 + 註冊號 | 全部在 meta 面板 | ✅ v5.17 |
| 4 個狀態條（健康/幸福/知識/人際）| `renderLifeStats()` | ✅ v5.8 |
| 淨資產 / PPP | `netAssets` 在 stats | ✅ v5.8 |
| 5 面向終身軌跡圖 | `renderLifeTrajectory()` | ✅ v5.15 |
| 存活曲線 | `renderSurvivalCurve()` | ✅ v5.11 |
| 人生地圖（1格=1年）| `renderLifeMap()` | ✅ v5.18 |
| 護照身分紀錄（MRZ）| `renderIdentityRecord()` | ✅ v5.18 |
| 5/15/30/50/70 暫停 + quote | `showPauseQuestion()` + `savePauseQuote()` | ✅ v5.10 |
| 每年自動事件生成 | `generateYearlyEvent()` | ✅ v5.14 |
| 手動決策面板（玩家主動選擇）| `renderManualDecisions()` | ✅ v5.16 |
| 投資管理（6 選項）| `showFinanceModal()` | ✅ v5.20 |
| 自動投資 toggle | `applyInvestmentReturn()` auto-execute | ✅ v5.20 |
| 財務管理 modal（投資/儲蓄）| 同上 | ✅ v5.20 |
| 花錢 modal（gifts/lifestyle/travel/donate）| `showSpendModal()` | ✅ v5.25 |
| 時間長度選擇（30min/1hr/1.5hr）| `lifeDuration` 動態調整 tickMs | ✅ v5.25 |
| 自動抉擇 + 快轉到下一個抉擇 | `btnAuto` + `btnSkip` + `fastForward` | ✅ v5.9 |
| ♪ 背景音樂（Web Audio 220Hz）| `toggleBackgroundMusic()` | ✅ v5.23 |
| ✎ 寫下想法 toggle | `btnThoughts` | ✅ v5.10 |
| ◐ 主題切換（light/dark/sepia）| `setTheme()` + localStorage | ✅ v5.22 |
| 💱 貨幣切換（NT$/HK$/MOP$/CNY/US）| `setCurrency()` 5 種即時換算 | ✅ v5.22 |
| 「繼續一段過去的人生」| `continueOldLife()` shelf 雙擊 | ✅ v5.22 |
| 「整理紀錄」modal | `showManageRecordsModal()` 檢視/刪除 | ✅ v5.23 |
| 「大家分享的人生」feed | `renderSharedLives()` + reactions | ✅ v5.19 |
| 追思館（蠟燭計數）| `renderMemorialWall()` + localStorage | ✅ v5.19 |
| 世界玩家地圖 | `renderActivePlayersMap()` | ✅ v5.19 |
| 訃聞 + 下載證書 PNG | `renderEnd()` + `downloadLifeCertPNG()` | ✅ v4.4 / v5.3 |
| 分享出生卡 + URL | `downloadBirthCardPNG()` + URL hash | ✅ v4.3 / v5.12 |
| 最後的時刻 replay | `replayLastMoments()` | ✅ v5.24 |
| 提供意見 modal（email+textarea）| `submitFeedback()` + localStorage | ✅ v5.24 |
| ★ 值得記住的時刻 quotes | life modal quotes list | ✅ v5.23 |
| 隱私權政策 + 使用須知 | `renderPrivacyModal()` / `renderTermsModal()` | ✅ v5.19 |
| 更新說明（changelog）| `renderChangelogModal()` | ✅ v5.19 |
| 回饋按鈕 | `renderFeedbackModal()` | ✅ v5.19 |
| PWA 加入主畫面 | `setupPWAInstall()` + manifest.json | ✅ v5.19 |
| 教學版（隱沉重事件）| `checkEduMode()` `?edu=1` | ✅ v5.19 |
| contact@born-somewhere 連結 | footer | ✅ v5.19 |
| Service Worker（離線 cache）| `sw.js` cache-first | ✅ v5.19 |
| 9 國螢幕適配（4 語言 word-break）| CSS lang 條件 | ✅ 1in8b.life 對齊 |
| 姓名 + 出生 + 註冊編號護照格式 | 全部顯示 | ✅ v5.17 + v5.18 |

## 與 zu-pu 的互通

zu-pu v1 已整合為本 repo 的 `zu-pu/` 子目錄（含 30 人張氏範例家族 + `gedcom.js` + `index.html`）。可透過以下方式匯入 born-somewhere：

1. 從 `zu-pu/data/demo.json` 用 `zu-pu/gedcom.js` 的 `Gedcom.export(DB)` 轉成 GEDCOM 5.5.1
2. 將產生的 .ged 檔透過 born-somewhere 族譜 tab 的「匯入 GEDCOM」按鈕載入
3. 透過中心人物下拉選單選「張文山」可看到完整三代家族（張守正、陳秀英為父母，已歿以 † 標示）

完整演示 born-somewhere 對 zu-pu 範例的相容性。

## 開發紀錄（v4.0 → v5.25，34 個版本）

- **v4.0** 族譜 tab + SVG 樹 + 9 語言 + Lab
- **v4.1** 真 GEDCOM + 寄養/收養 + 戰區孤兒
- **v4.2** 生命交叉事件面板
- **v4.3** shelf modal + 家族全景圖 + 共同親屬
- **v4.4** 完整 GEDCOM + 生育死亡 + Lab 家族統計 + 印度種姓 + URL 分享
- **v4.5** 跨國遷徙視覺化
- **v4.6** 完整備份機制 + wire() bug 修復
- **v4.7** life view 家族摘要小卡
- **v4.8** Lab 國家比較模式
- **v5.0** shelf 世界地圖視覺化
- **v5.1** Tree view 名字搜尋高亮
- **v5.2** life view 重新出生按鈕
- **v5.3** 訃聞下載證書 PNG
- **v5.4** 全局鍵盤快捷鍵
- **v5.5** 「?」快捷鍵說明 modal
- **v5.6** zu-pu demo 互通驗證 + README
- **v5.7** 浮動 ? FAB 按鈕
- **v5.8** 可玩性大補丁（時間 + 4 狀態條 + 家庭背景 + 4 同伴 + 淨資產）
- **v5.9** 完整國家統計面板 + 自動抉擇 + 快轉決策
- **v5.10** ✎ 寫下想法 modal 完整串接
- **v5.11** 存活曲線 SVG（國家 vs 世界平均）
- **v5.13** 放慢時間 + 年度焦點選擇 + 財務決策事件
- **v5.14** 每年自動事件生成器 + 本年事件 highlight
- **v5.15** 5 面向終身軌跡圖
- **v5.16** 移除自動彈出 + 手動決策面板
- **v5.17** meta 面板即時更新 + 詳細
- **v5.18** 人生地圖 SVG + 護照身分紀錄
- **v5.19** 1in8b.life 全套功能落地（4 sub-agent 合力）
- **v5.20** 財務管理 modal（投資 + 自動）
- **v5.22** 繼續過去人生 + 主題切換 + 貨幣切換
- **v5.23** 整理紀錄 + 背景音樂 + 值得記住的時刻
- **v5.24** 最後的時刻 replay + 提供意見 modal
- **v5.25** 時間長度選擇 + 花錢 modal
- **v5.55** 通用決策系統：24 個決策事件（大決定 / 家人共決 / 小選擇共用同一個 modal）
- **v5.59** 修掉四個死值：教育、工作、收入、幸福原本只會被單向推動
- **v5.85** 決策事件可達性校準（600 人生實測 23/24 觸發）
- **v5.88** 172 國全人口經濟校準
- **v5.89 – v6.09** 21 個缺陷修正 —— 詳見
  **[合併報告](evidence/CONSOLIDATED-v5.89-v6.09.md)**（每個缺陷都有個別證據檔）
- **v6.10** 更新說明合併：v5.20 → v6.10 的條目補進遊戲內與 `CHANGELOG.md`

> **v6.10 起的三個待辦**（都記在合併報告第五節）：
> 九語言在動態內容上仍基本是裝飾性的（`app.js` 裡 193 個 `isEn ? … : …` 有 192 個漢語退值）；
> 全景圖只畫一段人生而非真正的合併；
> 切換語言不會重譯已產生的旁白（`life.log` 存的是已翻譯字串）。

## 技術棧

- 純 HTML/CSS/JavaScript（無 build step，無 dependencies）
- 8 個資料檔：app.js、index.html、styles.css、gedcom.js、data/{countries,i18n,world-coords}.json、manifest.json、sw.js
- 跨 9 種語言 i18n（含繁中、簡中、英、日、韓、越、法、泰、西）
- 全部本地端（不上傳任何個資）
- 自動存檔（localStorage）保證中斷後可繼續

## 貢獻

基於 1in8b.life（原作，CC BY 4.0）+ zu-pu v1 的概念延伸。資料來源：聯合國《世界人口展望2024》、世界銀行 WDI、WHO、UNESCO UIS、UNDP HDR、ILO、UNAIDS、UNODC、UNICEF、生活滿意度報告2024。

## 部署

- GitHub：`rollroyces/born-somewhere` main 分支
- 正式 URL：https://qcm8a40uzgrkv.space.mcode.cn
- 含 PWA manifest，可「加到主畫面」離線使用
- 含 service worker（cache-first 策略）
- GitHub Pages + 客製 deploy node