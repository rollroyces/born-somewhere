/* born-somewhere v2
   人生模擬遊戲：選一個出生地（172 國真實統計），從 0 歲活到當地平均壽命。
   參考原作 1in8b.life 的生命表、死因分布、決策點等核心機制。
   引擎是獨立重寫，不含原作程式碼。
*/

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const STORAGE_KEY = 'born-somewhere-v2';

let COUNTRIES = [];
let I18N = {};
let LANG = 'zh-Hant';
let CACHE = { countries: null, i18n: null };

const STATE = {
  view: 'intro',
  era: 'now',          // 'now' | 'past' | 'future'
  birthMode: 'baby',   // 'baby' | 'all' (此刻出生 vs 80億人活口)
  selectedCountry: null,
  life: null,
  paused: false,
  speed: 1,
  tickMs: 1500,  // v5.13：1 年 ≈ 1.5 秒（慢到能讀事件；8× 時約 15 秒跑完一生）
              // v5.25：依生命長度選擇（30min/1hr/1.5hr）動態調整 → 改為 STATE.lifeDurationMs
  ticker: null,
  pendingDecision: null,
  autoDecide: false,  // v5.9 新增：自動抉擇模式
  fastForward: false, // v5.9 新增：快轉到下一個抉擇
  sharedShown: 8,    // v5.80：書架「共享人生」先顯示幾張
  shelfShown: 12,    // v5.81：書架「書本」先顯示幾本
  thoughtsEnabled: true, // v5.10：✎ 寫下想法 啟用（5/15/30/50/70 暫停時彈出 modal）
  pastLives: [],
  modal: null,
  eduMode: false,      // v5.19：教學版（?edu=1）— 過濾沉重事件、隱藏訃聞/書架
  softMode: false,     // v5.39：略過可怕的情節（1in8b.life 的 softBtn）— 可即時切換並記住
};

/* ==== v5.51：統一關閉 modal — 一定要解除暫停 ====
   過去每個 modal 各自在「選項點擊」時設 STATE.paused = false，但若使用者按 ×、
   點背景、或按空白鍵關閉，就沒有人把 paused 設回 false，tick() 便永久卡住，
   人生會停在該年不動。所有關閉路徑一律經過 closeModal()。 */
const PAUSING_MODALS = ['focusModal', 'financeModal', 'spendModal', 'pauseModal', 'decisionModal'];
function closeModal(id) {
  const el = id ? document.getElementById(id) : null;
  const wasOpen = el ? !el.hasAttribute('hidden') : false;
  // v5.73：決策 modal 若是被關掉（而非點選項），記成 skipped
  if (id === 'decisionModal' && wasOpen) {
    dismissDecision(STATE.pendingDecision?.id, STATE.pendingDecision?.age);
  }
  if (el) el.setAttribute('hidden', '');
  else PAUSING_MODALS.forEach(i => document.getElementById(i)?.setAttribute('hidden', ''));
  if (STATE.paused) {
    STATE.paused = false;
    const p = $('#btnPause');
    if (p) p.textContent = '❚❚';
    // v5.68：paused 在這裡被清掉，暫停鈕的圖示與 tooltip 也要跟著更新
    if (typeof syncPauseBtn === 'function') syncPauseBtn();
  }
  return el;
}

/* ==== v5.55：通用決策 modal（重大決定 / 小選擇 / 家人共決 三種版型共用） ====
   設計：showDecision() 一次塞入內容、綁定選項點擊，每個選項帶 apply(life, ctx)
        函式處理效果；關 modal 一律走 closeModal('decisionModal') 確保 tick 恢復。
   state 結構：
     STATE.pendingDecision = { kind: 'decision', id: 'de_xxx', age, choices: [...] }
     STATE.life.decisions  = [ { id, age, key } ]   // 已答過的決策避免重複 */
let _decisionBound = false;
/* v5.73：決策被「關掉但沒選」時要記成已處理。
   實測問題：25 歲那年同時是決策年與財務年，玩家對決策按 Escape ——
   決策有關掉、tick 也恢復了，但財務 modal 立刻補上來，玩家看到「按了沒反應」。
   修法：Escape / × / 點背景關掉決策時，把它記成 skipped，
   這樣 STATE.pendingDecision 清乾淨、tryTriggerDecision 的 done 集合也認得它已處理。 */
function dismissDecision(id, age) {
  if (!id) return;
  STATE.pendingDecision = null;
  const life = STATE.life;
  if (!life) return;
  life.decisions = life.decisions || [];
  if (life.decisions.some(d => d.id === id)) return;   // 已經答過了（例如 autoDecide）
  life.decisions.push({ id, age: age ?? life.age, key: 'skipped', note: '' });
  life.lastDecisionAge = age ?? life.age;               // 也吃冷卻期，避免下一年就補一個
}

function showDecision({ id, kind, age, title, body, fact, hint, choices, hasNote }) {
  const modal = $('#decisionModal');
  if (!modal) return false;
  // 防止重複觸發（避免連續年度同 ID 觸發兩次）
  if (modal && !modal.hasAttribute('hidden')) return false;
  if (!choices || choices.length === 0) return false;
  STATE.pendingDecision = { kind: 'decision', id, age, options: choices.length };
  STATE.paused = true;

  const kindLabel = { big: t('dec.kind.big'), small: t('dec.kind.small'), family: t('dec.kind.family'), pause: t('dec.kind.pause') }[kind] || t('dec.kind.big');
  $('#decisionKind').textContent = kindLabel + ' · ' + age + t('unit.years') + ' · ' + (STATE.life.year + STATE.life.yearOffset);
  $('#decisionTitle').textContent = title;
  $('#decisionBody').textContent = body || '';
  if (fact) { $('#decisionFact').textContent = fact; $('#decisionFact').hidden = false; }
  else { $('#decisionFact').hidden = true; }
  if (hint) { $('#decisionHint').textContent = hint; $('#decisionHint').hidden = false; }
  else { $('#decisionHint').hidden = true; }

  const noteWrap = $('#decisionNoteWrap');
  const note = $('#decisionNote');
  if (hasNote) {
    noteWrap.hidden = false;
    note.value = '';
    note.placeholder = t('dec.note.placeholder');
  } else {
    noteWrap.hidden = true;
  }

  const bodyEl = $('#decisionChoices');
  bodyEl.innerHTML = choices.map((c, i) => `
    <button type="button" class="dec-c" data-k="${escAttr(c.k)}" data-i="${i}">
      <span class="dec-c-k">${esc(c.label)}</span>
      ${c.sub ? `<span class="dec-c-sub">${esc(c.sub)}</span>` : ''}
    </button>`).join('');

  bodyEl.querySelectorAll('.dec-c').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k;
      const i = +btn.dataset.i;
      const choice = choices[i];
      const noteText = hasNote ? (note.value || '').trim() : '';
      // 套用效果
      try { choice.apply && choice.apply(STATE.life, { note: noteText }); } catch (e) { console.warn('decision apply failed', id, k, e); }
      // 記錄（v5.78：連 label / icon 一起存，訃聞頁才組得出這一生做過的決定）
      STATE.life.decisions = STATE.life.decisions || [];
      STATE.life.decisions.push({ id, age, key: k, label: choice.label, icon: choice.icon || '', note: noteText, lang: LANG });
      // 寫進 log（讓使用者往後看得到）
      STATE.life.log.push({ age, kind: 'decision', icon: choice.icon || '✦', text: title + ' → ' + choice.label });
      logLife(t('dec.log', choice.label));
      // 若使用者停用了 autoDecide，pendingDecision 在 closeModal 後會被忽略；
      // 不影響 ticker 因為 pause 已解除
      closeModal('decisionModal');
    });
  });

  // v5.55：自動抉擇模式 — 立即套用第一個選項並關閉，不打斷 ticker
  if (STATE.autoDecide) {
    STATE.pendingDecision = null;
    const first = choices[0];
    STATE.life.decisions = STATE.life.decisions || [];
    STATE.life.decisions.push({ id, age, key: first.k, note: '（自動抉擇）' });
    try { first.apply && first.apply(STATE.life, { note: '' }); } catch (e) { console.warn('auto-decide apply failed', id, e); }
    STATE.life.log.push({ age, kind: 'decision', icon: first.icon || '✦', text: title + ' → ' + first.label + '（自動）' });
    modal.setAttribute('hidden', '');
    return true;
  }

  modal.removeAttribute('hidden');
  // 焦點移到第一個選擇（鍵盤友好）
  setTimeout(() => bodyEl.querySelector('.dec-c')?.focus(), 50);
  return true;
}

/* 內容裡需要把 title、body 之類的字串塞進 innerHTML — 統一用這個轉義 */
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[m]);
}
function escAttr(s) { return esc(s); }

/* ==== v5.55：通用決策事件表 ====
   每個事件是一個物件：{ id, kind, chance(life), show(life) }，
     - chance(life) 是每年 tick 進入時的觸發機率（純粹年齡／狀態機率）
     - show(life) 才真正塞內容到 modal
   每個 choice = { k, label, sub, apply(life, ctx) }
   apply 不會 throw；失敗也要關 modal、不卡 tick。 */
/* v5.60：家屬存活狀態改為「按年份推算」，不再讀 p.alive。
   generateFamily() 只寫 birth / death 年份，從來沒有設過 alive，
   所以 `parents.some(p => p.alive)` 永遠是 undefined → falsy，
   de_parents_care 與 de_inheritance 兩個事件形同虛設（永久不會觸發）。
   現在改成用他們實際擁有的年份資料推算。 */
function isAliveAt(person, year) {
  if (!person) return false;
  const b = person.birth?.year;
  if (b == null || b > year) return false;
  const d = person.death?.year;
  return d == null || d > year;
}
function anyParentAlive(life) {
  if (!life?.family?.parents) return false;
  const year = (life.year || 0) + (life.yearOffset || 0);
  return life.family.parents.some(p => isAliveAt(p, year));
}

const DECISIONS = [
  // 1. 失業：要不要接受一份外地工作？
  {
    id: 'de_relocate', kind: 'big',
    chance: (life) => life.age >= 25 && life.age <= 50 &&
                     life.stats.employment === 'employed' &&
                     Math.random() < 0.06,
    show: (life) => ({
      title: t('de.relocate.title'),
      body: t('de.relocate.body', life.countryData?.ko || ''),
      fact: t('de.relocate.fact'),
      choices: [
        { k: 'go', icon: '✈️',
          label: t('de.relocate.go'),
          sub: t('de.relocate.go.sub'),
          apply: (life) => { life.stats.netAssets += 8000; life.stats.happiness -= 4; life.stats.social -= 3; logLife(t('de.relocate.go.log')); } },
        { k: 'stay', icon: '🏠',
          label: t('de.relocate.stay'),
          sub: t('de.relocate.stay.sub'),
          apply: () => { logLife(t('de.relocate.stay.log')); } },
      ],
    }),
  },

  // 2. 中年身心健康：戒菸 / 戒酒 vs. 維持
  {
    id: 'de_health_warning', kind: 'big',
    chance: (life) => life.age >= 30 && life.age <= 55 &&
                     (Math.random() < 0.05),
    show: (life) => ({
      title: t('de.health.title'),
      body: t('de.health.body'),
      fact: t('de.health.fact'),
      choices: [
        { k: 'quit', icon: '🧘',
          label: t('de.health.quit'),
          sub: t('de.health.quit.sub'),
          apply: (life) => { life.stats.health += 8; life.stats.happiness -= 2; logLife(t('de.health.quit.log')); } },
        { k: 'keep', icon: '🚬',
          label: t('de.health.keep'),
          sub: t('de.health.keep.sub'),
          apply: () => { logLife(t('de.health.keep.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 3. 通膨惡化：把錢換成美元/黃金 vs. 留現金
  {
    id: 'de_inflation', kind: 'big',
    chance: (life) => life.age >= 40 && life.age <= 70 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.inflation.title'),
      body: t('de.inflation.body'),
      fact: t('de.inflation.fact'),
      choices: [
        { k: 'dollar', icon: '💵',
          label: t('de.inflation.dollar'),
          sub: t('de.inflation.dollar.sub'),
          apply: (life) => { life.stats.netAssets *= 1.15; life.stats.happiness -= 1; logLife(t('de.inflation.dollar.log')); } },
        { k: 'hold', icon: '🏦',
          label: t('de.inflation.hold'),
          sub: t('de.inflation.hold.sub'),
          apply: (life) => { life.stats.netAssets *= 0.85; logLife(t('de.inflation.hold.log')); } },
      ],
    }),
  },

  // 4. 重病：治療 6 個月 vs. 撐著
  {
    id: 'de_illness_treat', kind: 'big',
    chance: (life) => !STATE.eduMode && !STATE.softMode &&
                     life.age >= 38 && life.age <= 70 &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.illness.title'),
      body: t('de.illness.body'),
      fact: t('de.illness.fact'),
      choices: [
        { k: 'treat', icon: '💊',
          label: t('de.illness.treat'),
          sub: t('de.illness.treat.sub'),
          apply: (life) => { life.stats.health += 5; life.stats.netAssets -= 4000; logLife(t('de.illness.treat.log')); } },
        { k: 'wait', icon: '⏳',
          label: t('de.illness.wait'),
          sub: t('de.illness.wait.sub'),
          apply: (life) => { life.stats.health -= 3; logLife(t('de.illness.wait.log')); } },
      ],
    }),
  },

  // 5. 父母行動不便：接過來同住 vs. 找看護 vs. 讓親戚照顧
  {
    id: 'de_parents_care', kind: 'big',
    chance: (life) =>
                     // v5.85：視窗原本是 45–75，但實測父母大約在你 40 歲前後就過世了
                     // （generateFamily 給父親 +70、母親 +75 年的壽命），
                     // 45 歲以後幾乎沒有任何人生還有活著的��親 — 這個事件從未出現。
                     // 改成 40–58：這才是「父母開始需要照顧」的實際年齡區間。
                     life.age >= 40 && life.age <= 58 &&
                     anyParentAlive(life) &&
                     Math.random() < 0.08,
    show: (life) => ({
      title: t('de.parents.title'),
      body: t('de.parents.body'),
      fact: t('de.parents.fact'),
      choices: [
        { k: 'home', icon: '🏡',
          label: t('de.parents.home'),
          sub: t('de.parents.home.sub'),
          apply: (life) => { life.stats.happiness += 5; life.stats.netAssets -= 6000; logLife(t('de.parents.home.log')); } },
        { k: 'nurse', icon: '🏥',
          label: t('de.parents.nurse'),
          sub: t('de.parents.nurse.sub'),
          apply: (life) => { life.stats.netAssets -= 8000; life.stats.happiness -= 1; logLife(t('de.parents.nurse.log')); } },
        { k: 'kin', icon: '👪',
          label: t('de.parents.kin'),
          sub: t('de.parents.kin.sub'),
          apply: () => { logLife(t('de.parents.kin.log')); } },
      ],
    }),
  },

  // 6. 婚姻觸礁：為了孩子撐著 vs. 分居 vs. 離婚
  {
    id: 'de_divorce', kind: 'big',
    chance: (life) => life.stats && life.stats.married &&
                     life.age >= 32 && life.age <= 55 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.divorce.title'),
      body: t('de.divorce.body'),
      fact: t('de.divorce.fact'),
      choices: [
        { k: 'stay', icon: '🤝',
          label: t('de.divorce.stay'),
          sub: t('de.divorce.stay.sub'),
          apply: (life) => { life.stats.happiness -= 6; logLife(t('de.divorce.stay.log')); } },
        { k: 'separate', icon: '🛏️',
          label: t('de.divorce.separate'),
          sub: t('de.divorce.separate.sub'),
          apply: (life) => { life.stats.netAssets *= 0.6; life.stats.happiness += 2; logLife(t('de.divorce.separate.log')); } },
        { k: 'final', icon: '📜',
          label: t('de.divorce.final'),
          sub: t('de.divorce.final.sub'),
          apply: (life) => { life.stats.married = false; life.stats.partner = null; life.stats.netAssets *= 0.5; life.stats.happiness += 4; logLife(t('de.divorce.final.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 7. 換工作：現職 vs. 朋友介紹的高風險高報酬
  {
    id: 'de_job_change', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.job.title'),
      body: t('de.job.body'),
      fact: t('de.job.fact'),
      choices: [
        { k: 'stay', icon: '💼',
          label: t('de.job.stay'),
          sub: t('de.job.stay.sub'),
          apply: () => { logLife(t('de.job.stay.log')); } },
        { k: 'jump', icon: '🚀',
          label: t('de.job.jump'),
          sub: t('de.job.jump.sub'),
          apply: (life) => { life.stats.netAssets *= (Math.random() < 0.5 ? 1.4 : 0.7); life.stats.happiness += (Math.random() < 0.5 ? 4 : -4); logLife(t('de.job.jump.log')); } },
      ],
    }),
  },

  // 8. 兵役/徵召：自願 vs. 抽籤 vs. 良心拒服
  {
    id: 'de_conscription', kind: 'big',
    chance: (life) => life.age >= 18 && life.age <= 25 &&
                     life.stats.sex === 'M' &&
                     ['KOR','TWN','ISR','SGP','CHN','RUS'].includes(life.country) &&
                     Math.random() < 0.10,
    show: (life) => ({
      title: t('de.conscript.title'),
      body: t('de.conscript.body'),
      fact: t('de.conscript.fact'),
      choices: [
        { k: 'volunteer', icon: '🪖',
          label: t('de.conscript.volunteer'),
          sub: t('de.conscript.volunteer.sub'),
          apply: (life) => { life.stats.netAssets += 2000; life.stats.happiness += 1; life.stats.health -= 2; logLife(t('de.conscript.volunteer.log')); } },
        { k: 'lottery', icon: '🎲',
          label: t('de.conscript.lottery'),
          sub: t('de.conscript.lottery.sub'),
          apply: (life) => {
            if (Math.random() < 0.5) { life.stats.netAssets += 2000; life.stats.health -= 2; logLife(t('de.conscript.lottery.go')); }
            else { logLife(t('de.conscript.lottery.skip')); }
          } },
        { k: 'object', icon: '✋',
          label: t('de.conscript.object'),
          sub: t('de.conscript.object.sub'),
          apply: (life) => { life.stats.happiness += 3; logLife(t('de.conscript.object.log')); } },
      ],
    }),
  },

  // 9. 小選擇：要不要把一筆意外之財分給家人
  {
    id: 'de_lottery', kind: 'small',
    chance: (life) => life.age >= 25 && life.age <= 65 &&
                     Math.random() < 0.03,
    show: (life) => ({
      title: t('de.lottery.title'),
      body: t('de.lottery.body'),
      fact: t('de.lottery.fact'),
      choices: [
        { k: 'keep', icon: '💰',
          label: t('de.lottery.keep'),
          sub: t('de.lottery.keep.sub'),
          apply: (life) => { life.stats.netAssets += 5000; life.stats.happiness += 3; logLife(t('de.lottery.keep.log')); } },
        { k: 'share', icon: '🎁',
          label: t('de.lottery.share'),
          sub: t('de.lottery.share.sub'),
          apply: (life) => { life.stats.netAssets += 2000; life.stats.social += 5; life.stats.happiness += 5; logLife(t('de.lottery.share.log')); } },
        { k: 'donate', icon: '❤️',
          label: t('de.lottery.donate'),
          sub: t('de.lottery.donate.sub'),
          apply: (life) => { life.stats.netAssets += 1000; life.stats.happiness += 8; logLife(t('de.lottery.donate.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 10. 心理健康：找諮商 vs. 撐著
  {
    id: 'de_mental_health', kind: 'big',
    chance: (life) => !STATE.eduMode &&
                     life.age >= 25 && life.age <= 70 &&
                     // v5.85：門檻是照著「實際量到的分布」訂的，不是拍腦袋。
                     // v5.59 設 < 55，但實測 25–70 歲的 happiness 每年取樣 4,537 筆：
                     //   p01=57.6  p05=60.9  p10=62.9  p50=65.2
                     // 55 低於 p01，等於這個事件永遠不會發生（實測 120 條人生 0 次）。
                     // 改成 < 62（約落在底端 6–8%），配合 6% 擲骰，
                     // 大約 15–20% 的人生會在某一年的某個時刻遇到一次低潮。
                     // 註：happy 分布偏窄（57–65）是幸福回歸模型本身的特性，
                     // 要拉寬分布得改那個模型，會連動淨資產／收入的數字，另行評估。
                     life.stats.happiness < 62 &&
                     Math.random() < 0.06,
    show: (life) => ({
      title: t('de.mental.title'),
      body: t('de.mental.body'),
      fact: t('de.mental.fact'),
      choices: [
        { k: 'therapy', icon: '🛋️',
          label: t('de.mental.therapy'),
          sub: t('de.mental.therapy.sub'),
          apply: (life) => { life.stats.happiness += 12; life.stats.netAssets -= 1500; logLife(t('de.mental.therapy.log')); } },
        { k: 'tough', icon: '💪',
          label: t('de.mental.tough'),
          sub: t('de.mental.tough.sub'),
          apply: () => { logLife(t('de.mental.tough.log')); } },
      ],
      hasNote: true,
    }),
  },

  // 11. 買房 vs 租房（30-55）
  {
    id: 'de_buy_home', kind: 'big',
    chance: (life) => life.age >= 30 && life.age <= 55 &&
                     life.stats.employment === 'employed' &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.home.title'),
      body: t('de.home.body'),
      fact: t('de.home.fact'),
      choices: [
        { k: 'buy', icon: '🏠',
          label: t('de.home.buy'),
          sub: t('de.home.buy.sub'),
          apply: (life) => { life.stats.netAssets -= 20000; life.stats.social += 1; logLife(t('de.home.buy.log')); } },
        { k: 'rent', icon: '🔑',
          label: t('de.home.rent'),
          sub: t('de.home.rent.sub'),
          apply: (life) => { life.stats.netAssets += 5000; life.stats.happiness += 1; logLife(t('de.home.rent.log')); } },
        { k: 'share', icon: '🏘️',
          label: t('de.home.share'),
          sub: t('de.home.share.sub'),
          apply: (life) => { life.stats.netAssets -= 6000; life.stats.social += 5; life.stats.happiness += 3; logLife(t('de.home.share.log')); } },
      ],
    }),
  },

  // 12. 借錢給親友（25-65）
  {
    id: 'de_loan_request', kind: 'family',
    chance: (life) => life.age >= 25 && life.age <= 65 &&
                     Math.random() < 0.07,
    show: (life) => ({
      title: t('de.loan.title'),
      body: t('de.loan.body'),
      fact: t('de.loan.fact'),
      choices: [
        { k: 'give', icon: '🤝',
          label: t('de.loan.give'),
          sub: t('de.loan.give.sub'),
          apply: (life) => { life.stats.netAssets -= 4000; life.stats.social += 6; logLife(t('de.loan.give.log')); } },
        { k: 'refuse', icon: '🚫',
          label: t('de.loan.refuse'),
          sub: t('de.loan.refuse.sub'),
          apply: () => { logLife(t('de.loan.refuse.log')); } },
        { k: 'help_otherwise', icon: '💡',
          label: t('de.loan.help_otherwise'),
          sub: t('de.loan.help_otherwise.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 2; logLife(t('de.loan.help_otherwise.log')); } },
      ],
    }),
  },

  // 13. 給自己放個長假（28-50）
  {
    id: 'de_sabbatical', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.sabbatical.title'),
      body: t('de.sabbatical.body'),
      fact: t('de.sabbatical.fact'),
      choices: [
        { k: 'take_it', icon: '🌴',
          label: t('de.sabbatical.take_it'),
          sub: t('de.sabbatical.take_it.sub'),
          apply: (life) => { life.stats.happiness += 8; life.stats.health += 4; life.stats.netAssets -= 8000; logLife(t('de.sabbatical.take_it.log')); } },
        { k: 'push', icon: '💼',
          label: t('de.sabbatical.push'),
          sub: t('de.sabbatical.push.sub'),
          apply: (life) => { life.stats.netAssets += 6000; life.stats.knowledge += 2; logLife(t('de.sabbatical.push.log')); } },
      ],
    }),
  },

  // 14. 長輩留下事業 / 遺產（40-80）
  {
    id: 'de_inheritance', kind: 'big',
    chance: (life) => life.age >= 40 && life.age <= 80 &&
                     anyParentAlive(life) &&
                     Math.random() < 0.04,
    show: (life) => ({
      title: t('de.inherit.title'),
      body: t('de.inherit.body'),
      fact: t('de.inherit.fact'),
      choices: [
        { k: 'keep', icon: '🏛️',
          label: t('de.inherit.keep'),
          sub: t('de.inherit.keep.sub'),
          apply: (life) => { life.stats.netAssets += 15000; life.stats.employment = 'family_biz'; logLife(t('de.inherit.keep.log')); } },
        { k: 'sell', icon: '💰',
          label: t('de.inherit.sell'),
          sub: t('de.inherit.sell.sub'),
          apply: (life) => { life.stats.netAssets += 80000; life.stats.happiness -= 2; logLife(t('de.inherit.sell.log')); } },
        { k: 'split', icon: '👨‍👩‍👧',
          label: t('de.inherit.split'),
          sub: t('de.inherit.split.sub'),
          apply: (life) => { life.stats.netAssets += 5000; life.stats.social += 8; logLife(t('de.inherit.split.log')); } },
      ],
    }),
  },

  // 15. 非父母親屬需要照顧（姑姑 / 阿姨）(35-65)
  {
    id: 'de_care_relative', kind: 'family',
    chance: (life) => life.age >= 35 && life.age <= 65 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.relative.title'),
      body: t('de.relative.body'),
      fact: t('de.relative.fact'),
      choices: [
        { k: 'take_in', icon: '🏡',
          label: t('de.relative.take_in'),
          sub: t('de.relative.take_in.sub'),
          apply: (life) => { life.stats.netAssets -= 5000; life.stats.social += 4; life.stats.happiness -= 1; logLife(t('de.relative.take_in.log')); } },
        { k: 'facility', icon: '🏥',
          label: t('de.relative.facility'),
          sub: t('de.relative.facility.sub'),
          apply: (life) => { life.stats.netAssets -= 10000; life.stats.social += 2; logLife(t('de.relative.facility.log')); } },
        { k: 'kin_share', icon: '👪',
          label: t('de.relative.kin_share'),
          sub: t('de.relative.kin_share.sub'),
          apply: (life) => { life.stats.social += 3; logLife(t('de.relative.kin_share.log')); } },
      ],
    }),
  },

  // 16. 公司晉升但要搬家（28-50, 在職）
  {
    id: 'de_promotion', kind: 'big',
    chance: (life) => life.stats.employment === 'employed' &&
                     life.age >= 28 && life.age <= 50 &&
                     Math.random() < 0.05,
    show: (life) => ({
      title: t('de.promotion.title'),
      body: t('de.promotion.body'),
      fact: t('de.promotion.fact'),
      choices: [
        { k: 'take', icon: '📈',
          label: t('de.promotion.take'),
          sub: t('de.promotion.take.sub'),
          apply: (life) => { life.stats.netAssets += 4000; life.stats.knowledge += 3; life.stats.social -= 2; logLife(t('de.promotion.take.log')); } },
        { k: 'decline', icon: '🚪',
          label: t('de.promotion.decline'),
          sub: t('de.promotion.decline.sub'),
          apply: (life) => { life.stats.happiness += 2; logLife(t('de.promotion.decline.log')); } },
        { k: 'negotiate', icon: '🤝',
          label: t('de.promotion.negotiate'),
          sub: t('de.promotion.negotiate.sub'),
          apply: (life) => { if (Math.random() < 0.5) { life.stats.netAssets += 2000; life.stats.happiness += 1; logLife(t('de.promotion.negotiate.ok')); } else { logLife(t('de.promotion.negotiate.no')); } } },
      ],
      hasNote: true,
    }),
  },

  // ===== v5.57：小型日常選擇（對齊原作 sm_* 家族）=====
  // 這些不是轉折點，而是讓人生「有紋理」的小決定；低頻、影響小、選項樸素。

  // 17. 週末怎麼度過（18-75）
  {
    id: 'sm_weekend', kind: 'small',
    chance: (life) => life.age >= 18 && life.age <= 75 && Math.random() < 0.10,
    show: () => ({
      title: t('sm.weekend.title'),
      body: t('sm.weekend.body'),
      choices: [
        { k: 'friends', icon: '🍻',
          label: t('sm.weekend.friends'),
          sub: t('sm.weekend.friends.sub'),
          apply: (life) => { life.stats.social += 4; life.stats.happiness += 3; life.stats.health -= 1; logLife(t('sm.weekend.friends.log')); } },
        { k: 'family', icon: '🏡',
          label: t('sm.weekend.family'),
          sub: t('sm.weekend.family.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 4; logLife(t('sm.weekend.family.log')); } },
        { k: 'rest', icon: '🛌',
          label: t('sm.weekend.rest'),
          sub: t('sm.weekend.rest.sub'),
          apply: (life) => { life.stats.health += 3; logLife(t('sm.weekend.rest.log')); } },
        { k: 'alone', icon: '🚶',
          label: t('sm.weekend.alone'),
          sub: t('sm.weekend.alone.sub'),
          apply: (life) => { life.stats.happiness -= 1; life.stats.knowledge += 1; logLife(t('sm.weekend.alone.log')); } },
      ],
    }),
  },

  // 18. 抽屜裡的零錢（8-15）
  {
    id: 'sm_pocket', kind: 'small',
    chance: (life) => life.age >= 8 && life.age <= 15 && Math.random() < 0.12,
    show: () => ({
      title: t('sm.pocket.title'),
      body: t('sm.pocket.body'),
      fact: t('sm.pocket.fact'),
      choices: [
        { k: 'save', icon: '🐷',
          label: t('sm.pocket.save'),
          sub: t('sm.pocket.save.sub'),
          apply: (life) => { life.stats.netAssets += 60; logLife(t('sm.pocket.save.log')); } },
        { k: 'snack', icon: '🍡',
          label: t('sm.pocket.snack'),
          sub: t('sm.pocket.snack.sub'),
          apply: (life) => { life.stats.happiness += 3; life.stats.health -= 1; logLife(t('sm.pocket.snack.log')); } },
        { k: 'gift', icon: '🎁',
          label: t('sm.pocket.gift'),
          sub: t('sm.pocket.gift.sub'),
          apply: (life) => { life.stats.social += 4; life.stats.happiness += 2; logLife(t('sm.pocket.gift.log')); } },
      ],
    }),
  },

  // 19. 打電話回家（25-80）
  {
    id: 'sm_call', kind: 'family',
    chance: (life) => life.age >= 25 && life.age <= 80 && Math.random() < 0.10,
    show: () => ({
      title: t('sm.call.title'),
      body: t('sm.call.body'),
      fact: t('sm.call.fact'),
      choices: [
        { k: 'call', icon: '📞',
          label: t('sm.call.call'),
          sub: t('sm.call.call.sub'),
          apply: (life) => { life.stats.social += 3; life.stats.happiness += 2; logLife(t('sm.call.call.log')); } },
        { k: 'visit', icon: '🚄',
          label: t('sm.call.visit'),
          sub: t('sm.call.visit.sub'),
          apply: (life) => { life.stats.social += 5; life.stats.netAssets -= 800; logLife(t('sm.call.visit.log')); } },
        { k: 'later', icon: '⏳',
          label: t('sm.call.later'),
          sub: t('sm.call.later.sub'),
          apply: (life) => { life.stats.social -= 2; life.stats.happiness -= 1; logLife(t('sm.call.later.log')); } },
      ],
    }),
  },

  // 20. 同學會（25-75）
  {
    id: 'sm_reunion', kind: 'small',
    chance: (life) => life.age >= 25 && life.age <= 75 && Math.random() < 0.08,
    show: () => ({
      title: t('sm.reunion.title'),
      body: t('sm.reunion.body'),
      fact: t('sm.reunion.fact'),
      choices: [
        { k: 'go', icon: '🥂',
          label: t('sm.reunion.go'),
          sub: t('sm.reunion.go.sub'),
          apply: (life) => { life.stats.social += 5; life.stats.happiness += 2; life.stats.netAssets -= 500; logLife(t('sm.reunion.go.log')); } },
        { k: 'skip', icon: '🚫',
          label: t('sm.reunion.skip'),
          sub: t('sm.reunion.skip.sub'),
          apply: (life) => { life.stats.netAssets += 200; logLife(t('sm.reunion.skip.log')); } },
      ],
    }),
  },

  // 21. 學做一道菜（20-75）
  {
    id: 'sm_cook', kind: 'small',
    chance: (life) => life.age >= 20 && life.age <= 75 && Math.random() < 0.09,
    show: () => ({
      title: t('sm.cook.title'),
      body: t('sm.cook.body'),
      fact: t('sm.cook.fact'),
      choices: [
        { k: 'learn', icon: '🍳',
          label: t('sm.cook.learn'),
          sub: t('sm.cook.learn.sub'),
          apply: (life) => { life.stats.happiness += 3; life.stats.knowledge += 2; life.stats.netAssets -= 100; logLife(t('sm.cook.learn.log')); } },
        { k: 'buy', icon: '🍱',
          label: t('sm.cook.buy'),
          sub: t('sm.cook.buy.sub'),
          apply: (life) => { life.stats.netAssets -= 200; life.stats.health -= 1; logLife(t('sm.cook.buy.log')); } },
      ],
    }),
  },

  // 22. 報名志工（20-75）
  {
    id: 'sm_volunteer', kind: 'small',
    chance: (life) => life.age >= 20 && life.age <= 75 && Math.random() < 0.08,
    show: () => ({
      title: t('sm.volunteer.title'),
      body: t('sm.volunteer.body'),
      fact: t('sm.volunteer.fact'),
      choices: [
        { k: 'join', icon: '🤲',
          label: t('sm.volunteer.join'),
          sub: t('sm.volunteer.join.sub'),
          apply: (life) => { life.stats.happiness += 5; life.stats.social += 4; life.stats.knowledge += 1; logLife(t('sm.volunteer.join.log')); } },
        { k: 'pass', icon: '🙅',
          label: t('sm.volunteer.pass'),
          sub: t('sm.volunteer.pass.sub'),
          apply: (life) => { life.stats.happiness -= 1; logLife(t('sm.volunteer.pass.log')); } },
      ],
    }),
  },

  // 23. 出去走走（40-85）
  {
    id: 'sm_walk', kind: 'small',
    chance: (life) => life.age >= 40 && life.age <= 85 && Math.random() < 0.09,
    show: () => ({
      title: t('sm.walk.title'),
      body: t('sm.walk.body'),
      fact: t('sm.walk.fact'),
      choices: [
        { k: 'walk', icon: '👟',
          label: t('sm.walk.walk'),
          sub: t('sm.walk.walk.sub'),
          apply: (life) => { life.stats.health += 4; life.stats.happiness += 2; logLife(t('sm.walk.walk.log')); } },
        { k: 'later', icon: '⏳',
          label: t('sm.walk.later'),
          sub: t('sm.walk.later.sub'),
          apply: (life) => { life.stats.health -= 1; logLife(t('sm.walk.later.log')); } },
      ],
    }),
  },

  // 24. 換新手機（13-60）
  {
    id: 'sm_phone', kind: 'small',
    chance: (life) => life.age >= 13 && life.age <= 60 && Math.random() < 0.07,
    show: () => ({
      title: t('sm.phone.title'),
      body: t('sm.phone.body'),
      fact: t('sm.phone.fact'),
      choices: [
        { k: 'upgrade', icon: '📱',
          label: t('sm.phone.upgrade'),
          sub: t('sm.phone.upgrade.sub'),
          apply: (life) => { life.stats.netAssets -= 900; life.stats.happiness += 3; life.stats.knowledge += 1; logLife(t('sm.phone.upgrade.log')); } },
        { k: 'keep', icon: '📴',
          label: t('sm.phone.keep'),
          sub: t('sm.phone.keep.sub'),
          apply: (life) => { life.stats.netAssets += 300; life.stats.happiness -= 1; logLife(t('sm.phone.keep.log')); } },
      ],
    }),
  },
];

/* v5.61：決策節奏控制
   實測一條人生（跑到 100 歲）會有 28 次 modal 中斷，而且決策嚴重擠在中年：
   26, 28, 30, 32, 34, 36, 38, 40 — 十五年裡八次，約兩年一個，
   而且 26/36/40 跟財務 modal 撞在同一年，玩家會被連續兩次打斷。
   這裡加兩道保護：
     1) 冷卻期：兩個決策之間至少隔 DECISION_COOLDOWN 年
     2) 避開其他 modal：別的中斷（財務 / 暫停）在 INTERRUPT_GAP 年內就不再出決策。
   注意：財務 modal 是 setTimeout 延遲開啟的，觸發那年跟真正打斷那年會差一歲，
   所以這裡用「區間」而不是「同年」，並且在 modal 真正開啟時才記錄中斷。 */
const DECISION_COOLDOWN = 4;
const INTERRUPT_GAP = 2;

function tryTriggerDecision(life, newAge) {
  if (!life) return false;
  // 已經有 modal 在開就不要觸發
  const decM = document.getElementById('decisionModal');
  if (decM && !decM.hasAttribute('hidden')) return false;
  // 冷卻期：距上一個決策還不夠就先不要，這一年仍然有機會（隔年再試）
  const lastAge = life.lastDecisionAge;
  if (lastAge != null && newAge - lastAge < DECISION_COOLDOWN) return false;
  // 剛被別的 modal 打斷過就讓玩家喘口氣
  const lastInt = life.lastInterruptAge;
  if (lastInt != null && newAge - lastInt < INTERRUPT_GAP) return false;

  const done = new Set((life.decisions || []).map(d => d.id));
  // v5.85：先收集所有「擲骰通過」的事件，再從中隨機挑一個。
  // 舊寫法照 DECISIONS 陣列順序逐一嘗試、遇到第一個就 return ——
  // 這讓排在後面的事件被前面的系統性壓制。
  // 實測 de_mental_health 排在第 10 位，200 條人生一次都沒出現過。
  const eligible = [];
  for (const dec of DECISIONS) {
    if (done.has(dec.id)) continue;
    let ok = false;
    try { ok = dec.chance(life); } catch (e) { continue; }
    if (ok) eligible.push(dec);
  }
  if (!eligible.length) return false;
  // 每年最多一個
  const dec = eligible[Math.floor(Math.random() * eligible.length)];
  try {
    const payload = dec.show(life);
    if (payload) {
      const ok = showDecision({ id: dec.id, kind: dec.kind, age: newAge, ...payload });
      if (ok) { life.lastDecisionAge = newAge; return true; }
    }
  } catch (e) { console.warn('decision show failed', dec.id, e); }
  return false;
}



// ==== i18n ====
function t(key, ...vals) {
  const dict = I18N[LANG] || I18N['zh-Hant'] || {};
  let s = dict[key] || key;
  // 支援 placeholder：
  //  1) {}     — 依序替換（vals 是基本型別陣列）
  //  2) {name} — 具名替換（從 vals[0] 物件讀 name 屬性）
  //  3) {0} {1} — 索引替換（按 vals 陣列索引）
  // 先把 {name} 與 {n} 換成對應 vals 值；再把剩餘 {} / {0} / {1} 依序套用
  // 自動偵測：如果 vals[0] 是物件，視為 named dict；否則按位置
  const first = vals[0];
  const isNamedDict = first && typeof first === 'object' && !Array.isArray(first);
  if (isNamedDict) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (first[name] !== undefined ? String(first[name]) : m));
  } else {
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      // 嘗試替換 {i} 與 {} 兩種
      s = s.replace(`{${i}}`, v).replace('{}', v);
    }
  }
  return s;
}
/* v5.46：死因 i18n — 死因在資料層以中文儲存，顯示時翻譯 */
function causeLabel(cause) {
  if (!cause) return '';
  return t('cause.' + cause);
}

async function loadData() {
  if (!CACHE.countries) {
    const r1 = await fetch('data/countries.json');
    CACHE.countries = await r1.json();
    COUNTRIES = CACHE.countries;
  }
  if (!CACHE.i18n) {
    const r2 = await fetch('data/i18n.json');
    CACHE.i18n = await r2.json();
    I18N = CACHE.i18n;
  }
  // 語言偏好
  LANG = localStorage.getItem(STORAGE_KEY + ':lang') || detectLang();
}
function detectLang() {
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh')) return nav.includes('hans') ? 'zh-Hans' : 'zh-Hant';
  if (nav.startsWith('en')) return 'en';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('vi')) return 'vi';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('th')) return 'th';
  if (nav.startsWith('es')) return 'es';
  return 'zh-Hant';
}
function setLang(lang) {
  LANG = lang;
  localStorage.setItem(STORAGE_KEY + ':lang', lang);
  document.documentElement.lang = lang;
  renderAll();
  syncDetailToggleLabel();
  syncPauseBtn();
  syncAutoBtn();
}
/* v5.61：切換語言後更新「詳細資料」按鈕文字 */
function syncDetailToggleLabel() {
  const btn = $('#btnDetailToggle');
  if (!btn) return;
  const on = $('#view-life')?.classList.contains('show-detail');
  const lbl = btn.querySelector('.ldt-label');
  if (lbl) lbl.textContent = t(on ? 'life.detail.hide' : 'life.detail.show');
}

// ==== 國家 ====
function countryById(id) { return COUNTRIES.find(c => c.id === id) || null; }
function localize(c) {
  if (!c) return null;
  return {
    ...c,
    name: LANG === 'en' ? c.name_en : (LANG === 'zh-Hans' ? (c.name_zh_cn || c.name_zh) : c.name_zh),
    region_name: LANG === 'en' ? c.region_en : c.region_zh,
  };
}

// ==== 出生選擇 ====
function chooseCountry(mode) {
  // mode:
  //   'baby' 依嬰兒出生人數權重（c.births — 每國每年新生兒數）
  //   'all'  依現存人口權重（c.pop — 80 億人口的當下分布）
  if (!COUNTRIES.length) return null;
  const m = (mode === 'all') ? 'all' : 'baby';
  const weights = COUNTRIES.map(c => {
    if (m === 'all') return Math.max(1, c.pop || 1);
    return Math.max(1, c.births || c.pop || 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < COUNTRIES.length; i++) {
    r -= weights[i];
    if (r <= 0) return COUNTRIES[i];
  }
  return COUNTRIES[0];
}

/* ==== v5.19：依出生人數加權的機率分布（top N） ==== */
function countryProbabilities(mode, n) {
  // 回傳 [{c, weight, pct, cumPct}]，c=country, pct=該國佔比(%), 已排序降冪
  const m = (mode === 'all') ? 'all' : 'baby';
  const rows = COUNTRIES.map(c => {
    const w = (m === 'all')
      ? Math.max(1, c.pop || 1)
      : Math.max(1, c.births || c.pop || 1);
    return { c, weight: w };
  });
  const total = rows.reduce((s, r) => s + r.weight, 0);
  rows.forEach(r => r.pct = r.weight / total * 100);
  rows.sort((a, b) => b.weight - a.weight);
  let cum = 0;
  rows.forEach(r => { cum += r.pct; r.cumPct = cum; });
  return n ? rows.slice(0, n) : rows;
}

/* ==== v5.19：今日主題 ==== */
const THEMES_ZH = ['家人','未來','記憶','離別','重逢','家鄉','城市','海','山','雨','雪','風','黎明','黃昏','路','名字','時光','童年','母親','父親','兄弟','姊妹','朋友','敵人','鄰居','陌生人','夢','醒','工作','休息','旅行','停留','選擇','機會','失敗','成功','病','老','死','生','信仰','希望','失望','愛','恨','孤獨','陪伴'];
const THEMES_EN = ['family','future','memory','farewell','homecoming','hometown','city','sea','mountain','rain','snow','wind','dawn','dusk','road','name','time','childhood','mother','father','brother','sister','friend','stranger','neighbor','dream','work','rest','travel','stay','choice','chance','failure','success','sickness','age','death','birth','faith','hope','love','loneliness','company'];
function getDailyTheme() {
  // 跨 session 同日保留；不同日期重新抽
  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10); // YYYY-MM-DD
  const cacheKey = STORAGE_KEY + ':theme:' + dayKey;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      return { word: obj.word, dayKey, en: obj.en || THEMES_EN[obj.idx] || '' };
    } catch (e) { /* fallthrough */ }
  }
  // 用日期當 hash seed（保證同日所有人都抽到同一個，但讓每天不同）
  const seed = hashStringToInt(dayKey);
  const idx = seed % THEMES_ZH.length;
  const word = LANG === 'en' ? (THEMES_EN[idx] || THEMES_ZH[idx]) : (THEMES_ZH[idx]);
  const en = THEMES_EN[idx] || THEMES_ZH[idx];
  localStorage.setItem(cacheKey, JSON.stringify({ word, idx, en }));
  // 清掉過期主題（保留最近 7 天）
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_KEY + ':theme:')) {
      const day = k.split(':').pop();
      if (day !== dayKey && Date.now() - new Date(day).getTime() > 7 * 86400 * 1000) {
        localStorage.removeItem(k);
      }
    }
  }
  return { word, dayKey, en };
}
function hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ==== v5.19：依瀏覽器語言/時區推測「你實際所在的國家」 ==== */
function guessUserCountry() {
  // 1) localStorage 顯式設定（若使用者已選過國家）
  const sel = localStorage.getItem(STORAGE_KEY + ':country');
  if (sel) {
    const c = countryById(sel);
    if (c) return c;
  }
  // 2) Intl locale → 國家
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const region = (locale.split('-').pop() || '').toUpperCase();
    if (region && region.length === 2) {
      const c = countryById(region);
      if (c) return c;
    }
  } catch (e) { /* ignore */ }
  // 3) navigator.language → 語言對應主要國家（單一國家）
  const lang = (navigator.language || 'en').toLowerCase();
  const langToCountry = {
    'zh-tw': 'TWN', 'zh-hk': 'HKG', 'zh-cn': 'CHN', 'zh': 'TWN',
    'en-us': 'USA', 'en-gb': 'GBR', 'en-ca': 'CAN', 'en-au': 'AUS',
    'ja': 'JPN', 'ja-jp': 'JPN',
    'ko': 'KOR', 'ko-kr': 'KOR',
    'vi': 'VNM', 'vi-vn': 'VNM',
    'fr': 'FRA', 'fr-fr': 'FRA',
    'th': 'THA', 'th-th': 'THA',
    'es': 'ESP', 'es-es': 'ESP', 'es-mx': 'MEX',
    'pt': 'BRA', 'pt-br': 'BRA',
    'de': 'DEU', 'de-de': 'DEU',
    'ru': 'RUS', 'ru-ru': 'RUS',
    'ar': 'SAU', 'ar-sa': 'SAU',
  };
  let key = lang.toLowerCase();
  if (langToCountry[key]) {
    const c = countryById(langToCountry[key]);
    if (c) return c;
  }
  // 部分匹配（zh-* → TWN、en-* → USA、es-* → ESP）
  const base = lang.split('-')[0];
  const fallback = {
    'zh': 'TWN', 'en': 'USA', 'ja': 'JPN', 'ko': 'KOR',
    'vi': 'VNM', 'fr': 'FRA', 'th': 'THA', 'es': 'ESP',
    'pt': 'BRA', 'de': 'DEU', 'ru': 'RUS', 'ar': 'SAU',
  };
  if (fallback[base]) {
    const c = countryById(fallback[base]);
    if (c) return c;
  }
  return countryById('USA') || COUNTRIES[0];
}

/* ==== v5.19：即時計數器 — 從頁面載入算起的全球出生/死亡數 ==== */
// 全球每秒約出生 4.3 人、死亡 1.8 人（依 UN WPP 2024 估算）
const REAL_BIRTHS_PER_SEC = 4.3;
const REAL_DEATHS_PER_SEC = 1.8;
let REALTIME_PAGE_LOAD = Date.now();
let REALTIME_INTERVAL = null;
function startRealtimeCounters() {
  if (REALTIME_INTERVAL) return;
  REALTIME_PAGE_LOAD = Date.now();
  REALTIME_INTERVAL = setInterval(updateRealtimeCounters, 1000);
  updateRealtimeCounters();
}
function stopRealtimeCounters() {
  if (REALTIME_INTERVAL) clearInterval(REALTIME_INTERVAL);
  REALTIME_INTERVAL = null;
}
function updateRealtimeCounters() {
  const elapsedSec = Math.max(0, (Date.now() - REALTIME_PAGE_LOAD) / 1000);
  // 加 ±5% 隨機讓數字不會太死板（用 seeded RNG 從載入秒數當種子）
  const jitter = 0.95 + Math.random() * 0.10;
  const born = Math.floor(elapsedSec * REAL_BIRTHS_PER_SEC * jitter);
  const died = Math.floor(elapsedSec * REAL_DEATHS_PER_SEC * jitter);
  const bornEl = $('#counterBorn');
  const diedEl = $('#counterDied');
  if (bornEl) bornEl.textContent = born.toLocaleString();
  if (diedEl) diedEl.textContent = died.toLocaleString();
}

// ==== 生命表 (Gompertz) ====
const LT_CACHE = {};
function lifeTable(c, sex) {
  const key = c.id + sex + (c.yr || '');
  if (LT_CACHE[key]) return LT_CACHE[key];
  const e0 = sex === 'F' ? c.le + (c.gap || 4) * 0.49 : c.le - (c.gap || 4) * 0.51;
  const k = sex === 'F' ? 0.92 : 1.08;
  const q0 = Math.min(0.25, (c.im || 15) / 1000 * k);
  const u5 = Math.min(0.35, Math.max(q0 + 0.0005, (c.u5 || 10) / 1000 * k));
  const H = -Math.log((1 - u5) / Math.max(0.0001, 1 - q0));
  const qc = [0.4, 0.27, 0.19, 0.14].map(w => 1 - Math.exp(-H * w));
  const A = 0.00025 + 0.000028 * (c.u5 || 10);
  const g = Math.max(0.085, Math.min(0.112, 0.112 - 0.00016 * (c.u5 || 10)));
  // q[0..4] 為嬰兒/幼兒段；q[5..110] 為 Gompertz
  const q = new Float64Array(111);
  q[0] = q0;
  for (let i = 1; i <= 4; i++) q[i] = qc[i - 1];
  for (let x = 5; x <= 110; x++) {
    if (x === 110) { q[x] = 1; continue; }
    q[x] = Math.min(1, 1 - Math.exp(-(A + Math.exp(g * (x + 0.5)) * 0.001)));
  }
  // 找 B 讓生命期望 = e0
  let lo = Math.log(1e-9), hi = Math.log(5e-2), r = 0.5;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    const B = Math.exp(m);
    // 計算生命期望
    let l = 1, e = 0;
    for (let x = 0; x <= 110; x++) {
      const qx = (x < 5) ? q[x] : Math.min(1, 1 - Math.exp(-(A + B * Math.exp(g * (x + 0.5)))));
      const d = l * qx;
      e += x === 0 ? l - 0.85 * d : l - 0.5 * d;
      l -= d;
    }
    if (e > e0) lo = m; else hi = m;
    r = B;
  }
  // 用最終的 r 重新算
  const qf = new Float64Array(111);
  qf[0] = q0;
  for (let i = 1; i <= 4; i++) qf[i] = qc[i - 1];
  for (let x = 5; x <= 110; x++) {
    if (x === 110) { qf[x] = 1; continue; }
    qf[x] = Math.min(1, 1 - Math.exp(-(A + r * Math.exp(g * (x + 0.5)))));
  }
  // 累計存活率
  const l = new Float64Array(112);
  l[0] = 1;
  for (let x = 0; x <= 110; x++) l[x + 1] = l[x] * (1 - qf[x]);
  LT_CACHE[key] = { q: qf, l, e0 };
  return LT_CACHE[key];
}

function pDie(age, c, sex) {
  if (age < 0) return 0;
  const lt = lifeTable(c, sex);
  if (age >= 110) return 1;
  if (age === 0) return lt.q[0];
  if (lt.l[age] === 0) return 1;
  return Math.max(0, Math.min(0.95, 1 - lt.l[age + 1] / lt.l[age]));
}

// ==== 死因分布 ====
const CAUSE_BASE = {
  // 嬰兒
  infant:  { '周產期問題':50, '先天異常':20, '感染性疾病':15, '嬰兒猝死':5, '事故':5, '其他':5 },
  // 兒童 1-4
  child:    { '感染性疾病':35, '事故':25, '先天異常':15, '營養不良':10, '溺水':8, '其他':7 },
  // 兒童 5-14
  young:    { '事故':30, '感染性疾病':25, '癌症':12, '溺水':10, '自殺':6, '他殺':5, '其他':12 },
  // 青年 15-29
  young_a:  { '事故':28, '自殺':20, '他殺':15, '癌症':10, '感染性疾病':10, '其他':17 },
  // 中年 30-49
  middle:   { '癌症':22, '心血管':18, '自殺':14, '事故':10, '感染性疾病':10, '他殺':6, '其他':20 },
  // 中老年 50-69
  older:    { '癌症':30, '心血管':25, '呼吸系統':8, '糖尿病':8, '自殺':5, '事故':5, '其他':19 },
  // 老年 70+
  elderly:  { '心血管':35, '癌症':25, '呼吸系統':12, '中風':8, '糖尿病':5, '其他':15 },
};

function causeWeights(c, age, sex) {
  let bucket;
  if (age < 1) bucket = 'infant';
  else if (age < 5) bucket = 'child';
  else if (age < 15) bucket = 'young';
  else if (age < 30) bucket = 'young_a';
  else if (age < 50) bucket = 'middle';
  else if (age < 70) bucket = 'older';
  else bucket = 'elderly';
  const w = { ...CAUSE_BASE[bucket] };
  // v5.39：略過可怕的情節 — 把自殺/他殺機率併入其他死因（不改變總死亡率）
  if (STATE.softMode) {
    let heavy = 0;
    for (const k of ['自殺', '他殺']) {
      if (w[k]) { heavy += w[k]; delete w[k]; }
    }
    if (heavy > 0) {
      w['其他'] = (w['其他'] || 0) + heavy;
    }
  }
  // 國家加成
  if (c.hom > 5 && w['他殺']) w['他殺'] *= c.hom / 5;
  else if (w['他殺'] && c.hom < 1) w['他殺'] *= 0.5;
  if (c.road > 15 && w['事故']) w['事故'] *= c.road / 15;
  if (c.hiv > 1 && w['感染性疾病']) w['感染性疾病'] *= c.hiv / 0.5;
  if (c.sm > 30 && w['癌症']) w['癌症'] *= c.sm / 25;
  if (c.sm > 30 && w['心血管']) w['心血管'] *= 1.2;
  if (c.war > 0.1 && (age < 50)) {
    w['戰爭/衝突'] = c.war * 5;
  }
  if (c.mal > 0.5) {
    w['瘧疾'] = (w['感染性疾病'] || 0) * c.mal * 2;
  }
  // 性別調整
  if (sex === 'F') {
    if (w['他殺'] && age >= 15 && age < 30) w['他殺'] *= 0.3;
    if (w['他殺'] && age >= 30 && age < 50) w['他殺'] *= 0.5;
    if (w['事故'] && age >= 15 && age < 50) w['事故'] *= 0.5;
  }
  // 個人條件
  if (STATE.life && STATE.life.smoker) {
    w['癌症'] *= 1.4; w['心血管'] *= 1.3; w['呼吸系統'] *= 1.5;
  }
  if (STATE.life && STATE.life.conditions) {
    if (STATE.life.conditions.diabetes) w['糖尿病'] = (w['糖尿病'] || 1) * 3;
    if (STATE.life.conditions.heart) w['心血管'] *= 1.5;
  }
  return w;
}

function pickCause(c, age, sex) {
  const w = causeWeights(c, age, sex);
  const keys = Object.keys(w);
  const weights = keys.map(k => Math.max(0.001, w[k]));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i];
    if (r <= 0) return keys[i];
  }
  return keys[0];
}

// ==== 隨機抽樣 ====
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const wpick = (obj) => {
  const keys = Object.keys(obj);
  const total = keys.reduce((s, k) => s + obj[k], 0);
  let r = Math.random() * total;
  for (const k of keys) {
    r -= obj[k];
    if (r <= 0) return k;
  }
  return keys[0];
};
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const chance = p => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ==== 名字 ====
const FIRST_NAMES_ZH = {
  M: ['志明','俊宏','家豪','建宏','俊傑','浩宇','承恩','柏翰','冠廷','彥廷','俊佑','俊廷','柏宇','宥廷','禹辰','建宇','俊宇','子軒','睿恩','嘉佑','家明','俊宏','志強','志偉','志豪','志遠','家豪','家銘','家祥','家瑞','國華','建國','建華','建民','建志','志強','志明','志偉','志豪','志遠','俊傑','俊宏','俊豪','俊宇','家豪','家銘','家祥','家瑞','家豪','家豪','家豪'],
  F: ['雅婷','怡君','佳穎','怡萱','雅雯','心怡','筱涵','筱萍','雅琪','雅文','郁婷','思妤','雅筑','宜君','詩涵','雅晴','宜臻','雅芳','婉婷','佳蓉','家瑜','家琪','雅琪','雅雯','怡君','佳穎','怡萱','雅雯','心怡','筱涵','筱萍','雅琪','雅文','郁婷','思妤','雅筑','宜君','詩涵','雅晴','宜臻','雅芳','婉婷','佳蓉','婉婷','佳蓉','家瑜','家琪','雅琪','雅雯','美華','美玲','美君','美玉','美麗','淑芬','淑君','淑玲','玉嬌','秀蘭','秀英','秀梅','秀珍','秀珠','秀鳳','麗華','麗君','麗玲','麗娟','麗美','麗珍','麗珠','麗鳳','麗雲','麗霞','麗秋','麗月','麗雪','麗冰','麗卿','麗珊','麗貞','麗蓉','麗蓮','麗萍','麗燕','麗虹','麗鳳','麗鸞','麗雁','麗燕','麗鸞']
};
const FIRST_NAMES_EN = {
  M: ['Wei','Hao','Junjie','Jianhong','Chen','Yu','Haochen','Bohan','Yanting','Yanting','Junjie','Yuchen','Jiayu','Bowen','Yuchen','Junhao','Zixuan','Rui','Jiayou','Minghao','David','James','Michael','John','Robert','William','Daniel','Matthew','Anthony','Mark','Steven','Paul','Andrew','Kenneth','George','Joshua','Kevin','Brian','Edward','Ronald','Timothy','Jason','Jeffrey','Ryan','Jacob','Gary','Nicholas','Eric','Jonathan','Stephen','Larry','Justin','Scott','Brandon','Benjamin','Samuel','Gregory','Alexander','Frank','Patrick','Raymond','Jack','Dennis','Jerry','Tyler','Aaron','Jose','Adam','Nathan','Henry','Douglas','Zachary','Peter','Kyle','Walter','Ethan','Jeremy','Harold','Keith','Christian','Roger','Noah','Gerald','Carl','Terry','Sean','Austin','Arthur','Lawrence','Jesse','Dylan','Bryan','Joe','Jordan','Billy','Bruce','Albert','Willie','Jordan','Dylan','Bryan','Joe','Alan','Ralph','Gabriel','Carl','Howard','Logan','Sean','Juan','Jack','Dean','Felix','Bruce','Peter','Patrick','Harold','Douglas','Jerry','Keith','Roger','Gerald','Carl','Terry','Arthur','Lawrence','Jesse','Christian','Sean','Austin','Noah','Bryan','Billy','Bruce','Albert','Willie','Gabriel','Alan','Ralph','Logan'],
  F: ['Mei','Hua','Lin','Fang','Yan','Ling','Min','Jing','Xia','Xiu','Lan','Ying','Mei','Fang','Yan','Jing','Lili','Min','Jing','Fang','Mei','Lan','Ying','Hua','Lily','Emma','Olivia','Ava','Sophia','Isabella','Mia','Charlotte','Amelia','Harper','Evelyn','Abigail','Emily','Ella','Elizabeth','Camila','Luna','Sofia','Avery','Mila','Aria','Scarlett','Penelope','Layla','Chloe','Victoria','Madison','Eleanor','Grace','Zoe','Nora','Riley','Zoey','Hannah','Hazel','Lily','Ellie','Violet','Aurora','Savannah','Audrey','Brooklyn','Bella','Claire','Skylar','Lucy','Paisley','Everly','Anna','Caroline','Nova','Genesis','Emilia','Kennedy','Samantha','Maya','Willow','Kinsley','Naomi','Aaliyah','Elena','Sarah','Ariana','Allison','Gabriella','Alice','Madelyn','Cora','Ruby','Eva','Serenity','Autumn','Adeline','Hailey','Gianna','Valentina','Isla','Eliana','Quinn','Nevaeh','Ivy','Sadie','Lydia','Piper','Lyla','Maya','Hailey']
};
const LAST_NAMES_ZH = ['張','王','李','陳','林','黃','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐','周','葉','蘇','莊','呂','江','何','羅','高','蕭','朱','羅','董','余','沈','許','韓','曹','許','鄧','曹','彭','曾','田','丁','杜','傅','范','方','鄒'];
const LAST_NAMES_EN = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner','Diaz','Parker','Cruz','Edwards','Collins','Reyes','Stewart','Morris','Morales','Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper','Peterson','Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward','Richardson','Watson','Brooks','Chavez','Wood','James','Bennett','Gray','Mendoza','Ruiz','Hughes','Price','Alvarez','Castillo','Sanders','Patel','Myers','Long','Ross','Foster','Jimenez'];
const FIRST_NAMES_INDIA = {
  M: ['Aarav','Vihaan','Aditya','Arjun','Rohit','Karan','Rahul','Amit','Vikram','Raj','Arun','Suresh','Mohan','Krishna','Ravi','Sanjay','Anil','Manish','Deepak','Pradeep','Rakesh','Sunil','Vinod','Ashok','Rajesh','Ajay','Naveen','Manoj','Dinesh','Pankaj','Sandeep','Mukesh','Anand','Sandeep','Rakesh','Prakash','Mukesh','Vivek','Vikas'],
  F: ['Aadhya','Saanvi','Ananya','Aaradhya','Diya','Pari','Anika','Navya','Myra','Ira','Aarohi','Anvi','Misha','Anaya','Pihu','Riya','Aaradhya','Ananya','Saanvi','Diya','Aadhya','Pari','Navya','Myra','Aarohi','Anvi','Misha','Pihu','Riya','Anaya','Saanvi','Diya','Aadhya','Pari','Navya','Myra','Aarohi','Anvi','Misha','Pihu','Riya','Anaya']
};
const LAST_NAMES_INDIA = {
  SC: ['Kumar','Ram','Lal','Das','Paswan','Choudhary','Valmiki','Korwa','Mochi','Dusadh','Pasi','Khatik','Dhobi','Nai','Kahar','Turi','Bhai','Gandhi','Mallah','Mochi','Dushadh','Mushahar','Rajbhar','Bind','Chamar','Dhanuk','Dobi','Dom','Ghasiya','Goswami','Harijan','Kori','Musahar','Ravidas','Sarang','Singh','Bauri','Daiya','Ghasia','Mahar','Mehtar','Meth','Rawat','Sapera','Saran','Saunta','Bhanwar','Bhanwaria','Bhangi','Bhil','Bhotia','Bhuiya','Boria','Charan','Gadia','Gadaria','Gandhila','Garia','Garoda','Gauda','Gawala','Ghasia','Ghogha','Ghisar','Gola','Gond','Goriya','Gosa','Gulam','Gurjar','Hajam','Halwai','Heliya','Jadugar','Jagal','Jaiswal','Jogi','Kalal','Kalwar','Kamathi','Kandara','Kandra','Kanjar','Kansar','Kansera','Kanth','Kanyal','Karadi','Kareem','Karigar','Karnam','Kashmiri','Kasumbi','Katiyar','Kavadi','Kavutia','Kayasth','Keelara','Keral','Kerkar','Kewat','Khadera','Khagi','Khaimar','Khaiyar','Khajanchi','Khalasi','Khalpa','Khamar','Khan'],
  ST: ['Meena','Munda','Ho','Oraon','Santhal','Bedia','Bhil','Korku','Gond','Kharia','Baiga','Marias','Gadabas','Chenchu','Thoti','Sabaria','Parahiya','Lodha','Birhor','Paharia','Asur','Birjia','Bhotda','Chakma','Gadaba','Gond','Gorait','Halba','Ho','Jatapu','Kamar','Karku','Katkari','Kawar','Khairwar','Kharia','Kharwar','Kol','Kolam','Korku','Koya','Kudubi','Maria','Munda','Nagesia','Nayak','Oraon','Paik','Pardhan','Parengi','Santhal','Saora','Sauka','Savara','Shabar','Toda','Tripuri','Warli'],
  obc: ['Yadav','Kurmi','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod','Mali','Teli','Kumhar','Lohar','Mocha','Nai','Sonar','Bania','Vaishya','Agrawal','Maheshwari','Khandelwal','Mittal','Garg','Jindal','Jain','Porwal','Kasat','Kalani','Bagrecha','Chhajed','Bothra','Singhal','Rathi','Bagaria','Lakhotia','Mundhra','Mangal','Kabra','Bansal','Goyal','Tibrewala','Dang','Hissaria','Bhut','Bhutra','Kothari','Karwa','Kala','Bagla','Asawa','Bagri','Choudhary','Halwai','Modi','Bhoot','Oswal','Kankariya','Porwal','Kansal','Mandhana','Bhandari','Kabra','Jalan','Bajoria','Bhuwalka','Mimani','Bumb','Bhand'],
  jana: ['Thapa','Tamang','Lama','Sherpa','Magar','Gurung','Rai','Limbu','Newar','Yadav','Mahato','Kami','Damai','Sarki','Chhetri','Bhatta','Bohara','Chauhan','Maharjan','Manandhar','Maharjan','Shrestha','Bajracharya','Pradhan','Karmacharya','Tamrakar','Manandhar','Joshi','Regmi','Bohara','Bist','Khatri','Khadka','Rana','Thapa','Bohara','Bist','Khatri','Khadka','Rana','Thapa','Mahato','Tharu','Rajbhar','Mahara','Kurmi','Yadav','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod'],
  madh: ['Yadav','Kurmi','Patel','Jat','Reddy','Nayak','Gujjar','Kamboj','Rathore','Saini','Khatri','Kayastha','Brahmin','Thakur','Rathod','Mali','Teli','Kumhar','Lohar','Mocha','Nai','Sonar','Bania','Vaishya','Agrawal','Maheshwari','Khandelwal','Mittal','Garg','Jindal','Jain','Porwal','Kasat','Kalani','Bagrecha','Chhajed','Bothra','Singhal','Rathi','Bagaria','Lakhotia','Mundhra','Mangal','Kabra','Bansal','Goyal','Tibrewala','Dang','Hissaria','Bhut','Bhutra','Kothari','Karwa','Kala','Bagla','Asawa','Bagri','Choudhary','Halwai','Modi','Bhoot','Oswal','Kankariya','Porwal','Kansal','Mandhana','Bhandari','Kabra','Jalan','Bajoria','Bhuwalka','Mimani','Bumb','Bhand'],
  '': ['Patel','Kumar','Singh','Shah','Sharma','Gupta','Verma','Yadav','Jain','Bansal','Garg','Mittal','Khatri','Kapoor','Mehta','Choudhary','Soni','Patwa','Sharma','Joshi','Bhatt','Pandey','Tiwari','Dubey','Mishra','Saxena','Srivastava','Trivedi','Chaturvedi','Dwivedi','Upadhyay','Pathak','Pandey','Mishra','Saxena','Srivastava','Trivedi','Chaturvedi','Dwivedi','Upadhyay','Pathak']
};

function randomName(country, sex) {
  const lang = country.lang || '';
  if (country.id === 'TWN' || country.id === 'HKG' || country.region === 'eap' && lang === 'zh') {
    const last = pick(LAST_NAMES_ZH);
    const first = pick(FIRST_NAMES_ZH[sex] || FIRST_NAMES_ZH.M);
    return { last, first, full: last + first, full_en: pick(LAST_NAMES_EN) + ' ' + pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M) };
  }
  if (country.id === 'IND') {
    const caste = pickIndianCaste();
    const last = pick(LAST_NAMES_INDIA[caste] || LAST_NAMES_INDIA['']);
    const first = pick(FIRST_NAMES_INDIA[sex] || FIRST_NAMES_INDIA.M);
    return { last, first, full: first + ' ' + last, full_en: first + ' ' + last, caste };
  }
  if (country.id === 'JPN' || country.id === 'KOR') {
    const last = sex === 'F' ? (chance(0.3) ? '김' : '이') : (chance(0.3) ? '박' : '최');
    const first = sex === 'F' ? '영' + pick(['희','은','아','수']) : '준' + pick(['호','혁','영','수']);
    return { last, first, full: last + first, full_en: pick(LAST_NAMES_EN) + ' ' + pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M) };
  }
  // 預設英文
  const last = pick(LAST_NAMES_EN);
  const first = pick(FIRST_NAMES_EN[sex] || FIRST_NAMES_EN.M);
  return { last, first, full: last + ' ' + first, full_en: last + ' ' + first };
}
function pickIndianCaste() {
  // SC 18%, ST 9%, OBC 44%, General 29% (近似 2024 估算)
  const r = Math.random();
  if (r < 0.18) return 'SC';
  if (r < 0.27) return 'ST';
  if (r < 0.71) return 'obc';
  return '';
}

// ==== 角色生成 ====
function newLife(countryCode) {
  const c = countryById(countryCode);
  if (!c) return null;
  const sex = Math.random() < 0.5 ? 'M' : 'F';
  const name = randomName(c, sex);
  // 1in8b.life 風格：出生登記背景
  const fam = generateFamily(countryCode, sex);
  const father = fam.parents.find(p => p.sex === 'M');
  const mother = fam.parents.find(p => p.sex === 'F');
  return {
    country: countryCode,
    countryData: c,
    name,
    sex,
    age: 0,
    year: STATE.era === 'past' ? 1990 : STATE.era === 'future' ? 2080 : 2024,
    yearOffset: 0,
    // 個人條件
    smoker: chance(c.sm / 100 * 0.5),
    conditions: {
      diabetes: chance(0.05 * (c.sm / 30)),
      heart: chance(0.03),
    },
    // 事件記錄
    log: [],
    quotes: {},
    // 統計
    stats: {
      education: 0,
      married: false,
      partner: null,
      kids: [],
      employment: 'none',
      health: 100,
      happiness: 70,
      knowledge: 50,    // v5.8 新增：知識 0-100
      social: 60,       // v5.8 新增：人際關係 0-100
      netAssets: 0,     // v5.8 新增：淨資產（PPP 美元）
      annualIncome: 0,  // v5.8 新增：年收入
      // 1in8b.life 風格：家境、宗教、出生地類型
      incomeQuartile: 1 + Math.floor(Math.random() * 4),  // 1-4 分位
      religion: pickReligion(c),
      birthPlaceType: Math.random() < 0.55 ? 'rural' : 'urban',  // 55% 鄉村、45% 城市
    },
    // v5.59：教育上限（依出生國家的 eys / ter 統計抽出），教育歷程會往這個目標推進
    eduTarget: rollEducation(c),
    // 父母詳細（v5.8 新增）
    fatherDetail: father ? { age: 20 + Math.floor(Math.random()*25), job: pickParentJob(c, 'M') } : null,
    motherDetail: mother ? { age: 18 + Math.floor(Math.random()*22), job: pickParentJob(c, 'F') } : null,
    // 同伴（v5.8 新增）：4 個同時出生的隨機人物
    companions: generateCompanions(countryCode, 4),
    // 1in8b.life 風格：出生登記編號
    regNumber: `${countryCode}-${(STATE.era==='past'?'1990':STATE.era==='future'?'2080':'2024')}-${Math.floor(Math.random()*9000000)+1000000}`,
    // 死亡
    died: false,
    cause: null,
    deathAge: null,
    // 族譜
    family: fam,
  };
}

/* ==== v5.8 新增：宗教 + 父母工作池 ==== */
function pickReligion(c) {
  const r = c.region || 'eap';
  const isEn = LANG === 'en';
  const mapZh = {
    'eap': ['佛教', '民間信仰', '基督新教', '天主教', '無信仰'],
    'sa': ['印度教', '伊斯蘭', '錫克教', '基督教', '佛教'],
    'eca': ['基督新教', '天主教', '東正教', '伊斯蘭', '無信仰'],
    'mena': ['伊斯蘭', '基督宗教', '德魯茲派'],
    'ssa': ['基督新教', '天主教', '伊斯蘭', '非洲傳統宗教'],
    'lac': ['天主教', '基督新教', '無信仰'],
    'na': ['基督新教', '天主教', '無信仰'],
  };
  const mapEn = {
    'eap': ['Buddhist', 'Folk religion', 'Protestant', 'Catholic', 'Non-religious'],
    'sa': ['Hindu', 'Muslim', 'Sikh', 'Christian', 'Buddhist'],
    'eca': ['Protestant', 'Catholic', 'Orthodox', 'Muslim', 'Non-religious'],
    'mena': ['Muslim', 'Christian', 'Druze'],
    'ssa': ['Protestant', 'Catholic', 'Muslim', 'African traditional'],
    'lac': ['Catholic', 'Protestant', 'Non-religious'],
    'na': ['Protestant', 'Catholic', 'Non-religious'],
  };
  const m = isEn ? mapEn : mapZh;
  return pick(m[r] || (isEn ? ['Non-religious'] : ['無信仰']));
}
function pickParentJob(c, sex) {
  const r = c.region || 'eap';
  const isEn = LANG === 'en';
  const ruralMZh = ['農夫', '工人', '計程車司機', '建築工', '漁民', '牧民', '汽車維修技師', '技工', '小販', '搬運工', '保全'];
  const urbanMZh = ['工程師', '教師', '銀行員', '銷售員', '公務員'];
  const urbanFZh = ['教師', '護理師', '銷售員', '公務員', '服務業'];
  const ruralMEn = ['Farmer', 'Laborer', 'Taxi driver', 'Construction worker', 'Fisherman', 'Herder', 'Auto mechanic', 'Technician', 'Vendor', 'Porter', 'Security guard'];
  const urbanMEn = ['Engineer', 'Teacher', 'Bank clerk', 'Sales clerk', 'Civil servant'];
  const urbanFEn = ['Teacher', 'Nurse', 'Sales clerk', 'Civil servant', 'Service worker'];
  // 55% 鄉村 → 農業；45% 城市 → 多元工作
  const isRural = Math.random() < 0.55;
  if (isEn) {
    return isRural ? pick(ruralMEn) : pick(sex === 'M' ? urbanMEn : urbanFEn);
  }
  return isRural ? pick(ruralMZh) : pick(sex === 'M' ? urbanMZh : urbanFZh);
}

/* ==== v5.8 新增：4 位同伴（同時出生的隨機人物） ==== */
/* v5.19：每位同伴補上「家庭背景」+「出生地區」 */
function generateCompanions(selfCountry, n) {
  const allCountries = ['USA','CHN','IND','JPN','KOR','BRA','RUS','DEU','GBR','FRA','MEX','IDN','TUR','SAU','ITA','EGY','PAK','BGD','NGA','VNM','PHL','ETH','IRN','COD','MMR','THA','ZAF','TZA','KEN','UKR','POL','CAN','AUS','ARG','KAZ','NPL','CUB'];
  const companions = [];
  for (let i = 0; i < n; i++) {
    let cCode;
    do { cCode = pick(allCountries); } while (cCode === selfCountry);
    const c = countryById(cCode);
    const sex = Math.random() < 0.5 ? 'M' : 'F';
    const nm = randomName(c, sex);
    // v5.19：父母職業依同伴國家脈絡
    const fatherJob = pickParentJob(c, 'M');
    const motherJob = pickParentJob(c, 'F');
    companions.push({
      id: 'comp_' + i,
      name: nm.full || nm.full_en,
      nameEn: nm.full_en || '',
      sex, country: cCode,
      countryData: c,
      flag: c.flag,
      // 每人也是 80 歲預期壽命起點
      lifeExpectancy: c.le,
      // 家境也分位
      incomeQuartile: 1 + Math.floor(Math.random()*4),
      // v5.19 新增：家庭背景 + 出生地類型
      parentJobFather: fatherJob,
      parentJobMother: motherJob,
      birthPlaceType: Math.random() < 0.55 ? 'rural' : 'urban',
    });
  }
  return companions;
}

/* v5.19：根據瀏覽器語言推測「你現在若出生」的真實國家 */
function guessBirthCountry() {
  const nav = (navigator.language || 'en').toLowerCase();
  // 依語系 → 推測人口最多的國家
  if (nav.startsWith('zh-tw') || nav === 'zh-hant' || nav === 'zh-hk' || nav === 'zh-mo') return countryById('TWN');
  if (nav.startsWith('zh')) return countryById('CHN');
  if (nav.startsWith('ja')) return countryById('JPN');
  if (nav.startsWith('ko')) return countryById('KOR');
  if (nav.startsWith('vi')) return countryById('VNM');
  if (nav.startsWith('fr')) return countryById('FRA');
  if (nav.startsWith('th')) return countryById('THA');
  if (nav.startsWith('es')) return countryById('MEX');
  // en / 其他：英文使用人口最多的國家
  if (nav.startsWith('en')) return countryById('USA');
  return countryById('USA');
}

/* v5.21 修：當年存活率 — 改用 l[]（cumulative survival probability），fallback 用通用曲線 */
function survivalRateForAge(c, sex, age) {
  if (!c) return null;
  try {
    const lt = lifeTable(c, sex);
    if (!lt || !lt.l || age < 0) return null;
    const i = Math.max(0, Math.min(110, Math.floor(age)));
    const v = lt.l[i];
    if (typeof v !== 'number' || isNaN(v)) return null;
    // 0歲顯示為 100%
    if (age === 0) return 1;
    return Math.max(0, Math.min(1, v));
  } catch (e) {
    // fallback：使用通用 GBD-style 簡化曲線
    if (age === 0) return 1;
    if (age < 5) return 0.99 - age * 0.001;
    if (age < 30) return 0.99 - (age-5) * 0.0008;
    if (age < 60) return 0.97 - (age-30) * 0.005;
    return Math.max(0.1, 0.82 - (age-60) * 0.02);
  }
}

/* v5.19：你是哪個家庭分位 (1-4) 的中文/英文短碼 */
function quartileLabel(q, isEn) {
  if (!q) return '—';
  if (isEn) return ['Bottom 25%','Lower-middle','Upper-middle','Top 25%'][q-1] || ('Q' + q);
  return ['最低 25%','中下 50%','中上 75%','最高 25%'][q-1] || ('Q' + q);
}

/* ==== 族譜：家族生成 ==== */
function generateFamily(countryCode, selfSex, fc) {
  const c = countryById(countryCode);
  if (!c) return { parents: [], siblings: [], grandparents: [], partner: null, kids: [] };
  const baseYear = (STATE.era === 'past' ? 1990 : STATE.era === 'future' ? 2080 : 2024);
  const war = c.war || 0;
  // 戰區孤兒機率：war 高 → 雙親存在率低
  const parentChance = Math.max(0.35, 1 - war * 0.4);
  const haveFather = Math.random() < parentChance;
  const haveMother = Math.random() < parentChance;
  // 寄養/收養：換父母
  let parentCountry = countryCode, parentCountryData = c;
  let parentNote = null;
  if (fc && fc.type === 'adopt') {
    // 從隨機另一個國家收養
    const adopters = ['USA','CAN','GBR','FRA','DEU','AUS','SWE','NOR'];
    const fcode = adopters[Math.floor(Math.random() * adopters.length)];
    parentCountry = fcode;
    parentCountryData = countryById(fcode) || c;
    parentNote = 'adoptive';
  } else if (fc && fc.type === 'foster') {
    parentNote = 'foster';
  }
  const fatherName = haveFather ? randomName(parentCountryData, 'M') : null;
  const motherName = haveMother ? randomName(parentCountryData, 'F') : null;
  const father = haveFather ? {
    id: 'f_' + Math.random().toString(36).slice(2,8),
    name: fatherName.full || fatherName.full_en || '?',
    sex: 'M', country: parentCountry, countryData: parentCountryData,
    note: parentNote,
    birth: { year: baseYear - 30 },
    death: parentNote ? null : { year: baseYear - 30 + (parentNote === 'foster' ? 50 : 70) }
  } : null;
  const mother = haveMother ? {
    id: 'm_' + Math.random().toString(36).slice(2,8),
    name: motherName.full || motherName.full_en || '?',
    sex: 'F', country: parentCountry, countryData: parentCountryData,
    note: parentNote,
    birth: { year: (father?.birth?.year || baseYear-30) + (Math.random() < 0.5 ? -2 : 3) },
    death: parentNote ? null : { year: (father?.birth?.year || baseYear-30) + 75 }
  } : null;
  const parents = [father, mother].filter(Boolean);
  // 手足數：戰區小孩通常更少
  let nSib = 0;
  const sibR = Math.random();
  if (war > 0.5) nSib = sibR < 0.4 ? 0 : sibR < 0.75 ? 1 : 2;
  else nSib = sibR < 0.3 ? 0 : sibR < 0.6 ? 1 : sibR < 0.85 ? 2 : 3;
  const siblings = [];
  for (let i = 0; i < nSib; i++) {
    const sibSex = Math.random() < 0.5 ? 'M' : 'F';
    const nm = randomName(c, sibSex);
    siblings.push({
      id: 's_' + Math.random().toString(36).slice(2,8),
      name: nm.full || nm.full_en || '?',
      sex: sibSex, country: countryCode, countryData: c,
      birth: { year: baseYear - (Math.floor(Math.random()*8)+1) }
    });
  }
  // 祖父母：有父母才合理；戰區祖父母多半死亡
  const grandparents = [];
  const gpChance = parentNote ? 0.5 : Math.max(0.2, 0.7 - war * 0.3);
  if (father && Math.random() < gpChance) {
    const gf = randomName(parentCountryData, 'M');
    grandparents.push({ id:'gf_'+Math.random().toString(36).slice(2,8), name: gf.full||gf.full_en||'?', sex:'M', country: parentCountry, countryData: parentCountryData, note: parentNote, birth:{year: father.birth.year - 28}, death:{year: father.birth.year + 35} });
  }
  if (mother && Math.random() < gpChance) {
    const gm = randomName(parentCountryData, 'F');
    grandparents.push({ id:'gm_'+Math.random().toString(36).slice(2,8), name: gm.full||gm.full_en||'?', sex:'F', country: parentCountry, countryData: parentCountryData, note: parentNote, birth:{year: mother.birth.year - 26}, death:{year: mother.birth.year + 38} });
  }
  return { parents, siblings, grandparents, partner: null, kids: [], fosterCare: fc?.type || null, adoptedFrom: fc?.type === 'adopt' ? countryCode : null };
}

// ==== 事件 ====
/* v5.59：依國家統計抽出個人教育上限（0–4）。
   刻度對應 i18n：0=未上學 1=小學 2=國中 3=高中 4=大學。
   eys = 預期受教育年數（UNESCO），ter = 高等教育粗在學率（%）。
   加一點個人變異，避免同一國家每個人讀一模一樣的書。 */
function rollEducation(c) {
  const base = Number.isFinite(c?.eys) ? c.eys : 12;
  const eys = base + (Math.random() * 6 - 3);          // ±3 年個人差異
  let lvl;
  if (eys < 6.5) lvl = 0;
  else if (eys < 9.5) lvl = 1;
  else if (eys < 12) lvl = 2;
  else if (eys < 15) lvl = 3;
  else lvl = 3;                                       // 有機會讀大學，但要看當地大學入學率
  if (eys >= 15) {
    const ter = Number.isFinite(c?.ter) ? c.ter : 30;
    if (Math.random() * 100 < ter) lvl = 4;
  }
  return lvl;
}

function milestoneEvents(life, newAge) {
  const events = [];
  // v5.59：教育歷程改為「往上限爬」而非用絕對值當門檻。
  // 舊碼只有 `education = 1` 這一個寫入點，因此 education >= 2 永不成立，
  // 連帶 employment 永遠不會是 'employed'（收入不累積、5 個決策事件形同虛設）。
  // 出生時先依國家統計抽出 eduTarget（0–4），之後每年齡把 education 往目標推進。
  const tgt = life.eduTarget ?? life.stats.education;
  if (newAge === 6) {
    if (tgt >= 1) life.stats.education = Math.max(life.stats.education, 1);
    events.push({ age: 6, kind: 'milestone', icon: '🎒', text: t('event.school.start') });
  }
  if (newAge === 12) {
    if (tgt >= 2) life.stats.education = Math.max(life.stats.education, 2);
    events.push({ age: 12, kind: 'milestone', icon: '📚', text: t('event.school.middle') });
  }
  if (newAge === 15 && life.stats.education === 2 && tgt < 3 && chance(0.5)) {
    life.stats.education = 1;  // 國中輟學
    events.push({ age: 15, kind: 'milestone', icon: '📖', text: t('event.education.low') });
  }
  if (newAge === 18) {
    if (tgt >= 3) {
      life.stats.education = 3;                       // 至少高中畢業
      life.stats.employment = life.stats.employment === 'none' ? 'seeking' : life.stats.employment;
      events.push({ age: 18, kind: 'milestone', icon: '🎓', text: t('event.school.graduate') });
    } else if (tgt >= 1) {
      life.stats.education = Math.max(life.stats.education, 1);
      life.stats.employment = 'employed';            // v5.59：舊碼忘了設，這裡補上
      events.push({ age: 18, kind: 'milestone', icon: '🔨', text: t('event.work.start') });
    }
  }
  if (newAge >= 19 && newAge <= 23 && life.stats.employment === 'seeking' && chance(0.4)) {
    life.stats.employment = 'employed';
  }
  if (newAge === 22 && life.stats.education >= 3 && tgt >= 4 && chance(0.6)) {
    life.stats.education = 4;
    life.stats.employment = 'university';
    events.push({ age: 22, kind: 'milestone', icon: '🎓', text: t('event.education.university') });
  }
  if (life.stats.employment === 'university' && newAge >= 24 && newAge <= 27) {
    life.stats.employment = 'employed';              // 研究所/大學畢業後進入職場
  }
  if (newAge >= 25 && newAge <= 35 && !life.stats.married && chance(0.15) && (life.stats.employment === 'university' || life.stats.employment === 'employed')) {
    life.stats.married = true;
    const partnerName = randomName(life.countryData, life.sex === 'M' ? 'F' : 'M');
    life.stats.partner = { name: partnerName, sex: life.sex === 'M' ? 'F' : 'M' };
    if (life.family) {
      life.family.partner = {
        id: 'p_' + Math.random().toString(36).slice(2,8),
        name: partnerName.full || partnerName.full_en || '?',
        nameEn: partnerName.full_en,
        sex: life.sex === 'M' ? 'F' : 'M',
        country: life.country,
        countryData: life.countryData,
        marriageAge: newAge,
        birth: { year: (life.year + life.yearOffset - life.age) - (newAge - Math.floor(Math.random()*5)) }
      };
    }
    events.push({ age: newAge, kind: 'milestone', icon: '💍', text: t('event.marriage', partnerName.full || partnerName.full_en || '') });
  }
  if (life.stats.married && life.stats.kids.length < 3 && newAge >= 25 && newAge <= 45 && chance(0.12)) {
    const sex = Math.random() < 0.5 ? 'M' : 'F';
    const child = { sex, bornAt: newAge };
    life.stats.kids.push(child);
    if (life.family) {
      life.family.kids = life.family.kids || [];
      const childBirth = { year: (life.year + life.yearOffset) };
      const childNode = {
        id: 'k_' + Math.random().toString(36).slice(2,8),
        name: randomName(life.countryData, sex).full || randomName(life.countryData, sex).full_en || '?',
        sex, country: life.country, countryData: life.countryData,
        birth: childBirth,
        // 依 country.im 機率夭折（5 歲以下死亡率）
        death: chance((life.countryData.im || 5) / 1000 * 0.3) ? { year: childBirth.year + Math.floor(Math.random() * 5) } : null
      };
      life.family.kids.push(childNode);
      if (childNode.death && !STATE.eduMode && !STATE.softMode) events.push({ age: newAge, kind: 'heavy', icon: '🕯️', text: LANG === 'en' ? `${childNode.name} died as an infant.` : `${childNode.name} 在嬰幼兒時期夭折了。` });
    }
    events.push({ age: newAge, kind: 'milestone', icon: '👶', text: t('event.baby', life.stats.kids.length) });
  }
  if (newAge === 60 && life.stats.employment !== 'none') {
    life.stats.employment = 'retired';
    events.push({ age: 60, kind: 'milestone', icon: '🏖️', text: t('event.retirement') });
  }
  // 偶發事件（教學版過濾掉疾病）
  // v5.62：只挑還沒得過的病 — 否則同一個人生會重複出現「罹患癌症」
  if (!STATE.eduMode && !STATE.softMode && newAge >= 18 && newAge <= 65 && chance(0.04)) {
    const fresh = ['cancer', 'heart', 'stroke', 'diabetes']
      .filter(c => !(c === 'stroke' ? life.conditions.heart : life.conditions[c]));
    if (fresh.length) {
      const cond = pick(fresh);
      life.conditions[cond === 'stroke' ? 'heart' : cond] = true;
      events.push({ age: newAge, kind: 'illness', icon: '💊', text: t('event.illness.' + cond) });
    }
  }
  if (newAge >= 12 && newAge <= 25 && chance(0.02)) {
    events.push({ age: newAge, kind: 'social', icon: '🎓', text: t('event.event.school.exam') });
  }
  // 印度種姓相關
  if (life.country === 'IND' && life.name.caste === 'SC' && newAge >= 8 && newAge <= 16 && chance(0.08)) {
    events.push({ age: newAge, kind: 'social', icon: '⚠️', text: t('event.caste.disc') });
  }
  // 紐澳原住民加成
  if ((life.country === 'NZL' || life.country === 'AUS') && newAge === 18 && chance(0.5)) {
    events.push({ age: newAge, kind: 'social', icon: '🌿', text: LANG === 'en' ? 'You identify as indigenous; get education & health support.' : '你被認定為原住民後裔，獲得教育補助與健康資源。' });
  }
  // 戰爭/衝突（教學版過濾掉）
  // v5.62：每種戰爭事件一生只出現一次，全部用完就不再抽
  const warEvt = life.countryData?.wh || 0;
  if (!STATE.eduMode && !STATE.softMode && warEvt > 0.1 && newAge >= 1) {
    const pool = [
      LANG === 'en' ? 'Air raid sirens. The family shelters in the basement.' : '空襲警報響起，全家躲進防空洞。',
      LANG === 'en' ? 'A neighbor dies in the fighting. You witness the scene.' : '鄰居在衝突中喪生，你目睹了場面。',
      LANG === 'en' ? 'Your father is conscripted. Months of silence.' : '父親被徵召上前線，數月無音訊。',
      LANG === 'en' ? 'The neighborhood is evacuated; supplies run short.' : '鄰里被疏散到臨時營地，物資匱乏。',
      LANG === 'en' ? 'Fighting blocks the roads. School closes for a week.' : '武裝衝突封鎖道路，學校關閉一週。',
    ];
    // 用陣列不用 Set：整段人生會被 lifeExport 整包 JSON.stringify，Set 會變成 {}
    const seenWar = life.seenWar || (life.seenWar = []);
    const fresh = pool.filter(w => !seenWar.includes(w));
    if (fresh.length && chance(warEvt * 0.1)) {
      const w = pick(fresh);
      seenWar.push(w);
      events.push({ age: newAge, kind: 'heavy', icon: '⚔️', text: w });
    }
  }
  // 寄養（美/英/紐/澳/韓/日）— 教學版不觸發
  if (!STATE.eduMode && !STATE.softMode && ['USA','GBR','NZL','AUS','KOR','JPN'].includes(life.country) && newAge === 0) {
    if (chance(0.04)) {
      life.fc = { in: 1, system: 'state', type: 'foster' };
      life.family = generateFamily(life.country, life.sex, { type: 'foster' });
      events.push({ age: 0, kind: 'heavy', icon: '🏠', text: LANG === 'en' ? 'You enter foster care due to family circumstances.' : '出生後因家庭變故，被送進寄養系統，由寄養父母撫養。' });
    }
  }
  // 國際收養（韓/中/越/柬/泰/印）
  if (['KOR','CHN','VNM','KHM','THA','IND'].includes(life.country) && newAge === 0 && chance(0.005)) {
    life.fc = { in: 1, system: 'international', type: 'adopt' };
    const oldCountry = life.country;
    const oldFlag = life.countryData?.flag || '';
    life.family = generateFamily(life.country, life.sex, { type: 'adopt' });
    // 遷徙：實際上 self 現在在收養國家
    const newCountry = life.family.parents[0]?.country || 'USA';
    const newCountryData = countryById(newCountry);
    const newFlag = newCountryData?.flag || '🏳️';
    life.country = newCountry;
    life.countryData = newCountryData;
    life.birthOrigin = { country: oldCountry, flag: oldFlag };  // 記錄出生國家
    events.push({ age: 0, kind: 'social', icon: '🌍', text: LANG === 'en' ? `You are adopted by a foreign family (${oldFlag} → ${newFlag}) and grow up in another country.` : `你被一對外國夫婦收養 ${oldFlag} → ${newFlag}，離開出生地到另一個國家長大。` });
    // 遷徙動畫 toast
    setTimeout(() => toast(`${oldFlag} → ${newFlag}  ${LANG==='en'?'Migration':'遷徙'}`), 200);
  }
  if (life.country === 'IND' && life.name.caste === 'SC' && newAge >= 18 && chance(0.05)) {
    events.push({ age: newAge, kind: 'social', icon: '📋', text: t('event.caste.form') });
  }
  // 5/15/30/50/70 暫停問題
  if ([5, 15, 30, 50, 70].includes(newAge) && !life.quotes[newAge]) {
    // v5.73 / v5.84：這一年若已經有別的 modal 開著，就不要再疊一個反思框上來。
    // v5.84 補上漏判：財務 modal 是 setTimeout(+100ms) 延遲開啟的，所以同一個 tick 裡
    // milestoneEvents 跑到這裡時 STATE.paused 還是 false，光看 paused 會漏掉 30／50 歲
    // 同時觸發財務 + 反思的情況（實測 pauseModal 與 financeModal 兩個視窗同時開著）。
    // 改看「今年是否已經記錄過任何一次打斷」，那是在排程當下同步寫的，不受延遲影響。
    const anyModalOpen = ['decisionModal', 'focusModal', 'financeModal', 'spendModal']
      .some(id => { const e = document.getElementById(id); return e && !e.hasAttribute('hidden'); });
    const alreadyShowing = STATE.paused || anyModalOpen || life.lastInterruptAge === newAge;
    if (alreadyShowing) {
      life.lastInterruptAge = newAge;
    } else {
      STATE.pendingDecision = { age: newAge, type: 'pause' };
      if (STATE.thoughtsEnabled && !STATE.autoDecide && STATE.view === 'life') {
        setTimeout(() => showPauseQuestion(), 50);
      }
    }
  }
  // v5.16：18/25/35/50 財務決策 — 改為手動觸發（不自動彈出）
  if ([18, 25, 35, 50].includes(newAge) && !life.financeDecisions?.find(d => d.age === newAge)) {
    // 只記標記（手動按鈕可觸發），不再自動彈出
    life.financeAgeAvailable = newAge;
  }
  // v5.14：每年保底事件（其他里程碑未觸發時）
  if (events.length === 0 && newAge >= 4) {
    const evt = generateYearlyEvent(life);
    if (evt) {
      const text = (LANG === 'en' ? evt.en : evt.zh);
      events.push({ age: newAge, kind: 'milestone', icon: evt.icon, text });
      life.latestEvent = { age: newAge, icon: evt.icon, text };
    }
  }
  return events;
}

// ==== 主迴圈 ====
/* v5.24：再看一次最後的時刻 — 顯示生命最後 3 個事件 */
function replayLastMoments() {
  if (!STATE.life) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const lastEvents = (life.log || []).slice(-5);  // 最後 5 條
  const list = $('#endLastMomentsList');
  if (!list) return;
  list.innerHTML = lastEvents.map(e => `<div class="elm-row"><span class="elm-age">${e.age} ${isEn?'yo':'歲'}</span><span class="elm-icon">${e.icon || '·'}</span><span class="elm-text">${escapeHtml(e.text || '')}</span></div>`).join('') || `<span class="muted">${isEn?'No events':'無事件'}</span>`;
  $('#endLastMoments')?.removeAttribute('hidden');
}

/* v5.24：提供意見送出 — 存 localStorage */
function submitFeedback() {
  const email = $('#feedbackEmail')?.value || '';
  const text = $('#feedbackText')?.value || '';
  if (!text || text.length < 5) {
    toast(LANG === 'en' ? 'Please write at least 5 characters' : '請至少寫 5 個字');
    return;
  }
  const feedbacks = JSON.parse(localStorage.getItem('born-somewhere-v2:feedbacks') || '[]');
  feedbacks.push({ ts: Date.now(), email, text, lang: LANG });
  localStorage.setItem('born-somewhere-v2:feedbacks', JSON.stringify(feedbacks));
  $('#feedbackModal')?.setAttribute('hidden', '');
  toast(LANG === 'en' ? 'Feedback sent (saved locally)' : '感謝您的意見（已存於本機）');
  if ($('#feedbackText')) $('#feedbackText').value = '';
  if ($('#feedbackEmail')) $('#feedbackEmail').value = '';
}

function startLife(countryCode) {
  stopTicker();
  STATE.life = newLife(countryCode);
  if (!STATE.life) return;
  STATE.life.log.push({ age: 0, kind: 'birth', icon: '👶', text: t('event.birth', '') });
  logLife(t('log.born_in', localize(STATE.life.countryData).name, ''));
  STATE.paused = false;
  STATE.speed = 1;
  // v5.25：依 duration 選擇調整 tickMs
  const dur = $('#lifeDuration')?.value || '1hr';
  if (dur === '30min') STATE.tickMs = 600;       // 約 30 分鐘跑完一生
  else if (dur === '1hr') STATE.tickMs = 1200;  // 預設約 1 小時
  else if (dur === '90min') STATE.tickMs = 1800; // 約 1.5 小時
  else STATE.tickMs = 1500;
  setView('life');
  renderAll();
  startTicker();
}
function startTicker() {
  STATE.ticker = setInterval(() => tick(), STATE.tickMs / STATE.speed);
}
function stopTicker() {
  if (STATE.ticker) clearInterval(STATE.ticker);
  STATE.ticker = null;
}
function setSpeed(sp) {
  STATE.speed = sp;
  stopTicker();
  startTicker();
  renderSpeedBtns();
}
function tick() {
  if (!STATE.life || STATE.life.died || STATE.paused) return;
  // v5.33：5/15/30/50/70 暫停不阻擋 tick（顯示 modal 但生命繼續；用戶可手動互動）
  // 原本：if (STATE.pendingDecision) return;
  if (STATE.pendingDecision && !STATE.pendingDecision._dismissed) {
    // 第一次彈出 modal（已透過 milestoneEvents 觸發）；不阻擋生命
    STATE.pendingDecision._dismissed = true;
    return;
  }
  const c = STATE.life.countryData;
  const sex = STATE.life.sex;
  // v5.9：快轉到下一個抉擇 — 跳過直到遇到 pause decision
  if (STATE.fastForward) {
    STATE.fastForward = false;
    let tries = 0;
    while (tries++ < 500) {
      if (STATE.life.died || STATE.paused || STATE.pendingDecision) break;
      STATE.life.age += 1;
      STATE.life.yearOffset += 1;
      if (Math.random() < pDie(STATE.life.age, c, sex)) { dieNow(); break; }
      if ([5,15,30,50,70].includes(STATE.life.age)) {
        STATE.pendingDecision = { age: STATE.life.age, type: 'pause' };
        if (STATE.autoDecide) resolvePendingDecision();
        break;
      }
    }
    renderAll();
    return;
  }
  STATE.life.age += 1;
  STATE.life.yearOffset += 1;
  // 死亡判定
  if (Math.random() < pDie(STATE.life.age, c, sex)) {
    dieNow();
    return;
  }
  // v5.8 新增：狀態自然衰減/成長
  if (STATE.life.age > 60) STATE.life.stats.health = Math.max(0, STATE.life.stats.health - 0.3);
  // v5.59：年收入 — 舊碼 annualIncome 永遠是 0，所以「在職」也存不到錢。
  // 基準對齊原作 incomeAt(c, pct) ≈ c.ppp * 0.9，再依教育、家境分位調整。
  // 生活開銷依「自己的收入」而非人均 GDP 計算（否則低教育的人生會被壓成負資產）；
  // 儲蓄率隨分位提高 — 高收入家庭本來就存得比較多。
  if (STATE.life.stats.employment === 'employed' || STATE.life.stats.employment === 'university') {
    const ppp = Number.isFinite(c?.ppp) ? c.ppp : 12000;
    const eduMult = [0.45, 0.6, 0.75, 0.9, 1.25][Math.min(STATE.life.stats.education, 4)] ?? 0.75;
    const q = Math.min(Math.max(STATE.life.stats.incomeQuartile, 1), 4);
    const qMult = [0.55, 0.8, 1.15, 1.9][q - 1] ?? 1;
    const saveRate = [0.15, 0.22, 0.28, 0.40][q - 1] ?? 0.25;   // 分位 1→4
    const gross = ppp * 0.9 * eduMult * qMult;
    STATE.life.stats.annualIncome = Math.round(gross);
    STATE.life.stats.netAssets += Math.round(gross * saveRate);
  }
  // 知識隨教育成長
  if (STATE.life.stats.education >= 2 && STATE.life.stats.knowledge < 90) STATE.life.stats.knowledge = Math.min(100, STATE.life.stats.knowledge + 0.5);
  // v5.59：幸福會慢慢回到「當下處境決定的水位」— 沒有這個，happiness 只會被玩家的
  // 選擇單向推動，低落的時候（失業／病中／孤立／負債）永遠走不到，心理健康事件形同虛設。
  {
    const st = STATE.life.stats;
    const baseline = 45
      + (st.health - 60) * 0.35
      + (st.social - 60) * 0.12
      + (st.employment === 'employed' ? 8 : st.employment === 'university' ? 5 : st.employment === 'retired' ? 3 : -2)
      + (st.netAssets < 0 ? -8 : 0);
    st.happiness += (baseline - st.happiness) * 0.06;
    st.happiness = Math.max(0, Math.min(100, st.happiness));
  }
  // 事件
  const events = milestoneEvents(STATE.life, STATE.life.age);
  for (const e of events) {
    STATE.life.log.push(e);
    if (e.kind === 'birth' || e.kind === 'milestone') {
      logLife(e.text);
    }
  }
  renderLife();
  recordTrajectory(STATE.life);
  // v5.16：年度焦點選擇 — 改為手動觸發（不再自動彈出）
  // v5.13：年度焦點選擇（每年 6+ 歲自動彈出，除非autoDecide）→ 已改為手動
  // 達到當地平均壽命 1.3x 自動死亡
  // v5.33：壽命上限放寬（從 1.35x 改為 1.8x，1in8b.life 實測 98-101 歲）
  const maxAge = c.le * 1.8;
  if (STATE.life.age > maxAge) dieNow('自然衰老');
  // v5.20：每 5 年套用投資收益
  if (STATE.life.age % 5 === 0 && STATE.life.age > 0) applyInvestmentReturn();
  // v5.20：每 5 年彈出財務管理 modal（25/30/35/40/45/50/55/60）
  // v5.73：若這一刻已經有別的 modal 開著，就不要疊上去 ——
  // 否則玩家對上方的決策按 Escape，下一瞬間又看到財務 modal，感覺「按了沒反應」。
  // 跳過的那一年記進 financeModalShown，下一次機會自然會補上。
  if ([25, 30, 35, 40, 45, 50, 55, 60].includes(STATE.life.age) && !STATE.life.financeModalShown?.includes(STATE.life.age)) {
    STATE.life.financeModalShown = STATE.life.financeModalShown || [];
    if (STATE.paused) {
      STATE.life.financeModalShown.push(STATE.life.age);   // 記成已處理，改用自動進行
      applyInvestmentReturn();                            // 投資照跑，不影響玩家資產
    } else {
      STATE.life.financeModalShown.push(STATE.life.age);
      setTimeout(() => showFinanceModal(), 100);
    }
  }
  // v5.55：通用決策 — 在每年 tick 末尾試一個未觸發過的事件
  setTimeout(() => tryTriggerDecision(STATE.life, STATE.life.age), 120);
}
function dieNow(forcedCause) {
  const c = STATE.life.countryData;
  const cause = forcedCause || pickCause(c, STATE.life.age, STATE.life.sex);
  STATE.life.died = true;
  STATE.life.cause = cause;
  STATE.life.deathAge = STATE.life.age;
  STATE.life.log.push({ age: STATE.life.age, kind: 'death', icon: '🕯️', text: t('log.died_of', cause) });
  savePastLife(STATE.life);
  stopTicker();
  // v5.43：用 setView() 才會真的切換 .view 面板的顯示（原本直接賦值 STATE.view 只更新資料、不換畫面）
  setView('end');
}
/* v5.9 新增：解析暫停決策（自動套預設值） */
function resolvePendingDecision() {
  const dec = STATE.pendingDecision;
  if (!dec) return;
  if (dec.type === 'pause') {
    if (!STATE.life.quotes[dec.age]) {
      STATE.life.quotes[dec.age] = STATE.autoDecide ? '（自動抉擇）' : '';
    }
  }
  STATE.pendingDecision = null;
}

/* v5.10：顯示暫停問題 modal（✎ 寫下想法） */
function showPauseQuestion() {
  if (!STATE.pendingDecision || STATE.pendingDecision.type !== 'pause') return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const age = STATE.pendingDecision.age;
  // v5.33：不再設 STATE.paused = true（讓生命繼續在背景跑；modal 顯示但可手動互動）
  const modal = $('#pauseModal');
  if (!modal) return;
  const q = $('#pauseQuestion');
  if (q) q.textContent = LANG === 'en' ? `If ${age}-year-old you could remember one thing...` : `如果 ${age} 歲的你能記得一件事⋯`;
  const input = $('#pauseInput');
  if (input) input.value = STATE.life.quotes[age] || '';
  modal.removeAttribute('hidden');
  setTimeout(() => input?.focus(), 100);
}

/* v5.13：年度焦點選擇（每年 6+ 歲彈出） */
function showFocusChoice() {
  if (!STATE.life) return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const _fm = $('#focusModal');
  if (_fm && !_fm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const age = STATE.life.age;
  const isEn = LANG === 'en';
  const modal = $('#focusModal');
  if (!modal) return;
  // 5 種焦點（依年齡變化選項）
  const focusOpts = age >= 65 ? [
    { id:'health', icon:'🧘', en:'Stay healthy', zh:'養生保健' },
    { id:'family', icon:'👨‍👩‍👧', en:'Family time', zh:'陪伴家人' },
    { id:'rest', icon:'🌳', en:'Rest & enjoy', zh:'退休生活' },
  ] : age >= 22 ? [
    { id:'work', icon:'💼', en:'Career growth', zh:'職場發展' },
    { id:'family', icon:'👨‍👩‍👧', en:'Start a family', zh:'建立家庭' },
    { id:'health', icon:'🏃', en:'Health & fitness', zh:'健康管理' },
    { id:'study', icon:'📚', en:'Self-study', zh:'自我進修' },
  ] : [
    { id:'study', icon:'📚', en:'Study hard', zh:'努力讀書' },
    { id:'play', icon:'⚽', en:'Play & explore', zh:'玩耍探索' },
    { id:'family', icon:'👪', en:'Help family', zh:'幫忙家裡' },
    { id:'health', icon:'🏃', en:'Stay active', zh:'保持活力' },
  ];
  const q = $('#focusQuestion');
  if (q) q.textContent = isEn ? `Age ${age} — What do you want to focus on this year?` : `${age} 歲——這一年你想把重心放在哪？`;
  // v5.19：每個選項的影響細節 tooltip
  const tooltips = isEn ? {
    study:  '📚 +3 Knowledge · +1 Happiness',
    work:   '💼 +$2000 net assets · +2 Knowledge',
    family: '👨‍👩‍👧 +4 Social · +3 Happiness',
    health: '🧘 +4 Health',
    play:   '⚽ +3 Happiness · +1 Social',
    rest:   '🌳 +3 Happiness · +1 Health',
  } : {
    study:  '📚 +3 知識 · +1 幸福',
    work:   '💼 +$2000 淨資產 · +2 知識',
    family: '👨‍👩‍👧 +4 人際 · +3 幸福',
    health: '🧘 +4 健康',
    play:   '⚽ +3 幸福 · +1 人際',
    rest:   '🌳 +3 幸福 · +1 健康',
  };
  const body = $('#focusBody');
  if (body) body.innerHTML = focusOpts.map(o => `<button class="focus-btn" data-focus="${o.id}" title="${(tooltips[o.id] || '').replace(/"/g,'&quot;')}"><span class="fb-icon">${o.icon}</span><span class="fb-label">${isEn ? o.en : o.zh}</span><span class="fb-tip">${tooltips[o.id] || ''}</span></button>`).join('');
  body.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.dataset.focus;
      STATE.life.focus = focus;
      const opt = focusOpts.find(o=>o.id===focus);
      STATE.life.log.push({ age, kind:'focus', icon: opt?.icon || '·', text: `${isEn?'Focus':'重心'}：${opt?(isEn?opt.en:opt.zh):focus}` });
      logLife(isEn ? `Focus: ${opt?.en}` : `這一年焦點：${opt?.zh}`);
      applyFocusEffects(focus);
      closeModal('focusModal');
    });
  });
  modal.removeAttribute('hidden');
}

function applyFocusEffects(focus) {
  if (!STATE.life || !STATE.life.stats) return;
  const s = STATE.life.stats;
  if (focus === 'study') s.knowledge = Math.min(100, s.knowledge + 3);
  else if (focus === 'work') s.netAssets += 2000;
  else if (focus === 'family') { s.social = Math.min(100, s.social + 4); s.happiness = Math.min(100, s.happiness + 3); }
  else if (focus === 'health') s.health = Math.min(100, s.health + 4);
  else if (focus === 'play' || focus === 'rest') s.happiness = Math.min(100, s.happiness + 3);
  renderLifeStats();
}

/* v5.20：財務管理 modal — 投資選項 + 自動進行 */
const INVEST_OPTIONS = [
  { id:'savings', en:'Savings', zh:'存款', realReturn: 0.013, volatility: 0, desc:{ en:'after inflation 1-1.5%/yr', zh:'扣除通膨後每年 1～1.5%' }},
  { id:'bonds', en:'Bonds', zh:'債券', realReturn: 0.02, volatility: 0.05, desc:{ en:'~2% avg, low volatility', zh:'平均約 2%，波動小' }},
  { id:'60-40', en:'60/40 fund', zh:'股債各半基金', realReturn: 0.035, volatility: 0.10, desc:{ en:'~3.5% avg, medium volatility', zh:'平均 3.5%，波動中等' }},
  { id:'index', en:'Stock index', zh:'股票（指數）', realReturn: 0.05, volatility: 0.18, desc:{ en:'~5% avg, high volatility', zh:'平均 5%，波動大' }},
  { id:'global', en:'Global index', zh:'全球指數（全球股票）', realReturn: 0.05, volatility: 0.18, desc:{ en:'~5% avg + currency risk, +1% fee', zh:'平均 5%，也會隨匯率波動，每年手續費約多 1.0%' }},
  { id:'pick', en:'Stock picking', zh:'自行選股買賣', realReturn: 0.04, volatility: 0.30, desc:{ en:'most earn less than index', zh:'多數人賺得比指數少' }}
];

function showFinanceModal(forceOpt) {
  if (!STATE.life) return;
  // v5.61：記錄「今年真的被打斷了」，讓通用決策避開（延遲開啟時觸發年跟實際年會差一歲）
  STATE.life.lastInterruptAge = STATE.life.age;
  const _fm = $('#financeModal');
  if (_fm && !_fm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const life = STATE.life;
  const s = life.stats;
  const isEn = LANG === 'en';
  const modal = $('#financeModal');
  if (!modal) return;
  const currency = life.currency || 'NT$';
  const netAssets = Math.round(s.netAssets || 0);
  const currentInvest = life.investChoice || 'global';
  // v5.42：修掉 ReferenceError — `auto` 未宣告，應讀 life.autoInvest
  const auto = life.autoInvest ? 'active' : '';
  const annualCost = Math.round(netAssets * 0.03);  // 假設生活方式成本 3%
  const q = $('#financeQuestion');
  if (q) q.textContent = isEn ? `Net Worth: ${currency || 'US$'}${netAssets.toLocaleString()}` : `積蓄：${currency || 'NT$'}${netAssets.toLocaleString()}`;
  const body = $('#financeBody');
  if (body) {
    body.innerHTML = `
      <p class="muted fin-intro">${isEn ? 'Spending affects happiness, social, health and future.':'金額以當地物價換算。你怎麼花錢，會改變你的幸福、人際關係、健康和未來。'}</p>
      <div class="fin-actions">
        <div class="fin-cost">
          <strong>${isEn?'Family/friend dinners + gifts':'和家人朋友聚餐·送禮'}</strong>
          <span class="fin-effect">${isEn?'social +4 · happy +2 · not enough':'人際關係 +4 · 幸福 +2 · 錢不夠'}</span>
          <span class="fin-price">${currency}${annualCost.toLocaleString()}</span>
        </div>
      </div>
      <h4>${isEn?'Idle money investment':'閒錢理財'}</h4>
      <div class="fin-grid">
        ${INVEST_OPTIONS.map(o => `
          <button class="fin-opt ${o.id===currentInvest?'active':''}" data-id="${o.id}">
            <span class="fin-icon">${o.id==='savings'?'🏦':o.id==='bonds'?'📜':o.id==='60-40'?'📊':o.id==='index'?'📈':o.id==='global'?'🌐':'🎲'}</span>
            <span class="fin-name">${isEn?o.en:o.zh}</span>
            <span class="fin-desc">${isEn?o.desc.en:o.desc.zh}</span>
          </button>
        `).join('')}
      </div>
      <p class="fin-info muted">${isEn?'Switching choices pays fees; profits may be taxed. Real estate is separate. Most traders underperform the index.':'點選其他選項，就會賣出後轉過去。賣出時要付手續費，依國家而定，獲利可能還要繳稅。不動產基金和自己的房子是分開的：自己住的房子請在「買自己的房子」中購買，出租用的房子請在「出租用的房子」中購買。多數人賺得比指數少。'}</p>
      <div class="fin-auto">
        <button id="finAutoBtn" class="${auto === 'active' ? 'active':''}">${isEn?'▶ Auto-execute (yearly)':'▶ 自動進行（每年）'}</button>
        <p class="muted">${isEn?'Once enabled, when triggered: family gifts, dates, dining, travel, classes, donations happen automatically. Only if savings > 3× the cost.':'開啟後，每到時候就會自動進行。需要花錢的事，只有在存款超過費用的三倍時才會進行。孝親費、約會、外食、旅行、上課和捐款，只有在花完之後還能剩下一般人一年的收入時才會進行；開啟得越多，能存下的錢就越少。'}</p>
      </div>
    `;
    // wire
    body.querySelectorAll('.fin-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const choice = btn.dataset.id;
        life.investChoice = choice;
        const opt = INVEST_OPTIONS.find(o => o.id === choice);
        if (opt) {
          // apply current return rate
          toast(isEn ? `Investment set to ${opt.en}` : `投資已設為 ${opt.zh}`);
        }
        closeModal('financeModal');
      });
    });
    $('#finAutoBtn')?.addEventListener('click', () => {
      life.autoInvest = !life.autoInvest;
      $('#finAutoBtn')?.classList.toggle('active', life.autoInvest);
      toast(isEn ? (life.autoInvest ? 'Auto-invest enabled' : 'Auto-invest disabled') : (life.autoInvest ? '已開啟自動投資' : '已關閉自動投資'));
      closeModal('financeModal');
    });
  }
  modal.removeAttribute('hidden');
}

/* v5.20：每年套用投資收益（依 investChoice） */
function applyInvestmentReturn() {
  if (!STATE.life || !STATE.life.stats) return;
  const life = STATE.life;
  const choice = life.investChoice || 'global';
  const opt = INVEST_OPTIONS.find(o => o.id === choice);
  if (!opt || life.stats.netAssets <= 0) return;
  // 真實報酬率（含通膨），每年變動
  const baseReturn = opt.realReturn;
  const volatility = opt.volatility;
  const noise = (Math.random() - 0.5) * 2 * volatility;
  const yearReturn = baseReturn + noise;
  const gained = Math.round(life.stats.netAssets * yearReturn);
  life.stats.netAssets = Math.max(0, life.stats.netAssets + gained);
  if (life.autoInvest && life.stats.netAssets > 1000) {
    // 自動社交支出（家庭聚餐等）
    const socialCost = Math.round(life.stats.netAssets * 0.02);
    if (socialCost > 0 && life.stats.netAssets > socialCost * 3) {
      life.stats.netAssets -= socialCost;
      life.stats.social = Math.min(100, life.stats.social + 4);
      life.stats.happiness = Math.min(100, life.stats.happiness + 2);
      life.log.push({ age: life.age, kind:'finance', icon:'💰', text: `自動社交支出 -${socialCost} · 人際+4` });
    }
  }
  renderLifeStats();
}

/* v5.13：財務決策（18/25/35/50 歲彈出） */
function showFinancialChoice() {
  if (!STATE.life) return;
  const _fm = $('#financeModal');
  if (_fm && !_fm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const age = STATE.life.age;
  const isEn = LANG === 'en';
  const modal = $('#financeModal');
  if (!modal) return;
  // v5.19：先建好 choices，再依據「快速決定」標記誰是預設
  let choices;
  if (age === 18) choices = [
    { id:'study_loan', text: isEn?'Take student loan to study':'學生貸款升學', delta:{net:-5000, knowledge:+10} },
    { id:'work', text: isEn?'Start working immediately':'直接工作', delta:{net:+3000} },
    { id:'trade', text: isEn?'Learn a trade':'學手藝', delta:{net:+1000, knowledge:+5} },
  ];
  else if (age === 25) choices = [
    { id:'save', text: isEn?'Save aggressively':'積極儲蓄', delta:{net:+8000, happiness:-5} },
    { id:'travel', text: isEn?'Travel the world':'環遊世界', delta:{net:-6000, happiness:+10, social:+5} },
    { id:'invest', text: isEn?'Start investing':'開始投資', delta:{net:+5000, knowledge:+3} },
  ];
  else if (age === 35) choices = [
    { id:'house', text: isEn?'Buy a house':'買房', delta:{net:-50000, happiness:+5} },
    { id:'kids', text: isEn?'Have children':'生孩子', delta:{net:-10000, happiness:+10, social:+5} },
    { id:'career', text: isEn?'Focus on career':'衝刺事業', delta:{net:+20000} },
  ];
  else choices = [
    { id:'retire', text: isEn?'Save for retirement':'為退休儲蓄', delta:{net:+50000} },
    { id:'enjoy', text: isEn?'Enjoy life now':'及時行樂', delta:{net:-10000, happiness:+10} },
    { id:'give_back', text: isEn?'Donate to charity':'慈善捐贈', delta:{net:-15000, happiness:+15} },
  ];
  const q = $('#financeQuestion');
  if (q) q.textContent = isEn ? `Age ${age} — How do you want to handle your money?` : `${age} 歲——你要怎麼處理你的錢？`;
  const body = $('#financeBody');
  // v5.19：「最便宜」= delta.net 最低（最負 / 最少正）
  const cheapestIdx = (() => {
    let idx = 0, best = Infinity;
    choices.forEach((c, i) => {
      const v = (c.delta && typeof c.delta.net === 'number') ? c.delta.net : 0;
      if (v < best) { best = v; idx = i; }
    });
    return idx;
  })();
  if (body) body.innerHTML = `
    <div class="fc-row">${choices.map((c, i) => {
      const d = c.delta;
      const tags = [];
      if (d.net > 0) tags.push(`<span class="fin-pos">+$${d.net.toLocaleString()}</span>`);
      else if (d.net < 0) tags.push(`<span class="fin-neg">−$${Math.abs(d.net).toLocaleString()}</span>`);
      if (d.knowledge) tags.push(`<span class="fin-stat">+${d.knowledge} 📚</span>`);
      if (d.happiness) tags.push(`<span class="fin-stat">${d.happiness > 0 ? '+' : ''}${d.happiness} 😊</span>`);
      if (d.social) tags.push(`<span class="fin-stat">${d.social > 0 ? '+' : ''}${d.social} 👥</span>`);
      const isCheap = i === cheapestIdx;
      const badge = isCheap ? `<span class="fin-badge">${isEn ? '⚡ auto' : '⚡ 自動'}</span>` : '';
      return `<button class="finance-btn" data-idx="${i}"><span class="fin-text">${c.text}${badge}</span><span class="fin-tags">${tags.join(' ')}</span></button>`;
    }).join('')}</div>
    <div class="fc-auto-row">
      <button id="btnFinanceAuto" class="fc-auto-btn">⚡ ${isEn ? 'Quick-decide (pick cheapest)' : '快速決定（最便宜的選項）'}</button>
    </div>
  `;
  body.querySelectorAll('.finance-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.idx;
      applyFinanceChoice(choices, idx, isEn);
      closeModal('financeModal');
    });
  });
  $('#btnFinanceAuto')?.addEventListener('click', () => {
    applyFinanceChoice(choices, cheapestIdx, isEn);
    closeModal('financeModal');
    toast(isEn ? '⚡ Auto-picked cheapest option' : '⚡ 已自動選最便宜的選項');
  });
  modal.removeAttribute('hidden');
}

/* v5.25：花錢 modal — 4 種隨機社交支出選項 */
function showSpendModal() {
  if (!STATE.life) return;
  STATE.life.lastInterruptAge = STATE.life.age;   // v5.61
  const _sm = $('#spendModal');
  if (_sm && !_sm.hasAttribute('hidden')) return; // 已在開啟中，避免重複掛 listener
  STATE.paused = true;
  const modal = $('#spendModal');
  if (!modal) return;
  modal.removeAttribute('hidden');
  modal.querySelectorAll('.spend-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      const s = STATE.life.stats;
      const cost = Math.max(50, Math.round((s.netAssets || 1000) * 0.03));
      if ((s.netAssets || 0) < cost) {
        toast(LANG === 'en' ? 'Not enough money' : '錢不夠');
        closeModal('spendModal');
        return;
      }
      s.netAssets -= cost;
      if (act === 'gifts') { s.social = Math.min(100, s.social + 4); s.happiness = Math.min(100, s.happiness + 2); }
      else if (act === 'travel') { s.knowledge = Math.min(100, s.knowledge + 5); s.happiness = Math.min(100, s.happiness + 8); s.health = Math.max(0, s.health - 3); }
      else if (act === 'donate') { s.happiness = Math.min(100, s.happiness + 10); s.health = Math.min(100, s.health + 2); s.knowledge = Math.min(100, s.knowledge + 2); }
      else if (act === 'lifestyle') { s.health = Math.min(100, s.health + 1); s.happiness = Math.min(100, s.happiness + 1); }
      STATE.life.log.push({ age: STATE.life.age, kind: 'finance', icon: '💰', text: `${act} -${cost}` });
      renderLifeStats();
      toast(LANG === 'en' ? `Spent ${cost}` : `支出 ${cost}`);
      closeModal('spendModal');
    });
  });
}

/* v5.19：抽出共用的「套用財務決策」邏輯（給按鈕和「快速決定」都用） */
function applyFinanceChoice(choices, idx, isEn) {
  const choice = choices[idx];
  if (!choice) return;
  const d = choice.delta || {};
  STATE.life.stats.netAssets = Math.max(-100000, (STATE.life.stats.netAssets || 0) + (d.net || 0));
  if (d.knowledge) STATE.life.stats.knowledge = Math.min(100, Math.max(0, STATE.life.stats.knowledge + d.knowledge));
  if (d.happiness) STATE.life.stats.happiness = Math.min(100, Math.max(0, STATE.life.stats.happiness + d.happiness));
  if (d.social) STATE.life.stats.social = Math.min(100, Math.max(0, STATE.life.stats.social + d.social));
  STATE.life.log.push({ age: STATE.life.age, kind:'finance', icon:'💰', text: (isEn ? 'Money: ' : '理財：') + choice.text });
  logLife('💰 ' + choice.text);
  renderLifeStats();
}
function savePauseQuote() {
  const age = STATE.pendingDecision?.age;
  const input = $('#pauseInput');
  const txt = input?.value?.trim() || '';
  if (age != null) STATE.life.quotes[age] = txt || '（隱蔽）';
  $('#pauseModal')?.setAttribute('hidden', '');
  STATE.paused = false;
  resolvePendingDecision();
}

/* v5.14：每年自動生成事件 — 依年齡/國家/焦點產生有意義的隨機事件 */
function generateYearlyEvent(life) {
  const age = life.age;
  const c = life.countryData;
  const sex = life.sex;
  const isEn = LANG === 'en';
  const focus = life.focusThisYear;
  // 隨機事件池（依年齡分層）
  const events = [];
  if (age < 5) {
    // 幼兒期
    events.push({ weight: 30, icon: '👶', en: 'Learned to walk', zh: '學會走路' });
    events.push({ weight: 20, icon: '🗣️', en: 'First word spoken', zh: '說出第一個字' });
    events.push({ weight: 15, icon: '🤒', en: 'Had a fever', zh: '發燒了', rep: true });
    events.push({ weight: 10, icon: '👨‍👩‍👧', en: 'Started recognizing family', zh: '開始認得家人' });
  } else if (age < 13) {
    // 學齡
    events.push({ weight: 25, icon: '📚', en: 'Made a new friend', zh: '交了新朋友', rep: true });
    events.push({ weight: 20, icon: '🏆', en: 'Won a small competition', zh: '在小比賽得名次' });
    events.push({ weight: 15, icon: '🤕', en: 'Got injured playing', zh: '玩耍時受傷' });
    events.push({ weight: 10, icon: '📖', en: 'Discovered a favorite book', zh: '發現一本喜歡的書' });
    events.push({ weight: 10, icon: '🤒', en: 'Caught a cold', zh: '感冒了', rep: true });
    if (focus === 'study') events.push({ weight: 30, icon: '📝', en: 'Got good grades', zh: '成績進步了' });
  } else if (age < 18) {
    // 青少年
    events.push({ weight: 25, icon: '🎵', en: 'Discovered favorite music', zh: '發現喜歡的音樂' });
    events.push({ weight: 20, icon: '💔', en: 'First heartbreak', zh: '初戀破滅' });
    events.push({ weight: 15, icon: '🎮', en: 'Got into gaming', zh: '迷上電玩' });
    events.push({ weight: 15, icon: '🚲', en: 'Biked somewhere new', zh: '騎腳踏車去新地方' });
    events.push({ weight: 10, icon: '🤒', en: 'Got sick for a week', zh: '病了一週', rep: true });
    if (focus === 'study') events.push({ weight: 30, icon: '🎓', en: 'Won academic award', zh: '獲得學業獎' });
  } else if (age < 30) {
    // 青年
    events.push({ weight: 25, icon: '🎓', en: 'Graduated', zh: '畢業了' });
    events.push({ weight: 20, icon: '💼', en: 'Got first job', zh: '找到第一份工作' });
    events.push({ weight: 20, icon: '❤️', en: 'Fell in love', zh: '戀愛了' });
    events.push({ weight: 15, icon: '🏃', en: 'Ran a marathon', zh: '跑了馬拉松' });
    events.push({ weight: 15, icon: '🚗', en: 'Got driver license', zh: '考了駕照' });
    events.push({ weight: 10, icon: '🤒', en: 'Had health scare', zh: '健康出了點狀況' });
    if (focus === 'work') events.push({ weight: 25, icon: '📈', en: 'Got promoted', zh: '升職了' });
  } else if (age < 50) {
    // 中年
    events.push({ weight: 20, icon: '💍', en: 'Got married', zh: '結婚了' });
    events.push({ weight: 20, icon: '👶', en: 'Had a child', zh: '有了孩子' });
    events.push({ weight: 15, icon: '🏠', en: 'Bought a home', zh: '買了房子' });
    events.push({ weight: 15, icon: '📈', en: 'Got big promotion', zh: '大幅晉升' });
    events.push({ weight: 15, icon: '🚗', en: 'Bought a car', zh: '買了車' });
    events.push({ weight: 10, icon: '🤒', en: 'Had health issue', zh: '健康出了狀況' });
    events.push({ weight: 5, icon: '💔', en: 'Got divorced', zh: '離婚了' });
    if (focus === 'family') events.push({ weight: 25, icon: '👨‍👩‍👧', en: 'Family trip', zh: '家族旅遊', rep: true });
  } else if (age < 65) {
    // 中老年
    events.push({ weight: 25, icon: '🎂', en: 'Child graduated', zh: '孩子畢業了' });
    events.push({ weight: 20, icon: '🏖', en: 'Took vacation', zh: '去度假', rep: true });
    events.push({ weight: 20, icon: '🎉', en: 'Grandchild born', zh: '孫子女出生' });
    events.push({ weight: 15, icon: '🤒', en: 'Health checkup', zh: '健康檢查', rep: true });
    events.push({ weight: 10, icon: '🎓', en: 'Went back to school', zh: '重返校園' });
    events.push({ weight: 10, icon: '💔', en: 'Lost a loved one', zh: '失去摯愛' });
  } else {
    // 老年
    events.push({ weight: 25, icon: '👨‍👩‍👧', en: 'Grandchildren visit', zh: '孫子女來訪', rep: true });
    events.push({ weight: 20, icon: '🌳', en: 'Walked in the park', zh: '公園散步', rep: true });
    events.push({ weight: 20, icon: '📖', en: 'Read a great book', zh: '讀了一本好書', rep: true });
    events.push({ weight: 15, icon: '👴', en: 'Saw grandchild grow', zh: '看孫子女長大' });
    events.push({ weight: 10, icon: '🏥', en: 'Had health check', zh: '做了健康檢查', rep: true });
  }
  // 加國家特殊事件
  if (c.wh > 0.5 && Math.random() < c.wh * 0.1) {
    events.push({ weight: 20, icon: '⚔️', en: 'Affected by local unrest', zh: '受到當地動亂影響' });
  }
  // v5.62：抽權重前先濾掉「一生只該發生一次」而且已經發生過的事件，
  // 否則「畢業了」「有了孩子」「結婚了」會在一生裡重複三四次，看起來像雜訊。
  // 標了 rep: true 的（感冒、旅行、健康檢查…）本來就是日常，可以重複。
  // 若這個年齡層的一次性事件全用完了，就寧可那年沒有小事件 ——
  // 寧靜也不要「同一生結了五次婚、離了三次婚」。
  // 用陣列不用 Set：整段人生會被 lifeExport 整包 JSON.stringify，Set 會變成 {}
  const seen = life.seenOnce || (life.seenOnce = []);
  const pool = events.filter(e => e.rep || !seen.includes(e.en));
  if (!pool.length) return null;
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of pool) {
    r -= e.weight;
    if (r <= 0) { if (!e.rep) seen.push(e.en); return e; }
  }
  const first = pool[0];
  if (first && !first.rep) seen.push(first.en);
  return first;
}

/* v5.14：套用事件到狀態條（重要事件才有效果） */
function applyEventEffects(event, isYearLike) {
  if (!STATE.life || !STATE.life.stats) return;
  const s = STATE.life.stats;
  const txt = (event.text || '').toLowerCase();
  if (txt.includes('戀愛') || txt.includes('結婚') || txt.includes('度假') || txt.includes('旅遊')) {
    s.happiness = Math.min(100, s.happiness + 3);
    s.social = Math.min(100, s.social + 2);
  } else if (txt.includes('升職') || txt.includes('畢業')) {
    s.knowledge = Math.min(100, s.knowledge + 3);
    s.netAssets += 1500;
  } else if (txt.includes('生病') || txt.includes('受傷') || txt.includes('動亂') || txt.includes('離婚')) {
    s.health = Math.max(0, s.health - 5);
    s.happiness = Math.max(0, s.happiness - 3);
  } else if (txt.includes('孩子') || txt.includes('孫')) {
    s.happiness = Math.min(100, s.happiness + 5);
  }
}

function logLife(text) {
  const el = $('#lifeLog');
  if (!el) return;
  const row = document.createElement('div');
  row.className = 'log-row';
  row.textContent = text;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

/* v5.27：完整時序事件 feed — 從 life.log 渲染為卡片 */
function renderLifeEventsFeed() {
  const el = $('#lifeEventsFeed');
  if (!el || !STATE.life) return;
  const isEn = LANG === 'en';
  const log = STATE.life.log || [];
  // v5.65：原本固定顯示 30 條，「查看更早的紀錄」按鈕的 onclick 只有 stopPropagation()
  // 是空的（按了沒反應）。改成：預設 12 條 → 30 條 → 全部，逐級展開。
  const shown = Math.min(log.length, STATE.feedShown || 12);
  const siblingCount = (STATE.life.family?.siblings || []).length;
  const canMore = log.length > shown;
  const nextLabel = shown >= log.length ? null
    : shown < 30 ? (isEn ? `Show older (${Math.min(30, log.length) - shown} more)` : `看更早的 ${Math.min(30, log.length) - shown} 筆`)
    : (isEn ? 'Show all' : `看全部 ${log.length} 筆`);
  const headerHtml = `<div class="lef-header">
    <span class="lef-meta">${isEn ? `Currently ${30000 + Math.floor(Math.random()*1000)} people in the world` : `此刻有 ${30000 + Math.floor(Math.random()*1000)} 人一起活在這個人生模擬裡`}${siblingCount ? ` · ${isEn ? 'Siblings' : '兄弟姊妹'}：${siblingCount} ${isEn?'ppl':'人'}` : ''} · ${isEn ? 'showing' : '顯示'} ${shown}/${log.length}</span>
    ${canMore ? `<button class="lef-more-btn" id="feedMoreBtn">${nextLabel}</button>` : ''}
  </div>`;
  el.innerHTML = headerHtml + log.slice(-shown).reverse().map((e, i) => `
    <div class="lef-row kind-${e.kind || 'log'}">
      <span class="lef-age">${e.age ?? '?'} ${isEn?'yo':'歲'}</span>
      <span class="lef-icon">${e.icon || '·'}</span>
      <span class="lef-text">${linkifyCountries(escapeHtml(e.text || ''))}</span>
      <span class="lef-star" data-i="${e._i = (e._i ?? (log.length - 1 - i))}" title="${isEn?'Star this moment':'加星此時刻'}">${e.starred ? '★' : '☆'}</span>
    </div>
  `).join('') || `<span class="muted">${isEn ? 'No events' : '無事件'}</span>`;
  // v5.65：「看更早」逐級展開
  $('#feedMoreBtn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    STATE.feedShown = shown < 30 ? 30 : log.length;
    renderLifeEventsFeed();
  });
  // wire star clicks
  el.querySelectorAll('.lef-star').forEach(s => {
    s.addEventListener('click', () => {
      const i = +s.dataset.i;
      const evt = log[i];
      if (evt) {
        evt.starred = !evt.starred;
        renderLifeEventsFeed();
        toast(evt.starred ? (isEn?'★ Moment starred':'★ 已記下此時刻') : (isEn?'☆ Unstarred':'☆ 已取消記下'));
      }
    });
  });
}

/* v5.28：把文字裡的「旗幟+國家」轉為點擊 link（跳到族譜看該國） */
function linkifyCountries(text) {
  if (!STATE.life || !text) return text;
  // 抓取 🇹🇼 國旗後接的 1-3 字中文國名
  const flagRegex = /([\u{1F1E6}-\u{1F1FF}]{2})([\u{4E00}-\u{9FFF}]{1,4})/gu;
  return text.replace(flagRegex, (m, flag, name) => {
    // 找對應國家
    const c = COUNTRIES.find(cc => cc.name_zh === name || cc.name_en === name);
    if (!c) return m;
    return `<a href="#" class="lef-country-link" data-country="${c.id}">${flag}${name}</a>`;
  });
}

/* v5.28：events feed 裡的國家 link 點擊 → 切換到族譜 + 切換到該國 */
document.addEventListener('click', e => {
  const a = e.target.closest('.lef-country-link');
  if (!a) return;
  e.preventDefault();
  const cid = a.dataset.country;
  if (!cid) return;
  document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === 'tree') b.click(); });
  setTimeout(() => {
    if (STATE.life) {
      STATE.life.country = cid;
      STATE.life.countryData = countryById(cid);
      STATE.life.family = generateFamily(cid, STATE.life.sex);
      renderAll();
    }
  }, 100);
});

// ==== 過去生命 ====
function savePastLife(life) {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY + ':past') || '[]');
    // v5.83：以前只存 country/name/age/cause 五個欄位（約 71 bytes），
    // 導致「回到那一生」和「家族全景圖」拿到的是空殼 ——
    // renderPanorama 每一次都會在 selfNodes[0].id 直接拋 TypeError（該功能完全壞掉）。
    // 改存完整人生：實測約 12.8KB／段，50 段 ≈ 626KB（localStorage 配額通常 5MB）。
    // 事件紀錄只留最後 60 條避免無限膨脹；family / stats / decisions 都保留。
    const full = JSON.parse(JSON.stringify(life));
    if (Array.isArray(full.log) && full.log.length > 60) full.log = full.log.slice(-60);
    const rec = {
      ts: Date.now(),
      country: life.country,
      name: life.name.full || life.name.full_en || '',
      age: life.deathAge || life.age,
      cause: life.cause,
      full,                        // 完整人生；舊紀錄沒有這個欄位
    };
    arr.unshift(rec);
    // 配額不足時逐步丟掉最舊的紀錄，而不是整個寫入失敗
    while (arr.length) {
      try {
        localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(arr.slice(0, 50)));
        break;
      } catch (e) {
        arr.pop();
      }
    }
  } catch (e) {}
}
function loadPastLives() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY + ':past') || '[]');
  } catch (e) { return []; }
}

// ==== 路由 ====
/* ==== v5.68：topbar 圖示按鈕的圖示與 tooltip ====
   修兩個問題：
   1) 暫停鈕第一次點擊後圖示會從 ❚❚ 變成 ⏸（不同字形），而且完全沒有 tooltip
   2) 自動抉擇鈕的標籤是寫死的中文「⏸ 停止自動」，在英文/日文介面仍是中文 */
function syncPauseBtn() {
  const b = $('#btnPause');
  if (!b) return;
  const paused = !!STATE.paused;
  b.textContent = paused ? '▶' : '❚❚';
  b.title = t(paused ? 'life.resume' : 'life.pause');
  b.setAttribute('aria-label', b.title);
}
function syncAutoBtn() {
  const b = $('#btnAuto');
  if (!b) return;
  const on = !!STATE.autoDecide;
  b.textContent = on ? `⏹ ${t('life.autoDecide.off')}` : `▶ ${t('life.autoDecide')}`;
  b.title = t(on ? 'life.autoDecide.off' : 'life.autoDecide');
}

function setView(v) {
  STATE.view = v;
  $$('.view').forEach(el => el.classList.remove('active'));
  $$('.navbtn').forEach(el => el.classList.remove('active'));
  const vEl = $('#view-' + v);
  if (vEl) vEl.classList.add('active');
  const nEl = $(`.navbtn[data-view="${v}"]`);
  if (nEl) nEl.classList.add('active');
  renderView(v);
}
function renderView(v) {
  if (v === 'intro') renderIntro();
  else if (v === 'life') renderLife();
  else if (v === 'end') renderEnd();
  else if (v === 'shelf') renderShelf();
  else if (v === 'lab') renderLab();
  else if (v === 'tree') renderTree();
}

// ==== 渲染 ====
function renderAll() {
  document.documentElement.lang = LANG;
  document.title = t('title');
  // 通用翻譯
  $$('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  $$('[data-t-html]').forEach(el => { el.innerHTML = t(el.dataset.tHtml); });
  // v5.68：title / aria-label 也走 i18n（topbar 那幾顆只有圖示，靠 tooltip 解釋）
  $$('[data-t-title]').forEach(el => { el.title = t(el.dataset.tTitle); });
  $$('[data-t-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.tAria)); });
  // 暫停鈕的圖示/t���示跟著實際狀態走（STATE.paused 有很多地方會被清掉）
  if (typeof syncPauseBtn === 'function') syncPauseBtn();
  if (typeof syncAutoBtn === 'function') syncAutoBtn();
  // 視圖
  if (STATE.view === 'intro') renderIntro();
  else if (STATE.view === 'life') renderLife();
  else if (STATE.view === 'end') renderEnd();
  else if (STATE.view === 'shelf') renderShelf();
  else if (STATE.view === 'lab') renderLab();
  else if (STATE.view === 'tree') renderTree();
  renderSpeedBtns();
  renderSoftModeBtn();
  updateLangSwitcher();
}

function renderIntro() {
  // 國家預設
  if (!STATE.selectedCountry) {
    // 預設第一個
    STATE.selectedCountry = 'TWN';
  }
  const sel = $('#countrySelect');
  if (sel && sel.children.length !== COUNTRIES.length) {
    sel.innerHTML = '';
    for (const c of COUNTRIES) {
      const loc = localize(c);
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.flag} ${loc.name}`;
      if (c.id === STATE.selectedCountry) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const c = countryById(STATE.selectedCountry);
  if (c) {
    const loc = localize(c);
    $('#introCountryRegion').textContent = loc.region_name;
    $('#introCountryLe').textContent = c.le + ' ' + t('unit.years');
    $('#introCountryIm').textContent = c.im;
    $('#introCountryU5').textContent = c.u5;
    $('#introCountryPpp').textContent = '$' + c.ppp.toLocaleString();
  }
  // v5.19：即時計數器 + 今日主題 + 機率分布 + 國家對照
  renderDailyTheme();
  renderProbTable();
  renderCountryCompare();
  // 即時計數器在 init 啟動；renderIntro 重繪時不重啟
  updateRealtimeCounters();
  // v5.20：現在居住的地方（active players map）
  renderActivePlayersMap();
}

/* v5.19：今日主題顯示 */
function renderDailyTheme() {
  const el = $('#dailyTheme');
  if (!el) return;
  const { word, dayKey, en } = getDailyTheme();
  el.textContent = word;
  el.dataset.en = en || '';
  el.dataset.dayKey = dayKey;
}

/* v5.19：出生機率分布表（top 10） */
function renderProbTable() {
  const wrap = $('#probTable');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const mode = STATE.birthMode === 'all' ? 'all' : 'baby';
  const rows = countryProbabilities(mode, 10);
  const modeLabel = mode === 'all'
    ? (isEn ? '8 billion alive' : '80 億人活口')
    : (isEn ? 'Just born' : '此刻出生');
  wrap.innerHTML = `
    <h3>${isEn ? 'If you were born right now…' : '如果你此刻出生⋯⋯'} <span class="muted">(${modeLabel})</span></h3>
    <table class="prob-table">
      <thead><tr>
        <th>${isEn ? 'Country' : '國家'}</th>
        <th class="prob-pct">${isEn ? 'Probability' : '機率'}</th>
        <th class="prob-bar-col"></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const loc = localize(r.c);
          return `<tr>
            <td><span class="prob-flag">${r.c.flag}</span><span class="prob-name">${escapeHtml(loc.name)}</span></td>
            <td class="prob-pct">${r.pct.toFixed(1)}%</td>
            <td class="prob-bar-col"><div class="prob-bar" style="width:${Math.max(2, r.pct * 5)}%"></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="muted">${isEn ? 'Source: UN WPP 2024 (annual births / total population by country)' : '資料來源：聯合國《世界人口展望 2024》（各國年度出生數／總人口）'}</p>
  `;
}

/* v5.19：「如果你現在出生」對照表 — 你的實際國家 vs 隨機國家 */
function renderCountryCompare() {
  const wrap = $('#countryCompare');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const me = guessUserCountry();
  const random = chooseCountry(STATE.birthMode);
  if (!me || !random) { wrap.innerHTML = ''; return; }
  // 三項關鍵指標
  const meLe = me.le;
  const rLe = random.le;
  const meU5 = (me.u5 || 0) / 1000 * 100;
  const rU5 = (random.u5 || 0) / 1000 * 100;
  const mePpp = me.ppp || 0;
  const rPpp = random.ppp || 0;
  const loc = (c) => LANG === 'en' ? c.name_en : c.name_zh;
  const fmtPct = (n) => (n < 0.1 ? n.toFixed(2) : n.toFixed(1)) + '%';
  const fmtMoney = (n) => '$' + Math.round(n).toLocaleString();
  wrap.innerHTML = `
    <h3>${isEn ? 'If you were born now, your life vs. a random one' : '如果你此刻出生：你的人生 vs 隨機的人生'}</h3>
    <table class="cmp-table">
      <thead><tr>
        <th></th>
        <th>${me.flag} ${escapeHtml(loc(me))}<div class="cmp-sub">${isEn ? 'Where you probably are' : '你實際所在地'}</div></th>
        <th>${random.flag} ${escapeHtml(loc(random))}<div class="cmp-sub">${isEn ? 'Random draw' : '隨機抽中'}</div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="cmp-k">${isEn ? 'Life expectancy' : '平均壽命'}</td>
          <td class="cmp-v">${meLe.toFixed(1)} ${isEn ? 'yrs' : '歲'}</td>
          <td class="cmp-v">${rLe.toFixed(1)} ${isEn ? 'yrs' : '歲'}</td>
        </tr>
        <tr>
          <td class="cmp-k">${isEn ? 'Under-5 mortality' : '5 歲前死亡機率'}</td>
          <td class="cmp-v">${fmtPct(meU5)}</td>
          <td class="cmp-v">${fmtPct(rU5)}</td>
        </tr>
        <tr>
          <td class="cmp-k">${isEn ? 'GDP per capita (PPP)' : '人均 GDP（PPP）'}</td>
          <td class="cmp-v">${fmtMoney(mePpp)}</td>
          <td class="cmp-v">${fmtMoney(rPpp)}</td>
        </tr>
      </tbody>
    </table>
    <p class="muted">${isEn ? 'Detected from browser language / locale. You can override by selecting one in the country list above.' : '依瀏覽器語系／地區推測。你可以從上方國家清單覆寫。'}</p>
  `;
}

/* v5.19：完整出生登記卡 — 1in8b.life 風格 */
function buildBirthCertCard(c, life) {
  if (!c || !life) return '';
  const isEn = LANG === 'en';
  const loc = localize(c);
  const fam = life.family || {};
  const father = fam.parents?.find(p => p.sex === 'M');
  const mother = fam.parents?.find(p => p.sex === 'F');
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  // 父母住房（依國家統計推測：urb%、agr% 推）
  const housing = (() => {
    const isRural = (life.stats.birthPlaceType === 'rural');
    if (isRural) {
      const typ = (c.agr || 30) > 50 ? (isEn ? 'Farm' : '農舍')
                : (c.agr || 30) > 20 ? (isEn ? 'Village house' : '村莊平房')
                : (isEn ? 'Suburban house' : '郊區住宅');
      return typ;
    }
    // 城市
    if ((c.ppp || 0) > 30000) return isEn ? 'Modern apartment' : '現代公寓';
    if ((c.ppp || 0) > 10000) return isEn ? 'Apartment block' : '公寓大樓';
    return isEn ? 'Slum / informal settlement' : '貧民窟／非正式住宅';
  })();
  const sexLabel = life.sex === 'M' ? t('sex.male') : t('sex.female');
  const yr = life.year + life.yearOffset;
  const u5pct = ((c.u5 || 0) / 1000 * 100);
  return `
    <div class="bc-stamp">${isEn ? 'OFFICIAL BIRTH REGISTRATION' : '出 生 登 記 證 明'}</div>
    <div class="bc-header">
      <div class="bc-flag">${c.flag}</div>
      <div class="bc-name">${escapeHtml(loc.name)}</div>
      <div class="bc-iso">${c.id}</div>
    </div>
    <div class="bc-reg">${isEn ? 'Reg. No.' : '登記編號'}：<b>${escapeHtml(life.regNumber || (c.id + '-' + yr + '-0000000'))}</b></div>
    <div class="bc-reg">${isEn ? 'Date of Birth' : '出生日期'}：<b>${yr}-01-01</b></div>
    <table class="bc-table">
      <tbody>
        <tr><td class="bc-k">${isEn ? 'Name' : '姓名'}</td><td class="bc-v">${escapeHtml(life.name.full || life.name.full_en || '—')}</td></tr>
        <tr><td class="bc-k">${isEn ? 'Sex' : '性別'}</td><td class="bc-v">${sexLabel}</td></tr>
        <tr><td class="bc-k">${isEn ? 'Country' : '出生國家'}</td><td class="bc-v">${c.flag} ${escapeHtml(loc.name)}</td></tr>
        <tr><td class="bc-k">${isEn ? 'Place' : '出生地'}</td><td class="bc-v">${life.stats.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : '🏙️ 城市')} · ${escapeHtml(loc.region_name || '')}</td></tr>
        <tr><td class="bc-k">${isEn ? 'Household income' : '家境'}</td><td class="bc-v">${isEn ? 'Quartile' : '分位'} Q${life.stats.incomeQuartile || 2} / 4</td></tr>
        <tr><td class="bc-k">${isEn ? "Father's age / job" : '父親年齡／工作'}</td><td class="bc-v">${father ? escapeHtml(father.name) : '—'}${fd.age ? ` · ${fd.age} ${isEn ? 'yrs' : '歲'}` : ''}${fd.job ? ` · ${escapeHtml(fd.job)}` : ''}</td></tr>
        <tr><td class="bc-k">${isEn ? "Mother's age / job" : '母親年齡／工作'}</td><td class="bc-v">${mother ? escapeHtml(mother.name) : '—'}${md.age ? ` · ${md.age} ${isEn ? 'yrs' : '歲'}` : ''}${md.job ? ` · ${escapeHtml(md.job)}` : ''}</td></tr>
        <tr><td class="bc-k">${isEn ? "Parents' housing" : '父母住房'}</td><td class="bc-v">${escapeHtml(housing)}</td></tr>
        <tr><td class="bc-k">${isEn ? 'Religion' : '宗教'}</td><td class="bc-v">${escapeHtml(life.stats.religion || (isEn ? '—' : '未填'))}</td></tr>
        <tr class="bc-stat"><td class="bc-k">${isEn ? 'Life expectancy' : '平均壽命'}</td><td class="bc-v">${c.le.toFixed(1)} ${isEn ? 'yrs' : '歲'}</td></tr>
        <tr class="bc-stat"><td class="bc-k">${isEn ? 'Under-5 mortality' : '5 歲前死亡機率'}</td><td class="bc-v">${u5pct < 0.1 ? u5pct.toFixed(2) : u5pct.toFixed(1)}%</td></tr>
        <tr class="bc-stat"><td class="bc-k">${isEn ? 'GDP per capita (PPP)' : '人均 GDP（PPP）'}</td><td class="bc-v">$${(c.ppp || 0).toLocaleString()}</td></tr>
      </tbody>
    </table>
  `;
}

/* v5.19：顯示出生登記卡 modal */
function showBirthCertModal(c) {
  const modal = $('#birthCertModal');
  if (!modal) return;
  // 先建立一個臨時的 life 物件（不啟動 ticker、不切換視圖）
  const life = newLife(c.id);
  if (!life) return;
  STATE.birthCertCountry = c;
  const body = $('#birthCertBody');
  if (body) body.innerHTML = buildBirthCertCard(c, life);
  modal.removeAttribute('hidden');
  STATE.modal = 'birthCert';
}
function hideBirthCertModal() {
  const modal = $('#birthCertModal');
  if (modal) modal.setAttribute('hidden', '');
  if (STATE.modal === 'birthCert') STATE.modal = null;
  STATE.birthCertCountry = null;
}

/* v5.19：點「出 生」按鈕 — 隨機抽國家、顯示出生卡、確認後才開始 */
function startLifeWithCert() {
  const c = chooseCountry(STATE.birthMode);
  if (!c) return;
  // 顯示出生卡 modal，等使用者按「開始人生」才正式 startLife
  showBirthCertModal(c);
}

function renderLife() {
  if (!STATE.life) return;
  const c = STATE.life.countryData;
  const loc = localize(c);
  const isEn = LANG === 'en';
  $('#lifeFlag').textContent = c.flag;
  $('#lifeName').textContent = loc.name;
  const yearTxt = STATE.life.year + STATE.life.yearOffset;
  $('#lifeYear').textContent = yearTxt;
  $('#lifeYear2') && ($('#lifeYear2').textContent = yearTxt);
  // v5.37：年齡大字（40px serif）含 inline 歲小字
  const ageEl = $('#lifeAge');
  if (ageEl) ageEl.innerHTML = (STATE.life.age || 0) + '<small>' + t('unit.years') + '</small>';
  $('#lifeName2').textContent = (STATE.life.name.full || STATE.life.name.full_en) || '...';
  $('#lifeLe').textContent = c.le;
  $('#lifeSex').textContent = STATE.life.sex === 'M' ? t('sex.male') : t('sex.female');
  // 教育：顯示 0-4 級距 + 已就讀年數
  const educLabels = ['—', t('edu.0')+'（'+t('edu.pre')+'）', t('edu.1'), t('edu.2'), t('edu.3'), t('edu.4')];
  $('#lifeEduc').textContent = educLabels[Math.min(STATE.life.stats.education + 1, educLabels.length - 1)];
  // 工作：顯示 sector + 是否在職
  $('#lifeJob').textContent = STATE.life.stats.employment === 'employed' ? `${jobLabel('employed')} · ${LANG==='en'?'employed':'在職'}` : jobLabel(STATE.life.stats.employment);
  // 伴侶：顯示名字 + 年齡
  if (STATE.life.stats.married && STATE.life.stats.partner) {
    const p = STATE.life.stats.partner;
    const pName = p.name?.full || p.name?.full_en || '';
    const pAge = p.age || ((STATE.life.year + STATE.life.yearOffset) - (p.birth?.year || 0));
    $('#lifePartner').textContent = `${pName}（${pAge} ${t('unit.years')}）`;
  } else {
    $('#lifePartner').textContent = t('partner.no');
  }
  // 子女：顯示數量 + 最長子年齡
  if (STATE.life.stats.kids.length) {
    const ages = STATE.life.stats.kids.map(k => k.bornAt ? STATE.life.age - k.bornAt : null).filter(a => a !== null);
    const oldest = ages.length ? Math.max(...ages) : null;
    $('#lifeKids').textContent = `${STATE.life.stats.kids.length}${LANG==='en'?` (oldest: ${oldest})`:`（最大的 ${oldest} 歲）`}`;
  } else {
    $('#lifeKids').textContent = '0';
  }
  // v5.37：進度條（4px scaleX，位於 sticky topbar 內）
  const pct = Math.min(100, STATE.life.age / c.le * 100);
  const bar = $('#lifeBar');
  if (bar) bar.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
  // 角色簡介
  const portrait = $('#lifePortrait');
  if (portrait) {
    portrait.className = 'cert-figure';
    portrait.innerHTML = pixelPortraitSVG(STATE.life.countryData, STATE.life.age, STATE.life.sex);
  }
  // 出生地：rural/urban + 國家 + 地區
  const cInfo = $('#lifeCountryInfo');
  if (cInfo) {
    // v5.21 修：fallback 給舊存檔的 birthPlaceType 缺失
    if (!STATE.life.stats.birthPlaceType) {
      STATE.life.stats.birthPlaceType = Math.random() < 0.55 ? 'rural' : 'urban';
    }
    const bpType = STATE.life.stats.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : '🏙️ 城市');
    cInfo.textContent = `${bpType} · ${c.flag} ${loc.name} · ${loc.region_name}`;
  }
  // 家族摘要
  renderFamilySummary();
  // v5.8 新增：狀態條 + 家庭背景 + 同伴
  renderLifeStats();
  renderLifeFamilyDetail();
  renderLifeCompanions();
  renderCountryStats();
  renderSurvivalCurve();
  renderThisYear();
  renderLifeEventsFeed();
  renderManualDecisions();
  renderLifeMap();
  renderIdentityRecord();
  // v5.20：本年死因分析
  renderLifeCauseThisYear();
  // v5.19：「如果你現在出生」vs 隨機 比較表 + 「狀態 ℹ️」綁定
  bindStateInfoButton();
  renderActualVsRandom();
}

/* v5.14：本年最重要事件 */
function renderThisYear() {
  if (!STATE.life) return;
  const wrap = $('#lifeThisYearBody');
  if (!wrap) return;
  const evt = STATE.life.latestEvent;
  const isEn = LANG === 'en';
  if (!evt) { wrap.innerHTML = `<span class="muted">${isEn ? '(no major event this year yet)':'（今年尚無重大事件）'}</span>`; return; }
  wrap.innerHTML = `
    <div class="ty-event">
      <span class="ty-icon">${evt.icon}</span>
      <span class="ty-text">${escapeHtml(evt.text)}</span>
      <span class="ty-age">${isEn ? `Age ${evt.age}` : `${evt.age} 歲`}</span>
    </div>
  `;
}

/* v5.15：5 面向終身軌跡圖（健康/教育/收入/關係/家境） */
/* v5.18：人生地圖（格子圖，1格=1年，顏色=幸福度） */
function renderLifeMap() {
  if (!STATE.life) return;
  const wrap = $('#lifeMap');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const c = life.countryData;
  const cols = 10;
  const maxAge = 100;
  const rows = Math.ceil(maxAge / cols);
  const W = cols * 12;  // 12px per cell
  const H = rows * 12;
  // 每格 = 1 歲。顏色依該歲的幸福度（已知數據由 trajectory/events 推估；未知用推測）
  const yearHappiness = (age) => {
    if (life.latestEvent && life.latestEvent.age === age) return Math.min(100, (life.stats.happiness || 70) + 10);
    if (age < 6) return 70 + age * 2; // 嬰兒期偏中性
    if (age < 18) return 75 + Math.sin(age * 0.5) * 15;
    if (age < 30) return 70 + Math.cos(age * 0.3) * 20;
    if (age < 65) return 65 + Math.sin(age * 0.4) * 20;
    return 60 + Math.cos(age * 0.5) * 15;
  };
  let cells = '';
  for (let a = 0; a < maxAge; a++) {
    const col = a % cols;
    const row = Math.floor(a / cols);
    const x = col * 12, y = row * 12;
    const isCurrent = a === life.age;
    const isDead = life.died && a > life.deathAge;
    const happiness = yearHappiness(a);
    const fill = isDead ? '#d8cdb8' : happinessColor(happiness);
    cells += `<rect x="${x+1}" y="${y+1}" width="10" height="10" fill="${fill}" opacity="${isDead?0.3:0.85}" stroke="${isCurrent?'#8C1D3C':'none'}" stroke-width="${isCurrent?2:0}"/>`;
  }
  wrap.innerHTML = `
    <h4>🗺️ ${isEn ? 'Life Map' : '人生地圖'} <span class="muted">${isEn ? '1 cell = 1 year · darker = happier':'1格=1年 · 顏色越深越幸福'}</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="life-map-svg" style="width:100%;max-width:480px;height:auto;display:block;margin:6px auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      ${cells}
    </svg>
    <p class="muted">${isEn?'Outer box = average life expectancy in this country':'外框格 = '+c.flag+(isEn?c.name_en:c.name_zh)+' 平均壽命 '+(c.le||70)+(isEn?' yrs':'歲')}</p>
  `;
}

function happinessColor(h) {
  // 0-100 幸福度 → 紅(0) → 橘(50) → 綠(100)
  if (h < 30) return `rgb(${Math.round(220 - h*1.5)}, ${Math.round(80 + h)}, ${Math.round(60 + h*1.5)})`;
  if (h < 60) return `rgb(${Math.round(220 - (h-30)*3)}, ${Math.round(180 + (h-30)*1.5)}, ${Math.round(70 + (h-30)*0.5)})`;
  return `rgb(${Math.round(110 - (h-60)*1.5)}, ${Math.round(220 + (h-60)*0.3)}, ${Math.round(90 + (h-60)*0.5)})`;
}

function renderLifeTrajectory() {
  if (!STATE.life) return;
  const wrap = $('#lifeTrajectory');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const traj = life.trajectory || [];
  const W = 600, H = 220;
  const maxAge = Math.max(life.age, 20);
  const projX = (a) => 40 + (a / maxAge) * (W - 60);
  const projY = (v) => H - 30 - (v / 100) * (H - 50);
  const lines = [
    { key:'health', color:'#22c55e', en:'Health', zh:'健康' },
    { key:'knowledge', color:'#3b82f6', en:'Education', zh:'教育' },
    { key:'income', color:'#eab308', en:'Income', zh:'收入' },
    { key:'relationship', color:'#a855f7', en:'Relationship', zh:'關係' }
  ];
  // income 標準化：netAssets / 50 (cap 100)
  const norm = (k, v) => k === 'income' ? Math.min(100, Math.max(0, v / 80)) : Math.max(0, Math.min(100, v));
  let paths = '';
  lines.forEach(L => {
    const pts = traj.filter(p => p[L.key] != null).map(p => `${projX(p.age)},${projY(norm(L.key, p[L.key]))}`).join(' L ');
    if (pts) paths += `<path d="M ${pts}" fill="none" stroke="${L.color}" stroke-width="2"/>`;
  });
  // 家境：水平虛線（基本不改變）
  const familyY = projY(norm('relationship', life.stats.incomeQuartile * 25));  // 簡化顯示
  const familyPath = traj.length ? `M ${projX(0)} ${familyY} L ${projX(maxAge)} ${familyY}` : '';
  // 自己位置
  const myAge = life.age;
  let lifeAtAge = traj.find(p => p.age === myAge);
  const myPoints = lines.map(L => {
    const v = L.key === 'health' ? life.stats.health : L.key === 'knowledge' ? life.stats.knowledge : L.key === 'income' ? Math.min(100, life.stats.netAssets / 80) : L.key === 'relationship' ? life.stats.social : 50;
    return `<circle cx="${projX(myAge)}" cy="${projY(norm(L.key, v))}" r="3" fill="${L.color}" stroke="white" stroke-width="1"/>`;
  }).join('');
  wrap.innerHTML = `
    <h4>📊 ${isEn ? '5 Life Dimensions Over Time' : '5 個面向終身軌跡'} <span class="muted">(${isEn ? 'past → present':'過去→現在'})</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="trajectory-svg" style="width:100%;height:auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      <line x1="40" y1="${H-30}" x2="${W-10}" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <line x1="40" y1="20" x2="40" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <text x="32" y="22" font-size="9" fill="#666" text-anchor="end">100</text>
      <text x="32" y="${H-32}" font-size="9" fill="#666" text-anchor="end">0</text>
      ${familyPath ? `<path d="${familyPath}" fill="none" stroke="#a16207" stroke-width="1.5" stroke-dasharray="6 4"/>` : ''}
      ${paths}
      ${myPoints}
      <text x="42" y="${H-15}" font-size="8" fill="#999">0</text>
      <text x="${W-12}" y="${H-15}" font-size="8" fill="#999" text-anchor="end">${maxAge}</text>
      <text x="${W/2}" y="${H-15}" font-size="8" fill="#999" text-anchor="middle">${isEn?'Age':'年齡'}</text>
      <g font-size="9" font-weight="600" transform="translate(${W-150}, 8)">
        <rect x="0" y="0" width="140" height="74" fill="white" stroke="#d8cdb8" rx="4"/>
        ${lines.map((L, i) => `<line x1="6" y1="${14 + i*15}" x2="20" y2="${14 + i*15}" stroke="${L.color}" stroke-width="2"/><text x="24" y="${17 + i*15}" fill="#5a4a3a">${isEn?L.en:L.zh}</text>`).join('')}
        <line x1="6" y1="${14 + 4*15}" x2="20" y2="${14 + 4*15}" stroke="#a16207" stroke-width="1.5" stroke-dasharray="4 2"/><text x="24" y="${17 + 4*15}" fill="#5a4a3a">${isEn?'Family BG':'家境'}</text>
      </g>
    </svg>
    <p class="muted">${isEn?'Current values: ':'當前數值：'}🟢 ${isEn?'Health':'健康'} ${Math.round(life.stats.health)} · 🔵 ${isEn?'Education':'教育'} ${Math.round(life.stats.knowledge)} · 🟡 ${isEn?'Income':'收入'} PPP $${Math.round(life.stats.netAssets).toLocaleString()} · 🟣 ${isEn?'Relationship':'關係'} ${Math.round(life.stats.social)}</p>
  `;
}

/* v5.15：在 tick 內記錄 5 面向狀態（每 5 年取樣） */
function recordTrajectory(life) {
  if (!life) return;
  if (!life.trajectory) life.trajectory = [];
  const age = life.age;
  const s = life.stats;
  const last = life.trajectory[life.trajectory.length - 1];
  // 每 5 歲或重大事件記錄一次
  if (age % 5 !== 0 && (!last || age - last.age < 5)) return;
  life.trajectory.push({
    age,
    health: s.health,
    knowledge: s.knowledge,
    income: Math.min(100, Math.round(s.netAssets / 80)),
    relationship: s.social
  });
}

/* v5.8 新增：4 個狀態條 + 淨資產 */
/* v5.16：手動決策面板（玩家主動觸發） */
/* v5.19：新增「⚡ 快速決定」+ 「♪ 音樂」按鈕 */
function renderManualDecisions() {
  if (!STATE.life) return;
  const wrap = $('#lifeManualDecisions');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const life = STATE.life;
  const age = life.age;
  const financeAges = [18, 25, 35, 50];
  const financeAvail = financeAges.includes(age) && !life.financeDecisions?.find(d => d.age === age);
  const financePast = (life.financeDecisions || []).filter(d => financeAges.includes(d.age));
  // 焦點按鈕永遠可用（玩家可主動選擇今年焦點）
  wrap.innerHTML = `
    <h4>🎯 ${isEn ? 'Manual Decisions' : '手動決策'} <span class="muted">${isEn ? '(player chooses when to act)':'（由玩家主動選擇）'}</span></h4>
    <div class="md-row">
      <button id="mdFocusBtn" class="md-btn">🎯 ${isEn ? 'Choose this year\'s focus' : '設定本年焦點'} <span class="md-hint">${life.focus ? (isEn?'Now: ':'目前：')+life.focus : (isEn?'(not set)':'（未設定）')}</span></button>
      ${financeAvail ? `<button id="mdFinanceBtn" class="md-btn">💰 ${isEn?'Make financial decision at age '+age:'決定 ' + age + ' 歲的財務規劃'}</button>` : financePast.length ? `<span class="md-hint">${isEn?'Financial decisions made: ':'已做的財務決策：'} ${financePast.map(d => d.age).join('、')}</span>` : ''}
      <button id="mdQuickDecideBtn" class="md-btn md-btn-auto" title="${isEn ? 'Auto-apply: focus=work + finance=cheapest. Lets you watch a full life without manual input.' : '自動套：焦點→work / 財務→最便宜。可以放手看完整個人生。'}">⚡ ${isEn ? 'Quick-decide all (focus=work + cheapest)' : '快速決定（焦點→work、最便宜）'}</button>
      <button id="mdMusicBtn" class="md-btn md-btn-music" title="${isEn ? 'Soft background music' : '輕柔的背景音樂'}">♪ ${isEn ? 'Background music' : '背景音樂'}</button>
      <button id="mdSpendBtn" class="md-btn md-btn-spend" title="${isEn ? 'Family gifts · Lifestyle · Travel · Donate' : '聚餐·生活方式·旅行·捐款'}">💸 ${isEn ? 'Spend' : '花錢'}</button>
    </div>
  `;
  // wire
  $('#mdFocusBtn')?.addEventListener('click', () => showFocusChoice());
  $('#mdFinanceBtn')?.addEventListener('click', () => showFinancialChoice());
  $('#mdSpendBtn')?.addEventListener('click', () => showSpendModal());
  // v5.19：「快速決定」= 焦點→work、財務→最便宜、然後加速看完一生
  $('#mdQuickDecideBtn')?.addEventListener('click', () => {
    if (!STATE.life) return;
    STATE.life.focus = 'work';
    applyFocusEffects('work');
    toast(isEn ? '⚡ Auto: focus=work, finance→cheapest. Speeding up ×4.' : '⚡ 自動：焦點→work、財務→最便宜。加速 ×4 中。');
    // 加快速度，讓玩家「放手看完」
    STATE.speed = 4;
    STATE.autoDecide = true;
    $$('.ltb-speed-btn').forEach(b => b.classList.toggle('active', +b.dataset.speed === STATE.speed));
    renderSpeedBtns && renderSpeedBtns();
  });
  // v5.19：「♪ 背景音樂」= 沒有音樂資源，顯示 toast
  $('#mdMusicBtn')?.addEventListener('click', () => {
    toast(isEn ? '♪ Music feature coming soon' : '♪ 音樂功能即將推出');
  });
}

function renderLifeStats() {
  if (!STATE.life) return;
  const s = STATE.life.stats;
  const set = (valEl, barEl, v) => {
    if (!valEl || !barEl) return;
    valEl.textContent = Math.round(v);
    barEl.style.width = Math.max(0, Math.min(100, v)) + '%';
  };
  set($('#stateHealthVal'), $('#stateHealth'), s.health);
  set($('#stateHappyVal'), $('#stateHappy'), s.happiness);
  set($('#stateKnowledgeVal'), $('#stateKnowledge'), s.knowledge);
  set($('#stateSocialVal'), $('#stateSocial'), s.social);
  // 淨資產（PPP 美元）
  const na = $('#netAssets');
  if (na) na.textContent = 'US$' + Math.round(s.netAssets || 0).toLocaleString();
  // v5.19：當年存活率
  renderSurvivalRate();
  // v5.19：你現在 vs 隨機國家 比較表
  renderActualVsRandom();
}

/* v5.19 新增：「狀態代表什麼？」展開說明 */
function bindStateInfoButton() {
  const btn = $('#btnStateInfo');
  const panel = $('#stateInfoPanel');
  if (!btn || !panel) return;
  // 避免重複綁定
  if (btn.__wired) return;
  btn.__wired = true;
  btn.addEventListener('click', () => {
    const isHidden = panel.hasAttribute('hidden');
    const isEn = LANG === 'en';
    if (isHidden) {
      panel.innerHTML = `
        <div class="si-row"><span class="si-k">${isEn ? 'Health' : '健康'}</span><span class="si-v">${isEn ? '100 − age × 0.5 (capped 0-100). Drops sharply after age 60.' : '100 − 年齡 × 0.5（最大 0、最小 100）。60 歲後下降加速。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Knowledge' : '知識'}</span><span class="si-v">${isEn ? 'Education level + life experience. Self-study focus +3, secondary school +0.5/yr.' : '學歷 + 人生經歷。每年自我進修 +3、升上國中 +0.5。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Happiness' : '幸福'}</span><span class="si-v">${isEn ? '70 + random life events. Marriage/children +10, illness −15, health focus +3.' : '70 + 隨機事件。結婚生子 +10、生病 −15、養生焦點 +3。'}</span></div>
        <div class="si-row"><span class="si-k">${isEn ? 'Social' : '人際'}</span><span class="si-v">${isEn ? '60 + partner (married +10) + each child (+4) + working years (+2).' : '60 + 伴侶（已婚 +10）+ 每位子女（+4）+ 工作年資（+2）。'}</span></div>
      `;
      panel.removeAttribute('hidden');
      btn.textContent = 'ℹ️✕';
    } else {
      panel.setAttribute('hidden', '');
      btn.textContent = 'ℹ️';
    }
  });
}

/* v5.8 新增：1in8b.life 風格家庭背景卡 */
function renderLifeFamilyDetail() {
  if (!STATE.life) return;
  const life = STATE.life;
  const wrap = $('#lifeFamilyDetail');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  wrap.innerHTML = `
    <h4>${isEn ? '👪 Family Background' : '👪 出身家庭'}</h4>
    <div class="fd-row">
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Father' : '父親'} · ${life.stats.incomeQuartile ? `Q${life.stats.incomeQuartile}` : 'Q?'}</div>
        <div class="fd-name">${isEn ? (life.family?.parents?.find(p=>p.sex==='M')?.name || '—') : (life.family?.parents?.find(p=>p.sex==='M')?.name || '—')}</div>
        <div class="fd-detail">${fd.age ? (fd.age + (isEn ? ' years old' : '歲')) : ''} ${fd.job ? '· ' + fd.job : ''}</div>
      </div>
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Mother' : '母親'}</div>
        <div class="fd-name">${life.family?.parents?.find(p=>p.sex==='F')?.name || '—'}</div>
        <div class="fd-detail">${md.age ? (md.age + (isEn ? ' years old' : '歲')) : ''} ${md.job ? '· ' + md.job : ''}</div>
      </div>
      <div class="fd-cell">
        <div class="fd-role">${isEn ? 'Religion' : '宗教'} · ${isEn ? 'Place' : '出生地'}</div>
        <div class="fd-name" style="font-size:13px;font-weight:500">${life.stats.religion || '—'}</div>
        <div class="fd-detail">${life.stats.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : '🏙️ 城市')}</div>
      </div>
    </div>
    ${life.family?.siblings?.length ? `<div class="fd-sib"><strong>${isEn ? 'Siblings' : '兄弟姊妹'}：</strong> ${life.family.siblings.map(s => {
      const sAge = life.age - (s.birth?.year || life.year);
      return `${s.name}（${sAge}${isEn?'yo':'歲'}）`;
    }).join('、')}</div>` : ''}
  `;
}

/* v5.8 新增：4 位同伴（同時出生的人） */
/* v5.19 強化：補上「家庭背景」「父母職業」「出生地區」 */
function renderLifeCompanions() {
  if (!STATE.life || !STATE.life.companions) return;
  const wrap = $('#lifeCompanions');
  if (!wrap) return;
  const isEn = LANG === 'en';
  // v5.53：隨年齡更換的可愛插畫（<18 寶寶書本 / 18–64 時間種子 / 65+ 丘陵老人）
  const illusEl = $('#lifeIllus');
  if (illusEl) {
    const age = STATE.life.age;
    const src = age < 18 ? 'assets/illus-baby-book.jpg'
               : age < 65 ? 'assets/illus-time-seed.jpg'
               : 'assets/illus-elder-hill.jpg';
    if (illusEl.dataset.src !== src) {
      illusEl.dataset.src = src;
      illusEl.innerHTML = `<img src="${src}" alt="" loading="lazy" decoding="async">`;
    }
  }
  // v5.29：渲染場景描述（1in8b.life 風格「與父母和兄弟姊妹X人同住」）
  const sceneEl = $('#lifeScene');
  if (sceneEl) {
    const c = STATE.life.countryData;
    const loc = c ? localize(c) : { name: STATE.life.country };
    const place = STATE.life.stats.birthPlaceType === 'rural' ? (isEn ? 'rural' : '鄉村') : (isEn ? 'urban' : '城市');
    const sibCount = (STATE.life.family?.siblings || []).length;
    const housing = isEn ? 'small house' : '鄉間小屋';
    const familyText = isEn
      ? `${loc.name} ${place} · ${housing} · lives with parents and ${sibCount} siblings`
      : `${loc.name} ${place} · ${housing} · 與父母和兄弟姊妹${sibCount}人同住`;
    sceneEl.innerHTML = `<h4>🏡 ${isEn?'Where you live':'你住的地方'}</h4><p class="muted">${familyText}</p>`;
  }
  wrap.innerHTML = `
    <h4>${isEn ? '👶 Born in the same second' : '👶 在同一秒出生的人們'} <span class="muted">(${isEn ? 'growing up together' : '一起長大'})</span></h4>
    <div class="lc-grid">${STATE.life.companions.map(c => `
      <div class="lc-cell">
        <div class="lc-flag">${c.flag}</div>
        <div class="lc-name">${c.name}</div>
        <div class="lc-meta">${c.countryData?.name_zh || c.country} · ${c.sex === 'M' ? (isEn?'♂':'男') : (isEn?'♀':'女')} · ${c.lifeExpectancy ? c.lifeExpectancy + (isEn?' yrs':'歲') : ''}</div>
        <div class="lc-bg">
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Father' : '父'}</span><span class="lc-bg-v">${c.parentJobFather || '—'}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Mother' : '母'}</span><span class="lc-bg-v">${c.parentJobMother || '—'}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Family' : '家境'}</span><span class="lc-bg-v lc-q">${quartileLabel(c.incomeQuartile, isEn)}</span></div>
          <div class="lc-bg-row"><span class="lc-bg-k">${isEn ? 'Born in' : '出生地'}</span><span class="lc-bg-v">${c.birthPlaceType === 'rural' ? (isEn ? '🌾 Rural' : '🌾 鄉村') : (isEn ? '🏙️ Urban' : '🏙️ 城市')}</span></div>
        </div>
      </div>
    `).join('')}</div>
  `;
}

/* v5.19 新增：「如果你現在出生」vs 隨機國家 比較表 */
function renderActualVsRandom() {
  if (!STATE.life) return;
  const wrap = $('#lifeActualVsRandom');
  if (!wrap) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const isEn = LANG === 'en';
  const real = guessBirthCountry();
  const random = c;
  if (!real) return;
  const rows = [
    { key: 'le',   labelZh: '平均壽命',      labelEn: 'Life expectancy', fmt: v => (v ? (v + ' ' + (isEn ? 'yrs' : '歲')) : '—'), realVal: real.le, randVal: random.le },
    { key: 'u5',   labelZh: '5 歲前死亡機率', labelEn: 'Under-5 mortality', fmt: v => v != null ? ((v / 1000) * 100).toFixed(2) + '%' : '—', realVal: real.u5, randVal: random.u5 },
    { key: 'ppp',  labelZh: '人均 GDP (PPP)', labelEn: 'GDP per capita (PPP)', fmt: v => v != null ? ('$' + Math.round(v).toLocaleString()) : '—', realVal: real.ppp, randVal: random.ppp },
    { key: 'eys',  labelZh: '預期受教育年數',  labelEn: 'Expected school years', fmt: v => v != null ? (v.toFixed(1) + ' ' + (isEn ? 'yrs' : '年')) : '—', realVal: real.eys, randVal: random.eys },
  ];
  wrap.innerHTML = `
    <h4>${isEn ? '🧭 If you were born now' : '🧭 如果你現在出生'} <span class="muted">${isEn ? 'vs your random country' : 'vs 你的隨機出生地'}</span></h4>
    <table class="ar-table">
      <thead>
        <tr><th></th><th class="ar-you">${real.flag} ${isEn ? real.name_en : real.name_zh} <span class="muted">${isEn?'(by your browser language)':'（依瀏覽器語言推測）'}</span></th><th class="ar-rand">${random.flag} ${isEn ? random.name_en : random.name_zh} <span class="muted">${isEn?'(random draw)':'（隨機）'}</span></th></tr>
      </thead>
      <tbody>${rows.map(r => {
        const realV = r.fmt(r.realVal);
        const randV = r.fmt(r.randVal);
        const numReal = parseFloat(String(r.realVal).replace(/[^0-9.\-]/g, ''));
        const numRand = parseFloat(String(r.randVal).replace(/[^0-9.\-]/g, ''));
        let winner = '';
        if (!isNaN(numReal) && !isNaN(numRand)) {
          if (r.key === 'u5') winner = numReal < numRand ? '🟢' : (numReal > numRand ? '🔴' : '⚪');
          else winner = numReal > numRand ? '🟢' : (numReal < numRand ? '🔴' : '⚪');
        }
        return `<tr><td class="ar-k">${isEn ? r.labelEn : r.labelZh}${winner ? ' ' + winner : ''}</td><td class="ar-v">${realV}</td><td class="ar-v">${randV}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <p class="muted ar-note">${isEn ? '🟢 = better than random · 🔴 = worse · ⚪ = same. ' : '🟢 = 比隨機好 · 🔴 = 比隨機差 · ⚪ = 一樣。'}</p>
  `;
}

/* v5.19 新增：在 cert-meta 加「當年存活率」欄位 */
function renderSurvivalRate() {
  const el = $('#lifeSurvival');
  if (!el) return;
  if (!STATE.life || !STATE.life.countryData) {
    el.textContent = '—';
    return;
  }
  const c = STATE.life.countryData;
  const sr = survivalRateForAge(c, STATE.life.sex, STATE.life.age);
  if (sr == null) {
    el.textContent = '—';
    return;
  }
  const pct = Math.round(sr * 100);
  el.textContent = pct + '%';
  el.style.color = pct >= 95 ? 'var(--good)' : pct >= 80 ? 'var(--gold)' : 'var(--bad)';
}

/* v5.9 新增：完整國家統計面板（16 個關鍵指標） */
function renderCountryStats() {
  if (!STATE.life) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const wrap = $('#lifeCountryStats');
  if (!wrap) return;
  const isEn = LANG === 'en';
  const sex = STATE.life.sex;
  // 16 個統計指標（依國家資料）
  const rows = [
    [isEn?'Annual births':'每年出生人數', Math.round(c.births || 240000).toLocaleString() + (isEn?' people':'人')],
    [isEn?'Population':'人口', ((c.pop || 5000000)/1000000).toFixed(1) + (isEn?'M people':'百萬人')],
    [isEn?'Life expectancy F/M':'平均壽命 女/男', ((c.le || 70) + (isEn?'/':'/') + Math.max(0,(c.le||70) - 4)) + (isEn?' yrs':'歲')],
    [isEn?'Under-5 mortality':'5歲以下死亡率', ((c.u5 || 25) / 1000 * 100).toFixed(1) + '%'],
    [isEn?'GDP per capita (PPP)':'人均GDP（PPP）', '$' + Math.round(c.ppp || 10000).toLocaleString()],
    [isEn?'Gini coefficient':'所得吉尼係數', (c.gi || 0.35).toFixed(2)],
    [isEn?'Urban population %':'都市人口比例', Math.round(c.urb || 50) + '%'],
    [isEn?'Agricultural workforce':'從事農業', Math.round(c.agr || 30) + '%'],
    [isEn?'Expected education years':'預期受教育年數', (c.eys || 12).toFixed(1) + (isEn?' yrs':'年')],
    [isEn?'Higher education rate':'高等教育粗在學率', Math.round(c.ter || 30) + '%'],
    [isEn?'Internet usage':'網路使用率', Math.round(c.net || 60) + '%'],
    [isEn?'Total fertility rate':'總生育率', (c.tfr || 2).toFixed(2) + (isEn?' children':'人')],
    [isEn?'Maternal mortality':'孕產婦死亡率（每10萬活產）', Math.round(c.mmr || 50)],
    [isEn?'HIV prevalence 15-49':'HIV 盛行率（15-49歲）', (c.hiv || 1).toFixed(2) + '%'],
    [isEn?'Homicide rate':'兇殺率（每10萬人）', Math.round(c.hom || 5) + (isEn?'/100k':'/10萬')],
    [isEn?'Traffic fatality':'交通事故死亡（每10萬人）', Math.round(c.road || 15) + (isEn?'/100k':'/10萬')],
    [isEn?'Tobacco use M/F':'菸草使用 男/女', (Math.round(c.sm * 0.8)) + '% / ' + (Math.round(c.sm * 0.1)) + '%'],
    [isEn?'Out-of-pocket health':'醫療費用自付比例', Math.round(c.oop || 30) + '%'],
    [isEn?'Child marriage (F)':'18歲前結婚（女性）', Math.round(c.cm || 20) + '%'],
    [isEn?'Life satisfaction (0-10)':'生活滿意度（0-10）', (c.ls || 5.5).toFixed(2)]
  ];
  wrap.innerHTML = `
    <h4>🌍 ${c.flag} ${isEn ? c.name_en : c.name_zh} <span class="muted">(${isEn?'20 key stats':'20 個關鍵統計'})</span></h4>
    <table class="cs-table">
      <tbody>${rows.map(r => `<tr><td class="cs-k">${r[0]}</td><td class="cs-v">${r[1]}</td></tr>`).join('')}</tbody>
    </table>
    <p class="muted cs-source">${isEn?'Sources: UN WPP 2024, WB WDI, WHO, UNESCO UIS, UNDP HDR, ILO, UNAIDS, UNODC, UNICEF, World Happiness Report 2024':'資料來源：聯合國《世界人口展望2024》、世界銀行WDI、WHO、UNESCO UIS、UNDP HDR、ILO、UNAIDS、UNODC、UNICEF、生活滿意度報告2024'}</p>
  `;
  // v5.11：存活曲線圖
  renderSurvivalCurve();
  renderLifeTrajectory();
}

/* v5.11：存活曲線圖（國家 vs 世界平均 vs 自己年齡點） */
function renderSurvivalCurve() {
  if (!STATE.life) return;
  const wrap = $('#lifeSurvivalCurve');
  if (!wrap) return;
  const c = STATE.life.countryData;
  if (!c) return;
  const isEn = LANG === 'en';
  const sex = STATE.life.sex;
  const lifeExp = c.le || 70;
  // 計算國家男性的存活曲線（簡化 Gompertz）
  const lt = lifeTable(c, sex);
  const W = 500, H = 180;
  const maxAge = 100;
  const points = [];
  let surv = 1.0;
  for (let a = 0; a <= maxAge; a += 2) {
    points.push([a, surv]);
    surv *= (1 - lt.q[Math.min(a, 110)]);
  }
  const worldPoints = [];
  let wsurv = 1.0;
  // 世界平均：使用通用生命表 (UN WPP world)
  for (let a = 0; a <= maxAge; a += 2) {
    // 簡化世界 Gompertz：平均壽命 73 歲
    const wq = Math.exp(-Math.exp(0.1 * (a - 75))) * 0.0008;
    wsurv *= (1 - Math.min(0.5, wq));
    worldPoints.push([a, wsurv]);
  }
  // 縮放 + 平移
  const proj = (a, s) => [40 + (a/maxAge) * (W-50), H-30 - s * (H-50)];
  let path = `M ${proj(points[0][0], points[0][1])[0]} ${proj(points[0][0], points[0][1])[1]}`;
  for (let i = 1; i < points.length; i++) {
    path += ` L ${proj(points[i][0], points[i][1])[0]} ${proj(points[i][0], points[i][1])[1]}`;
  }
  let worldPath = `M ${proj(worldPoints[0][0], worldPoints[0][1])[0]} ${proj(worldPoints[0][0], worldPoints[0][1])[1]}`;
  for (let i = 1; i < worldPoints.length; i++) {
    worldPath += ` L ${proj(worldPoints[i][0], worldPoints[i][1])[0]} ${proj(worldPoints[i][0], worldPoints[i][1])[1]}`;
  }
  // 自己的位置
  const myAge = STATE.life.age;
  let mySurv = 1;
  for (let a = 0; a < Math.min(myAge, 110); a++) mySurv *= (1 - lt.q[a]);
  const myPos = proj(myAge, mySurv);
  const avgPoint = proj(lifeExp, 0.5);
  wrap.innerHTML = `
    <h4>📉 ${isEn ? 'Survival curve' : '存活曲線'} <span class="muted">${isEn ? '% still alive at each age' : '同年出生的人當中仍存活的比例'}</span></h4>
    <svg viewBox="0 0 ${W} ${H}" class="survival-svg" style="width:100%;height:auto;">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#faf7f0"/>
      <line x1="40" y1="${H-30}" x2="${W-10}" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <line x1="40" y1="20" x2="40" y2="${H-30}" stroke="#999" stroke-width="1"/>
      <text x="${W-12}" y="${H-32}" font-size="9" fill="#666" text-anchor="end">${isEn ? 'Age':'年齡'}</text>
      <text x="32" y="22" font-size="9" fill="#666" text-anchor="end">100%</text>
      <text x="32" y="${H-32}" font-size="9" fill="#666" text-anchor="end">0%</text>
      <text x="42" y="${H-15}" font-size="8" fill="#999">0</text>
      <text x="${W/2}" y="${H-15}" font-size="8" fill="#999" text-anchor="middle">${Math.round(maxAge/2)}</text>
      <text x="${W-12}" y="${H-15}" font-size="8" fill="#999" text-anchor="end">${maxAge}</text>
      <path d="${worldPath}" fill="none" stroke="#999" stroke-width="1.5" stroke-dasharray="4 3"/>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${myAge <= maxAge ? `<circle cx="${myPos[0]}" cy="${myPos[1]}" r="5" fill="#ff8800" stroke="white" stroke-width="2"/>` : ''}
      <circle cx="${avgPoint[0]}" cy="${avgPoint[1]}" r="4" fill="white" stroke="#666" stroke-width="1.5"/>
      <g font-size="9" fill="#5a4a3a">
        <rect x="${W-130}" y="6" width="120" height="36" fill="white" stroke="#d8cdb8"/>
        <line x1="${W-122}" y1="16" x2="${W-110}" y2="16" stroke="var(--accent)" stroke-width="2"/>
        <text x="${W-105}" y="19">${c.flag} ${isEn ? c.name_en : c.name_zh}</text>
        <line x1="${W-122}" y1="28" x2="${W-110}" y2="28" stroke="#999" stroke-width="1.5" stroke-dasharray="3 2"/>
        <text x="${W-105}" y="31">🌐 ${isEn?'World avg':'世界平均'}</text>
      </g>
    </svg>
    <p class="muted">${isEn?'Outer box = average life expectancy in this country':'外框格 = '+c.flag+(isEn?c.name_en:c.name_zh)+' 平均壽命 '+lifeExp+(isEn?' yrs':'歲')}</p>
  `;
}

/* v5.18：護照格式身分紀錄（1in8b.life 風格） */
function renderIdentityRecord() {
  if (!STATE.life) return;
  const wrap = $('#lifeIdentityRecord');
  if (!wrap) return;
  const life = STATE.life;
  const isEn = LANG === 'en';
  const surname = (life.name?.full || '').slice(0, 1);
  const givenName = (life.name?.full || '').slice(1);
  // MRZ-like format
  const mrz = `I<${life.country || 'XXX'}${surname.toUpperCase().padEnd(5)}<<${givenName.toUpperCase().padEnd(44)}<`.slice(0, 44);
  const year = life.year + life.yearOffset;
  const mm = String(Math.floor(Math.random()*12)+1).padStart(2, '0');
  const dd = String(Math.floor(Math.random()*28)+1).padStart(2, '0');
  const exp = String((year + 10) % 100).padStart(2, '0') + String(Math.floor(Math.random()*12)+1).padStart(2, '0') + String(Math.floor(Math.random()*28)+1).padStart(2, '0');
  wrap.innerHTML = `
    <h4>🛂 ${isEn ? 'Identity Record' : '身分紀錄'} <span class="muted">${life.country || ''} · ${life.regNumber || ''}</span></h4>
    <pre class="mrz-line">${mrz}${life.name?.full_en?.toUpperCase().replace(/[^A-Z]/g,'').padEnd(20,'<').slice(0,20) || ''}</pre>
    <pre class="mrz-line">${year}${mm}${dd}${life.sex}${exp}${life.country || 'XXX'}</pre>
    <div class="ir-meta">${surname} ${givenName} · ${life.sex === 'M' ? (isEn?'Male':'男') : (isEn?'Female':'女')} · ${year}/${life.regNumber?.split('-').pop() || ''}</div>
  `;
}

function renderFamilySummary() {
  const wrap = $('#certFamilyBody');
  const goBtn = $('#certFamilyGo');
  if (!wrap) return;
  if (!STATE.life || !STATE.life.family) { wrap.innerHTML = ''; return; }
  const f = STATE.life.family;
  const parts = [];
  // 父母
  const father = f.parents.find(p => p.sex === 'M');
  const mother = f.parents.find(p => p.sex === 'F');
  if (father && mother) parts.push(`👨 ${father.name} · 👩 ${mother.name}`);
  else if (father) parts.push(`👨 ${father.name}`);
  else if (mother) parts.push(`👩 ${mother.name}`);
  else parts.push(`<span class="fam-orphan">${LANG==='en'?'🕯️ Orphan':'🕯️ 孤兒'}</span>`);
  // 手足
  if (f.siblings && f.siblings.length) {
    const liveSib = f.siblings.filter(s => !s.death?.year);
    const deadSib = f.siblings.filter(s => s.death?.year);
    let sibText = `👫 ${f.siblings.length} ${LANG==='en'?'siblings':'手足'}`;
    if (liveSib.length < f.siblings.length) sibText += `（${liveSib.length} ${LANG==='en'?'alive':'存'}，${deadSib.length} †）`;
    parts.push(sibText);
  }
  // 祖父母
  if (f.grandparents && f.grandparents.length) {
    parts.push(`👴👵 ${f.grandparents.length} ${LANG==='en'?'grandparents':'祖父母'}`);
  }
  // 伴侶
  if (f.partner) parts.push(`💍 ${f.partner.name}`);
  // 子女
  if (f.kids && f.kids.length) {
    const deadKids = f.kids.filter(k => k.death?.year);
    let kidText = `👶 ${f.kids.length} ${LANG==='en'?'children':'子女'}`;
    if (deadKids.length) kidText += `（${deadKids.length} †）`;
    parts.push(kidText);
  }
  // 收養/寄養
  if (f.fosterCare === 'adopt') parts.push(`<span class="fam-flag">🧩 ${LANG==='en'?'Adopted':'收養家庭'}</span>`);
  else if (f.fosterCare === 'foster') parts.push(`<span class="fam-flag">🏠 ${LANG==='en'?'Foster':'寄養家庭'}</span>`);
  // 跨國遷徙
  if (STATE.life.birthOrigin) {
    parts.push(`<span class="fam-flag">${STATE.life.birthOrigin.flag}→${c.flag} ${LANG==='en'?'migrated':'遷徙'}</span>`);
  }
  wrap.innerHTML = parts.map(p => `<div class="fam-row">${p}</div>`).join('');
  if (goBtn) {
    goBtn.onclick = () => {
      document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === 'tree') b.click(); });
    };
  }
}

function jobLabel(j) {
  return ({none: t('job.none'), student: t('job.student'), employed: t('job.employed'), university: t('job.university'), retired: t('job.retired')})[j] || t('job.none');
}

function renderEnd() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  const loc = localize(c);
  $('#endCertTitle').textContent = t('end.cert_title');
  $('#endCountry').textContent = c.flag + ' ' + loc.name;
  $('#endBorn').textContent = life.year + '/' + t('event.born_in2', life.sex === 'M' ? t('sex.male') : t('sex.female'));
  $('#endAge').textContent = life.deathAge + ' ' + t('unit.years');
  $('#endCause').textContent = causeLabel(life.cause);
  $('#endName').textContent = life.name.full || life.name.full_en || '—';
  $('#endPortrait').innerHTML = pixelPortraitSVG(life.countryData, life.age, life.sex);
  $('#endLe').textContent = t('end.lifespan_le', { age: life.deathAge, le: c.le });
  const past = loadPastLives();
  $('#endPastCount').textContent = past.length;
  // 證書（guilloche）
  const cert = $('#certCanvas');
  if (cert) {
    cert.innerHTML = drawGuilloche(680, 420);
  }
  // v5.20：死亡原因分析（本年 + 一生 Top 3）
  renderEndCauseAnalysis();
  // v5.78：這一生做過的決定
  renderEndDecisions();
  // v5.31：前世紀錄面板
  renderEndPastRecords(past);
}

/* v5.31：前世紀錄面板 — 顯示最近 5 段人生 + 全部操作按鈕 */
function renderEndPastRecords(past) {
  const wrap = $('#endPastRecords');
  const list = $('#endPastList');
  const meta = $('#endPastMeta');
  if (!wrap || !list) return;
  if (!past || past.length === 0) {
    list.innerHTML = `<div class="muted">—</div>`;
    if (meta) meta.textContent = '';
    return;
  }
  const avg = (past.reduce((s, p) => s + (p.age || 0), 0) / past.length).toFixed(1);
  if (meta) meta.textContent = `${past.length} 段 · 平均 ${avg} 歲`;
  list.innerHTML = past.slice(0, 5).map((p, i) => `
    <div class="pr-row" data-i="${i}">
      <div class="pr-info">
        <strong>${p.name || '—'}</strong>
        <span class="muted">${p.country || '—'} · ${p.sex === 'M' ? '男' : (p.sex === 'F' ? '女' : '?')} · ${p.age || 0} 歲 · ${p.cause || '—'}</span>
      </div>
      <div class="pr-actions">
        <button class="ghost pr-replay" data-i="${i}">↻ 再看一次</button>
        <button class="ghost pr-del" data-i="${i}">🗑️</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.pr-replay').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    const ls = loadPastLives();
    const lifeData = ls[i];
    if (lifeData && lifeData.full) {
      STATE.life = lifeData.full;
      STATE.view = 'end';
      setView('end');
    } else {
      showLifeModal(ls[i]);
    }
  }));
  list.querySelectorAll('.pr-del').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    const ls = loadPastLives();
    ls.splice(i, 1);
    localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(ls));
    renderEnd();
  }));
}

function drawGuilloche(w, h) {
  // 簡化 guilloche：多個同心橢圓 + 文字水印
  const cx = w / 2, cy = h / 2;
  let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;pointer-events:none;opacity:0.08;">`;
  for (let r = 30; r < w; r += 18) {
    const rx = r, ry = r * 0.6;
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#8C1D3C" stroke-width="0.5" />`;
  }
  for (let r = 24; r < w; r += 22) {
    const rx = r, ry = r * 0.5;
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#0F6E68" stroke-width="0.4" />`;
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const x = cx + Math.cos(a) * 200;
    const y = cy + Math.sin(a) * 100;
    svg += `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="#8C1D3C" transform="rotate(${a*180/Math.PI} ${x} ${y})">8 億 分 之 1</text>`;
  }
  svg += `</svg>`;
  return svg;
}

function portraitFor(age, sex) {
  if (age < 5) return sex === 'M' ? '👶🏻' : '👶🏻';
  if (age < 18) return sex === 'M' ? '👦' : '👧';
  if (age < 60) return sex === 'M' ? '🧑' : '👩';
  return sex === 'M' ? '👴' : '👵';
}

// 依國家 + 年齡 + 性別生成 SVG 像素頭像
function pixelPortraitSVG(country, age, sex) {
  const region = country?.region || 'eap';
  const skinMap = {
    'eap': '#f0d5b1', 'sa': '#c8a47c', 'eca': '#fde0c8', 'mena': '#e0c098',
    'ssa': '#704020', 'lac': '#d4a574', 'na': '#f0d5b1', 'hi': '#f0d5b1',
  };
  const skin = skinMap[region] || '#f0d5b1';
  const hairMap = {
    'eap': '#1a1a1a', 'sa': '#0a0a0a', 'eca': '#3a2410', 'mena': '#1a0a05',
    'ssa': '#0a0a0a', 'lac': '#1a0a05', 'na': '#3a2410', 'hi': '#3a2410',
  };
  const hair = hairMap[region] || '#1a1a1a';
  const stage = age < 5 ? 'baby' : age < 12 ? 'child' : age < 18 ? 'teen' : age < 60 ? 'adult' : 'elder';
  const W = 200, H = 200, cx = W/2, cy = H/2;
  const headSizes = { baby: 90, child: 80, teen: 70, adult: 70, elder: 75 };
  const hr = headSizes[stage] / 2;
  const parts = [];
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${W*0.45}" fill="#f5efe2"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy - 10}" r="${hr}" fill="${skin}"/>`);
  if (stage === 'baby') {
    parts.push(`<ellipse cx="${cx}" cy="${cy - 10 - hr + 8}" rx="${hr - 10}" ry="8" fill="${hair}"/>`);
  } else if (stage === 'child') {
    parts.push(`<path d="M ${cx - hr + 5} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 10} ${cx + hr - 5} ${cy - 10 - hr + 5} L ${cx + hr - 5} ${cy - 10 - hr + 25} L ${cx - hr + 5} ${cy - 10 - hr + 25} Z" fill="${hair}"/>`);
  } else if (stage === 'teen') {
    parts.push(`<path d="M ${cx - hr + 3} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 15} ${cx + hr - 3} ${cy - 10 - hr + 5} L ${cx + hr + 5} ${cy - 10 - hr + 30} L ${cx - hr - 5} ${cy - 10 - hr + 30} Z" fill="${hair}"/>`);
  } else {
    parts.push(`<path d="M ${cx - hr + 3} ${cy - 10 - hr + 5} Q ${cx} ${cy - 10 - hr - 18} ${cx + hr - 3} ${cy - 10 - hr + 5} L ${cx + hr + 8} ${cy - 10 - hr + 35} L ${cx - hr - 8} ${cy - 10 - hr + 35} Z" fill="${hair}"/>`);
    if (stage === 'elder') {
      parts.push(`<circle cx="${cx - 15}" cy="${cy - 10 - hr - 5}" r="2" fill="#cccccc"/>`);
      parts.push(`<circle cx="${cx + 18}" cy="${cy - 10 - hr - 3}" r="2" fill="#cccccc"/>`);
    }
  }
  if (stage === 'baby') {
    parts.push(`<circle cx="${cx - 12}" cy="${cy - 10}" r="3" fill="#1a1a1a"/>`);
    parts.push(`<circle cx="${cx + 12}" cy="${cy - 10}" r="3" fill="#1a1a1a"/>`);
  } else {
    parts.push(`<circle cx="${cx - 14}" cy="${cy - 8}" r="2.5" fill="#1a1a1a"/>`);
    parts.push(`<circle cx="${cx + 14}" cy="${cy - 8}" r="2.5" fill="#1a1a1a"/>`);
  }
  if (stage === 'baby') {
    parts.push(`<path d="M ${cx - 6} ${cy + 12} Q ${cx} ${cy + 8} ${cx + 6} ${cy + 12}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  } else if (stage === 'elder') {
    parts.push(`<path d="M ${cx - 8} ${cy + 10} Q ${cx} ${cy + 18} ${cx + 8} ${cy + 10}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  } else {
    parts.push(`<path d="M ${cx - 6} ${cy + 12} Q ${cx} ${cy + 16} ${cx + 6} ${cy + 12}" stroke="#1a1a1a" stroke-width="1.5" fill="none"/>`);
  }
  if (country?.flag) {
    parts.push(`<text x="10" y="${H-10}" font-size="14">${country.flag}</text>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto;">${parts.join('')}</svg>`;
}

function renderShelf() {
  const shelf = $('#shelfGrid');
  if (!shelf) return;
  const lives = loadPastLives();
  shelf.innerHTML = '';
  // 頂部加「家族全景圖」按鈕
  if (lives.length > 1) {
    const btn = document.createElement('div');
    btn.className = 'shelf-panorama';
    btn.innerHTML = `<button class="primary" id="shelfPanoramaBtn">🌐 ${t('shelf.panorama') || '家族全景圖'}</button><p class="muted">${t('shelf.panoramaSub') || '合併 ' + lives.length + ' 段人生，找出共同親屬'}</p>`;
    shelf.appendChild(btn);
    btn.querySelector('#shelfPanoramaBtn').addEventListener('click', () => renderPanorama(lives));
  }
  // 世界地圖：標出歷來人生去過的國家
  if (lives.length > 0) {
    const worldWrap = document.createElement('div');
    worldWrap.className = 'shelf-world';
    worldWrap.appendChild(renderShelfWorldMap(lives));
    shelf.appendChild(worldWrap);
  }
  // v5.81：書架書本也是無上限的 — 37 本 = 2738px，50 本（savePastLife 的上限）
  // 會到 3700px。書本比較小，先顯示 12 本再逐批展開。
  const BOOK_PAGE = 12;
  const shownBooks = STATE.shelfShown || BOOK_PAGE;
  for (const life of lives.slice(0, shownBooks)) {
    const c = countryById(life.country);
    const flag = c ? c.flag : '🏳️';
    const book = document.createElement('div');
    book.className = 'shelf-book';
    book.innerHTML = `
      <div class="shelf-cover">
        <div class="shelf-flag">${flag}</div>
        <div class="shelf-spine"></div>
        <div class="shelf-info">
          <div class="shelf-name">${life.name || '—'}</div>
          <div class="shelf-meta">${life.age} 歲 · ${flag}</div>
        </div>
      </div>
    `;
    book.title = `${life.name} · ${causeLabel(life.cause)}`;
    book.addEventListener('click', () => showLifeModal(life));
    shelf.appendChild(book);
    // v5.22：右鍵 / long-press 觸發「繼續這段人生」選單（雙擊 = 從當年齡接續）
    let clickTime = 0;
    book.addEventListener('dblclick', () => continueOldLife(life));
  }
  // v5.81：書本「看更多 / 收合」
  if (lives.length > BOOK_PAGE) {
    const more = document.createElement('button');
    more.className = 'shared-more-btn';
    more.style.gridColumn = '1/-1';
    if (shownBooks >= lives.length) {
      more.textContent = t('shared.less');
      more.addEventListener('click', () => { STATE.shelfShown = BOOK_PAGE; renderShelf(); });
    } else {
      more.textContent = t('shared.more', { n: Math.min(BOOK_PAGE, lives.length - shownBooks), left: lives.length - shownBooks });
      more.addEventListener('click', () => {
        STATE.shelfShown = Math.min(lives.length, shownBooks + BOOK_PAGE);
        renderShelf();
      });
    }
    shelf.appendChild(more);
  }
  // v5.23：整理紀錄按鈕 + 音樂 toggle + PWA badges
  const manageWrap = document.createElement('div');
  manageWrap.className = 'shelf-manage';
  manageWrap.style.cssText = 'grid-column:1/-1;text-align:center;margin-top:12px;';
  manageWrap.innerHTML = `<button class="ghost" id="manageRecordsBtn">📋 ${LANG==='en'?'Manage records':'整理紀錄'}</button> <button class="ghost" id="toggleMusicBtn" style="margin-left:6px;">♪ ${LANG==='en'?'Music':'音樂'}</button>`;
  shelf.appendChild(manageWrap);
  $('#manageRecordsBtn')?.addEventListener('click', showManageRecordsModal);
  $('#toggleMusicBtn')?.addEventListener('click', toggleBackgroundMusic);
  // v5.20：追思館（Memorial Wall） + 大家分享的人生
  renderMemorialWall(lives);
  renderSharedLives(lives);
}

/* v5.23：整理紀錄 modal — 列出 / 刪除 / 重新展開 */
function showManageRecordsModal() {
  const lives = loadPastLives();
  document.querySelector('#manageModal')?.remove();
  const isEn = LANG === 'en';
  const modal = document.createElement('div');
  modal.id = 'manageModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card" style="max-width:520px;">
      <button class="lm-close" onclick="document.getElementById('manageModal').remove()">×</button>
      <h2 class="lm-title">📋 ${isEn ? 'Manage Records' : '紀錄整理'}</h2>
      <p class="muted" style="font-size:12px;">${isEn ? 'Show or delete each past life.':'可逐本檢視或刪除過去的人生。'}</p>
      <div class="manage-list">
        ${lives.length === 0 ? '<span class="muted">—</span>' : lives.map((l, i) => `
          <div class="manage-row">
            <div class="manage-info">
              <strong>${l.name || '—'}</strong>
              <span class="muted">${l.year || '?'} – ${l.year + l.yearOffset} · ${l.age}${isEn?'yo':'歲'} · ${l.cause || ''}</span>
            </div>
            <div class="manage-actions">
              <button class="ghost" data-act="show" data-i="${i}">${isEn?'Show':'檢視'}</button>
              <button class="ghost" data-act="del" data-i="${i}">🗑️</button>
            </div>
          </div>
        `).join('')}
      </div>
      ${lives.length > 0 ? `<button class="ghost" id="manageClearAll" style="margin-top:8px;">🗑️ ${isEn?'Delete all':'全部刪除'}</button>` : ''}
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.i;
      const act = btn.dataset.act;
      const ls = loadPastLives();
      if (act === 'show') showLifeModal(ls[idx]);
      else if (act === 'del') {
        ls.splice(idx, 1);
        localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(ls));
        modal.remove();
        renderShelf();
        toast(isEn ? 'Life deleted' : '已刪除');
      }
    });
  });
  $('#manageClearAll')?.addEventListener('click', () => {
    if (confirm(isEn ? 'Delete all past lives?' : '刪除所有過去的人生？')) {
      localStorage.setItem(STORAGE_KEY + ':past', '[]');
      modal.remove();
      renderShelf();
      toast(isEn ? 'All deleted' : '已全部刪除');
    }
  });
}

/* v5.23：背景音樂（Web Audio API 簡單環境音） */
let bgMusic = null;
function toggleBackgroundMusic() {
  if (!bgMusic) {
    const isEn = LANG === 'en';
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 220;  // A1
      gain.gain.value = 0.02;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      bgMusic = { ctx, osc, gain };
      toast(isEn ? '♪ Music on' : '♪ 音樂已開啟');
    } catch (e) { toast('Audio not supported'); }
  } else {
    try { bgMusic.osc.stop(); bgMusic.ctx.close(); } catch (e) {}
    bgMusic = null;
    toast(LANG === 'en' ? '♪ Music off' : '♪ 音樂已關閉');
  }
}

/* ==== Shelf 世界地圖 ==== */
function renderShelfWorldMap(lives) {
  const W = 720, H = 360;
  // 計算各國家被經歷次數 + 平均壽命
  const countryStats = {};
  lives.forEach(l => {
    if (!countryStats[l.country]) countryStats[l.country] = { count: 0, totalAge: 0, deaths: [] };
    countryStats[l.country].count++;
    countryStats[l.country].totalAge += l.age || 0;
    countryStats[l.country].deaths.push(l.cause);
  });
  // 經度→x: (lng + 180) / 360 * W; 緯度→y: (90 - lat) / 180 * H
  const proj = (lng, lat) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'world-map', style: 'max-width:100%;height:auto;background:var(--bg-3);border-radius:8px;' });
  // 大陸輪廓（簡化用矩形網格代替）
  const grid = svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#dde6e8' }, svg);
  // 為每個經歷國家繪製點
  const visited = Object.keys(countryStats);
  const tooltipLines = [];
  visited.forEach(iso => {
    const coords = window.WORLD_COORDS && window.WORLD_COORDS[iso];
    if (!coords) return;
    const [lng, lat] = coords;
    const [x, y] = proj(lng, lat);
    const stat = countryStats[iso];
    const avgAge = (stat.totalAge / stat.count).toFixed(1);
    const c = countryById(iso);
    const flag = c ? c.flag : '🏳️';
    // 主圓點：依去過次數調整大小
    const r = 4 + Math.min(stat.count * 2, 12);
    const circle = svgEl('circle', { cx: x, cy: y, r, fill: 'var(--accent)', stroke: 'white', 'stroke-width': 1, opacity: 0.85 }, svg);
    circle.addEventListener('mouseenter', e => showMapTooltip(e, `${flag} ${c?.name_zh || iso}<br>${LANG==='en'?'Lived':'活過'} ${stat.count} ${LANG==='en'?'lives':'次'}, ${LANG==='en'?'avg':'平均'} ${avgAge} ${LANG==='en'?'yrs':'歲'}`));
    circle.addEventListener('mouseleave', hideMapTooltip);
    // 國旗 emoji 標記
    const flagText = svgEl('text', { x: x, y: y - r - 4, 'font-size': 12, 'text-anchor': 'middle' }, svg);
    flagText.textContent = flag;
    tooltipLines.push(`${flag} ${c?.name_zh || iso}: ${stat.count} ${LANG==='en'?'times':'次'}`);
  });
  // 圖例
  const legend = svgEl('text', { x: 8, y: H - 8, 'font-size': 10, fill: '#5a4a3a' }, svg);
  legend.textContent = `${LANG==='en'?'Lived in':'曾活過'} ${visited.length} ${LANG==='en'?'countries':'個國家'}`;
  return svg;
}

/* ==== v5.20：追思館 (Memorial Wall) ==== */
let _memorialIdx = 0;
function getMemorialState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + ':memorial_state');
    if (!raw) return { candlesByLife: {}, heartsByLife: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { candlesByLife: {}, heartsByLife: {} };
  }
}
function saveMemorialState(s) {
  try {
    localStorage.setItem(STORAGE_KEY + ':memorial_state', JSON.stringify(s));
  } catch (e) { /* quota exceeded */ }
}
function lifeMemorialId(life) {
  // 用生命唯一識別：country|year|name|age|cause hash
  const base = `${life.country || '?'}|${life.year || '?'}|${life.name || '?'}|${life.age || '?'}|${life.cause || '?'}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = ((h << 5) - h) + base.charCodeAt(i) | 0;
  return 'm_' + (h >>> 0).toString(36);
}
function getLifeSummary(life) {
  // 一句總結：取一個有意義的 quote，或用一句合成
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') return q;
  }
  const c = countryById(life.country);
  const loc = localize(c);
  const flag = c ? c.flag : '🏳️';
  const cause = life.cause || '';
  const age = life.age || '?';
  if (LANG === 'en') return `Lived ${age} years in ${flag} ${loc?.name || ''}. ${cause ? 'Cause: ' + cause + '.' : ''}`;
  return `在 ${flag} ${loc?.name || ''} 活了 ${age} 歲。${cause ? '原因：' + cause + '。' : ''}`;
}
function getLifeOneLine(life) {
  // 短摘：用第一個非空 quote
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') return q;
  }
  return '';
}
function getLifeStory(life) {
  // 完整故事：所有 quote 串起來 + 重大事件
  if (!life) return '';
  const quotes = life.quotes || {};
  const ages = Object.keys(quotes).map(Number).sort((a, b) => a - b);
  const lines = [];
  for (const a of ages) {
    const q = (quotes[a] || '').trim();
    if (q && q !== '（自動抉擇）' && q !== '（隱蔽）') {
      lines.push(`【${a}${LANG==='en'?'':'歲'}】${q}`);
    }
  }
  if (lines.length === 0) {
    if (LANG === 'en') return '(No words left behind.)';
    return '（沒有留下任何話）';
  }
  return lines.join('\n');
}
function renderMemorialWall(lives) {
  const wall = $('#memorialWall');
  if (!wall) return;
  if (!lives || lives.length === 0) {
    wall.querySelector('.memorial-empty').hidden = false;
    wall.querySelector('.memorial-content').hidden = true;
    return;
  }
  wall.querySelector('.memorial-empty').hidden = true;
  wall.querySelector('.memorial-content').hidden = false;
  if (_memorialIdx >= lives.length) _memorialIdx = 0;
  const life = lives[_memorialIdx];
  const c = countryById(life.country);
  const flag = c ? c.flag : '🏳️';
  const loc = localize(c);
  const card = $('#memorialCard');
  if (!card) return;
  const summary = getLifeSummary(life);
  const state = getMemorialState();
  const id = lifeMemorialId(life);
  const candles = state.candlesByLife[id] || 0;
  const hearts = state.heartsByLife[id] || 0;
  card.innerHTML = `
    <div class="memorial-candle-display">
      ${candles > 0 ? `<span class="candle-flame">🕯️×${candles}</span>` : ''}
    </div>
    <div class="memorial-card-content">
      <div class="memorial-flag">${flag}</div>
      <div class="memorial-name">${escapeHtml(life.name || '—')}</div>
      <div class="memorial-years">${life.year || ''} → ${(life.year || 0) + (life.yearOffset || 0)} · ${life.age || '?'} ${LANG==='en'?'yrs':'歲'}</div>
      <div class="memorial-country">${escapeHtml(loc?.name || life.country || '?')}</div>
      <div class="memorial-summary">${escapeHtml(summary)}</div>
    </div>
  `;
  // 計數
  const cn = $('#memorialCandles');
  const hn = $('#memorialHearts');
  if (cn) cn.textContent = candles > 0 ? `🕯️ ${t('memorial.candles', candles)}` : '';
  if (hn) hn.textContent = hearts > 0 ? `🤍 ${t('memorial.hearts', hearts)}` : '';
  $('#memorialCounter').textContent = `${_memorialIdx + 1} / ${lives.length}`;
  // 按鈕事件（綁定一次即可，但每次重渲染時重新綁以保證指向當前 life）
  const lifeRef = life;
  const bind = (sel, fn) => {
    const el = $(sel);
    if (!el) return;
    el.onclick = () => fn(lifeRef, id);
  };
  bind('#memorialPrev', (l) => {
    _memorialIdx = (_memorialIdx - 1 + lives.length) % lives.length;
    renderMemorialWall(lives);
  });
  bind('#memorialNext', (l) => {
    _memorialIdx = (_memorialIdx + 1) % lives.length;
    renderMemorialWall(lives);
  });
  bind('#memorialCandle', (l, mid) => {
    const s = getMemorialState();
    s.candlesByLife[mid] = (s.candlesByLife[mid] || 0) + 1;
    saveMemorialState(s);
    renderMemorialWall(lives);
    toast(LANG === 'en' ? 'A candle lit 🕯️' : '已點一支蠟燭 🕯️', 1500);
  });
  bind('#memorialHeart', (l, mid) => {
    const s = getMemorialState();
    s.heartsByLife[mid] = (s.heartsByLife[mid] || 0) + 1;
    saveMemorialState(s);
    renderMemorialWall(lives);
    toast(LANG === 'en' ? 'Kept in heart 🤍' : '已記在心裡 🤍', 1500);
  });
  bind('#memorialVisit', (l) => showLifeModal(l));
  bind('#memorialRandom', () => {
    if (lives.length > 1) {
      let ni;
      do { ni = Math.floor(Math.random() * lives.length); } while (ni === _memorialIdx && lives.length > 1);
      _memorialIdx = ni;
      renderMemorialWall(lives);
    }
  });
}

/* ==== v5.20：大家分享的人生 (Shared Lives Feed) ==== */
function getSharedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + ':shared_state');
    if (!raw) return { heartsByLife: {}, reportedByLife: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { heartsByLife: {}, reportedByLife: {} };
  }
}
function saveSharedState(s) {
  try {
    localStorage.setItem(STORAGE_KEY + ':shared_state', JSON.stringify(s));
  } catch (e) { /* quota */ }
}
function renderSharedLives(lives) {
  const wrap = $('#sharedFeed');
  if (!wrap) return;
  if (!lives || lives.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const list = $('#sharedList');
  if (!list) return;
  list.innerHTML = '';
  const state = getSharedState();
  // v5.80：過去人生一多，這一區會長到 7000px 以上（實測 34 條 = 7101px）。
  // 先顯示前 SHARED_PAGE 張，其餘按「看更多」逐批展開。
  const SHARED_PAGE = 8;
  const shown = STATE.sharedShown || SHARED_PAGE;
  const slice = lives.slice(0, shown);

  slice.forEach((life) => {
    const c = countryById(life.country);
    const flag = c ? c.flag : '🏳️';
    const loc = localize(c);
    const id = lifeMemorialId(life);
    const oneLine = getLifeOneLine(life);
    const fullStory = getLifeStory(life);
    const hearts = state.heartsByLife[id] || 0;
    const reported = !!state.reportedByLife[id];
    const sexLabel = life.sex === 'M' ? t('sex.male') : t('sex.female');
    const card = document.createElement('div');
    card.className = 'shared-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="shared-head">
        <span class="shared-flag">${flag}</span>
        <div>
          <div class="shared-name">${escapeHtml(life.name || '—')}</div>
          <div class="shared-meta">${escapeHtml(loc?.name || life.country || '?')} · ${sexLabel} · ${life.age || '?'} ${LANG==='en'?'yrs':'歲'}</div>
        </div>
      </div>
      <div class="shared-quote ${oneLine ? '' : 'shared-empty'}">${oneLine ? escapeHtml(oneLine) : (LANG==='en'?'(no words left behind)':'（沒有留下任何話）')}</div>
      <div class="shared-story" data-story>${escapeHtml(fullStory).replace(/\n/g, '<br/>')}</div>
      <div class="shared-actions">
        <button class="shared-action-btn heart ${hearts > 0 ? 'active' : ''}" data-act="heart">${hearts > 0 ? '♥' : '♡'} ${hearts > 0 ? hearts : ''} ${LANG==='en'?'Keep in heart':'記在心裡'}</button>
        <button class="shared-action-btn report ${reported ? 'active' : ''}" data-act="report">${reported ? '✓' : '⚐'} ${LANG==='en'?'Report':'檢舉'}</button>
        <button class="shared-expand-btn" data-act="expand">${LANG==='en'?'Expand ▼':'展開 ▼'}</button>
      </div>
    `;
    // 事件
    card.querySelector('[data-act="heart"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = getSharedState();
      s.heartsByLife[id] = (s.heartsByLife[id] || 0) + 1;
      saveSharedState(s);
      renderSharedLives(lives);
    });
    card.querySelector('[data-act="report"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const s = getSharedState();
      if (!s.reportedByLife[id]) {
        s.reportedByLife[id] = Date.now();
        saveSharedState(s);
        toast(t('shared.reported'));
      }
      renderSharedLives(lives);
    });
    card.querySelector('[data-act="expand"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const story = card.querySelector('[data-story]');
      const isExpanded = story.classList.toggle('expanded');
      e.currentTarget.textContent = isExpanded
        ? (LANG === 'en' ? '▲ Collapse' : '▲ 收合')
        : (LANG === 'en' ? 'Expand ▼' : '展開 ▼');
    });
    list.appendChild(card);
  });

  // v5.80：剩餘的按「看更多」逐批展開
  if (lives.length > shown) {
    const more = document.createElement('button');
    more.className = 'shared-more-btn';
    more.textContent = t('shared.more', { n: Math.min(SHARED_PAGE, lives.length - shown), left: lives.length - shown });
    more.addEventListener('click', () => {
      STATE.sharedShown = Math.min(lives.length, shown + SHARED_PAGE);
      renderSharedLives(lives);
    });
    list.appendChild(more);
  } else if (shown > SHARED_PAGE) {
    const less = document.createElement('button');
    less.className = 'shared-more-btn';
    less.textContent = t('shared.less');
    less.addEventListener('click', () => {
      STATE.sharedShown = SHARED_PAGE;
      renderSharedLives(lives);
    });
    list.appendChild(less);
  }
}

/* ==== v5.20：現在居住的地方 (Active Players Map, intro) ==== */
function renderActivePlayersMap() {
  const wrap = $('#introPlayersMap');
  if (!wrap) return;
  // 收集目前「進行中」的 life：來自 STATE.life（若有）以及任何未死的 pastLives
  const points = [];
  if (STATE.life && !STATE.life.died) {
    const c = countryById(STATE.life.country);
    if (c) {
      points.push({
        country: STATE.life.country,
        flag: c.flag,
        name: STATE.life.name?.full || STATE.life.name?.full_en || '—',
        age: STATE.life.age,
        sex: STATE.life.sex,
        active: true
      });
    }
  }
  // 過去 lives 中若 died 為 false 也算 active（理論上 loadPastLives 只存死亡，保留相容）
  const past = loadPastLives();
  past.forEach(l => {
    if (!l.died) {
      const c = countryById(l.country);
      if (c) {
        points.push({
          country: l.country,
          flag: c.flag,
          name: l.name,
          age: l.age,
          sex: l.sex,
          active: false
        });
      }
    }
  });
  if (points.length === 0) {
    wrap.innerHTML = `<div class="players-empty">${t('intro.players.empty')}</div>`;
    return;
  }
  const W = 720, H = 360;
  const proj = (lng, lat) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'world-map',
    style: 'max-width:100%;height:auto;background:var(--bg-3);border-radius:8px;'
  });
  svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#dde6e8' }, svg);
  // 已去過國家（過去 lives）淡化顯示
  const pastCountries = new Set(past.map(l => l.country));
  const tooltipLines = [];
  // 畫目前進行中（亮）
  points.forEach(p => {
    const coords = window.WORLD_COORDS && window.WORLD_COORDS[p.country];
    if (!coords) return;
    const [lng, lat] = coords;
    const [x, y] = proj(lng, lat);
    const r = p.active ? 6 : 4;
    const circle = svgEl('circle', {
      cx: x, cy: y, r,
      fill: p.active ? '#c2185b' : '#8C1D3C',
      stroke: 'white', 'stroke-width': 1.5,
      opacity: p.active ? 1 : 0.7
    }, svg);
    circle.addEventListener('mouseenter', e => showMapTooltip(e, `${p.flag} ${escapeHtml(p.name)}<br>${LANG==='en'?'Age':'年齡'} ${p.age}${LANG===''?' ':' '}<br>${p.active ? (LANG==='en'?'● Active':'● 進行中') : (LANG==='en'?'○ Past':'○ 過去')}`));
    circle.addEventListener('mouseleave', hideMapTooltip);
    const flagText = svgEl('text', { x, y: y - r - 4, 'font-size': 12, 'text-anchor': 'middle' }, svg);
    flagText.textContent = p.flag;
  });
  // 圖例
  const legend = svgEl('text', { x: 8, y: H - 8, 'font-size': 10, fill: '#5a4a3a' }, svg);
  legend.textContent = `${LANG==='en'?'Active lives':'進行中人生'} ${points.length}${LANG===''?'':' '}${LANG==='en'?'/ past countries':'/ 過去國家'} ${pastCountries.size}`;
  wrap.innerHTML = '';
  wrap.appendChild(svg);
}

/* ==== v5.20：本年死因（life view） ==== */
function renderLifeCauseThisYear() {
  const wrap = $('#lifeCauseThisYear');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  if (life.died) {
    // 已死：本年分析改用死因年齡
    const age = life.deathAge || life.age;
    const w = causeWeights(life.countryData, age, life.sex);
    const entries = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = entries.reduce((a, b) => a + b[1], 0);
    wrap.innerHTML = `
      <h4>⚖️ ${t('life.causeThisYear')}</h4>
      <div class="lcw-list">
        ${entries.map(([c, n]) => {
          const pct = total > 0 ? (n / total * 100).toFixed(1) : 0;
          return `<div class="lcw-row">
            <span class="lcw-name">${escapeHtml(c)}</span>
            <span class="lcw-bg"><span class="lcw-fi" style="width:${pct}%"></span></span>
            <span class="lcw-pct">${pct}%</span>
          </div>`;
        }).join('')}
      </div>
    `;
    return;
  }
  const age = life.age;
  const w = causeWeights(life.countryData, age, life.sex);
  const entries = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = entries.reduce((a, b) => a + b[1], 0);
  wrap.innerHTML = `
    <h4>${t('life.causeThisYear')}</h4>
    <p class="muted" style="font-size:11px;margin:0 0 8px;">${t('life.causeThisYearAge', age)}</p>
    <div class="lcw-list">
      ${entries.map(([c, n]) => {
        const pct = total > 0 ? (n / total * 100).toFixed(1) : 0;
        return `<div class="lcw-row">
          <span class="lcw-name">${escapeHtml(c)}</span>
          <span class="lcw-bg"><span class="lcw-fi" style="width:${pct}%"></span></span>
          <span class="lcw-pct">${pct}%</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ==== v5.20：一生主要死因 Top 3（end view） ==== */
function computeLifetimeCauses(life) {
  // 模擬每年 age→cause weights，整合為一生的死因分布
  if (!life) return { top: [], byAge: {} };
  const c = life.countryData;
  const sex = life.sex;
  const causeAccum = {};
  // 取幾個代表性年齡：每 5 年（嬰兒細分）
  const sampleAges = [0, 1, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
  const maxAge = life.deathAge || life.age || 80;
  const filtered = sampleAges.filter(a => a <= Math.min(110, maxAge + 1));
  if (filtered.length === 0) filtered.push(maxAge);
  for (const a of filtered) {
    const w = causeWeights(c, a, sex);
    Object.entries(w).forEach(([k, v]) => {
      causeAccum[k] = (causeAccum[k] || 0) + v;
    });
  }
  const total = Object.values(causeAccum).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(causeAccum).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([k, v]) => ({ cause: k, pct: total > 0 ? (v / total * 100) : 0 }));
  return { top, byAge: causeAccum };
}
/* v5.78：訃聞頁的「你做過的決定」
   決策事件一直只寫進 life.log / life.decisions，訃聞頁完全沒有提到它們。
   這裡把一生做過的選擇整理出來，讓互動有回報。 */
const DECISION_KIND_LABEL = {
  big: 'dec.kind.big',
  small: 'dec.kind.small',
  family: 'dec.kind.family',
};
function renderEndDecisions() {
  const wrap = $('#endDecisions');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  // 決定是在作答當下記下的，標籤也是那個時候的語言。
  // 如果玩家中途換語言，整塊用「當初記錄時的語言」呈現，避免清單跟著標題變、
  // 內容卻停在另一種語言。
  const recorded = (life.decisions || []).find(d => d && d.lang)?.lang;
  const prevLang = LANG;
  if (recorded && recorded !== LANG) { LANG = recorded; }
  try { renderEndDecisionsInner(wrap, life); }
  finally { if (recorded && recorded !== prevLang) LANG = prevLang; }
}

function renderEndDecisionsInner(wrap, life) {
  const decided = (life.decisions || []).filter(d => d && d.key && d.key !== 'skipped');
  const skipped = (life.decisions || []).filter(d => d && d.key === 'skipped');
  if (!decided.length && !skipped.length) {
    wrap.innerHTML = `<h3>${t('dec.end.title')}</h3><p class="muted">${t('dec.end.none')}</p>`;
    return;
  }
  // 用事件 id 找回當初的 label（choices 內的 icon / label 不存起來，這裡重建）
  const byId = {};
  for (const d of DECISIONS) byId[d.id] = d;
  const rows = decided.map(r => {
    // label / icon 在作答當下就存進紀錄了；舊紀錄沒有就退回事件 id
    const label = r.label || r.id;
    const icon = r.icon || '✦';
    return `<div class="ed-row">
      <span class="ed-age">${r.age ?? '?'}</span>
      <span class="ed-icon">${escapeHtml(icon)}</span>
      <span class="ed-text">${escapeHtml(label)}</span>
    </div>`;
  }).join('');

  const kindCount = {};
  for (const r of decided) {
    const k = byId[r.id]?.kind || 'small';
    kindCount[k] = (kindCount[k] || 0) + 1;
  }
  const chips = Object.entries(kindCount).map(([k, n]) =>
    `<span class="ed-chip ed-chip-${k}">${t(DECISION_KIND_LABEL[k] || k)} ${n}</span>`).join('');

  wrap.innerHTML = `
    <h3>${t('dec.end.title')}</h3>
    <p class="muted" style="font-size:12px;margin:0 0 10px;">${t('dec.end.count', { n: decided.length })}</p>
    <div class="ed-chips">${chips}${skipped.length ? `<span class="ed-chip ed-chip-skip">${t('dec.end.skipped', { n: skipped.length })}</span>` : ''}</div>
    <div class="ed-list">${rows}</div>`;
}

function renderEndCauseAnalysis() {
  const wrap = $('#endCauseAnalysis');
  if (!wrap || !STATE.life) return;
  const life = STATE.life;
  // 本年（死那年）死因
  const deathAge = life.deathAge || life.age;
  const yearW = causeWeights(life.countryData, deathAge, life.sex);
  const yearEntries = Object.entries(yearW).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const yearTotal = yearEntries.reduce((a, b) => a + b[1], 0);
  // 一生 top 3
  const { top } = computeLifetimeCauses(life);
  const isEn = LANG === 'en';
  wrap.innerHTML = `
    <h3>${isEn ? '⚖️ Death cause analysis' : '⚖️ 死亡原因分析'}</h3>
    <div class="eca-section">
      <h4 style="font-size:13px;color:var(--ink-2);margin:0 0 8px;">${t('end.causeYear')}</h4>
      <p class="muted" style="font-size:11px;margin:0 0 8px;">${t('end.causeYearAge', deathAge)}</p>
      <div class="eca-list">
        ${yearEntries.length === 0 ? `<div class="eca-empty">${t('end.causeNot')}</div>` : yearEntries.map(([c, n]) => {
          const pct = yearTotal > 0 ? (n / yearTotal * 100).toFixed(1) : 0;
          return `<div class="eca-row">
            <span class="eca-name">${escapeHtml(c)}</span>
            <span class="eca-bg"><span class="eca-fi" style="width:${pct}%"></span></span>
            <span class="eca-pct">${t('end.causeShare', pct)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="eca-section">
      <h4 style="font-size:13px;color:var(--ink-2);margin:14px 0 8px;">${t('end.topCauseLifetime')}</h4>
      <div class="eca-list">
        ${top.length === 0 ? `<div class="eca-empty">${t('end.causeNot')}</div>` : top.map(({ cause, pct }) => {
          return `<div class="eca-row">
            <span class="eca-name">${escapeHtml(cause)}</span>
            <span class="eca-bg"><span class="eca-fi" style="width:${pct.toFixed(1)}%"></span></span>
            <span class="eca-pct">${t('end.causeShare', pct.toFixed(1))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

let _mapTooltip = null;
function showMapTooltip(e, html) {
  hideMapTooltip();
  _mapTooltip = document.createElement('div');
  _mapTooltip.className = 'map-tooltip';
  _mapTooltip.innerHTML = html;
  _mapTooltip.style.left = (e.pageX + 12) + 'px';
  _mapTooltip.style.top = (e.pageY + 12) + 'px';
  document.body.appendChild(_mapTooltip);
}
function hideMapTooltip() {
  if (_mapTooltip) { _mapTooltip.remove(); _mapTooltip = null; }
}

function showShortcutsModal() {
  document.querySelector('#shortcutsModal')?.remove();
  const isEn = LANG === 'en';
  const rows = [
    ['Space', isEn ? 'Pause / Resume life' : '暫停 / 繼續'],
    ['1 / 2 / 4 / 8', isEn ? 'Speed 1× / 2× / 4× / 8×' : '速度 1× / 2× / 4× / 8×'],
    ['I / L / S / T / E', isEn ? 'Switch tab: Intro / Lab / Shelf / Tree / End' : '切換 tab：開始 / Lab / 書架 / 族譜 / 訃聞'],
    ['R', isEn ? 'Rebirth (new country)' : '重新出生（換國家）'],
    ['?', isEn ? 'This shortcuts modal' : '本快捷鍵說明']
  ];
  const html = `
    <div id="shortcutsModal" class="life-modal">
      <div class="life-modal-card shortcuts-card">
        <button class="lm-close" onclick="document.getElementById('shortcutsModal').remove()">×</button>
        <h2 class="lm-title">⌨️ ${isEn ? 'Keyboard shortcuts' : '鍵盤快捷鍵'}</h2>
        <table class="shortcuts-table">
          <thead><tr><th>${isEn ? 'Key' : '按鍵'}</th><th>${isEn ? 'Action' : '動作'}</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</tbody>
        </table>
        <p class="muted" style="margin-top:12px;">${isEn ? 'Press <kbd>?</kbd> anytime to toggle this. Shortcuts skip when typing in inputs.' : '隨時按 <kbd>?</kbd> 切換本說明。在輸入框中會自動跳過。'}</p>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.querySelector('#shortcutsModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function showLifeModal(rec) {
  // 移除舊的
  document.querySelector('#lifeModal')?.remove();
  // v5.83：完整人生放在 .full 裡（v5.82 以前只有摘要殼，這裡的 family / quotes /
  // year / yearOffset 全部拿不到，詳情視窗永遠是空的）
  const life = rec.full || rec;
  const isEn = LANG === 'en';
  const c = countryById(life.country);
  const modal = document.createElement('div');
  modal.id = 'lifeModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card">
      <button class="lm-close" onclick="document.getElementById('lifeModal').remove()">×</button>
      <h2 class="lm-title">${c?.flag || ''} ${escapeHtml(life.name)}</h2>
      <div class="lm-meta">
        <span>${life.year || ''} → ${life.year + life.yearOffset || ''}</span>
        <span>·</span>
        <span>${life.age} ${t('unit.years')}</span>
        <span>·</span>
        <span>${escapeHtml(causeLabel(life.cause))}</span>
        ${life.family?.fosterCare ? `<span class="badge badge-foster">🏠 ${t('tree.noteFoster')}</span>` : ''}
        ${life.family?.adoptedFrom ? `<span class="badge badge-adopt">🧩 ${t('tree.noteAdoptive')}</span>` : ''}
      </div>
      <div id="lifeTree" class="life-tree"></div>
      <div class="life-quotes">
        <h4>${isEn ? 'Memorable moments' : '☆ 值得記住的時刻'}</h4>
        <div class="lq-list">${Object.entries(life.quotes || {}).map(([age, q]) => `<div class="ql-row"><span class="ql-age">${age} ${isEn?'yo':'歲'}</span><span class="ql-text">${escapeHtml(q)}</span></div>`).join('') || '<span class="muted">—</span>'}</div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  // 渲染該生命的 tree（如果 family 存在）
  if (life.family) {
    renderLifeTreeInto(life, $('#lifeTree'));
  }
}

function renderLifeTreeInto(life, container) {
  if (!container) return;
  const f = life.family;
  // 重建 people + edges（用該 life 為中心）
  const self = {
    id: 'self_life',
    name: life.name,
    sex: life.sex,
    country: life.country,
    countryData: countryById(life.country),
    birth: { year: life.year },
    death: life.died ? { year: life.year + life.yearOffset } : null
  };
  const people = { [self.id]: self };
  (f.parents || []).forEach(p => { people[p.id] = p; });
  (f.siblings || []).forEach(p => { people[p.id] = p; });
  (f.grandparents || []).forEach(p => { people[p.id] = p; });
  const edges = [];
  (f.parents || []).forEach((p, idx) => {
    if (idx === 0) edges.push({ parentId: p.id, childId: self.id });
    else if (idx === 1) edges.push({ parentId: p.id, childId: self.id });
  });
  (f.siblings || []).forEach(s => {
    (f.parents || []).forEach(p => edges.push({ parentId: p.id, childId: s.id }));
  });
  (f.grandparents || []).forEach(gp => {
    const par = (f.parents || []).find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
    if (par) edges.push({ parentId: gp.id, childId: par.id });
  });
  // 簡化版：只渲染祖上 1 層（父母 + 祖父母），避免 modal 太大
  renderMiniTree(container, self.id, 2, people, edges);
}

function renderMiniTree(container, rootId, maxGen, people, edges) {
  container.innerHTML = '';
  const nodes = [];
  const links = [];
  function recurse(id, gen, xSlot) {
    if (!id || !people[id]) return;
    if (gen > maxGen) return;
    if (nodes.find(n => n.id === id)) return;
    nodes.push({ id, gen, xSlot });
    if (gen < maxGen) {
      const parents = edges.filter(e => e.childId === id).map(e => e.parentId);
      const slotW = Math.pow(2, maxGen - gen - 1);
      recurse(parents[0], gen + 1, xSlot);
      if (parents[1]) recurse(parents[1], gen + 1, xSlot + slotW);
      else recurse(parents[0], gen + 1, xSlot);
      const slotW2 = Math.pow(2, maxGen - gen - 1);
      if (parents[0]) links.push({ from: { gen: gen+1, xSlot }, to: { gen, xSlot } });
      if (parents[1]) links.push({ from: { gen: gen+1, xSlot: xSlot + slotW2 }, to: { gen, xSlot } });
    }
  }
  recurse(rootId, 0, Math.pow(2, maxGen) / 2 - 0.5);
  const slotW = 200, rowH = 110, marginX = 30, marginY = 30;
  const totalSlots = Math.pow(2, maxGen);
  const w = marginX * 2 + totalSlots * slotW;
  const h = marginY * 2 + (maxGen + 1) * rowH;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const { from, to } of links) {
    const fn = nodes.find(n => n.xSlot === from.xSlot && n.gen === from.gen);
    const tn = nodes.find(n => n.xSlot === to.xSlot && n.gen === to.gen);
    if (!fn || !tn) continue;
    const fx = marginX + fn.xSlot * slotW + slotW/2;
    const fy = marginY + fn.gen * rowH + 40;
    const tx = marginX + tn.xSlot * slotW + slotW/2;
    const ty = marginY + tn.gen * rowH + 80;
    svgEl('path', { d: `M ${fx} ${fy} L ${fx} ${fy + (ty-fy)/2} L ${tx} ${fy + (ty-fy)/2} L ${tx} ${ty}`, class: 'tree-link' }, svg);
  }
  for (const n of nodes) {
    drawPersonNode(svg, people[n.id], marginX + n.xSlot * slotW, marginY + n.gen * rowH, slotW - 12, 70, n.id === rootId);
  }
  container.appendChild(svg);
}

function renderPanorama(lives) {
  // 合併多段人生的 family，找出共同祖先
  // 合併邏輯：同一個人以 name+birthYear+deathYear 為 key
  const allPeople = {};
  const allEdges = [];
  const selfNodes = [];
  function keyOf(p) {
    return `${p.name}|${p.birth?.year || '?'}|${p.death?.year || ''}|${p.sex || ''}|${p.country || ''}`;
  }
  const idMap = {};
  for (const rec of lives) {
    // v5.83：紀錄裡的完整人生放在 .full（v5.82 以前是沒有 .full 的摘要殼）
    const life = rec.full || rec;
    if (!life.family) continue;
    const f = life.family;
    const selfId = 'self_' + Math.random().toString(36).slice(2,9);
    const selfNode = {
      id: selfId,
      name: life.name?.full || life.name?.full_en || rec.name || '',
      sex: life.sex,
      country: life.country,
      countryData: countryById(life.country),
      birth: { year: life.year },
      death: life.died || rec.cause ? { year: (life.year || 0) + (life.yearOffset || 0) } : null,
      isSelf: true,
      lifeAge: rec.age ?? life.age,
      lifeCause: life.cause || rec.cause
    };
    allPeople[selfId] = selfNode;
    selfNodes.push(selfNode);
    const upsertPerson = (p) => {
      const k = keyOf(p);
      if (idMap[k]) return idMap[k];
      const newId = 'p_' + Math.random().toString(36).slice(2,9);
      idMap[k] = newId;
      allPeople[newId] = { ...p, id: newId };
      return newId;
    };
    (f.parents || []).forEach(p => {
      const pid = upsertPerson(p);
      allEdges.push({ parentId: pid, childId: selfId });
    });
    (f.siblings || []).forEach(s => {
      const sid = upsertPerson(s);
      (f.parents || []).forEach(p => {
        const pid = upsertPerson(p);
        allEdges.push({ parentId: pid, childId: sid });
      });
    });
    (f.grandparents || []).forEach(gp => {
      const gpid = upsertPerson(gp);
      const par = (f.parents || []).find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
      if (par) {
        const pid = upsertPerson(par);
        allEdges.push({ parentId: gpid, childId: pid });
      }
    });
  }
  // v5.83：舊紀錄（v5.82 以前存的）沒有 family，selfNodes 會是空的，
  // 直接 selfNodes[0].id 會拋 TypeError。改成顯示訊息而不是整片空白 + console error。
  if (!selfNodes.length) {
    toast(t('shelf.noFamilyData'));
    return;
  }
  const commonAncestors = findCommonAncestors(selfNodes, allEdges, allPeople);
  const modal = document.createElement('div');
  modal.id = 'lifeModal';
  modal.className = 'life-modal';
  modal.innerHTML = `
    <div class="life-modal-card life-modal-wide">
      <button class="lm-close" onclick="document.getElementById('lifeModal').remove()">×</button>
      <h2 class="lm-title">🌐 ${t('shelf.panorama') || '家族全景圖'}</h2>
      <p class="muted">${t('shelf.panoramaSub') || '合併 ' + lives.length + ' 段人生的族譜。共同祖先以紅框標示。'}</p>
      ${commonAncestors.length ? `<div class="panorama-common"><b>${t('shelf.commonAncestors') || '共同親屬'}：</b> ${commonAncestors.map(c => escapeHtml(c.name)).join('、')}</div>` : `<div class="panorama-common"><span class="muted">${t('shelf.noCommon') || '無共同親屬'}</span></div>`}
      <div id="lifeTree" class="life-tree"></div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  renderMiniTree($('#lifeTree'), selfNodes[0].id, 2, allPeople, allEdges);
  setTimeout(() => {
    document.querySelectorAll('#lifeTree .tree-node').forEach(n => {
      const name = n.querySelector('.node-name')?.textContent;
      if (commonAncestors.some(c => c.name === name)) {
        n.querySelector('.node-rect')?.setAttribute('stroke', '#a04040');
        n.querySelector('.node-rect')?.setAttribute('stroke-width', '3');
      }
    });
  }, 100);
}

function findCommonAncestors(selfNodes, edges, allPeople) {
  // 共同親屬：直接出現在 ≥2 個 self 的「家族清單」（parents + grandparents + siblings）
  // 注意：不要走 parent-of-parent 路徑，因為那會把 A 的祖父錯算成 B 的祖父（除非 B 也明確收錄）
  const counts = new Map();
  for (const self of selfNodes) {
    const ancestors = edges.filter(e => e.childId === self.id).map(e => e.parentId);
    ancestors.forEach(a => {
      if (!counts.has(a)) counts.set(a, new Set());
      counts.get(a).add(self.id);
    });
  }
  const common = [];
  counts.forEach((selves, pid) => {
    if (selves.size >= 2 && allPeople[pid] && !allPeople[pid].isSelf) {
      common.push({ id: pid, name: allPeople[pid].name, count: selves.size });
    }
  });
  return common;
}

function renderSpeedBtns() {
  $$('.ltb-speed-btn').forEach(b => {
    b.classList.toggle('active', +b.dataset.speed === STATE.speed);
  });
}

function updateLangSwitcher() {
  const sel = $('#langSwitcher');
  if (sel) sel.value = LANG;
}

// ==== Lab 模式：批次模擬 ====
function runLab(countryCode, era, sexMode, N) {
  // 跑 N 條人生，收集統計
  const deaths = []; // age of death
  const causes = {}; // cause -> count
  const country = countryById(countryCode);
  if (!country) return null;
  const adjustEra = { past: 1990, future: 2080, any: 2024, now: 2024 }[era] || 2024;
  for (let i = 0; i < N; i++) {
    const sex = sexMode === 'random' ? (Math.random() < 0.5 ? 'M' : 'F') : sexMode;
    const life = newLife(countryCode);
    life.sex = sex;
    life.year = adjustEra;
    life.yearOffset = 0;
    // 跑到死
    while (!life.died && life.age < 120) {
      life.age += 1;
      life.yearOffset += 1;
      if (Math.random() < pDie(life.age, life.countryData, sex)) {
        life.died = true;
        life.deathAge = life.age;
        const cause = pickCause(life.countryData, life.age, sex);
        life.cause = cause;
        break;
      }
    }
    if (!life.died) {
      life.deathAge = life.age;
      life.cause = '自然衰老';
    }
    deaths.push(life.deathAge);
    causes[life.cause] = (causes[life.cause] || 0) + 1;
  }
  deaths.sort((a, b) => a - b);
  const avg = deaths.reduce((a, b) => a + b, 0) / deaths.length;
  const median = deaths[Math.floor(deaths.length / 2)];
  // 家族統計
  const famStats = runFamilyLab(countryCode, Math.min(N, 200));
  return { deaths, causes, avg, median, country, N, era: adjustEra, famStats };
}

/* ==== Lab 家族統計：批次產生 N 個家族，看孤兒率/手足數/收養率 ==== */
function runFamilyLab(countryCode, N) {
  const c = countryById(countryCode);
  if (!c) return null;
  let adopted = 0, fostered = 0, orphan = 0, withFather = 0, withMother = 0, twoParents = 0;
  let sibTotal = 0, gpTotal = 0;
  for (let i = 0; i < N; i++) {
    const f = generateFamily(countryCode, Math.random() < 0.5 ? 'M' : 'F');
    if (f.fosterCare === 'adopt') adopted++;
    if (f.fosterCare === 'foster') fostered++;
    if (f.parents.length === 0) orphan++;
    const hasFather = f.parents.some(p => p.sex === 'M');
    const hasMother = f.parents.some(p => p.sex === 'F');
    if (hasFather) withFather++;
    if (hasMother) withMother++;
    if (hasFather && hasMother) twoParents++;
    sibTotal += f.siblings.length;
    gpTotal += (f.grandparents || []).length;
  }
  return {
    N,
    adoptedPct: (adopted / N * 100).toFixed(1),
    fosteredPct: (fostered / N * 100).toFixed(1),
    orphanPct: (orphan / N * 100).toFixed(1),
    twoParentsPct: (twoParents / N * 100).toFixed(1),
    withFatherPct: (withFather / N * 100).toFixed(1),
    withMotherPct: (withMother / N * 100).toFixed(1),
    avgSib: (sibTotal / N).toFixed(2),
    avgGP: (gpTotal / N).toFixed(2)
  };
}

function renderLab() {
  const countrySel = $('#labCountry');
  const countryBSel = $('#labCountryB');
  if (countrySel && countrySel.children.length !== COUNTRIES.length) {
    countrySel.innerHTML = '';
    for (const c of COUNTRIES) {
      const loc = localize(c);
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.flag} ${loc.name}`;
      countrySel.appendChild(opt);
    }
    if (countryBSel) {
      countryBSel.innerHTML = '<option value="">—</option>';
      for (const c of COUNTRIES) {
        const loc = localize(c);
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.flag} ${loc.name}`;
        countryBSel.appendChild(opt);
      }
    }
  }
}

function displayLabResults(result) {
  const target = $('#labResults');
  if (!target) return;
  if (!result) {
    target.innerHTML = '<div class="lab-section" style="text-align:center;color:var(--ink-3);">—</div>';
    return;
  }
  const { deaths, causes, avg, median, country, N, era } = result;
  // 直方圖分箱
  const minA = Math.min(...deaths), maxA = Math.max(...deaths);
  const bins = {};
  const binSize = Math.max(1, Math.ceil((maxA - minA) / 20));
  for (let i = 0; i < N; i++) {
    const b = Math.floor(deaths[i] / binSize) * binSize;
    bins[b] = (bins[b] || 0) + 1;
  }
  const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...Object.values(bins));
  // 死因排序
  const sortedCauses = Object.entries(causes).sort((a, b) => b[1] - a[1]);
  // 格式化
  const flag = country.flag;
  const loc = localize(country);
  const deathPercent = (deaths.filter(d => d < 5).length / N * 100).toFixed(1);
  let html = `
    <div class="lab-stats">
      <div class="lab-stat"><div class="k">${flag} ${loc.name}</div><div class="v">${N}</div><div class="sub">${t('lab.run').toLowerCase()}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.avg_age')}</div><div class="v">${avg.toFixed(1)}</div><div class="sub">${t('unit.years')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.median_age')}</div><div class="v">${median}</div><div class="sub">${t('unit.years')}</div></div>
      <div class="lab-stat"><div class="k">5 歲以下死亡</div><div class="v">${deathPercent}%</div><div class="sub">${N} 人中 ${deaths.filter(d => d < 5).length} 人</div></div>
      <div class="lab-stat"><div class="k">${t('lab.top_cause')}</div><div class="v" style="font-size:16px;">${sortedCauses[0] ? sortedCauses[0][0] : '—'}</div><div class="sub">${sortedCauses[0] ? (sortedCauses[0][1] / N * 100).toFixed(1) + '%' : ''}</div></div>
    </div>
    <div class="lab-section">
      <h3>${t('lab.distribution')}</h3>
      <div class="lab-bars">
  `;
  for (const b of sortedBins) {
    const h = (bins[b] / maxCount) * 140;
    html += `<div class="lab-bar-col"><div class="val">${bins[b]}</div><div class="lab-bar" style="height:${h}px"></div><div class="lbl">${b}</div></div>`;
  }
  html += `</div></div><div class="lab-section"><h3>${t('lab.top_cause')} ${t('lab.distribution')}</h3><div class="lab-causes">`;
  const maxC = sortedCauses[0] ? sortedCauses[0][1] : 1;
  for (const [cause, count] of sortedCauses) {
    const pct = (count / N * 100).toFixed(1);
    const width = (count / maxC * 100).toFixed(0);
    html += `<div class="lab-cause"><span class="nm">${cause}</span><span class="bg"><span class="fi" style="width:${width}%"></span></span><span class="ct">${count} (${pct}%)</span></div>`;
  }
  html += `</div></div>`;
  // 家族統計
  if (result.famStats) {
    const fs = result.famStats;
    html += `<div class="lab-section"><h3>${t('lab.familyStats')}</h3><div class="fam-stats-grid">
      <div class="lab-stat"><div class="k">${t('lab.famOrphan')}</div><div class="v">${fs.orphanPct}%</div><div class="sub">${fs.N} 個家族</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famTwoParents')}</div><div class="v">${fs.twoParentsPct}%</div><div class="sub">${t('lab.famFull')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAdopted')}</div><div class="v">${fs.adoptedPct}%</div><div class="sub">${t('lab.famAdoptedHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAvgSib')}</div><div class="v">${fs.avgSib}</div><div class="sub">${t('lab.famAvgSibHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famAvgGP')}</div><div class="v">${fs.avgGP}</div><div class="sub">${t('lab.famAvgGPHint')}</div></div>
      <div class="lab-stat"><div class="k">${t('lab.famFostered')}</div><div class="v">${fs.fosteredPct}%</div><div class="sub">${t('lab.famFosteredHint')}</div></div>
    </div></div>`;
  }
  target.innerHTML = html;
}

/* ==== Lab 國家比較模式 ==== */
function displayLabResultsCompare(rA, rB) {
  const target = $('#labResults');
  if (!target) return;
  const flag = (c) => c.flag || '🏳️';
  const stat = (label, a, b, fmt, lowerBetter) => {
    const da = (a ?? 0), db = (b ?? 0);
    const wa = lowerBetter ? (da < db ? '▲' : da > db ? '▼' : '=') : (da > db ? '▲' : da < db ? '▼' : '=');
    const wb = lowerBetter ? (db < da ? '▲' : db > da ? '▼' : '=') : (db > da ? '▲' : db < da ? '▼' : '=');
    return `<tr><td>${label}</td><td>${fmt(da)} ${wa}</td><td>${fmt(db)} ${wb}</td></tr>`;
  };
  const fmt1 = x => x?.toFixed ? x.toFixed(1) : x;
  const fmt0 = x => Math.round(x ?? 0);
  const html = `
    <div class="lab-section"><h3>${flag(rA.country)} ${rA.country.name_zh} vs ${flag(rB.country)} ${rB.country.name_zh}</h3>
      <p class="muted">${rA.N} ${LANG==='en'?'lives per country':'人/國家'} · ${LANG==='en'?'avg lifespan, family stats':'平均壽命、家庭統計'}</p>
      <table class="lab-compare">
        <thead><tr><th></th><th>${flag(rA.country)} ${rA.country.name_zh}</th><th>${flag(rB.country)} ${rB.country.name_zh}</th></tr></thead>
        <tbody>
          ${stat(t('lab.avg_age'), rA.avg, rB.avg, fmt1)}
          ${stat(t('lab.median_age'), rA.median, rB.median, fmt0)}
          ${stat('5歲以下死亡%', (rA.deaths.filter(d => d < 5).length / rA.N * 100), (rB.deaths.filter(d => d < 5).length / rB.N * 100), fmt1, true)}
          ${stat(t('lab.famOrphan'), parseFloat(rA.famStats.orphanPct), parseFloat(rB.famStats.orphanPct), fmt1, true)}
          ${stat(t('lab.famTwoParents'), parseFloat(rA.famStats.twoParentsPct), parseFloat(rB.famStats.twoParentsPct), fmt1)}
          ${stat(t('lab.famAdopted'), parseFloat(rA.famStats.adoptedPct), parseFloat(rB.famStats.adoptedPct), fmt1)}
          ${stat(t('lab.famAvgSib'), parseFloat(rA.famStats.avgSib), parseFloat(rB.famStats.avgSib), fmt1)}
          ${stat(t('lab.famAvgGP'), parseFloat(rA.famStats.avgGP), parseFloat(rB.famStats.avgGP), fmt1)}
        </tbody>
      </table>
    </div>
    <div class="lab-section"><h3>${LANG==='en'?'Top causes':'死因分布對比'}</h3>
      <div class="lab-compare-causes">
        <div><h4>${flag(rA.country)} ${rA.country.name_zh}</h4>${renderCauseList(rA.causes)}</div>
        <div><h4>${flag(rB.country)} ${rB.country.name_zh}</h4>${renderCauseList(rB.causes)}</div>
      </div>
    </div>`;
  target.innerHTML = html;
}

function renderCauseList(causes) {
  const sorted = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = Object.values(causes).reduce((a, b) => a + b, 0);
  return '<ol class="lab-causes">' + sorted.map(([c, n]) =>
    `<li><span class="lab-cause">${c}</span><span class="lab-cause-n">${(n/total*100).toFixed(1)}%</span></li>`
  ).join('') + '</ol>';
}

// ==== 事件 ====
function wire() {
  // v5.51：任何關閉 modal 的方式（× / 點背景 / 空白鍵）都必須恢復計時
  $$('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  $$('.modal').forEach(m => {
    m.addEventListener('mousedown', e => { if (e.target === m) closeModal(m.id); });
  });
  document.addEventListener('keydown', e => {
    const openAll = $$('.modal').filter(el => !el.hasAttribute('hidden'));
    // v5.72：焦點圈住 — modal 開著時 Tab 只能在 modal 裡面循環。
    // 實測原本按兩次 Tab 就會跳出到 modal 背後的頁面元件（例如右下角的 ? 按鈕），
    // 鍵盤使用者會在不知不覺中操作到被遮住的控制項。
    if (e.key === 'Tab' && openAll.length) {
      const m = openAll[openAll.length - 1];
      const f = $$('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])', m)
        .filter(el => !el.hasAttribute('hidden') && el.offsetParent !== null && el.tabIndex !== -1);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const active = document.activeElement;
      if (!m.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return; }
      return;
    }
    if (e.key !== 'Escape') return;
    const open = PAUSING_MODALS.map(i => document.getElementById(i))
      .filter(el => el && !el.hasAttribute('hidden'));
    if (open.length) { closeModal(open[0].id); e.preventDefault(); }
  });
  // 導覽
  $$('.navbtn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  // 語言
  const ls = $('#langSwitcher');
  if (ls) ls.addEventListener('change', e => setLang(e.target.value));
  // 國家選擇
  const sel = $('#countrySelect');
  if (sel) sel.addEventListener('change', e => { STATE.selectedCountry = e.target.value; renderIntro(); });
  // 出生模式
  $$('[data-birth-mode]').forEach(b => b.addEventListener('click', () => {
    $$('[data-birth-mode]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    STATE.birthMode = b.dataset.birthMode;
  }));
  // 年代
  $$('[data-era]').forEach(b => b.addEventListener('click', () => {
    $$('[data-era]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    STATE.era = b.dataset.era;
  }));
  // 開始按鈕（v5.19：先顯示出生登記卡 modal，等使用者確認才 startLife）
  const start = $('#btnStart');
  if (start) start.addEventListener('click', () => {
    startLifeWithCert();
  });
  // 選特定國家開始（v5.19：同樣先顯示出生卡）
  const startSelected = $('#btnStartSelected');
  if (startSelected) startSelected.addEventListener('click', () => {
    const c = countryById(STATE.selectedCountry);
    if (c) showBirthCertModal(c);
  });
  // v5.19：出生卡 modal 的確認按鈕
  const birthCertConfirm = $('#birthCertConfirm');
  if (birthCertConfirm) birthCertConfirm.addEventListener('click', () => {
    const c = STATE.birthCertCountry;
    hideBirthCertModal();
    if (c) startLife(c.id);
  });
  // v5.19：出生卡 modal 的取消按鈕
  const birthCertCancel = $('#birthCertCancel');
  if (birthCertCancel) birthCertCancel.addEventListener('click', () => {
    hideBirthCertModal();
  });
  // v5.19：出生卡 modal 的「換一個國家」
  const birthCertReroll = $('#birthCertReroll');
  if (birthCertReroll) birthCertReroll.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) showBirthCertModal(c);
  });
  // v5.19：modal 點背景關閉
  const birthCertModal = $('#birthCertModal');
  if (birthCertModal) birthCertModal.addEventListener('click', (e) => {
    if (e.target === birthCertModal) hideBirthCertModal();
  });
  // 生命控制
  const pauseBtn = $('#btnPause');
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    STATE.paused = !STATE.paused;
    syncPauseBtn();
  });
  syncPauseBtn();
  $$('.ltb-speed-btn').forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
  // v5.9：自動抉擇模式
  const autoBtn = $('#btnAuto');
  if (autoBtn) autoBtn.addEventListener('click', () => {
    STATE.autoDecide = !STATE.autoDecide;
    autoBtn.classList.toggle('active', STATE.autoDecide);
    syncAutoBtn();
    if (STATE.autoDecide && STATE.pendingDecision) resolvePendingDecision();
  });
  // v5.9：快轉到下一個抉擇
  const skipBtn = $('#btnSkip');
  if (skipBtn) skipBtn.addEventListener('click', () => {
    if (STATE.pendingDecision) { resolvePendingDecision(); return; }
    STATE.fastForward = true;
  });
  // v5.10：✎ 寫下想法 modal 啟用開關 + 暫停問題
  const thoughtsBtn = $('#btnThoughts');
  if (thoughtsBtn) thoughtsBtn.addEventListener('click', () => {
    STATE.thoughtsEnabled = !STATE.thoughtsEnabled;
    thoughtsBtn.classList.toggle('active', STATE.thoughtsEnabled);
    if (STATE.thoughtsEnabled && STATE.pendingDecision) showPauseQuestion();
  });
  // v5.22：貨幣切換 + 主題切換
  const currencyBtn = $('#currencyToggle');
  const currencies = ['NT$', 'HK$', 'MOP$', 'CNY', 'US$'];
  if (currencyBtn) currencyBtn.addEventListener('click', () => {
    const i = currencies.indexOf(STATE.life?.currency || 'NT$');
    const next = currencies[(i + 1) % currencies.length];
    setCurrency(next);
    const lbl = $('#currencyLabel');
    if (lbl) lbl.textContent = next;
    toast(LANG === 'en' ? `Currency: ${next}` : `貨幣：${next}`);
  });
  const themeBtn = $('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const order = ['theme-light','theme-dark','theme-sepia'];
    const cur = order.find(c => document.body.classList.contains(c)) || 'theme-light';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setTheme(next);
    toast(LANG === 'en' ? `Theme: ${next.replace('theme-','')}` : `主題：${next.replace('theme-','')}`);
  });
  // v5.50：略過可怕的情節（1in8b.life softBtn / softBtn2）— topbar 與 intro 兩處共用
  ['#btnSoftMode', '#softBtnIntro'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.addEventListener('click', toggleSoftMode);
  });
  // v5.61：詳細資料展開／收合（記住偏好）
  const detailBtn = $('#btnDetailToggle');
  if (detailBtn) {
    const apply = () => {
      const on = localStorage.getItem(STORAGE_KEY + ':detail') === '1';
      $('#view-life')?.classList.toggle('show-detail', on);
      detailBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      syncDetailToggleLabel();
    };
    detailBtn.addEventListener('click', () => {
      const on = $('#view-life')?.classList.contains('show-detail');
      localStorage.setItem(STORAGE_KEY + ':detail', on ? '0' : '1');
      apply();
    });
    apply();
  }
  const pauseSave = $('#pauseSave');
  if (pauseSave) pauseSave.addEventListener('click', savePauseQuote);
  const pauseSkip = $('#pauseSkip');
  if (pauseSkip) pauseSkip.addEventListener('click', () => {
    resolvePendingDecision();
    closeModal('pauseModal');
  });
  // 死亡
  const dieBtn = $('#btnDieNow');
  if (dieBtn) dieBtn.addEventListener('click', () => { if (STATE.life && !STATE.life.died) dieNow('自行結束'); });
  const rebirthBtn = $('#btnRebirth');
  if (rebirthBtn) rebirthBtn.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) {
      stopTicker();
      toast(LANG==='en' ? `Reborn in ${c.flag} ${c.name_zh}` : `在 ${c.flag} ${c.name_zh} 重新出生`);
      startLife(c.id);
    }
  });
  // v5.12 / v5.20：分享出生卡（下載 PNG + 複製 base64 URL）
  const shareCardBtn = $('#btnShareCard');
  if (shareCardBtn) shareCardBtn.addEventListener('click', () => {
    downloadBirthCardPNG();
    copyBirthCardShareURL();
  });
  // 結束畫面
  const restart = $('#btnRestart');
  if (restart) restart.addEventListener('click', () => setView('intro'));
  const newLife = $('#btnNewLife');
  if (newLife) newLife.addEventListener('click', () => {
    const c = chooseCountry(STATE.birthMode);
    if (c) startLife(c.id);
  });
  const downloadCert = $('#btnDownloadCert');
  if (downloadCert) downloadCert.addEventListener('click', downloadLifeCertPNG);
  // v5.24：再看一次最後的時刻 + 提供意見
  const replayLast = $('#btnReplayLast');
  if (replayLast) replayLast.addEventListener('click', replayLastMoments);
  $('#endCloseReplay')?.addEventListener('click', () => $('#endLastMoments')?.setAttribute('hidden', ''));
  // v5.31：前世紀錄面板按鈕
  $('#endShowMore9')?.addEventListener('click', () => {
    const past = loadPastLives();
    const more = past.slice(5, 14);
    const html = more.map((p, i) => `<div class="pr-row"><div class="pr-info"><strong>${p.name || '—'}</strong><span class="muted">${p.country || '—'} · ${p.age} 歲</span></div></div>`).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = html || '<div class="muted">—</div>';
    document.querySelector('#endPastList')?.appendChild(wrap);
    toast(isEn ? `Showing ${more.length} more` : `顯示 ${more.length} 段過去`);
  });
  $('#endViewShelf')?.addEventListener('click', () => setView('shelf'));
  $('#endResumeLife')?.addEventListener('click', () => {
    if (!STATE.life || !STATE.life.died) return;
    STATE.life.died = false;
    STATE.life.cause = null;
    STATE.life.deathAge = null;
    STATE.paused = false;
    setView('life');
    startTicker();
    toast(isEn ? 'Life resumed' : '已回到那一生');
  });
  $('#endOrganize')?.addEventListener('click', () => {
    setView('shelf');
    setTimeout(() => document.querySelector('#manageRecordsBtn')?.click(), 200);
  });
  $('#endDeleteAll')?.addEventListener('click', () => {
    if (confirm(isEn ? 'Delete all past lives?' : '刪除所有過去的人生？')) {
      localStorage.setItem(STORAGE_KEY + ':past', '[]');
      renderEnd();
      toast(isEn ? 'All deleted' : '已全部刪除');
    }
  });
  const feedbackSubmit = $('#feedbackSubmit');
  if (feedbackSubmit) feedbackSubmit.addEventListener('click', submitFeedback);
  $('#footerFeedbackBtn')?.addEventListener('click', () => $('#feedbackModal')?.removeAttribute('hidden'));
  // esc 關閉
  document.addEventListener('keydown', e => {
    // 跳過輸入框
    if (['INPUT','TEXTAREA','SELECT'].includes((e.target.tagName||'').toUpperCase())) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === ' ') { if (STATE.view === 'life') $('#btnPause')?.click(); e.preventDefault(); return; }
    // 速度 1/2/4/8
    if (['1','2','4','8'].includes(k)) {
      const btn = document.querySelector(`.ltb-speed-btn[data-speed="${k}"]`);
      if (btn) { btn.click(); e.preventDefault(); }
      return;
    }
    const navMap = { i:'intro', l:'lab', s:'shelf', t:'tree', e:'end' };
    if (navMap[k]) {
      document.querySelectorAll('.navbtn').forEach(b => { if (b.dataset.view === navMap[k]) b.click(); });
      e.preventDefault();
      return;
    }
    // R = 重新出生
    if (k === 'r' || k === 'R') {
      if (STATE.life && STATE.view === 'life') {
        $('#btnRebirth')?.click();
        e.preventDefault();
      }
      return;
    }
    // ? = 快捷鍵說明
    if (k === '?' || (k === '/' && e.shiftKey)) {
      showShortcutsModal();
      e.preventDefault();
    }
  });
  // Lab
  const labRun = $('#labRun');
  if (labRun) labRun.addEventListener('click', () => {
    const code = $('#labCountry').value;
    const codeB = $('#labCountryB')?.value;
    const era = $('#labEra').value;
    const sex = $('#labSex').value;
    const N = +$('#labN').value;
    const result = runLab(code, era, sex, N);
    if (codeB) {
      const resultB = runLab(codeB, era, sex, N);
      displayLabResultsCompare(result, resultB);
    } else {
      displayLabResults(result);
    }
  });
  // Tree (族譜)
  $('#treeRoot')?.addEventListener('change', e => { TREE_STATE.rootId = e.target.value; renderTree(); });
  $('#treeMode')?.addEventListener('change', e => { TREE_STATE.mode = e.target.value; renderTree(); });
  $('#treeDepth')?.addEventListener('change', e => { TREE_STATE.depth = +e.target.value; renderTree(); });
  $('#treeSearch')?.addEventListener('input', e => highlightTreeSearch(e.target.value));
  $('#treeRefresh')?.addEventListener('click', () => {
    if (STATE.life) {
      STATE.life.family = generateFamily(STATE.life.country, STATE.life.sex);
      TREE_STATE.rootId = 'self';
      renderTree();
    }
  });
  $('#treeExport')?.addEventListener('click', exportGEDCOM);
  $('#treeShare')?.addEventListener('click', shareTreeLink);
  $('#lifeExport')?.addEventListener('click', exportLifeJSON);
  $('#lifeImport')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importLifeJSON(file);
    e.target.value = '';
  });
}

/* ==== URL hash 分享：序列化 life 到 LZ-string-ish JSON base64 ==== */
function shareTreeLink() {
  if (!STATE.life) { toast(LANG === 'en' ? 'Start a life first' : '請先開始一段人生'); return; }
  const { people, edges } = treePeopleGraph();
  const payload = {
    meta: { title: '族譜 · ' + (STATE.life.name.full || 'born-somewhere'), ts: Date.now() },
    people: Object.values(people).map(p => ({
      id: p.id, name: p.name, sex: p.sex, country: p.country,
      birth: p.birth, death: p.death, note: p.note, family: p.family
    })),
    edges
  };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const url = `${location.origin}${location.pathname}#tree=${b64}`;
  navigator.clipboard?.writeText(url).then(() => {
    toast(t('share.copied') || '已複製');
  }, () => {
    prompt(LANG === 'en' ? 'Copy this URL:' : '複製此連結：', url);
  });
}

/* ==== 完整生涯 JSON 匯出/匯入 ==== */
function exportLifeJSON() {
  if (!STATE.life) { toast(LANG === 'en' ? 'Start a life first' : '請先開始一段人生'); return; }
  const payload = {
    type: 'born-somewhere-life',
    version: 1,
    exportedAt: new Date().toISOString(),
    state: {
      life: STATE.life,
      pastLives: loadPastLives(),
      importedFamily: STATE.importedFamily || null
    }
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (STATE.life.name?.full || STATE.life.name?.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
  a.href = url; a.download = `born-somewhere-${safeName}-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(LANG === 'en' ? 'Life exported' : '已匯出生涯');
}

/* v5.22：繼續一段過去的人生（從 shelf 載入並接續從當年齡） */
function continueOldLife(pastLife) {
  if (!pastLife || pastLife.died) {
    toast(LANG === 'en' ? 'Life already ended' : '這段人生已結束');
    return;
  }
  stopTicker();
  // v5.83：v5.82 以前只存摘要，這裡會拿到空殼人生；新紀錄有 full 欄位就用它。
  const src = pastLife.full || pastLife;
  STATE.life = JSON.parse(JSON.stringify(src));  // 深拷貝
  STATE.life.died = false;
  STATE.life.cause = null;
  STATE.life.deathAge = null;
  STATE.life.financeModalShown = [];  // 重開財務 modal 選項
  STATE.life.focusThisYear = null;
  STATE.feedShown = 12;               // v5.65：重開人生時事件紀錄收回到 12 筆
  setView('life');
  setTimeout(() => {
    startTicker();
    toast(LANG === 'en' ? `Continuing from age ${STATE.life.age}` : `從 ${STATE.life.age} 歲接續這一生`);
  }, 100);
}

/* v5.22：貨幣切換 — 即時換算 netAssets */
function setCurrency(cur) {
  if (!STATE.life) return;
  STATE.life.currency = cur;
  const s = STATE.life.stats;
  const rateMap = { 'NT$': 30, 'HK$': 7.8, 'MOP$': 8.05, 'CNY': 7.2, 'US$': 1 };
  const rates = { 'NT$': '🇹🇼 NT$', 'HK$': '🇭🇰 HK$', 'MOP$': '🇲🇴 MOP$', 'CNY': '🇨🇳 CNY', 'US$': '🇺🇸 US$' };
  if (!rateMap[cur]) return;
  const na = $('#netAssets');
  if (na) na.textContent = rates[cur] + Math.round((s.netAssets || 0) * rateMap[cur]).toLocaleString();
  // 也更新「💰 投資」選項的價格顯示
  document.querySelectorAll('.fin-price').forEach(el => {
    if (el.dataset.basePrice) {
      el.textContent = cur + Math.round(parseFloat(el.dataset.basePrice) * rateMap[cur]).toLocaleString();
    }
  });
}

/* v5.22：主題切換（light/dark/sepia） */
function setTheme(theme) {
  document.body.classList.remove('theme-light','theme-dark','theme-sepia');
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'theme-dark' : 'theme-light';
  document.body.classList.add(theme);
  localStorage.setItem('born-somewhere-v2:theme', theme);
}

function importLifeJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (payload.type !== 'born-somewhere-life') throw new Error(LANG === 'en' ? 'Invalid format' : '格式不正確');
      if (payload.state?.life) {
        STATE.life = payload.state.life;
        if (payload.state.pastLives) localStorage.setItem(STORAGE_KEY + ':past', JSON.stringify(payload.state.pastLives));
        if (payload.state.importedFamily) STATE.importedFamily = payload.state.importedFamily;
        stopTicker();
        setView('life');
        renderAll();
        toast(LANG === 'en' ? 'Life imported — press ⏸/▶ to resume' : '已匯入生涯，按 ⏸/▶ 繼續');
      } else { throw new Error('No life data'); }
    } catch (e) {
      console.error(e);
      toast(LANG === 'en' ? 'Import failed: ' + e.message : '匯入失敗：' + e.message);
    }
  };
  reader.readAsText(file);
}

function loadFromHash() {
  const m = location.hash.match(/#tree=([^&]+)/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    const payload = JSON.parse(json);
    if (!payload.people || !payload.people.length) return false;
    STATE.importedFamily = { _meta: payload.meta, people: {} };
    payload.people.forEach(p => { STATE.importedFamily.people[p.id] = p; });
    const self = payload.people.find(p => p.id === 'self') || payload.people[0];
    STATE.life = {
      country: self.country || 'TWN',
      countryData: countryById(self.country || 'TWN'),
      name: { full: self.name, full_en: self.nameEn || '' },
      sex: self.sex || 'U',
      age: 30, year: new Date().getFullYear(),
      yearOffset: 0,
      family: { parents: [], siblings: [], grandparents: [], partner: null, kids: [] }
    };
    TREE_STATE.rootId = 'self';
    setView('tree');
    renderTree();
    toast(LANG === 'en' ? 'Loaded from URL' : '已從連結載入');
    return true;
  } catch (e) { console.error(e); return false; }
}
  $('#treeImport')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result;
        const parsed = window.Gedcom.import(text);
        STATE.importedFamily = parsed;  // 存到 STATE 供 GEDCOM.parse 之後用
        if (!STATE.life) {
          toast(LANG === 'en' ? 'Start a life first, then import GEDCOM' : '請先開始一段人生，再匯入 GEDCOM');
          return;
        }
        const f = STATE.life.family;
        f.parents = [];
        f.grandparents = [];
        f.siblings = [];
        // 自動找 self：用 @self@ xref 或姓名/出生年匹配現有 self
        const selfP = findSelfInGedcom(parsed);
        if (!selfP) {
          toast(LANG === 'en' ? 'GEDCOM imported — pick a person from Tree dropdown' : '已匯入 GEDCOM，請從族譜中心人物選擇');
        } else {
          // 灌入 self 的家族
          const fMembers = buildFamilyAround(selfP, parsed);
          f.parents = fMembers.parents;
          f.siblings = fMembers.siblings;
          f.grandparents = fMembers.grandparents;
        }
        TREE_STATE.rootId = selfP ? 'self' : Object.keys(parsed.people)[0];
        renderTree();
        const n = Object.keys(parsed.people).length;
        toast(t('io.imported', n));
      } catch (err) {
        console.error(err);
        toast(LANG === 'en' ? 'GEDCOM parse failed: ' + err.message : 'GEDCOM 解析失敗：' + err.message);
      }
    };
    reader.readAsText(file);
  });

/* 從 zu-pu/gedcom.js 解析結果找 self：
   1) 先看有沒有 xref "@self@" 標記的
   2) 否則用 STATE.life 的名字 + 出生年匹配 */
function findSelfInGedcom(parsed) {
  const ps = Object.values(parsed.people);
  const selfTagged = ps.find(p => p.notes && p.notes.includes('@self@'));
  if (selfTagged) return selfTagged;
  if (!STATE.life) return ps[0];
  const lifeName = STATE.life.name.full || STATE.life.name.full_en || '';
  const lifeYear = STATE.life.year + STATE.life.yearOffset - STATE.life.age;
  return ps.find(p => p.name === lifeName && p.birth && p.birth.year === lifeYear) || ps[0];
}

function buildFamilyAround(selfP, parsed) {
  const ps = parsed.people;
  const parents = (selfP.parents || []).map(pid => ps[pid]).filter(Boolean);
  const siblings = [];
  // 同父母的其他人 = 手足
  parents.forEach(par => {
    (par.spouses || []).forEach(spid => {
      // 找所有 children of FAM(parents)
    });
  });
  // 直接從 parents 的 children 找
  const allSibs = new Set();
  ps[parents[0]?.id] && (ps[parents[0].id].spouses || []).forEach(spid => {
    // 這對配偶的 FAM 的 children
  });
  // 簡化：找自我以外的所有人，其 parents 包含自我任一 parent
  Object.values(ps).forEach(p => {
    if (p.id === selfP.id) return;
    if ((p.parents || []).some(pid => parents.find(par => par.id === pid))) {
      siblings.push(p);
    }
  });
  const grandparents = [];
  parents.forEach(par => {
    (par.parents || []).forEach(gpid => {
      const gp = ps[gpid];
      if (gp && !grandparents.find(g => g.id === gp.id)) grandparents.push(gp);
    });
  });
  // 轉成 born-somewhere family 格式
  return {
    parents: parents.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    })),
    siblings: siblings.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    })),
    grandparents: grandparents.map(p => ({
      id: 'g_' + p.id,
      name: p.name || p.nameEn || '?',
      sex: p.gender === 'F' ? 'F' : 'M',
      country: p.birthPlace || STATE.life.country,
      countryData: countryById(p.birthPlace) || STATE.life.countryData,
      birth: p.birth ? { year: p.birth.year } : null,
      death: p.death ? { year: p.death.year } : null,
      note: null,
      sourceGedcomId: p.id
    }))
  };
}

async function init() {
  await loadData();
  document.documentElement.lang = LANG;
  // v5.39：預設跟隨系統（1in8b.life 行為）；沒存過就用 auto
  const savedTheme = localStorage.getItem('born-somewhere-v2:theme') || 'auto';
  setTheme(savedTheme);  // v5.22：套用保存的主題
  checkEduMode();      // v5.19: 教學版旗標 (?edu=1)
  wire();
  renderAll();
  injectHelpFab();
  injectFooter();      // v5.19: footer + 工具列
  registerServiceWorker(); // v5.19: PWA
  setupPWAInstall();   // v5.19: beforeinstallprompt
  startRealtimeCounters(); // v5.19: 即時計數器（每秒更新）
  if (location.hash.includes('tree=')) loadFromHash();
  // v5.19 dev: hash 直接打開對應 modal（截圖 / 深連結用）
  if (location.hash === '#feedback') setTimeout(renderFeedbackModal, 200);
  if (location.hash === '#changelog') setTimeout(renderChangelogModal, 200);
  if (location.hash === '#privacy') setTimeout(renderPrivacyModal, 200);
  if (location.hash === '#terms') setTimeout(renderTermsModal, 200);
}
init();

/* =====================================================================
   v5.19 新增：footer + 工具列（feedback / changelog / privacy / terms /
   contact / PWA install）+ 教學版模式 + 版本歷史
   ===================================================================== */

const APP_VERSION = '5.19.0';
const APP_BUILD = '2026-10-18';

// 版本歷史（每個版本：v / date / items；每個 item 含 emoji badge + 文字）
// 為節省空間與維護成本，所有語言文字都用 i18n key；徽章 emoji 是視覺標記。
const CHANGELOG = [
  { v: '5.19', date: '2026-10-18', items: [
      { tag: 'new',    icon: '📲', key: 'cl.5.19.pwa' },
      { tag: 'new',    icon: '🎓', key: 'cl.5.19.edu' },
      { tag: 'feat',   icon: '💌', key: 'cl.5.19.feedback' },
      { tag: 'feat',   icon: '📜', key: 'cl.5.19.changelog' },
      { tag: 'feat',   icon: '🔒', key: 'cl.5.19.privacy' },
    ] },
  { v: '5.18', date: '2026-10-15', items: [
      { tag: 'feat',   icon: '🗺️', key: 'cl.5.18.map' },
      { tag: 'feat',   icon: '🛂', key: 'cl.5.18.passport' },
    ] },
  { v: '5.17', date: '2026-10-10', items: [
      { tag: 'fix',    icon: '🐛', key: 'cl.5.17.bugfix' },
      { tag: 'style',  icon: '🎨', key: 'cl.5.17.style' },
    ] },
  { v: '5.16', date: '2026-10-05', items: [
      { tag: 'feat',   icon: '🎯', key: 'cl.5.16.manual' },
      { tag: 'fix',    icon: '⚙️', key: 'cl.5.16.focus' },
    ] },
  { v: '5.15', date: '2026-09-28', items: [
      { tag: 'feat',   icon: '📈', key: 'cl.5.15.trajectory' },
    ] },
  { v: '5.14', date: '2026-09-20', items: [
      { tag: 'feat',   icon: '🎲', key: 'cl.5.14.events' },
      { tag: 'feat',   icon: '🛡️', key: 'cl.5.14.protect' },
    ] },
  { v: '5.13', date: '2026-09-10', items: [
      { tag: 'feat',   icon: '⏱️', key: 'cl.5.13.tick' },
      { tag: 'feat',   icon: '🎯', key: 'cl.5.13.focus' },
      { tag: 'feat',   icon: '💰', key: 'cl.5.13.finance' },
    ] },
  { v: '5.12', date: '2026-08-25', items: [
      { tag: 'feat',   icon: '📤', key: 'cl.5.12.share' },
    ] },
  { v: '5.11', date: '2026-08-12', items: [
      { tag: 'feat',   icon: '📉', key: 'cl.5.11.survival' },
    ] },
  { v: '5.10', date: '2026-07-30', items: [
      { tag: 'feat',   icon: '✎', key: 'cl.5.10.thoughts' },
    ] },
  { v: '5.9',  date: '2026-07-15', items: [
      { tag: 'feat',   icon: '⏭', key: 'cl.5.9.auto' },
      { tag: 'feat',   icon: '⏩', key: 'cl.5.9.skip' },
    ] },
  { v: '5.8',  date: '2026-07-01', items: [
      { tag: 'new',    icon: '⚖️', key: 'cl.5.8.status' },
      { tag: 'new',    icon: '💵', key: 'cl.5.8.assets' },
      { tag: 'new',    icon: '👨‍👩‍👧', key: 'cl.5.8.family' },
      { tag: 'new',    icon: '👥', key: 'cl.5.8.companions' },
    ] },
  { v: '5.7',  date: '2026-06-15', items: [
      { tag: 'feat',   icon: '🌳', key: 'cl.5.7.tree' },
      { tag: 'feat',   icon: '📚', key: 'cl.5.7.shelf' },
    ] },
  { v: '5.6',  date: '2026-06-01', items: [
      { tag: 'feat',   icon: '🧪', key: 'cl.5.6.lab' },
    ] },
  { v: '5.5',  date: '2026-05-20', items: [
      { tag: 'style',  icon: '🌐', key: 'cl.5.5.i18n' },
    ] },
  { v: '5.0',  date: '2026-05-01', items: [
      { tag: 'new',    icon: '🚀', key: 'cl.5.0.engine' },
    ] },
  { v: '4.x',  date: '2026-03-15', items: [
      { tag: 'feat',   icon: '🌏', key: 'cl.4.country' },
    ] },
  { v: '3.x',  date: '2026-01-20', items: [
      { tag: 'feat',   icon: '🎭', key: 'cl.3.character' },
    ] },
  { v: '2.x',  date: '2025-11-10', items: [
      { tag: 'feat',   icon: '🧬', key: 'cl.2.stats' },
    ] },
  { v: '1.0',  date: '2025-10-01', items: [
      { tag: 'new',    icon: '👶', key: 'cl.1.first' },
    ] },
];

// ==== 教學版模式 (?edu=1) ====
function checkEduMode() {
  const params = new URLSearchParams(location.search);
  STATE.eduMode = params.get('edu') === '1';
  // v5.39：略過可怕的情節 — 從 localStorage 還原；教學版一律開啟
  STATE.softMode = STATE.eduMode || localStorage.getItem(STORAGE_KEY + ':soft') === '1';
  if (STATE.softMode) localStorage.setItem(STORAGE_KEY + ':soft', '1');
  if (STATE.eduMode) {
    document.documentElement.classList.add('edu-mode');
    // 預設自動抉擇
    STATE.autoDecide = true;
    // 隱藏訃聞 + 書架 tab（書架 = 追思館）
    $$('.navbtn[data-view="end"]').forEach(el => el.hidden = true);
    $$('.navbtn[data-view="shelf"]').forEach(el => el.hidden = true);
    // 顯示教學版 badge
    const badge = $('#eduBadge');
    if (badge) badge.hidden = false;
    // 文案提示
    const sub = $('#introCountryInfoSub');
    // 不要覆蓋既有 intro.sub，避免破壞既有 i18n
  }
}

// ==== Footer 注入 ====
function injectFooter() {
  const f = $('#appFooter');
  if (!f) return;
  f.hidden = false;
  // 綁定事件
  $('#btnFeedback')?.addEventListener('click', renderFeedbackModal);
  $('#btnChangelog')?.addEventListener('click', renderChangelogModal);
  $('#btnPrivacy')?.addEventListener('click', e => { e.preventDefault(); renderPrivacyModal(); });
  $('#btnTerms')?.addEventListener('click', e => { e.preventDefault(); renderTermsModal(); });
  // contact 是 mailto，預設瀏覽器處理
  // install 按鈕在 setupPWAInstall() 處理
  // 套翻譯
  $$('#appFooter [data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
}

// ==== Feedback modal ====
const FEEDBACK_MAX = 500;
function renderFeedbackModal() {
  document.querySelector('#feedbackModal')?.remove();
  const isEn = LANG === 'en';
  const html = `
    <div id="feedbackModal" class="life-modal">
      <div class="life-modal-card">
        <button class="lm-close" onclick="document.getElementById('feedbackModal').remove()">×</button>
        <h2 class="lm-title">💌 ${t('feedback.title')}</h2>
        <p class="modal-help">${t('feedback.help')}</p>
        <textarea id="feedbackInput" class="feedback-textarea" maxlength="${FEEDBACK_MAX}" placeholder="${t('feedback.placeholder')}"></textarea>
        <div class="feedback-meta">
          <span>${t('feedback.local')}</span>
          <span id="feedbackCount">0 / ${FEEDBACK_MAX}</span>
        </div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="ghost" onclick="document.getElementById('feedbackModal').remove()">${t('feedback.cancel')}</button>
          <button class="primary" id="feedbackSend">${t('feedback.send')}</button>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = $('#feedbackModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  const input = $('#feedbackInput');
  const count = $('#feedbackCount');
  input.addEventListener('input', () => {
    const len = input.value.length;
    count.textContent = `${len} / ${FEEDBACK_MAX}`;
    count.classList.toggle('over', len >= FEEDBACK_MAX);
  });
  $('#feedbackSend').addEventListener('click', () => {
    const text = (input.value || '').trim().slice(0, FEEDBACK_MAX);
    if (!text) {
      toast(t('feedback.empty'));
      return;
    }
    try {
      const KEY = STORAGE_KEY + ':feedback';
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      list.push({ ts: Date.now(), lang: LANG, v: APP_VERSION, text });
      // 只保留最近 50 則
      while (list.length > 50) list.shift();
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) { /* localStorage 滿了就靜默忽略 */ }
    modal.remove();
    toast(t('feedback.thanks'));
  });
}

// ==== Changelog modal ====
function renderChangelogModal() {
  document.querySelector('#changelogModal')?.remove();
  const items = CHANGELOG.map(entry => `
    <div class="changelog-entry">
      <div>
        <span class="changelog-ver">v${escapeHtml(entry.v)}</span>
        <span class="changelog-date">${escapeHtml(entry.date)}</span>
      </div>
      <ul class="changelog-items">
        ${entry.items.map(it => `
          <li>
            <span class="cl-badge cl-badge-${it.tag}">${escapeHtml(t('cl.tag.' + it.tag))}</span>
            <span>${it.icon}</span>
            <span>${escapeHtml(t(it.key))}</span>
          </li>`).join('')}
      </ul>
    </div>`).join('');
  const html = `
    <div id="changelogModal" class="life-modal">
      <div class="life-modal-card life-modal-wide">
        <button class="lm-close" onclick="document.getElementById('changelogModal').remove()">×</button>
        <h2 class="lm-title">📜 ${t('changelog.title')} <span class="muted" style="font-size:13px;font-weight:400;margin-left:6px;">v${APP_VERSION} · ${APP_BUILD}</span></h2>
        <p class="modal-help">${t('changelog.intro')}</p>
        <div class="changelog-list">${items}</div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="primary" onclick="document.getElementById('changelogModal').remove()">${t('changelog.close')}</button>
        </div>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  const modal = $('#changelogModal');
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ==== Privacy modal ====
function renderPrivacyModal() {
  showLegalModal('privacyModal', '🔒 ' + t('privacy.title'), `
    <p>${t('privacy.p1')}</p>
    <p>${t('privacy.p2')}</p>
    <ul>
      <li>${t('privacy.p3')}</li>
      <li>${t('privacy.p4')}</li>
      <li>${t('privacy.p5')}</li>
    </ul>
    <p class="legal-helpline"><strong>${t('privacy.licenseTitle')}</strong><br/>${t('privacy.license')}</p>
  `);
}

// ==== Terms modal ====
function renderTermsModal() {
  showLegalModal('termsModal', '📋 ' + t('terms.title'), `
    <p>${t('terms.p1')}</p>
    <p>${t('terms.p2')}</p>
    <ul>
      <li>${t('terms.p3')}</li>
      <li>${t('terms.p4')}</li>
    </ul>
    <p>${t('terms.p5')}</p>
    <p class="legal-helpline">${t('terms.helpline')}</p>
  `);
}

function showLegalModal(id, title, html) {
  document.querySelector('#' + id)?.remove();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="${id}" class="life-modal">
      <div class="life-modal-card">
        <button class="lm-close" onclick="document.getElementById('${id}').remove()">×</button>
        <h2 class="lm-title">${title}</h2>
        <div class="legal-body">${html}</div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="primary" onclick="document.getElementById('${id}').remove()">${t('changelog.close')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const modal = document.querySelector('#' + id);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* v5.39：略過可怕的情節 — 按鈕狀態同步（topbar + intro 兩處） */
function renderSoftModeBtn() {
  const on = STATE.softMode;
  ['#btnSoftMode', '#softBtnIntro'].forEach(sel => {
    const b = $(sel);
    if (!b) return;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('active', on);
    // v5.82：intro 那顆以前沒有 tooltip（只有 topbar 有），順手補上並走 i18n
    b.title = t(on ? 'soft.on' : 'soft.off');
  });
}

/* v5.50：切換「略過可怕的情節」的共用邏輯（topbar / intro 兩處呼叫） */
function toggleSoftMode() {
  STATE.softMode = !STATE.softMode;
  localStorage.setItem(STORAGE_KEY + ':soft', STATE.softMode ? '1' : '0');
  renderSoftModeBtn();
  renderAll();
  toast(STATE.softMode
    ? (LANG === 'en' ? 'Heavy events are hidden' : '已略過可怕的情節')
    : (LANG === 'en' ? 'Heavy events are shown' : '會顯示全部情節'));
}

// ==== Service Worker 註冊（PWA 離線快取）====
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 開發/檔案模式跳過（sw.js 需 HTTP 協議）
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    // 監聽更新
    reg.addEventListener('updatefound', () => {
      const ni = reg.installing;
      if (!ni) return;
      ni.addEventListener('statechange', () => {
        if (ni.state === 'activated' && navigator.serviceWorker.controller) {
          // 新 SW 已接管
        }
      });
    });
  }).catch(() => { /* 靜默失敗，不影響主程式 */ });
}

// ==== PWA 安裝提示（beforeinstallprompt） ====
let pwaDeferredPrompt = null;
function setupPWAInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    pwaDeferredPrompt = e;
    // 顯示 footer 的安裝按鈕
    const btn = $('#btnInstall');
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', promptPWAInstall, { once: true });
    }
    // 在 help-fab 上加 pulse 提示
    document.querySelector('.help-fab')?.classList.add('install-ready');
  });
  window.addEventListener('appinstalled', () => {
    pwaDeferredPrompt = null;
    const btn = $('#btnInstall');
    if (btn) { btn.hidden = true; }
    document.querySelector('.help-fab')?.classList.remove('install-ready');
    toast(t('install.installed'));
  });
}
async function promptPWAInstall() {
  if (!pwaDeferredPrompt) {
    showInstallHelp();
    return;
  }
  try {
    pwaDeferredPrompt.prompt();
    const choice = await pwaDeferredPrompt.userChoice;
    pwaDeferredPrompt = null;
    if (choice?.outcome === 'accepted') {
      // appinstalled 會處理
    } else {
      const btn = $('#btnInstall');
      if (btn) btn.addEventListener('click', promptPWAInstall, { once: true });
    }
  } catch (e) {
    showInstallHelp();
  }
}
function showInstallHelp() {
  const btn = $('#btnInstall');
  if (btn) btn.hidden = true;
  showLegalModal('installHelp', '📲 ' + t('install.title'), `
    <p>${t('install.text')}</p>
    <div class="install-card">
      <span class="install-emoji">📲</span>
      <div>
        <div><strong>${t('install.androidHint')}</strong></div>
        <div class="install-hint">${t('install.androidStep')}</div>
      </div>
    </div>
    <div class="install-card">
      <span class="install-emoji">🍎</span>
      <div>
        <div><strong>${t('install.iosHint')}</strong></div>
        <div class="install-hint">${t('install.iosStep')}</div>
      </div>
    </div>
    <p class="install-hint" style="margin-top:10px;">${t('install.unavailable')}</p>
  `);
}

function injectHelpFab() {
  if (document.querySelector('.help-fab')) return;
  const btn = document.createElement('button');
  btn.className = 'help-fab';
  btn.title = LANG === 'en' ? 'Keyboard shortcuts (?)' : '鍵盤快捷鍵 (?)';
  btn.textContent = '?';
  btn.addEventListener('click', showShortcutsModal);
  document.body.appendChild(btn);
}

/* =====================================================================
   族譜模組 (zu-pu 移植)：以目前人生為中心，產生祖上/子孫 SVG 樹
   ===================================================================== */
const TREE_STATE = { rootId: null, mode: 'ancestor', depth: 3 };

function treePeopleGraph() {
  if (!STATE.life || !STATE.life.family) return { people: {}, edges: [] };
  const f = STATE.life.family;
  const selfCaste = STATE.life.country === 'IND' ? STATE.life.name.caste : null;
  const self = {
    id: 'self',
    name: STATE.life.name.full || STATE.life.name.full_en || 'You',
    nameEn: STATE.life.name.full_en || '',
    sex: STATE.life.sex,
    country: STATE.life.country,
    countryData: STATE.life.countryData,
    birthOrigin: STATE.life.birthOrigin,
    birth: { year: STATE.life.year + STATE.life.yearOffset - STATE.life.age },
    death: STATE.life.died ? { year: (STATE.life.year + STATE.life.yearOffset - STATE.life.age) + STATE.life.deathAge } : null,
    family: selfCaste
  };
  const people = { [self.id]: self };
  // v5.71：這些陣欄位未必都存在（重開舊人生時 JSON 可能是舊格式），一律補上預設值。
  // 原本只有 grandparents / kids 有 || []，parents / siblings 沒有，
  // 讀到舊人生會直接 forEach undefined 而整個族譜頁崩掉。
  const parents = f.parents || [];
  const siblings = f.siblings || [];
  parents.forEach(p => { 
    if (selfCaste && p.country === 'IND' && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  siblings.forEach(p => { 
    if (selfCaste && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  (f.grandparents||[]).forEach(p => { 
    if (selfCaste && p.country === 'IND' && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  if (f.partner) people[f.partner.id] = f.partner;
  (f.kids || []).forEach(p => { 
    if (selfCaste && !p.family) p.family = selfCaste;
    people[p.id] = p; 
  });
  const edges = [];
  if (parents[0]) edges.push({ parentId: parents[0].id, childId: 'self', kind: 'parent' });
  if (parents[1]) edges.push({ parentId: parents[1].id, childId: 'self', kind: 'parent' });
  siblings.forEach(s => {
    if (parents[0]) edges.push({ parentId: parents[0].id, childId: s.id, kind: 'parent' });
    if (parents[1]) edges.push({ parentId: parents[1].id, childId: s.id, kind: 'parent' });
  });
  (f.grandparents||[]).forEach(gp => {
    const par = parents.find(p => p.sex === gp.sex && Math.abs((p.birth?.year||0) - (gp.birth?.year||0)) < 35);
    if (par) edges.push({ parentId: gp.id, childId: par.id, kind: 'parent' });
  });
  if (f.partner) edges.push({ parentId: 'self', childId: f.partner.id, kind: 'spouse' });
  (f.kids || []).forEach(k => {
    edges.push({ parentId: 'self', childId: k.id, kind: 'parent' });
    if (f.partner) edges.push({ parentId: f.partner.id, childId: k.id, kind: 'parent' });
  });
  return { people, edges };
}

function renderTree() {
  const canvas = $('#treeCanvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  if (!STATE.life) {
    canvas.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">${t('intro.cta.hint')}</div>`;
    return;
  }
  const { people, edges } = treePeopleGraph();
  const ids = Object.keys(people);
  if (!ids.length) {
    canvas.innerHTML = `<div class="muted" style="padding:24px;text-align:center;">—</div>`;
    return;
  }
  // root 預設：self
  let rootId = TREE_STATE.rootId || 'self';
  if (!people[rootId]) rootId = 'self';
  TREE_STATE.rootId = rootId;
  // 同步選單
  const sel = $('#treeRoot');
  if (sel && sel.children.length !== ids.length) {
    sel.innerHTML = '';
    for (const id of ids) {
      const p = people[id];
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${p.name}${p.birth?.year ? ' ('+p.birth.year+')' : ''}${id==='self'?' · '+t('label.center',''):''}`;
      if (id === rootId) opt.selected = true;
      sel.appendChild(opt);
    }
  } else if (sel) {
    // 語言切換後重畫 option 文字
    Array.from(sel.options).forEach((opt) => {
      const id = opt.value;
      const p = people[id];
      if (!p) return;
      opt.textContent = `${p.name}${p.birth?.year ? ' ('+p.birth.year+')' : ''}${id==='self'?' · '+t('label.center',''):''}`;
    });
    sel.value = rootId;
  }

  const mode = TREE_STATE.mode;
  const depth = +TREE_STATE.depth;
  if (mode === 'ancestor') renderAncestorTree(canvas, rootId, depth, people, edges);
  else if (mode === 'descendant') renderDescendantTree(canvas, rootId, depth, people, edges);
  else renderBothTree(canvas, rootId, depth, people, edges);
}

function getAncestorLayout(rootId, maxGen, people, edges) {
  const nodes = [];
  const links = [];
  function recurse(id, gen, xSlot) {
    if (!id || !people[id]) return;
    if (gen > maxGen) return;
    if (nodes.find(n => n.id === id)) return;
    nodes.push({ id, gen, xSlot });
    if (gen < maxGen) {
      const parents = edges.filter(e => e.childId === id).map(e => e.parentId);
      const slotW = Math.pow(2, maxGen - gen - 1);
      recurse(parents[0], gen + 1, xSlot);
      if (parents[1]) recurse(parents[1], gen + 1, xSlot + slotW);
      else recurse(parents[0], gen + 1, xSlot);
      const slotW2 = Math.pow(2, maxGen - gen - 1);
      if (parents[0]) links.push({ from: { gen: gen+1, xSlot }, to: { gen, xSlot } });
      if (parents[1]) links.push({ from: { gen: gen+1, xSlot: xSlot + slotW2 }, to: { gen, xSlot } });
    }
  }
  recurse(rootId, 0, Math.pow(2, maxGen) / 2 - 0.5);
  return { nodes, links, totalSlots: Math.pow(2, maxGen) };
}

function renderAncestorTree(canvas, rootId, maxGen, people, edges) {
  const layout = getAncestorLayout(rootId, maxGen, people, edges);
  const slotW = 220, rowH = 130, marginX = 30, marginY = 30;
  const w = marginX * 2 + layout.totalSlots * slotW;
  const h = marginY * 2 + (maxGen + 1) * rowH;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const { from, to } of layout.links) {
    const fn = layout.nodes.find(n => n.xSlot === from.xSlot && n.gen === from.gen);
    const tn = layout.nodes.find(n => n.xSlot === to.xSlot && n.gen === to.gen);
    if (!fn || !tn) continue;
    const fx = marginX + fn.xSlot * slotW + slotW/2;
    const fy = marginY + fn.gen * rowH + 40;
    const tx = marginX + tn.xSlot * slotW + slotW/2;
    const ty = marginY + tn.gen * rowH + 90;
    svgEl('path', { d: `M ${fx} ${fy} L ${fx} ${fy + (ty-fy)/2} L ${tx} ${fy + (ty-fy)/2} L ${tx} ${ty}`, class: 'tree-link' }, svg);
  }
  // 伴侶邊（水平虛線）— 在 self 同層右側
  const spouseEdges = edges.filter(e => e.kind === 'spouse');
  for (const e of spouseEdges) {
    const a = layout.nodes.find(n => n.id === e.parentId);
    const b = layout.nodes.find(n => n.id === e.childId);
    if (!a || !b) continue;
    const ax = marginX + a.xSlot * slotW + slotW - 12;
    const ay = marginY + a.gen * rowH + 40;
    const bx = marginX + b.xSlot * slotW;
    const by = marginY + b.gen * rowH + 40;
    svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: '#0F6E68', 'stroke-width': 2, 'stroke-dasharray': '6 4' }, svg);
    svgEl('circle', { cx: (ax+bx)/2, cy: (ay+by)/2, r: 4, fill: '#0F6E68' }, svg);
  }
  for (const n of layout.nodes) {
    drawPersonNode(svg, people[n.id], marginX + n.xSlot * slotW, marginY + n.gen * rowH, slotW - 12, 80, n.id === TREE_STATE.rootId);
  }
  canvas.appendChild(svg);
}

function renderDescendantTree(canvas, rootId, maxGen, people, edges) {
  const nodes = [{ id: rootId, gen: 0 }];
  const subEdges = [];
  function recurse(id, gen) {
    if (gen >= maxGen) return;
    const kids = edges.filter(e => e.parentId === id).map(e => e.childId);
    for (const k of kids) {
      nodes.push({ id: k, gen: gen + 1 });
      subEdges.push({ parentId: id, childId: k });
      recurse(k, gen + 1);
    }
  }
  recurse(rootId, 0);
  const genCounts = [];
  for (let g = 0; g <= maxGen; g++) genCounts.push(nodes.filter(n => n.gen === g).length);
  const maxInGen = Math.max(...genCounts, 1);
  const slotW = 240, rowH = 130, marginX = 30, marginY = 30;
  const totalW = marginX * 2 + maxInGen * slotW;
  const totalH = marginX * 2 + (maxGen + 1) * rowH;
  const genOffsets = genCounts.map(c => (maxInGen - c) * slotW / 2);
  const nodePos = {};
  for (let g = 0; g <= maxGen; g++) {
    nodes.filter(n => n.gen === g).forEach((n, i) => {
      nodePos[n.id] = { x: marginX + genOffsets[g] + i * slotW, y: marginY + g * rowH };
    });
  }
  const svg = svgEl('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`, preserveAspectRatio: 'xMidYMid meet', style:'max-width:100%;height:auto;' });
  for (const e of subEdges) {
    const a = nodePos[e.parentId], b = nodePos[e.childId];
    if (!a || !b) continue;
    svgEl('path', { d: `M ${a.x + slotW/2} ${a.y + 80} L ${a.x + slotW/2} ${a.y + (b.y-a.y)/2} L ${b.x + slotW/2} ${a.y + (b.y-a.y)/2} L ${b.x + slotW/2} ${b.y}`, class: 'tree-link' }, svg);
  }
  for (const n of nodes) drawPersonNode(svg, people[n.id], nodePos[n.id].x, nodePos[n.id].y, slotW - 12, 80, n.id === TREE_STATE.rootId);
  canvas.appendChild(svg);
}

function renderBothTree(canvas, rootId, maxGen, people, edges) {
  renderAncestorTree(canvas, rootId, Math.max(1, Math.floor(maxGen/2)), people, edges);
}

function drawPersonNode(svg, p, x, y, w, h, selected) {
  const g = svgEl('g', { class: 'tree-node' + (selected ? ' selected' : ''), transform: `translate(${x}, ${y})` }, svg);
  const genderColor = p.sex === 'M' ? '#4a6da8' : p.sex === 'F' ? '#b86998' : '#c2b693';
  const deceased = !!(p.death && p.death.year);
  const dash = deceased ? '4 5' : '';
  const op = deceased ? 0.6 : 1;
  svgEl('rect', { class: 'node-rect ' + (p.sex === 'M' ? 'node-m' : p.sex === 'F' ? 'node-f' : 'node-u'),
    x: 0, y: 0, width: w, height: h, rx: 8, ry: 8,
    fill: '#faf7f0', stroke: genderColor, 'stroke-width': selected ? 2.5 : 1.5, 'stroke-dasharray': dash, opacity: op }, g);
  // 點擊開 detail panel
  g.style.cursor = 'pointer';
  g.addEventListener('click', () => {
    TREE_STATE.selectedId = p.id;
    showPersonDetail(p);
  });
  // head
  const portrait = svgEl('svg', { x: 6, y: 4, width: 56, height: 70, viewBox: '0 0 200 200' }, g);
  portrait.innerHTML = pixelPortraitSVG(p.countryData, computeAge(p), p.sex).match(/<svg[^>]*>(.*)<\/svg>/)?.[1] || '';
  // name
  const nameY = 22;
  const nameEl = svgEl('text', { class: 'node-name', x: 70, y: nameY, 'font-size': 14, 'font-weight': 500, fill: '#1a1a1a' }, g);
  nameEl.textContent = p.name || '?';
  if (p.nameEn && p.nameEn !== p.name) {
    const ne = svgEl('text', { class: 'node-en', x: 70, y: nameY + 14, 'font-size': 10, fill: '#7a7a7a' }, g);
    ne.textContent = p.nameEn;
  }
  const lifeText = p.birth?.year ? `${p.birth.year || '?'} – ${p.death?.year || ''}` : '';
  if (lifeText) {
    const lt = svgEl('text', { class: 'node-life', x: 70, y: h - 8, 'font-size': 10, fill: '#7a7a7a' }, g);
    lt.textContent = lifeText;
  }
  if (deceased) {
    const c = svgEl('text', { x: w - 12, y: 16, 'font-size': 14, fill: '#a04040', 'text-anchor': 'end' }, g);
    c.textContent = '†';
  }
  if (p.note === 'adoptive') {
    const m = svgEl('text', { x: w - 14, y: h - 4, 'font-size': 11, fill: '#0F6E68', 'text-anchor': 'end' }, g);
    m.textContent = '🧩';
  } else if (p.note === 'foster') {
    const m = svgEl('text', { x: w - 14, y: h - 4, 'font-size': 11, fill: '#8C1D3C', 'text-anchor': 'end' }, g);
    m.textContent = '🏠';
  }
  // 跨國遷徙：顯示原國旗
  if (p.birthOrigin) {
    const ob = svgEl('text', { x: 4, y: 14, 'font-size': 12 }, g);
    ob.textContent = p.birthOrigin.flag + '→';
    ob.setAttribute('fill', '#a04040');
    const c = svgEl('text', { x: 32, y: 14, 'font-size': 12 }, g);
    c.textContent = (p.countryData?.flag || '🏳️');
  }
  // 印度種姓標記（依 p.family 或 self.country='IND' + 隨機 caste）
  if (p.family || p._caste) {
    const caste = p.family || p._caste;
    const cw = svgEl('rect', { class: 'caste-marker caste-' + caste, x: 70, y: h - 22, width: 50, height: 12, rx: 3 }, g);
    const ct = svgEl('text', { x: 95, y: h - 12, 'font-size': 9, fill: 'white', 'text-anchor': 'middle', 'font-weight': 600 }, g);
    ct.textContent = t('tree.caste.' + caste);
  }
}

/* ==== 生命交叉事件計算 ==== */
function computeCrossLifeEvents(p) {
  if (!STATE.life || p.id === 'self') return [];
  const self = STATE.life;
  const events = [];
  const selfBirthYear = self.year + self.yearOffset - self.age;
  const selfAgeAt = (year) => Math.max(0, year - selfBirthYear);
  // 他出生時我幾歲
  if (p.birth?.year) {
    const myAge = selfAgeAt(p.birth.year);
    const sexTerm = LANG === 'en' ? (p.sex === 'M' ? 'your brother/brother-in-law' : 'your sister/sister-in-law')
                  : (p.sex === 'M' ? '兄弟/手足' : '姊妹/手足');
    events.push({
      icon: '👶',
      text: LANG === 'en' ? `${p.name} was born when you were ${myAge}.` : `${p.name}出生時，你 ${myAge} 歲。`
    });
  }
  // 他去世時我幾歲
  if (p.death?.year) {
    const myAge = selfAgeAt(p.death.year);
    if (myAge >= 0 && myAge <= self.age) {
      if (!STATE.eduMode && !STATE.softMode) {
        events.push({
          icon: '🕯️',
          text: LANG === 'en' ? `${p.name} passed away when you were ${myAge}.` : `${p.name} 過世時，你 ${myAge} 歲。`,
          kind: 'heavy'
        });
      }
    } else if (myAge > self.age) {
      events.push({
        icon: '🕯️',
        text: LANG === 'en' ? `${p.name} would have been ${p.death.year - selfBirthYear} years older than you.` : `${p.name} 將在你 ${myAge} 歲時離世（在你身後）。`,
        kind: 'forecast'
      });
    }
  }
  // 他出生時自己幾歲（年齡差）
  if (p.birth?.year && selfBirthYear) {
    const diff = p.birth.year - selfBirthYear;
    if (diff > 0 && diff < 30 && p.id !== 'self') {
      const role = p.sex === 'M' ? (LANG === 'en' ? 'elder brother' : '兄長') : (LANG === 'en' ? 'elder sister' : '姊姊');
      events.push({
        icon: '👫',
        text: LANG === 'en' ? `${p.name} is ${diff} years older than you (${role}).` : `${p.name} 比你大 ${diff} 歲（${role}）。`
      });
    } else if (diff < 0 && diff > -30) {
      const role = p.sex === 'M' ? (LANG === 'en' ? 'younger brother' : '弟弟') : (LANG === 'en' ? 'younger sister' : '妹妹');
      events.push({
        icon: '👫',
        text: LANG === 'en' ? `${p.name} is ${-diff} years younger than you (${role}).` : `${p.name} 比你小 ${-diff} 歲（${role}）。`
      });
    }
  }
  return events;
}

function showPersonDetail(p) {
  let panel = $('#personDetail');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'personDetail';
    panel.className = 'person-detail';
    document.querySelector('.tree-canvas')?.parentNode.insertBefore(panel, document.querySelector('#treeCanvas').nextSibling);
  }
  const age = computeAge(p);
  const rel = relationLabel(p);
  const crossEvents = computeCrossLifeEvents(p);
  // self 的事件（從 STATE.life.log 摘要）
  let ownEventsHtml = '';
  if (p.id === 'self' && STATE.life && STATE.life.log) {
    const recent = STATE.life.log.filter(e => e.kind !== 'log').slice(-8);
    ownEventsHtml = recent.length ? `<div class="pd-cross"><h4>${LANG==='en'?'Life milestones':'生命里程碑'}</h4>${recent.map(e => `<div class="pd-cross-row"><span class="pd-cross-icon">${e.icon||'·'}</span><span>${escapeHtml(e.text)}</span></div>`).join('')}</div>` : '';
  }
  panel.innerHTML = `
    <div class="pd-head">
      <div class="pd-portrait">${pixelPortraitSVG(p.countryData, age, p.sex)}</div>
      <div class="pd-meta">
        <h3 class="pd-name">${escapeHtml(p.name || '?')} ${deceasedMark(p)}</h3>
        <div class="pd-relation"><span class="badge">${rel}</span> ${p.note === 'adoptive' ? `<span class="badge badge-adopt">🧩 ${t('tree.noteAdoptive')}</span>` : p.note === 'foster' ? `<span class="badge badge-foster">🏠 ${t('tree.noteFoster')}</span>` : ''}</div>
        <div class="pd-life">${p.birth?.year || '?'} – ${p.death?.year || t('legend.m')}</div>
        <div class="pd-country">${p.countryData?.flag || ''} ${p.country || ''}${p.birthOrigin ? ' <span class="fam-flag">' + p.birthOrigin.flag + '→</span>' : ''}</div>
      </div>
      <button class="pd-close" onclick="document.getElementById('personDetail').remove()">×</button>
    </div>
    ${ownEventsHtml}
    ${crossEvents.length ? `<div class="pd-cross"><h4>${t('person.cross')}</h4>${crossEvents.map(e => `<div class="pd-cross-row kind-${e.kind||''}"><span class="pd-cross-icon">${e.icon}</span><span>${escapeHtml(e.text)}</span></div>`).join('')}</div>` : ''}
  `;
  // 高亮選中
  document.querySelectorAll('.tree-node').forEach(n => n.classList.remove('selected'));
  document.querySelectorAll('.tree-node').forEach(n => {
    if (n.querySelector('.node-name')?.textContent === (p.name || '?')) n.classList.add('selected');
  });
}

function relationLabel(p) {
  if (!STATE.life || !STATE.life.family) return '';
  const f = STATE.life.family;
  if (f.parents && f.parents.includes(p)) return t('relation.' + (p.sex === 'M' ? 'father' : 'mother'));
  if (f.siblings && f.siblings.includes(p)) {
    const diff = (p.birth?.year || 0) - (STATE.life.year + STATE.life.yearOffset - STATE.life.age);
    if (diff > 0) return t('relation.' + (p.sex === 'M' ? 'uncle' : 'aunt'));
    return t('relation.' + (p.sex === 'M' ? 'sibling' : 'sibling'));
  }
  if (f.grandparents && f.grandparents.includes(p)) return t('relation.' + (p.sex === 'M' ? 'grandfather' : 'grandmother'));
  if (f.partner === p) return t('relation.' + (p.sex === 'M' ? 'spouse' : 'spouse.f'));
  if (f.kids && f.kids.includes(p)) return t('relation.' + (p.sex === 'M' ? 'child' : 'child.f'));
  return '';
}

function deceasedMark(p) {
  return (p.death && p.death.year) ? '<span class="pd-deceased">†</span>' : '';
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function highlightTreeSearch(query) {
  const q = (query || '').trim().toLowerCase();
  const all = document.querySelectorAll('#treeCanvas .tree-node');
  let hits = 0;
  all.forEach(node => {
    const name = node.querySelector('.node-name')?.textContent || '';
    const en = node.querySelector('.node-en')?.textContent || '';
    const match = q && (name.toLowerCase().includes(q) || en.toLowerCase().includes(q));
    const rect = node.querySelector('.node-rect');
    if (rect) {
      if (match) {
        rect.setAttribute('stroke', '#ff8800');
        rect.setAttribute('stroke-width', '3');
        hits++;
      } else {
        rect.setAttribute('stroke', rect.getAttribute('data-orig-stroke') || rect.getAttribute('stroke'));
        rect.setAttribute('stroke-width', '1.5');
      }
    }
  });
  const hint = $('#treeSearchHint');
  if (hint) hint.textContent = q ? (LANG==='en' ? `${hits} matches` : `${hits} 個符合`) : '';
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) {
    if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      const v = attrs[k];
      if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    }
  }
  if (parent) parent.appendChild(el);
  return el;
}

function computeAge(p) {
  const by = p.birth?.year || 1990;
  const ey = p.death?.year || 2024;
  return Math.max(0, ey - by);
}

/* ==== GEDCOM 5.5.1 簡易版（只匯出） ==== */
function exportGEDCOM() {
  const { people, edges } = treePeopleGraph();
  // 轉成 zu-pu/gedcom.js 的 DB 格式
  const DB = { _meta: { title: '族譜 · ' + (STATE.life?.name?.full || 'born-somewhere') }, people: {} };
  for (const id of Object.keys(people)) {
    const p = people[id];
    DB.people[id] = {
      id,
      name: p.name || '',
      nameEn: p.nameEn || '',
      gender: p.sex || 'U',
      birth: p.birth ? { year: p.birth.year, month: p.birth.month, day: p.birth.day } : null,
      death: p.death ? { year: p.death.year } : null,
      birthPlace: p.country || '',
      deathPlace: '',
      notes: id === 'self' ? '@self@' : (p.note || ''),
      parents: edges.filter(e => e.childId === id && e.kind !== 'spouse').map(e => e.parentId),
      spouses: edges.filter(e => (e.childId === id || e.parentId === id) && e.kind === 'spouse').map(e => e.parentId === id ? e.childId : e.parentId)
    };
  }
  const ged = window.Gedcom.export(DB);
  const blob = new Blob([ged], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `born-somewhere-${Date.now()}.ged`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('io.exported', Object.keys(people).length));
}

/* ==== 生命證書下載為 PNG ==== */
function downloadLifeCertPNG() {
  if (!STATE.life) { toast(LANG==='en' ? 'No life' : '沒有當前人生'); return; }
  const life = STATE.life;
  const c = life.countryData;
  const loc = c ? localize(c) : { name: life.country };
  const W = 700, H = 480;
  const svgParts = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  // 背景紙質
  svgParts.push(`<rect width="${W}" height="${H}" fill="#faf7f0"/>`);
  // 邊框
  svgParts.push(`<rect x="6" y="6" width="${W-12}" height="${H-12}" fill="none" stroke="#8C1D3C" stroke-width="2" rx="8"/>`);
  svgParts.push(`<rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#0F6E68" stroke-width="1" rx="6"/>`);
  // guilloche 簡化紋路
  for (let r = 30; r < W; r += 28) {
    svgParts.push(`<ellipse cx="${W/2}" cy="${H/2}" rx="${r}" ry="${r*0.6}" fill="none" stroke="#8C1D3C" stroke-width="0.3" opacity="0.18"/>`);
  }
  // 標題列
  svgParts.push(`<rect x="20" y="40" width="${W-40}" height="60" fill="#8C1D3C"/>`);
  svgParts.push(`<text x="40" y="80" font-size="24" fill="white" font-weight="bold">${c?.flag || '🏳️'} ${escapeHtml(loc.name)}</text>`);
  svgParts.push(`<text x="${W-40}" y="80" font-size="20" fill="white" text-anchor="end">${life.year + life.yearOffset}</text>`);
  // 姓名
  svgParts.push(`<text x="${W/2}" y="160" font-size="36" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${escapeHtml(life.name.full || life.name.full_en || '—')}</text>`);
  if (life.name.full_en && life.name.full_en !== life.name.full) {
    svgParts.push(`<text x="${W/2}" y="186" font-size="14" fill="#7a6a5a" text-anchor="middle" font-style="italic">${escapeHtml(life.name.full_en)}</text>`);
  }
  // 大字歲數
  svgParts.push(`<text x="${W/2}" y="250" font-size="48" fill="#1a1a1a" text-anchor="middle" font-weight="bold">${life.deathAge || life.age} ${LANG==='en'?'yrs':'歲'}</text>`);
  // 副標題
  svgParts.push(`<text x="${W/2}" y="285" font-size="14" fill="#5a4a3a" text-anchor="middle">${LANG==='en'?'Life Expectancy':'預期壽命'} ${c?.le || '—'} ${LANG==='en'?'yrs':'歲'}</text>`);
  // 詳情
  const rowY = 320;
  const rows = [
    [LANG==='en'?'Sex':'性別', life.sex === 'M' ? t('sex.male') : t('sex.female')],
    [LANG==='en'?'Born':'出生', life.year || '?'],
    [LANG==='en'?'Died':'逝世', life.died ? `${life.year + life.yearOffset}` : '—'],
    [LANG==='en'?'Cause':'原因', escapeHtml(life.cause || (LANG==='en'?'(still alive)':'仍在世'))]
  ];
  rows.forEach((r, i) => {
    const yy = rowY + i * 28;
    svgParts.push(`<text x="40" y="${yy}" font-size="13" fill="#5a4a3a">${r[0]}</text>`);
    svgParts.push(`<text x="${W-40}" y="${yy}" font-size="14" fill="#1a1a1a" text-anchor="end">${r[1]}</text>`);
  });
  // 章戳
  svgParts.push(`<circle cx="${W-110}" cy="430" r="36" fill="none" stroke="#8C1D3C" stroke-width="1.5" opacity="0.7"/>`);
  svgParts.push(`<text x="${W-110}" y="425" font-size="10" fill="#8C1D3C" text-anchor="middle">${LANG==='en'?'BORN-SOMEWHERE':'選出生地'}</text>`);
  svgParts.push(`<text x="${W-110}" y="440" font-size="8" fill="#8C1D3C" text-anchor="middle">EST. 2024</text>`);
  // 底部
  svgParts.push(`<text x="40" y="450" font-size="9" fill="#9a8a7a">${LANG==='en'?'Life certificate':'生命證書'} · born-somewhere v5.2 · ${LANG==='en'?'Real statistics':'真實統計'}</text>`);
  svgParts.push(`</svg>`);
  const svgStr = svgParts.join('');
  // 轉成 PNG via canvas
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2; // 高解析度
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(pngBlob => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      const safeName = (life.name.full || life.name.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
      a.href = pngUrl; a.download = `${safeName}-${LANG==='en'?'certificate':'證書'}-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(pngUrl); }, 1000);
      toast(LANG==='en'?'Certificate downloaded':'證書已下載');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(LANG==='en'?'Image conversion failed':'圖片轉換失敗');
  };
  img.src = url;
}

/* v5.12：分享出生卡（1in8b.life 風格登記證） */
function downloadBirthCardPNG() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  if (!c) return;
  const loc = localize(c);
  const isEn = LANG === 'en';
  const W = 800, H = 520;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  // 背景
  parts.push(`<rect width="${W}" height="${H}" fill="#faf7f0"/>`);
  // guilloche
  for (let r = 40; r < W; r += 24) {
    parts.push(`<ellipse cx="${W/2}" cy="${H/2}" rx="${r}" ry="${r*0.5}" fill="none" stroke="#8C1D3C" stroke-width="0.4" opacity="0.15"/>`);
  }
  // 邊框
  parts.push(`<rect x="6" y="6" width="${W-12}" height="${H-12}" fill="none" stroke="#8C1D3C" stroke-width="2.5" rx="10"/>`);
  parts.push(`<rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#0F6E68" stroke-width="1" rx="8"/>`);
  // 標題
  parts.push(`<rect x="20" y="30" width="${W-40}" height="60" fill="#8C1D3C"/>`);
  parts.push(`<text x="36" y="68" font-size="22" fill="white" font-weight="bold">${c.flag} ${escapeHtml(loc.name)}</text>`);
  parts.push(`<text x="${W-36}" y="68" font-size="18" fill="white" text-anchor="end">${life.year + life.yearOffset}</text>`);
  // 註冊編號
  parts.push(`<text x="${W/2}" y="120" font-size="11" fill="#8C1D3C" text-anchor="middle" font-weight="bold" letter-spacing="0.1em">${isEn?'BIRTH REGISTRATION':'出生登記'} · ${escapeHtml(life.regNumber || '')}</text>`);
  // 名字
  parts.push(`<text x="${W/2}" y="170" font-size="40" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${escapeHtml(life.name?.full || '?')}</text>`);
  if (life.name?.full_en && life.name.full_en !== life.name.full) {
    parts.push(`<text x="${W/2}" y="195" font-size="14" fill="#7a6a5a" text-anchor="middle" font-style="italic">${escapeHtml(life.name.full_en)}</text>`);
  }
  // 大字年齡
  parts.push(`<text x="${W/2}" y="270" font-size="56" fill="#1a1a1a" text-anchor="middle" font-weight="bold">${life.age} ${isEn?'yrs':'歲'}</text>`);
  // 副標題
  parts.push(`<text x="${W/2}" y="305" font-size="14" fill="#5a4a3a" text-anchor="middle">${isEn?'Life expectancy':'預期壽命'} ${c.le} ${isEn?'yrs':'歲'} · ${isEn?'Born in':'出生於'} ${escapeHtml(loc.name)}</text>`);
  // 家庭背景
  const fd = life.fatherDetail || {};
  const md = life.motherDetail || {};
  parts.push(`<line x1="60" y1="335" x2="${W-60}" y2="335" stroke="#d8cdb8" stroke-width="1"/>`);
  parts.push(`<text x="${W/2}" y="362" font-size="13" fill="#8C1D3C" text-anchor="middle" font-weight="bold">${isEn?'👪 Family Background':'👪 出身家庭'}</text>`);
  const fRows = [
    [isEn?'Father':'父親', `${(life.family?.parents||[]).find(p=>p.sex==='M')?.name || '—'} · ${fd.age ? fd.age + (isEn?' yo':'歲') : ''}${fd.job ? ' · ' + fd.job : ''}`],
    [isEn?'Mother':'母親', `${(life.family?.parents||[]).find(p=>p.sex==='F')?.name || '—'} · ${md.age ? md.age + (isEn?' yo':'歲') : ''}${md.job ? ' · ' + md.job : ''}`],
    [isEn?'Religion · Place':'宗教 · 出生地', `${life.stats.religion || '—'} · ${life.stats.birthPlaceType === 'rural' ? (isEn?'🌾 Rural':'🌾 鄉村') : (isEn?'🏙️ Urban':'🏙️ 城市')}`]
  ];
  fRows.forEach((r, i) => {
    const yy = 392 + i * 24;
    parts.push(`<text x="60" y="${yy}" font-size="12" fill="#7a6a5a">${r[0]}</text>`);
    parts.push(`<text x="160" y="${yy}" font-size="12" fill="#1a1a1a">${r[1]}</text>`);
  });
  // 底部 — 同伴
  if (life.companions && life.companions.length) {
    parts.push(`<text x="${W/2}" y="475" font-size="11" fill="#5a4a3a" text-anchor="middle">${isEn?'Born in the same second: ':'同一秒出生：'}${' '}${life.companions.slice(0,4).map(c=>c.flag + ' ' + (isEn?(c.nameEn||c.name):c.name)).join(' · ')}</text>`);
  }
  // 章戳
  parts.push(`<circle cx="${W-110}" cy="${H-25}" r="20" fill="none" stroke="#8C1D3C" stroke-width="1.5" opacity="0.7"/>`);
  parts.push(`<text x="${W-110}" y="${H-22}" font-size="8" fill="#8C1D3C" text-anchor="middle" font-weight="bold">BORN-SOMEWHERE</text>`);
  parts.push(`<text x="${W-110}" y="${H-12}" font-size="7" fill="#8C1D3C" text-anchor="middle">EST. 2024</text>`);
  // 底部 watermark
  parts.push(`<text x="40" y="${H-12}" font-size="8" fill="#9a8a7a">${isEn?'Birth certificate · born-somewhere v5.12':'出生登記 · born-somewhere v5.12'} · ${isEn?'Real statistics':'真實統計'}</text>`);
  parts.push(`</svg>`);
  const svgStr = parts.join('');
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(pngBlob => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      const safeName = (life.name?.full || life.name?.full_en || 'life').replace(/[\/\\<>:"|?*\u0000-\u001f]/g, '_');
      a.href = pngUrl; a.download = `${safeName}-${isEn?'birth-card':'出生卡'}-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); URL.revokeObjectURL(pngUrl); }, 1000);
      toast(isEn ? 'Birth card downloaded' : '出生卡已下載');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isEn ? 'Image conversion failed' : '圖片轉換失敗');
  };
  img.src = url;
}

/* v5.20：複製出生卡 base64 data URL 到剪貼簿（並顯示 toast） */
function copyBirthCardShareURL() {
  if (!STATE.life) return;
  const life = STATE.life;
  const c = life.countryData;
  if (!c) return;
  // 構建一個精簡版 life 物件，序列化後 base64 成 URL hash
  try {
    const minimal = {
      name: life.name?.full || life.name?.full_en || '',
      country: life.country,
      year: life.year,
      yearOffset: life.yearOffset,
      age: life.age,
      sex: life.sex,
      regNumber: life.regNumber,
      cause: life.cause
    };
    const json = JSON.stringify(minimal);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    const url = `${location.origin}${location.pathname}#life=${b64}`;
    const ok = navigator.clipboard?.writeText(url);
    if (ok && typeof ok.then === 'function') {
      ok.then(() => toast(t('share.linkCopied')))
        .catch(() => toast(t('share.linkCopied')));
    } else {
      toast(t('share.linkCopied'));
    }
  } catch (e) {
    // btoa 失敗時靜默
  }
}

function toast(msg, ms=2200) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, ms);
}
