const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || '../lyrics_data.db');
const PARENT_DIR = path.join(__dirname, '..');

// Global media state continuously updated by python script
let currentMediaState = {
  title: "",
  artist: "",
  position: 0.0,
  is_playing: false
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Database initialization
console.log(`Connecting to SQLite database at: ${DB_PATH}`);
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('✓ Connected to SQLite database');
    db.run('PRAGMA journal_mode=WAL;');
    
    db.run(`
      CREATE TABLE IF NOT EXISTS listening_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        duration INTEGER DEFAULT 180,
        played_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
});

// Start Media Monitor Bridge
function startMediaMonitor() {
  const monitorScript = path.join(PARENT_DIR, 'media_monitor.py');
  const venvPythonPath = path.join(PARENT_DIR, 'venv', 'Scripts', 'python.exe');
  const pythonCmd = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';
  
  if (!fs.existsSync(monitorScript)) {
    console.error('media_monitor.py not found at', monitorScript);
    return;
  }
  
  console.log(`Starting media monitor bridge: ${pythonCmd} ${monitorScript}`);
  const monitorProcess = spawn(pythonCmd, [monitorScript], {
    cwd: PARENT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  
  monitorProcess.stdout.on('data', (data) => {
    const lines = data.toString('utf-8').split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          currentMediaState = JSON.parse(line.trim());
        } catch (e) {
          // ignore parsing errors from partial lines
        }
      }
    }
  });
  
  monitorProcess.stderr.on('data', (data) => {
    console.error('Media Monitor Error:', data.toString('utf-8'));
  });
  
  monitorProcess.on('close', (code) => {
    console.log(`Media monitor bridge exited with code ${code}. Restarting in 3 seconds...`);
    setTimeout(startMediaMonitor, 3000);
  });
}

startMediaMonitor();

// Pages
app.get('/', (req, res) => {
  res.render('index', { activePage: 'home' });
});

app.get('/stats', (req, res) => {
  res.render('stats', { activePage: 'stats' });
});

// REST APIs
// 1. Get current media state
app.get('/api/current-media', (req, res) => {
  res.json(currentMediaState);
});

// 2. Fetch lyrics (checks DB, if missing fetches from lrclib)
app.get('/api/lyrics/fetch', async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });
  
  // 1. Check DB first
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (row && row.lyrics) {
      return res.json({ lyrics: row.lyrics, source: 'cache' });
    }
    
    // 2. Not in DB, fetch from lrclib
    try {
      const cleanTitle = title.replace(/\(feat\..*?\)|\- Remastered.*|\- Live.*/ig, '').trim();
      const apiUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(cleanTitle)}`;
      
      const lrclibResp = await fetch(apiUrl);
      if (lrclibResp.ok) {
        const data = await lrclibResp.json();
        const bestLyric = data.syncedLyrics || data.plainLyrics || "";
        
        // Save to DB
        if (bestLyric) {
          db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, bestLyric]);
          return res.json({ lyrics: bestLyric, source: 'lrclib' });
        }
      }
      return res.json({ lyrics: "", source: 'not_found' });
    } catch (e) {
      console.error('Error fetching lyrics from lrclib:', e);
      return res.json({ lyrics: "", source: 'error' });
    }
  });
});

// 3. Get all cached songs
app.get('/api/songs', (req, res) => {
  db.all('SELECT artist, title, SUBSTR(lyrics, 1, 100) AS lyric_snippet FROM cache', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 4. Record play event
app.post('/api/play-event', (req, res) => {
  const { artist, title, duration } = req.body;
  if (!artist || !title) return res.status(400).json({ error: 'Artist and Title required' });
  const songDuration = duration || 180;
  
  db.run(
    'INSERT INTO listening_history (artist, title, duration) VALUES (?, ?, ?)',
    [artist, title, songDuration],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 5. Stats APIs
app.get('/api/stats/summary', (req, res) => {
  const query = `
    SELECT 
      (SELECT COUNT(DISTINCT(title || ' - ' || artist)) FROM listening_history) AS totalSongs,
      COUNT(*) AS totalPlays,
      SUM(duration) AS totalTime
    FROM listening_history
  `;
  db.get(query, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ totalSongs: row.totalSongs || 0, totalPlays: row.totalPlays || 0, totalTime: row.totalTime || 0 });
  });
});

app.get('/api/stats/top-songs', (req, res) => {
  const query = `
    SELECT artist, title, COUNT(*) AS play_count, SUM(duration) AS total_duration
    FROM listening_history
    GROUP BY artist, title
    ORDER BY play_count DESC
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/stats/timeline', (req, res) => {
  const query = `
    SELECT strftime('%Y-%m-%d', played_at) AS play_date, COUNT(*) AS play_count
    FROM listening_history
    WHERE played_at >= date('now', '-7 days')
    GROUP BY play_date
    ORDER BY play_date ASC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const timelineData = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateString = d.toISOString().split('T')[0];
      timelineData[dateString] = 0;
    }
    rows.forEach(row => { if (timelineData[row.play_date] !== undefined) timelineData[row.play_date] = row.play_count; });
    
    const formattedData = Object.keys(timelineData).map(date => ({
      play_date: date,
      play_count: timelineData[date]
    }));
    res.json(formattedData);
  });
});

// 6. Launch PyQt6
app.post('/api/launch-pyqt6', (req, res) => {
  try {
    const mainPyPath = path.join(PARENT_DIR, 'main.py');
    const venvPythonPath = path.join(PARENT_DIR, 'venv', 'Scripts', 'python.exe');
    
    if (!fs.existsSync(mainPyPath)) return res.status(404).json({ error: 'main.py not found' });
    const pythonCmd = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';
    
    const child = spawn(pythonCmd, [mainPyPath], { detached: true, stdio: 'ignore', cwd: PARENT_DIR });
    child.unref();
    res.json({ success: true, pid: child.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Web Server running on http://localhost:${PORT}`);
});
