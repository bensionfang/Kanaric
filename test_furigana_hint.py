"""apply_hint 的最小自檢:python test_furigana_hint.py"""
from furigana_inject import apply_hint

def hira_of(words, orig):
    return next(w['hira'] for w in words if w['orig'] == orig)

# 1. 對齊歪掉時不能吃掉送り仮名 (花人局:hint 把 そんな 寫成 そんあ,整行偏移一格)
words = [
    {'orig': '美人局', 'hira': 'つつもたせ', 'is_space': False},
    {'orig': 'を', 'hira': 'を', 'is_space': False},
    {'orig': '疑う', 'hira': 'うたがう', 'is_space': False},
    {'orig': '、', 'hira': '、', 'is_space': False},
    {'orig': 'そんな', 'hira': 'そんな', 'is_space': False},
    {'orig': '気', 'hira': 'き', 'is_space': False},
]
apply_hint(words, 'つつもたせをうたがうそんあき')
assert hira_of(words, '疑う') == 'うたがう', hira_of(words, '疑う')  # 不是 うたが
assert hira_of(words, '気') == 'き'

# 2. hint 仍然要能修正 fugashi 挑錯的讀音 (君 くん → きみ)
words = [
    {'orig': '君', 'hira': 'くん', 'is_space': False},
    {'orig': 'の', 'hira': 'の', 'is_space': False},
    {'orig': '声', 'hira': 'こえ', 'is_space': False},
]
apply_hint(words, 'きみのこえ')
assert hira_of(words, '君') == 'きみ'

# 3. 帶送り仮名的詞,hint 對得上時照樣可以覆蓋
words = [
    {'orig': '行く', 'hira': 'ゆく', 'is_space': False},
]
apply_hint(words, 'いく')
assert hira_of(words, '行く') == 'いく'

print('OK')

# 4. 讀音 = 原文的詞 (unidic 查不到,中文歌整行如此) 不可以被吞掉
import re
from furigana_inject import build_ruby_html
plain = re.sub(r'<[^>]+>', '', build_ruby_html('我們的愛情斷了線', 'x', 'y'))
for ch in '我們的愛情斷了線':
    assert ch in plain, (ch, plain)

print('OK')

# 5. 整首沒假名 = 中文歌,原文照抄不注音;日文歌照常注音
from furigana_inject import process_lrc
zh = '[00:12.34]我們的愛情像風箏斷了線\n[00:15.00]別問我為什麼還愛妳'
assert process_lrc('x', 'y', zh) == zh
assert '<ruby' in process_lrc('x', 'y', '[00:12.34]君の声が聞こえる')

print('OK')

# 6. 片假名標平假名:預設不動,開啟時包 ruby 且原文保留、長音符 ー 不展開
assert '<ruby' not in build_ruby_html('サヨナラ', 'x', 'y')
kr = build_ruby_html('サヨナラ', 'x', 'y', kata_ruby=True)
assert 'サヨナラ' in kr and '<rt>さよなら</rt>' in kr, kr
assert '<rt>らーめん</rt>' in build_ruby_html('ラーメン', 'x', 'y', kata_ruby=True)
assert build_ruby_html('ー', 'x', 'y', kata_ruby=True) == 'ー'   # 轉了也一樣就不包

print('OK')
