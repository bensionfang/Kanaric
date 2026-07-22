"""
把歷史資料裡「歌名被 Spotify 翻成英文」的舊列，用 iTunes JP 還原成日文原名並收斂，一次性清理。

server.js 的 getResolvedMetadata 現在會在查詢失敗時標記 failedAt、冷卻後重試，新資料不會再
因為一次逾時就永久分裂；這支處理的是改動之前就已經用兩種寫法存進去的舊列。實測 TUYU / ツユ
底下各存了同樣四首歌，listening_history 也分裂（排行榜與統計因此是錯的）。

    python scripts/restore_jp_titles.py            # dry-run，只印出會做什麼
    python scripts/restore_jp_titles.py --apply    # 備份後實際寫入

**採用條件刻意比 server.js 嚴，而且只認一條證據：時長 ±3 秒吻合。**
線上路徑判錯只是一首歌一時標錯、使用者看得到；這支是合併資料列，判錯等於把兩首不同的歌
併成一筆，而且不可逆。

實測 dry-run 證明「新歌名含假名」這類形態證據**完全擋不住**，會誤判成：

  - 同一位歌手的**另一首歌**（`ヨルシカ - 春泥棒` → `花に亡霊`，合併就是把歌詞蓋掉）
  - 別人的**翻唱**（`Vaundy - Fukakoryoku` → `りぶ - 不可幸力(りぶcover)`）
  - **Live / replica 版**（`正義` → `正義 (… 2024 / LIVE)`、`怪獣の花唄 - replica -`）
  - 西洋歌的**片假名音譯**（`Juice WRLD` → `ジュース・ワールド`）

同一批資料裡時長那條零誤判（153≈153、218≈218、244≈244、248≈248），所以只留它。

候選也一併收緊成**歌名是純英數**：被翻譯過的特徵就是歌名變成羅馬字或英文
（`Fukakoryoku`、`Goodbye to Rock you`）。`春泥棒`、`正義` 這種純漢字歌名本來就是對的，
放進候選只會製造上面那種誤判。

證據不足的一律不動，改列進「需人工確認」清單印出來。

iTunes 沒公布限流規則，實測 0.4 秒間隔跑幾筆就開始回 429/403。查詢結果會寫進
scripts/.itunes_cache.json，被擋住時直接重跑即可從中斷處續跑。
"""
import json
import os
import re
import shutil
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'lyrics_data.db')
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.itunes_cache.json')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

KANA = re.compile(r'[぀-ヿ]')
# 「被翻譯過」的歌名長這樣:純英數與常見標點。有漢字/假名就代表原名還在,不必動
LATIN_TITLE = re.compile(r'^[\x20-\x7E]+$')

REQUEST_GAP = 3.0      # 實測 0.4 秒間隔跑幾筆就被整個 IP 擋掉，慢一點跑得完比快而全滅好
MAX_RETRY = 3
GIVE_UP_AFTER = 5      # 連續這麼多首查不到就整支中止（見 Blocked）


class Blocked(Exception):
    """iTunes 擋住這個 IP。**不要繼續逐首重試** —— 403 不是限流而是封鎖，
    每首硬等 42 秒既跑不完也只會延長封鎖。中止讓使用者晚點重跑，已查的都在快取裡。"""

# (資料表, 主鍵欄位, 內容欄位)。內容欄位有值代表 PK 撞到時要「留比較長的那份」——
# 沿用 merge_aliases.py 的慣例，實測長度差就是完整度差。
TABLES = [
    ('cache',               ('artist', 'title'),         'lyrics'),
    ('romaji_hints',        ('artist', 'title'),         'data'),
    ('llm_hints',           ('artist', 'title'),         'data'),
    ('lyrics_translations', ('artist', 'title'),         'data'),
    ('sync_offsets',        ('artist', 'title'),         None),
    ('word_corrections',    ('artist', 'title', 'word'), None),
]


def has_kana(s):
    return bool(KANA.search(s or ''))


def is_translated_title(s):
    """歌名整串都是英數/標點 = 被 Spotify 翻譯或羅馬字化過,才是這支要處理的對象"""
    return bool(LATIN_TITLE.match(s or ''))


def load_cache():
    try:
        with open(CACHE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)


def itunes_lookup(title, artist, cache):
    """
    查 iTunes JP 的第一個結果，回傳 (請求是否成功, 結果或 None)。

    **「查無此歌」與「請求失敗」一定要分開**：前者是確定的結論（記進快取，重跑不必再查），
    後者是暫時的（不記快取，而且連續幾次就代表被封鎖，要中止整支）。兩者都回 None 的話，
    一首冷門歌就會被算成封鎖跡象。
    """
    key = f'{artist} {title}'
    if key in cache:
        return True, cache[key]

    term = urllib.parse.quote(f'{title} {artist}')
    url = f'https://itunes.apple.com/search?term={term}&country=JP&entity=song&limit=1'
    delay = REQUEST_GAP
    for attempt in range(MAX_RETRY):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode('utf-8'))
            results = data.get('results') or []
            hit = None
            if results:
                h = results[0]
                hit = {
                    'title': h.get('trackName') or title,
                    'artist': h.get('artistName') or artist,
                    'duration': (h.get('trackTimeMillis') or 0) / 1000.0 or None,
                }
            cache[key] = hit
            save_cache(cache)
            time.sleep(REQUEST_GAP)
            return True, hit
        except urllib.error.HTTPError as e:
            # 429 = 太快，退避一下多半就過了。403 = 整個 IP 被封，退避沒有用
            if e.code == 429 and attempt < MAX_RETRY - 1:
                delay *= 2
                print(f'    被限流（HTTP 429），等 {delay:.0f} 秒再試…')
                time.sleep(delay)
                continue
            print(f'    iTunes 查詢失敗（HTTP {e.code}），跳過（**不記快取**，重跑會再試）')
            return False, None
        except Exception as e:
            print(f'    iTunes 查詢失敗（{e}），跳過（**不記快取**，重跑會再試）')
            return False, None
    return False, None


def decide(old_title, old_artist, hit, known_duration):
    """回傳 ('accept'|'review'|'skip', 理由)。條件見檔頭。"""
    if not hit:
        return 'skip', 'iTunes 查無結果'
    new_title, new_artist = hit['title'], hit['artist']
    if (new_title, new_artist) == (old_title, old_artist):
        return 'skip', '與原本相同'
    if not has_kana(new_title) and not has_kana(new_artist):
        return 'skip', '結果不含假名，不是日文歌'

    # **只認時長。** 形態證據 (含假名/含平假名) 實測會把另一首歌、翻唱、Live 版全部收進來
    if known_duration and hit.get('duration'):
        if abs(hit['duration'] - known_duration) <= 3:
            return 'accept', f'時長吻合（{known_duration:.0f}s ≈ {hit["duration"]:.0f}s）'
        return 'review', (f'時長對不上（{known_duration:.0f}s vs {hit["duration"]:.0f}s）'
                          '——可能是別的版本或翻唱')
    return 'review', '沒有時長可佐證（這首沒進過聆聽紀錄）'


def existing_tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


# server.js 的 writeListen 在拿不到時長時寫死這個值 (`Math.round(state.duration) || 180`)。
# 實測 386 筆裡有 69 筆剛好是它 —— 當成真時長比對的話,任何 177~183 秒的歌都會「吻合」。
UNKNOWN_DURATION = 180


def durations(conn, tables):
    """(artist, title) -> 曲目長度（秒）。listening_history 存的是曲目長度，不是聽了多久。"""
    if 'listening_history' not in tables:
        return {}
    out = {}
    for artist, title, dur in conn.execute(
            'SELECT artist, title, AVG(duration) FROM listening_history '
            'WHERE duration IS NOT NULL AND duration != ? GROUP BY artist, title',
            (UNKNOWN_DURATION,)):
        if dur:
            out[(artist, title)] = float(dur)
    return out


def merge_one(conn, old, new, tables, apply):
    """把 (artist,title) 從 old 搬到 new，回傳 (更新數, 合併刪除數)"""
    (o_artist, o_title), (n_artist, n_title) = old, new
    updated = deleted = 0

    # listening_history 沒有唯一鍵，直接改名不會撞
    if 'listening_history' in tables:
        n = conn.execute('SELECT COUNT(*) FROM listening_history WHERE artist=? AND title=?',
                         (o_artist, o_title)).fetchone()[0]
        if n:
            updated += n
            if apply:
                conn.execute('UPDATE listening_history SET artist=?, title=? WHERE artist=? AND title=?',
                             (n_artist, n_title, o_artist, o_title))

    for table, keys, value in TABLES:
        if table not in tables:
            continue
        rest = keys[2:]   # keys[0:2] 固定是 artist, title
        where_rest = ''.join(f' AND {k}=?' for k in rest)
        cols = ', '.join([*rest, value] if value else rest)
        sel = f'SELECT {cols} FROM {table}' if cols else f'SELECT 1 FROM {table}'
        rows = conn.execute(f'{sel} WHERE artist=? AND title=?', (o_artist, o_title)).fetchall()

        for row in rows:
            key_vals = tuple(row[:len(rest)])
            target = conn.execute(
                f'SELECT {value or "1"} FROM {table} WHERE artist=? AND title=?{where_rest}',
                (n_artist, n_title, *key_vals)
            ).fetchone()

            if target is None:                      # 日文名還沒有這列，直接改名
                updated += 1
                if apply:
                    conn.execute(
                        f'UPDATE {table} SET artist=?, title=? WHERE artist=? AND title=?{where_rest}',
                        (n_artist, n_title, o_artist, o_title, *key_vals))
                continue

            deleted += 1
            src_val = row[len(rest)] if value else None
            if value and len(src_val or '') > len(target[0] or ''):
                print(f'    {table}: 舊名那份比較完整'
                      f'（{len(src_val)} > {len(target[0] or "")}），覆蓋日文名那份')
                if apply:
                    conn.execute(
                        f'UPDATE {table} SET {value}=? WHERE artist=? AND title=?{where_rest}',
                        (src_val, n_artist, n_title, *key_vals))
            if apply:
                conn.execute(f'DELETE FROM {table} WHERE artist=? AND title=?{where_rest}',
                             (o_artist, o_title, *key_vals))

    return updated, deleted


def main():
    apply = '--apply' in sys.argv
    if apply:
        shutil.copy(DB, DB + '.bak')
        print(f'已備份 → {DB}.bak\n')
    else:
        print('*** dry-run，不會寫入。確認無誤後加 --apply ***\n')

    conn = sqlite3.connect(DB)
    conn.isolation_level = None
    tables = existing_tables(conn)
    dur_map = durations(conn, tables)

    # 候選：歌名是純英數的 (artist, title)。那才是被翻譯／羅馬字化過的樣子。
    # **純漢字歌名 (春泥棒、正義) 不算** —— 它們本來就是對的，放進來只會讓 iTunes
    # 回一首同歌手的別首歌，合併下去就是把歌詞蓋掉。
    seen = set()
    for t in ('cache', 'listening_history'):
        if t not in tables:
            continue
        for artist, title in conn.execute(f'SELECT DISTINCT artist, title FROM {t}'):
            if artist and title and is_translated_title(title):
                seen.add((artist, title))

    cache = load_cache()
    cached_n = sum(1 for a, t in seen if f'{a} {t}' in cache)
    print(f'候選（歌名不含假名）共 {len(seen)} 首，其中 {cached_n} 首已有查詢快取')
    print(f'每次請求間隔 {REQUEST_GAP:.0f} 秒，被擋住就直接重跑（會從中斷處續跑）\n')

    conn.execute('BEGIN')
    total_u = total_d = 0
    accepted, review = [], []
    blocked = False
    misses = 0
    try:
        for artist, title in sorted(seen):
            ok, hit = itunes_lookup(title, artist, cache)
            # 連續「請求失敗」才是封鎖跡象;「查無此歌」是正常結果,不能算進去
            misses = 0 if ok else misses + 1
            if misses >= GIVE_UP_AFTER:
                blocked = True
                break
            verdict, why = decide(title, artist, hit, dur_map.get((artist, title)))
            if verdict == 'skip':
                continue
            line = f'{artist} - {title}\n    → {hit["artist"]} - {hit["title"]}   [{why}]'
            if verdict == 'review':
                review.append(line)
                continue
            accepted.append(line)
            print(f'  {line}')
            u, d = merge_one(conn, (artist, title), (hit['artist'], hit['title']), tables, apply)
            total_u += u
            total_d += d
            print(f'    改名 {u} 列，合併刪除 {d} 列')
        conn.execute('COMMIT' if apply else 'ROLLBACK')
    except Exception:
        conn.execute('ROLLBACK')
        raise
    finally:
        save_cache(cache)

    if blocked:
        print(f'\n*** 連續 {GIVE_UP_AFTER} 首查不到，iTunes 應該擋住這個 IP 了，提早中止。***')
        print('    這不是資料的問題。等一段時間 (數十分鐘) 再重跑即可 ——')
        print(f'    已經查到的結果都在 {os.path.basename(CACHE_FILE)}，會從中斷處續跑。')
        if not apply:
            print('    (dry-run 本來就不寫入,這次沒有動到任何資料)')

    print(f'\n自動合併 {len(accepted)} 首：改名 {total_u} 列，合併刪除 {total_d} 列')
    if review:
        print(f'\n=== 需人工確認 {len(review)} 首（沒有動到，證據不夠硬）===')
        for line in review:
            print(f'  {line}')
        print('\n確認某首是對的，可以在 app 裡用「搜尋覆寫」修，或手動改 DB。')
    if not apply and accepted:
        print('\n確認無誤後加 --apply 實際寫入。')
    conn.close()


if __name__ == '__main__':
    main()
