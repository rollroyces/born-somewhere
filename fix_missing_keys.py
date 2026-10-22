#!/usr/bin/env python3
"""v5.76 — add the 10 i18n keys that were missing and rendering as raw key text.

Found by walking every data-t attribute in index.html and checking the key exists
in zh-Hant. t() returns the key itself when missing, and renderAll() does
el.textContent = t(el.dataset.t) -- so a missing key REPLACES good HTML fallback
text with the literal key, which is what the player sees.

These are the Lab input labels and the end/feedback modal buttons: v5.54 added the
Lab *result* labels but never the Lab *input* labels.
"""
import json, io

P = 'data/i18n.json'
d = json.load(io.open(P, encoding='utf-8'))

NEW = {
 'zh-Hant': {
   'end.replay': '再看一次最後的時刻',
   'end.lastMoments': '最後的時刻',
   'lab.country': '國家 A',
   'lab.sex': '性別',
   'lab.this': '隨機',
   'lab.era': '年代',
   'lab.start': '人數',
   'focus.placeholder': '選一個會影響你的狀態條與淨資產。',
   'finance.placeholder': '選一項會影響淨資產與狀態。',
   'feedback.submit': '送出',
 },
 'zh-Hans': {
   'end.replay': '再看一次最后的时刻',
   'end.lastMoments': '最后的时刻',
   'lab.country': '国家 A',
   'lab.sex': '性别',
   'lab.this': '随机',
   'lab.era': '年代',
   'lab.start': '人数',
   'focus.placeholder': '选一个会影响你的状态条与净资产。',
   'finance.placeholder': '选一项会影响净资产与状态。',
   'feedback.submit': '发送',
 },
 'en': {
   'end.replay': 'Watch the last moments again',
   'end.lastMoments': 'The last moments',
   'lab.country': 'Country A',
   'lab.sex': 'Sex',
   'lab.this': 'Random',
   'lab.era': 'Era',
   'lab.start': 'How many',
   'focus.placeholder': 'Picking one affects your stat bars and net assets.',
   'finance.placeholder': 'Picking one affects net assets and stats.',
   'feedback.submit': 'Send',
 },
 'ko': {
   'end.replay': '마지막 순간 다시 보기',
   'end.lastMoments': '마지막 순간',
   'lab.country': '국가 A',
   'lab.sex': '성별',
   'lab.this': '무작위',
   'lab.era': '시대',
   'lab.start': '인원',
   'focus.placeholder': '고르면 능력치 막대와 순자산에 영향을 줍니다.',
   'finance.placeholder': '고르면 순자산과 능력치에 영향을 줍니다.',
   'feedback.submit': '보내기',
 },
 'ja': {
   'end.replay': '最後の瞬間をもう一度',
   'end.lastMoments': '最後の瞬間',
   'lab.country': '国 A',
   'lab.sex': '性別',
   'lab.this': 'ランダム',
   'lab.era': '時代',
   'lab.start': '人数',
   'focus.placeholder': '選ぶとステータスと純資産が変わります。',
   'finance.placeholder': '選ぶと純資産とステータスが変わります。',
   'feedback.submit': '送信',
 },
 'vi': {
   'end.replay': 'Xem lại khoảnh khắc cuối',
   'end.lastMoments': 'Khoảnh khắc cuối',
   'lab.country': 'Quốc gia A',
   'lab.sex': 'Giới tính',
   'lab.this': 'Ngẫu nhiên',
   'lab.era': 'Giai đoạn',
   'lab.start': 'Số lượng',
   'focus.placeholder': 'Chọn sẽ ảnh hưởng thanh chỉ số và tài sản ròng.',
   'finance.placeholder': 'Chọn sẽ ảnh hưởng tài sản ròng và chỉ số.',
   'feedback.submit': 'Gửi',
 },
 'fr': {
   'end.replay': 'Revoir les derniers moments',
   'end.lastMoments': 'Les derniers moments',
   'lab.country': 'Pays A',
   'lab.sex': 'Sexe',
   'lab.this': 'Aléatoire',
   'lab.era': 'Époque',
   'lab.start': 'Combien',
   'focus.placeholder': 'Choisir modifie vos barres de stats et votre patrimoine.',
   'finance.placeholder': 'Choisir modifie le patrimoine et les stats.',
   'feedback.submit': 'Envoyer',
 },
 'th': {
   'end.replay': 'ดูช่วงสุดท้ายอีกครั้ง',
   'end.lastMoments': 'ช่วงสุดท้าย',
   'lab.country': 'ประเทศ A',
   'lab.sex': 'เพศ',
   'lab.this': 'สุ่ม',
   'lab.era': 'ยุคสมัย',
   'lab.start': 'จำนวนคน',
   'focus.placeholder': 'การเลือกจะส่งผลต่อแถบสถานะและสินทรัพย์สุทธิ',
   'finance.placeholder': 'การเลือกจะส่งผลต่อสินทรัพย์สุทธิและสถานะ',
   'feedback.submit': 'ส่ง',
 },
 'es': {
   'end.replay': 'Ver los últimos momentos otra vez',
   'end.lastMoments': 'Los últimos momentos',
   'lab.country': 'País A',
   'lab.sex': 'Sexo',
   'lab.this': 'Aleatorio',
   'lab.era': 'Era',
   'lab.start': 'Cuántas',
   'focus.placeholder': 'Elegir afecta a las barras de estado y al patrimonio.',
   'finance.placeholder': 'Elegir afecta al patrimonio y a las estadísticas.',
   'feedback.submit': 'Enviar',
 },
}

added = 0
for lang, kv in NEW.items():
    for k, v in kv.items():
        if k in d[lang] and str(d[lang][k]).strip():
            continue
        d[lang][k] = v
        added += 1

io.open(P, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
print('added', added, 'values across', len(NEW), 'languages')

# verify
d2 = json.load(io.open(P, encoding='utf-8'))
for lang in d2:
    for k in NEW['en']:
        assert k in d2[lang] and str(d2[lang][k]).strip(), (lang, k)
print('verified: all 10 keys present and non-empty in every language')