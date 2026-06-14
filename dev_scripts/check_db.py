import sqlite3
conn = sqlite3.connect('C:/Users/USER/Desktop/Floating-Lyrics/lyrics_data.db')
cursor = conn.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
print(cursor.fetchall())
cursor.execute("PRAGMA table_info(lyrics);")
print(cursor.fetchall())
cursor.execute("SELECT * FROM lyrics WHERE title LIKE '%No.4%' OR artist LIKE '%Chevon%';")
rows = cursor.fetchall()
for row in rows:
    print(row)
