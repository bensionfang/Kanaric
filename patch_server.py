import re

with open('web-app/server.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Modify /api/lyrics/fetch to also return offset
# Wait, it's easier to just fetch the offset in a separate query inside the route, or a separate endpoint.
# A separate endpoint is cleaner: /api/lyrics/offset (GET and POST)

endpoint_code = """
app.get('/api/lyrics/offset', (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Missing parameters' });
  db.get('SELECT offset FROM sync_offsets WHERE title = ? AND artist = ?', [title, artist], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ offset: row ? row.offset : 0.0 });
  });
});

app.post('/api/lyrics/offset', (req, res) => {
  const { title, artist, offset } = req.body;
  if (!title || !artist || typeof offset !== 'number') return res.status(400).json({ error: 'Missing parameters' });
  db.run('INSERT OR REPLACE INTO sync_offsets (artist, title, offset) VALUES (?, ?, ?)', [artist, title, offset], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, offset });
  });
});

"""

if '/api/lyrics/offset' not in text:
    text = text.replace('app.get(\'/api/lyrics/fetch\'', endpoint_code + 'app.get(\'/api/lyrics/fetch\'')

with open('web-app/server.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
