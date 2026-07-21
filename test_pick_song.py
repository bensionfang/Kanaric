"""_pick_song 的最小自檢:venv/Scripts/python.exe test_pick_song.py"""
from cn_music import _pick_song

S = lambda n: {'id': n}

# 1. 歌手不合 + 時長對不上 → 退貨
#    實例:神はサイコロを振らない 的「初恋」(239 秒) 曾被判成林志美的粵語同名曲 (230 秒)
cands = [(S(1), '初恋', '林志美', 230.0), (S(2), '初恋', '陈百潭', 209.0)]
assert _pick_song(cands, '神不擲骰子', 239) is None

# 2. 歌手不合但時長吻合 → 照收 (歌手名被平台翻譯過,時長是唯一證據)
cands = [(S(1), '初恋', '林志美', 230.0), (S(2), '初恋', '神はサイコロを振らない', 239.0)]
assert _pick_song(cands, '神不擲骰子', 239)['id'] == 2

# 3. 沒有時長資訊 → 不退貨 (維持舊行為,總比沒歌詞好)
assert _pick_song([(S(1), '初恋', '林志美', 230.0)], '神不擲骰子', None)['id'] == 1

# 4. 歌手對得上就不看時長 (Live 版、不同 master 的長度本來就會差)
assert _pick_song([(S(1), '初恋', '神不擲骰子', 260.0)], '神不擲骰子', 239)['id'] == 1

print('OK')
