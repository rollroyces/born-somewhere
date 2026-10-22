#!/usr/bin/env python3
"""i18n integrity audit — the two defect classes that actually occurred.

1. U+FFFD replacement characters: a mangled character that survived review
   because the earlier regex only looked for Latin-in-CJK / CJK-in-Latin.
2. Han characters inside Korean values: Korean is written in Hangul. A Han
   character there means a Chinese fragment leaked into a Korean translation.

Deliberately narrow: broad script heuristics produce false positives here
(Japanese legitimately uses kanji; CJK languages legitimately contain
"OECD", "CC BY 4.0", "GEDCOM"), so they are not used as pass/fail signals.

Run: python3 i18n_audit.py   (exit 1 = issues found)
"""
import json, io, sys

d = json.load(io.open('data/i18n.json', encoding='utf-8'))
issues = []

for lang, kv in d.items():
    for k, v in kv.items():
        s = str(v)
        n = s.count('�')
        if n:
            issues.append(('U+FFFD', lang, k, f'x{n}', s[:60]))

for k, v in d.get('ko', {}).items():
    han = sorted(set(ch for ch in str(v) if '一' <= ch <= '鿿'))
    if han:
        issues.append(('HAN-in-KO', 'ko', k, ''.join(han), str(v)[:60]))

if issues:
    for t, lang, k, detail, snippet in issues:
        print(f'{t:10} {lang}.{k}  [{detail}]  {snippet!r}')
    print('\nTOTAL:', len(issues))
    sys.exit(1)

total = sum(len(v) for v in d.values())
print(f'clean — {len(d)} languages, {total} values, 0 U+FFFD, 0 Han-in-Korean')