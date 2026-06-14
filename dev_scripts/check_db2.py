import sqlite3
conn = sqlite3.connect('C:/Users/USER/Desktop/Floating-Lyrics/lyrics_data.db')
cursor = conn.cursor()
cursor.execute("PRAGMA table_info(cache);")
print("cache columns:", cursor.fetchall())
cursor.execute("SELECT * FROM cache WHERE title LIKE '%No.4%' OR artist LIKE '%Chevon%';")
rows = cursor.fetchall()
for row in rows:
    print(row)
