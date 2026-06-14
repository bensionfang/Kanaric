import sqlite3
conn = sqlite3.connect('lyrics_data.db')
conn.execute('CREATE TABLE IF NOT EXISTS artist_aliases (alias TEXT PRIMARY KEY, true_name TEXT)')
conn.execute("INSERT OR REPLACE INTO artist_aliases (alias, true_name) VALUES ('魚韻', 'サカナクション')")
conn.execute("INSERT OR REPLACE INTO artist_aliases (alias, true_name) VALUES ('綠黃色社會', '緑黄色社会')")
conn.execute("INSERT OR REPLACE INTO artist_aliases (alias, true_name) VALUES ('星期三的康帕內拉', '水曜日のカンパネラ')")
conn.commit()
conn.close()
print("Aliases added successfully!")
