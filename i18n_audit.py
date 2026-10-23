#!/usr/bin/env python3
"""i18n integrity audit — three defect classes that actually occurred here.

1. U+FFFD replacement characters: a mangled character that survived review
   because an earlier regex only looked for Latin-in-CJK / CJK-in-Latin.
2. Han characters inside Korean values: Korean is written in Hangul, so a Han
   character there means a Chinese fragment leaked into a Korean translation.
3. data-t / t() keys referenced by the markup but absent from i18n.json.
   t() returns the key itself when missing and renderAll() assigns it with
   textContent, so a missing key REPLACES good HTML fallback text with the
   literal key -- the player sees "lab.country" instead of a label.

Deliberately narrow: broad script heuristics were tried and rejected because
Japanese legitimately uses kanji and CJK strings legitimately contain
"OECD", "CC BY 4.0", "GEDCOM" -- those checks only produced false positives.

Run: python3 i18n_audit.py   (exit 1 = issues found)
"""
import json, io, re, sys, os

root = os.path.dirname(os.path.abspath(__file__))
d = json.load(io.open(os.path.join(root, 'data/i18n.json'), encoding='utf-8'))
html = io.open(os.path.join(root, 'index.html'), encoding='utf-8').read()
js = io.open(os.path.join(root, 'app.js'), encoding='utf-8').read()

issues = []

# 1. U+FFFD
for lang, kv in d.items():
    for k, v in kv.items():
        n = str(v).count('�')
        if n:
            issues.append(('U+FFFD', lang, k, f'x{n}', str(v)[:60]))

# 2. Han inside Korean
for k, v in d.get('ko', {}).items():
    han = sorted(set(ch for ch in str(v) if '一' <= ch <= '鿿'))
    if han:
        issues.append(('HAN-in-KO', 'ko', k, ''.join(han), str(v)[:60]))

# 3. referenced-but-missing keys.
#    t('a.' + x) concatenates, so a trailing dot is a prefix, not a key.
refs = set()
for src in (html, js):
    for m in re.finditer(r'data-t(?:-html|-title|-aria)?="([^"]+)"', src):
        refs.add(m.group(1))
    for m in re.finditer(r"\bt\(\s*'([A-Za-z0-9_.]+)'", js):
        refs.add(m.group(1))

for lang, kv in d.items():
    for r in sorted(refs):
        if r.endswith('.'):
            continue                      # concatenation prefix
        if r not in kv or not str(kv[r]).strip():
            issues.append(('MISSING-KEY', lang, r, '', ''))

# 4. key-set parity. A language missing a key the others have renders the raw key
#    in that language only -- invisible if you only test zh-Hant and en.
base = set(d['zh-Hant'])
for lang, kv in d.items():
    if lang == 'zh-Hant':
        continue
    missing = sorted(base - set(kv))
    extra = sorted(set(kv) - base)
    for k in missing:
        issues.append(('MISSING-VS-BASE', lang, k, '', ''))
    for k in extra:
        issues.append(('ORPHAN-KEY', lang, k, '', ''))

# 5. empty / placeholder values anywhere
import re as _re
_placeholder = _re.compile(r'^(TODO|FIXME|xxx|test|lorem|\.\.\.)$', _re.I)
for lang, kv in d.items():
    for k, v in kv.items():
        s = str(v).strip()
        if not s:
            issues.append(('EMPTY', lang, k, '', ''))
        elif _placeholder.match(s):
            issues.append(('PLACEHOLDER', lang, k, '', s))

# 6. 版本號一致性（v5.98）
# 這個專案有三處必須對齊的版本字串，過去全部各自硬編碼而且互相漂移：
# 更新說明標題顯示 5.19.0、匯出的出生卡寫 v5.12、匯出的生命證書寫 v5.2，
# 而線上實際是 5.97。分享圖會被別人看到，所以特別不能錯。
import os as _os, re as _re2
_root = _os.path.dirname(_os.path.abspath(__file__))
def _read(name):
    with open(_os.path.join(_root, name), encoding='utf-8') as f:
        return f.read()

_html, _sw, _app = _read('index.html'), _read('sw.js'), _read('app.js')

_m = _re2.search(r'class="footer-ver">v(5\.\d+)', _html)
_html_v = _m.group(1) if _m else None
_m = _re2.search(r"const APP_VERSION = '(5\.\d+\.\d+)'", _app)
_app_v = _m.group(1) if _m else None
_m = _re2.search(r"CACHE_NAME = 'born-somewhere-v(5\.\d+)'", _sw)
_sw_v = _m.group(1) if _m else None

_versions = {'index.html footer': _html_v, 'app.js APP_VERSION': _app_v,
             'sw.js CACHE_NAME': _sw_v}
for where, val in _versions.items():
    if val is None:
        issues.append(('VERSION', where, '', 'not found', ''))
if _app_v and _html_v and _app_v.rsplit('.', 1)[0] != _html_v:
    issues.append(('VERSION', 'app.js APP_VERSION', '', f'!= index.html v{_html_v}', _app_v))
if _html_v and _sw_v and _html_v != _sw_v:
    issues.append(('VERSION', 'sw.js CACHE_NAME', '', f'!= index.html v{_html_v}', _sw_v))
# 匯出圖的頁尾不得再出現硬編碼版本。
# 只看含「真實統計 / Real statistics」的那幾行（兩張匯出圖的頁尾）——
# 檔頭註解裡的 "born-somewhere v2" 是 localStorage 的 schema 版本，另一套編號，
# 不是 app 版本，不該被這條規則擋下。
for _line in _app.splitlines():
    if ('真實統計' in _line or 'Real statistics' in _line) and 'born-somewhere v' in _line:
        _hit = _re2.search(r"born-somewhere v(?!\$\{)[0-9.]+", _line)
        if _hit:
            issues.append(('VERSION', 'app.js', '', 'hardcoded version in export footer', _hit.group(0)))

if issues:
    for t, lang, k, detail, snippet in issues:
        print(f'{t:15} {lang}.{k}  [{detail}]  {snippet!r}')
    print('\nTOTAL:', len(issues))
    sys.exit(1)

total = sum(len(v) for v in d.values())
print(f'clean — {len(d)} languages, {total} values, '
      f'{len([r for r in refs if not r.endswith(".")])} referenced keys all resolve, '
      f'key sets identical, 0 U+FFFD, 0 Han-in-Korean, 0 empty/placeholder, '
      f'version {_html_v} consistent across index.html / app.js / sw.js')