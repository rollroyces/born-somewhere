/* GEDCOM 5.5.1 解析與產生
   給 zu-pu 用：把內部資料結構轉 GEDCOM 文字、或把 GEDCOM 文字轉回內部結構。
   內部結構：{ _meta, people: { id: { id, name, nameEn, gender, birth, death, birthPlace, deathPlace, notes, parents, spouses } } }
   對應規則：
     兩位有共同子女的父母 = 一個 FAM
     子女出現在父母的 FAM 內
     單親子女的家庭：FAM 只有 HUSB 或 WISE
     配偶但無共同子女：也算一個 FAM
*/

(function () {
  const NS = window.Gedcom = {};

  /* === 日期格式化 === */
  const MONTHS = { 1: 'JAN', 2: 'FEB', 3: 'MAR', 4: 'APR', 5: 'MAY', 6: 'JUN',
                   7: 'JUL', 8: 'AUG', 9: 'SEP', 10: 'OCT', 11: 'NOV', 12: 'DEC' };
  function dateToGedcom(d) {
    if (!d || !d.year) return '';
    let s = String(d.year);
    if (d.month) s = `${d.day || ''} ${MONTHS[d.month]} ${d.year}`.trim().replace(/^/, '').trim();
    if (d.month && d.day) s = `${d.day} ${MONTHS[d.month]} ${d.year}`;
    if (d.month && !d.day) s = `${MONTHS[d.month]} ${d.year}`;
    return s;
  }
  const MONTHS_REV = {};
  for (const [k, v] of Object.entries(MONTHS)) MONTHS_REV[v] = +k;
  function gedcomToDate(s) {
    if (!s) return null;
    s = String(s).trim().toUpperCase();
    // BEF, AFT, BETWEEN 等略
    if (/[A-Z]{3}/.test(s)) {
      // 抓 YYYY
      const m = s.match(/(\d{4})/);
      if (!m) return null;
      const year = +m[1];
      const monthMatch = s.match(/(\d{1,2})?\s*([A-Z]{3})\s+(\d{4})/);
      const dayMatch = s.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/);
      if (dayMatch) return { year, month: MONTHS_REV[dayMatch[2]], day: +dayMatch[1] };
      if (monthMatch) return { year, month: MONTHS_REV[monthMatch[2]] };
      return { year };
    }
    // 純數字
    const parts = s.split(/[-\s\/.]/).filter(Boolean).map(Number);
    if (parts.length >= 1 && parts[0] >= 1000) {
      const d = { year: parts[0] };
      if (parts[1]) d.month = parts[1];
      if (parts[2]) d.day = parts[2];
      return d;
    }
    return null;
  }

  /* === 名字處理 === */
  // 中文姓名（姓在前）："張守正" → 拆分為 given "守正"、surname "張"
  // 輸出 GEDCOM 標準 "GivenName /Surname/" 格式
  function nameToGedcom(name) {
    if (!name) return { name: '', surname: '' };
    if (name.length === 1) return { name: '', surname: name };
    if (name.length === 2) return { name: name[1], surname: name[0] };
    return { name: name.slice(1), surname: name[0] };
  }
  function gedcomToName(nameStr) {
    if (!nameStr) return '';
    // "Given /Surname" 格式
    const m = nameStr.match(/^(.*?)\s*\/\s*(.*?)\s*\/?\s*$/);
    if (m) {
      const given = m[1].trim();
      const surname = m[2].trim();
      if (given && surname) return surname + given;  // 中文姓在前
      if (surname) return surname;
      return given || nameStr.trim();
    }
    return nameStr.trim();
  }

  /* === 匯出 === */
  function exportFn(DB) {
    const people = DB.people || {};
    const lines = [];
    function ln(level, tag, value) {
      if (value === undefined || value === null || value === '') {
        lines.push(`${level} ${tag}`);
      } else {
        // 去掉換行
        const v = String(value).replace(/\n/g, ' ').trim();
        lines.push(`${level} ${tag} ${v}`);
      }
    }

    ln(0, 'HEAD');
    // v5.99：這裡原本寫 'zu-pu'（本專案改名前的舊名），會原樣出現在玩家匯出的
    // .ged 檔案裡。族譜軟體會把 SOUR 顯示為「來源」，所以等於每份匯出都掛著舊專案名。
    ln(1, 'SOUR', 'born-somewhere');
    ln(1, 'GEDC');
    ln(2, 'VERS', '5.5.1');
    ln(2, 'FORM', 'LINEAGE-LINKED');
    ln(1, 'CHAR', 'UTF-8');
    ln(1, 'NOTE', DB._meta?.title || '族譜');

    // 構建 FAM 結構
    // 規則 1: 兩位父母若有共同子女 → 一個 FAM
    // 規則 2: 子女出現在父母的 FAM
    // 規則 3: 配偶無共同子女 → 一個 FAM
    // 我們建立一個 map: famKey → {husb, wife, children: [ids]}
    const fams = new Map();
    function getOrCreateFam(husbId, wifeId) {
      const key = [husbId || '', wifeId || ''].sort().join('|');
      if (!fams.has(key)) fams.set(key, { husb: husbId || null, wife: wifeId || null, children: [] });
      return fams.get(key);
    }
    // 為每位有父母的子女建 FAM
    for (const id of Object.keys(people)) {
      const p = people[id];
      const parents = p.parents || [];
      if (parents.length === 0) continue;
      const f = getFather(id);
      const m = getMother(id);
      const fam = getOrCreateFam(f?.id, m?.id);
      fam.children.push(id);
    }
    // 為每對未建 FAM 的配偶建 FAM
    for (const id of Object.keys(people)) {
      const p = people[id];
      for (const sid of p.spouses || []) {
        if (sid <= id) continue; // 避免重複
        const sp = people[sid];
        if (!sp) continue;
        const f = getFamForCouple(id, sid);
        if (!f) {
          // 判斷性別
          const a = p, b = sp;
          let h = null, w = null;
          if (a.gender === 'M') h = a.id;
          else if (a.gender === 'F') w = a.id;
          if (b.gender === 'M') h = b.id;
          else if (b.gender === 'F') w = b.id;
          // 若兩者都不是 HUSB/WIFE 已知，以 a 為 HUSB, b 為 WIFE
          if (!h && !w) { h = a.id; w = b.id; }
          else if (!h) h = a.id;
          else if (!w) w = a.id;
          getOrCreateFam(h, w);
        }
      }
    }
    function getFamForCouple(a, b) {
      for (const [k, v] of fams.entries()) {
        const ids = [v.husb, v.wife].filter(Boolean);
        if (ids.includes(a) && ids.includes(b)) return v;
      }
      return null;
    }
    // 因為 getFather/Mother 在 export 時要 inline 運算，定義本地版
    function getFather(id) {
      const p = people[id]; if (!p) return null;
      const ps = (p.parents || []).map(x => people[x]).filter(Boolean);
      return ps.find(x => x.gender === 'M') || ps[0] || null;
    }
    function getMother(id) {
      const p = people[id]; if (!p) return null;
      const ps = (p.parents || []).map(x => people[x]).filter(Boolean);
      return ps.find(x => x.gender === 'F') || ps[1] || null;
    }
    // 重新走 FAM 構造（因為 getFather/Mother 在 closure 內）
    fams.clear();
    for (const id of Object.keys(people)) {
      const p = people[id];
      const parents = p.parents || [];
      if (parents.length === 0) continue;
      const f = getFather(id);
      const m = getMother(id);
      const fam = getOrCreateFam(f?.id, m?.id);
      if (!fam.children.includes(id)) fam.children.push(id);
    }
    for (const id of Object.keys(people)) {
      const p = people[id];
      for (const sid of p.spouses || []) {
        if (sid <= id) continue;
        const sp = people[sid];
        if (!sp) continue;
        const a = p, b = sp;
        let h = null, w = null;
        if (a.gender === 'M') h = a.id;
        else if (a.gender === 'F') w = a.id;
        if (b.gender === 'M') h = b.id;
        else if (b.gender === 'F') w = b.id;
        if (!h && !w) { h = a.id; w = b.id; }
        else if (!h) h = a.id;
        else if (!w) w = a.id;
        getOrCreateFam(h, w);
      }
    }
    // 為每個人建 INDI
    // FAMS / FAMC 索引
    const personFams = {}; // id → fam keys
    const personFamc = {}; // id → fam key
    for (const id of Object.keys(people)) personFams[id] = [];
    let famIdx = 1;
    const famIdMap = new Map(); // key → 'F1' etc
    for (const [k, v] of fams.entries()) {
      famIdMap.set(k, 'F' + famIdx++);
      if (v.husb) personFams[v.husb].push(k);
      if (v.wife) personFams[v.wife].push(k);
    }
    for (const id of Object.keys(people)) {
      const p = people[id];
      const parents = p.parents || [];
      if (parents.length === 0) continue;
      const f = getFather(id);
      const m = getMother(id);
      const key = [f?.id || '', m?.id || ''].sort().join('|');
      if (fams.has(key)) personFamc[id] = key;
    }

    for (const id of Object.keys(people)) {
      const p = people[id];
      const indiId = 'I' + id.replace(/^p/, '');
      ln(0, '@' + indiId + '@', 'INDI');
      if (p.name) {
        const { name, surname } = nameToGedcom(p.name);
        const nameField = surname ? `${name} /${surname}/` : name;
        ln(1, 'NAME', nameField);
      }
      if (p.nameEn) ln(1, 'NAME', p.nameEn);
      if (p.gender) ln(1, 'SEX', p.gender);
      if (p.birth?.year) {
        ln(1, 'BIRT');
        const ds = dateToGedcom(p.birth);
        if (ds) ln(2, 'DATE', ds);
        if (p.birthPlace) ln(2, 'PLAC', p.birthPlace);
      }
      if (p.death?.year) {
        ln(1, 'DEAT');
        const ds = dateToGedcom(p.death);
        if (ds) ln(2, 'DATE', ds);
        if (p.deathPlace) ln(2, 'PLAC', p.deathPlace);
      }
      if (p.notes) ln(1, 'NOTE', p.notes);
      for (const k of personFams[id] || []) ln(1, 'FAMS', '@' + famIdMap.get(k) + '@');
      if (personFamc[id]) ln(1, 'FAMC', '@' + famIdMap.get(personFamc[id]) + '@');
    }

    // FAM records
    for (const [k, v] of fams.entries()) {
      const fid = '@' + famIdMap.get(k) + '@';
      ln(0, fid, 'FAM');
      if (v.husb) {
        const hid = 'I' + v.husb.replace(/^p/, '');
        ln(1, 'HUSB', '@' + hid + '@');
      }
      if (v.wife) {
        const wid = 'I' + v.wife.replace(/^p/, '');
        ln(1, 'WIFE', '@' + wid + '@');
      }
      for (const cid of v.children) {
        const kid = 'I' + cid.replace(/^p/, '');
        ln(1, 'CHIL', '@' + kid + '@');
      }
    }

    ln(0, 'TRLR');
    return lines.join('\n') + '\n';
  }

  /* === 解析 === */
  function importFn(text) {
    const lines = text.split(/\r?\n/);
    const tokens = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(@[^@]+@|\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      tokens.push({
        level: +m[1],
        xref: m[2].startsWith('@') ? m[2] : null,
        tag: m[2].startsWith('@') ? m[3] : m[2],
        value: m[3] || '',
        raw: line,
      });
    }
    // 處理 xref + tag 模式
    const tokens2 = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // 兩種格式：1) "LEVEL @ID@ TAG value"  2) "LEVEL TAG value"
      let m = line.match(/^(\d+)\s+(@[^@]+@)\s+(\S+)(?:\s+(.*))?$/);
      if (m) {
        tokens2.push({ level: +m[1], xref: m[2], tag: m[3], value: m[4] || '' });
        continue;
      }
      m = line.match(/^(\d+)\s+(\S+)(?:\s+(.*))?$/);
      if (m) {
        tokens2.push({ level: +m[1], xref: null, tag: m[2], value: m[3] || '' });
      }
    }

    // 樹狀化
    const root = { children: [] };
    const stack = [root];
    for (const t of tokens2) {
      while (stack.length > 1 && stack[stack.length - 1].level >= t.level) stack.pop();
      const node = { ...t, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }

    // 找 INDI / FAM 記錄
    const indis = {}; // xref → tree
    const fams = {};
    for (const child of root.children) {
      if (child.xref && child.tag === 'INDI') indis[child.xref] = child;
      if (child.xref && child.tag === 'FAM') fams[child.xref] = child;
    }

    // 標題
    let title = '匯入族譜';
    for (const c of root.children) {
      if (c.tag === 'HEAD') {
        for (const cc of c.children) {
          if (cc.tag === 'NOTE') { title = cc.value || title; break; }
        }
      }
    }

    // INDI → 內部人
    const people = {};
    const indiToPid = {};
    let pidSeq = 1;
    for (const [xref, indi] of Object.entries(indis)) {
      const id = 'p' + (pidSeq++);
      indiToPid[xref] = id;
      const p = {
        id,
        name: '',
        nameEn: '',
        gender: 'U',
        birth: null,
        death: null,
        birthPlace: '',
        deathPlace: '',
        notes: '',
        parents: [],
        spouses: [],
      };
      // 解析子節點
      for (const ch of indi.children) {
        if (ch.tag === 'NAME') {
          if (!p.name) p.name = gedcomToName(ch.value);
          else if (ch.value && ch.value !== p.name) p.nameEn = ch.value;
        }
        else if (ch.tag === 'SEX') p.gender = (ch.value || 'U').toUpperCase()[0];
        else if (ch.tag === 'BIRT') {
          const b = parseEvent(ch);
          p.birth = b.date;
          p.birthPlace = b.place;
        }
        else if (ch.tag === 'DEAT') {
          const d = parseEvent(ch);
          p.death = d.date;
          p.deathPlace = d.place;
        }
        else if (ch.tag === 'NOTE') p.notes = ch.value || '';
        else if (ch.tag === 'FAMC') p.parents.push('@FAMC@' + ch.value);
        else if (ch.tag === 'FAMS') p.spouses.push('@FAMS@' + ch.value);
      }
      people[id] = p;
    }
    function parseEvent(node) {
      const out = { date: null, place: '' };
      for (const c of node.children) {
        if (c.tag === 'DATE') out.date = gedcomToDate(c.value);
        else if (c.tag === 'PLAC') out.place = c.value || '';
      }
      return out;
    }
    // 解析 FAM：建立 parent / spouse 連結
    for (const [xref, fam] of Object.entries(fams)) {
      let husb = null, wife = null;
      const children = [];
      for (const ch of fam.children) {
        if (ch.tag === 'HUSB' && ch.value) husb = indiToPid[ch.value] || null;
        else if (ch.tag === 'WIFE' && ch.value) wife = indiToPid[ch.value] || null;
        else if (ch.tag === 'CHIL' && ch.value) {
          const pid = indiToPid[ch.value];
          if (pid) children.push(pid);
        }
      }
      // 設定子女的 parents
      for (const cid of children) {
        const c = people[cid];
        if (!c.parents.includes(husb) && husb) c.parents.push(husb);
        if (!c.parents.includes(wife) && wife) c.parents.push(wife);
        // 移除佔位符
        c.parents = c.parents.filter(x => !x.startsWith('@FAMC@'));
      }
      // 設定配偶的 spouses
      if (husb && wife) {
        if (!people[husb].spouses.includes(wife)) people[husb].spouses.push(wife);
        if (!people[wife].spouses.includes(husb)) people[wife].spouses.push(husb);
      }
    }
    // 清理所有 FAMS 佔位符
    for (const p of Object.values(people)) {
      p.spouses = p.spouses.filter(x => !x.startsWith('@FAMS@'));
    }
    return { _meta: { source: 'gedcom', version: 1, title }, people };
  }

  NS.export = exportFn;
  NS.import = importFn;
})();
