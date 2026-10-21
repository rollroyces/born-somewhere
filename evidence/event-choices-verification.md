# v5.54 — Event-Choice Verification

**Question (user):** "can they make choices in the happen event like the orginial one"

**Date:** 2026-10-21
**Live URL tested:** https://qcm8a40uzgrkv.space.mcode.cn/?bust=2 (v5.54 deployed)

## Result: ✅ Yes — choices work end-to-end.

The simulation pauses at designated ages and pops up modals with 3–6 mutually-exclusive buttons. Clicking one closes the modal AND resumes the ticker (a regression in this path was fixed in v5.51–v5.52; this run confirms the fix holds across multiple modal types).

## Traces captured during one run

1. **intro → birthCertModal**
   - Click `#btnStart` (出 生) → `birthCertModal` opens
   - Click `#birthCertConfirm` (開始這段人生) → `STATE.view='life'`, age=19, simulation begins

2. **focusModal at age 25** (yearly from age 6+, only 25 fired during this observation window)
   - Question: `25 歲——這一年你想把重心放在哪？`
   - 4 options rendered: `💼 職場發展`, `👨‍👩‍👧 建立家庭`, `🏃 健康管理`, `📚 自我進修`
   - Clicked `data-focus="work"` → `STATE.life.focus='work'`, modal closed (`hidden=true`), `paused=false`, age advanced 25 → 47

3. **financeModal at age 47** (fires at 25/30/35/40/45/50/55/60)
   - 6 options rendered: `🏦 存款`, `📜 債券`, `📊 股債各半基金`, `📈 股票（指數）`, `🌐 全球指數`, `🎲 自行選股買賣`, plus `▶ 自動進行`
   - Clicked `data-id="bonds"` → modal closed, age advanced 47 → 87, `STATE.life.finance` updated

4. **pauseModal at age 70** (intermittent reflection prompt)
   - Visible in screenshot: "如果 70 歲的你能記得一件事⋯" with two actions: `略過` / `留下這句話`
   - Classified by the original as "잠시 멈춤" (brief pause) — passive optional quote save

5. **end view at age 87**
   - `cause='心血管'`, `view='end'` — natural death shown
   - Decisions accumulated throughout life remain in `STATE.life.focus` and `STATE.life.finance`

## Modal close paths all resume the ticker (v5.51–v5.52 fix held)

- ✅ Click choice button → `closeModal()` → ticker resumes
- ✅ (not exercised this run: click ×, overlay, Escape — all wired through the same `closeModal(id)` in `app.js:42`)

## Gap vs the original

The original `1in8b.life` fires `decFa`/`.dec` decisions at many more points:
- Major decisions (`중대 결정`): marriage timing, parental care, illness treatment, immigration, debt restructure, job change
- Small choices (`작은 선택`): wallet vs. save pocket money, friends vs. solo weekend, etc. — see `app.js` `sm_*` family
- Pause reflection (`잠시 멈춤`): textarea +1 question (we have this)
- Family-together (`가족과 함께 정해요`)

Each of those would let the user pick a path. In our build, only **focus**, **finance**, **spend**, and **pause-question** are interactive; everything else is silent (and goes through statistical rolls). Filling the gap means writing a generic decision modal and ~30+ event hookers.

This verification does NOT include the "decision density" gap — see the follow-up question to the user before any new code work.
