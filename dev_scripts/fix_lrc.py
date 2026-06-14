import sqlite3
import re

conn = sqlite3.connect('C:/Users/USER/Desktop/Floating-Lyrics/lyrics_data.db')
cursor = conn.cursor()

cursor.execute("SELECT artist, title, lyrics FROM cache WHERE title = 'No.4' AND artist = 'Chevon';")
rows = cursor.fetchall()

for row in rows:
    artist, title, lyrics = row
    
    # Process lyrics to add space after timestamp if missing
    new_lyrics_lines = []
    for line in lyrics.split('\n'):
        # Match standard LRC time tags like [00:00.00] or [00:00:00]
        # and capture the text after it.
        match = re.match(r'^(\[\d{2}:\d{2}[:\.]\d{2,3}\])(.*)', line)
        if match:
            time_tag = match.group(1)
            text = match.group(2)
            if len(text) > 0 and not text.startswith(' '):
                new_line = f"{time_tag} {text}"
            else:
                new_line = line
            new_lyrics_lines.append(new_line)
        else:
            new_lyrics_lines.append(line)
            
    new_lyrics = '\n'.join(new_lyrics_lines)
    
    cursor.execute("UPDATE cache SET lyrics = ? WHERE artist = ? AND title = ?", (new_lyrics, artist, title))
    print(f"Updated lyrics for {artist} - {title}")

conn.commit()
conn.close()
