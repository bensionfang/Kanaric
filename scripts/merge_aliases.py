"""
依 artist_aliases 把歷史資料裡的歌手別名收斂成正規名，一次性清理。

server.js 現在會在 handleMediaUpdate 就把歌手名收斂掉，新資料不會再分裂；
這支處理的是改動之前就已經用兩種寫法存進去的舊列。

    python scripts/merge_aliases.py            # dry-run，只印出會做什麼
    python scripts/merge_aliases.py --apply    # 備份後實際寫入

也會掃出「同一首歌名底下出現兩個歌手寫法、但 artist_aliases 沒收錄」的候選對，
方便補進別名表後再跑一次。
"""
import os
import re
import shutil
import sqlite3
import sys
from collections import defaultdict

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lyrics_data.db')

# 方向一律收斂到原文名，與 artist_aliases 現有 6 筆的慣例一致
NEW_ALIASES = [
    ('ZUTOMAYO', 'ずっと真夜中でいいのに。'),
    ('Fujii Kaze', '藤井 風'),
    ('Jay Chou', '周杰倫'),
    ('Hoshimachi Suisei', '星街すいせい'),
    ('RETRORIRON', 'レトロリロン'),
]

# (資料表, 主鍵欄位, 內容欄位)。內容欄位有值代表 PK 撞到時要「留比較長的那份」——
# 實測長度差就是完整度差 (星街すいせい 的『星をみる少女』一份 32 字元、一份 1531)。
# 內容欄位為 None 代表撞到就保留原本的目標列、丟掉別名那列。
TABLES = [
    ('cache',            ('artist', 'title'),         'lyrics'),
    ('romaji_hints',     ('artist', 'title'),         'data'),
    ('llm_hints',        ('artist', 'title'),         'data'),
    ('sync_offsets',     ('artist', 'title'),         None),
    ('word_corrections', ('artist', 'title', 'word'), None),
]


def norm_title(t):
    t = re.sub(r'[(（\[【].*?[)）\]】]', '', (t or '').lower())
    return re.sub(r'[^0-9a-z぀-ヿ一-鿿]', '', t)


def suggest(conn, aliases):
    """找出同一首歌名下有多個歌手寫法、而別名表沒收錄的候選對"""
    groups = defaultdict(set)
    for table in ('cache', 'listening_history'):
        for artist, title in conn.execute(f'SELECT DISTINCT artist, title FROM {table}'):
            groups[norm_title(title)].add(artist)
    out = []
    for artists in groups.values():
        if len(artists) < 2:
            continue
        pair = tuple(sorted(artists))
        if any(a in aliases for a in pair):
            continue
        if pair not in out:
            out.append(pair)
    return out


def merge(conn, alias, true_name, apply):
    """把單一 alias 的所有舊列搬到正規名底下，回傳 (更新數, 刪除數)"""
    updated = deleted = 0

    # listening_history 沒有唯一鍵，直接改名不會撞
    n = conn.execute('SELECT COUNT(*) FROM listening_history WHERE artist=?', (alias,)).fetchone()[0]
    if n:
        updated += n
        if apply:
            conn.execute('UPDATE listening_history SET artist=? WHERE artist=?', (true_name, alias))

    for table, keys, value in TABLES:
        rest = keys[1:]  # keys[0] 固定是 artist
        where_rest = ' AND '.join(f'{k}=?' for k in rest)
        cols = ', '.join(rest) + (f', {value}' if value else '')
        rows = conn.execute(f'SELECT {cols} FROM {table} WHERE artist=?', (alias,)).fetchall()
        for row in rows:
            key_vals = row[:len(rest)]
            target = conn.execute(
                f'SELECT {value or "1"} FROM {table} WHERE artist=? AND {where_rest}',
                (true_name, *key_vals)
            ).fetchone()

            if target is None:                      # 正規名還沒有這列，直接改名
                updated += 1
                if apply:
                    conn.execute(f'UPDATE {table} SET artist=? WHERE artist=? AND {where_rest}',
                                 (true_name, alias, *key_vals))
                continue

            deleted += 1
            src_val = row[len(rest)] if value else None
            if value and len(src_val or '') > len(target[0] or ''):
                print(f'    {table}: {key_vals} 別名那份比較完整 '
                      f'({len(src_val)} > {len(target[0] or "")})，覆蓋正規名那份')
                if apply:
                    conn.execute(f'UPDATE {table} SET {value}=? WHERE artist=? AND {where_rest}',
                                 (src_val, true_name, *key_vals))
            if apply:
                conn.execute(f'DELETE FROM {table} WHERE artist=? AND {where_rest}',
                             (alias, *key_vals))

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
    conn.execute('BEGIN')
    try:
        for alias, true_name in NEW_ALIASES:
            exists = conn.execute('SELECT 1 FROM artist_aliases WHERE alias=?', (alias,)).fetchone()
            if not exists:
                print(f'新增別名 {alias} → {true_name}')
                if apply:
                    conn.execute('INSERT INTO artist_aliases VALUES (?, ?)', (alias, true_name))

        aliases = dict(conn.execute('SELECT alias, true_name FROM artist_aliases'))
        aliases.update(dict(NEW_ALIASES))

        total_u = total_d = 0
        for alias, true_name in sorted(aliases.items()):
            u, d = merge(conn, alias, true_name, apply)
            if u or d:
                print(f'  {alias} → {true_name}: 改名 {u} 列，合併刪除 {d} 列')
            total_u += u
            total_d += d
        print(f'\n合計：改名 {total_u} 列，合併刪除 {total_d} 列')

        conn.execute('COMMIT' if apply else 'ROLLBACK')
    except Exception:
        conn.execute('ROLLBACK')
        raise

    pending = suggest(conn, aliases)
    if pending:
        print('\n以下歌手寫法看起來是同一位但別名表沒收錄，確認後可加進 NEW_ALIASES 再跑一次：')
        for pair in pending:
            print('  ', ' / '.join(pair))
    conn.close()


if __name__ == '__main__':
    main()
