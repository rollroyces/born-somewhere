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

if issues:
    for t, lang, k, detail, snippet in issues:
        print(f'{t:15} {lang}.{k}  [{detail}]  {snippet!r}')
    print('\nTOTAL:', len(issues))
    sys.exit(1)

total = sum(len(v) for v in d.values())
print(f'clean — {len(d)} languages, {total} values, '
      f'{len([r for r in refs if not r.endswith(".")])} referenced keys all resolve, '
      f'key sets identical, 0 U+FFFD, 0 Han-in-Korean, 0 empty/placeholder')