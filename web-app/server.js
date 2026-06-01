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
    `, () => {
      // Alter table to add album column if it doesn't exist
      db.run('ALTER TABLE listening_history ADD COLUMN album TEXT', (err) => {
        if (err) {
          // Column already exists, ignore
        } else {
          console.log('✓ Added album column to listening_history');
        }
      });
    });
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

app.get('/leaderboard', (req, res) => {
  res.render('leaderboard', { activePage: 'leaderboard' });
});

app.get('/wrapped', (req, res) => {
  res.render('wrapped', { activePage: 'wrapped' });
});

app.get('/editor', (req, res) => {
  res.render('editor', { activePage: 'editor' });
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
  const { artist, title, album, duration } = req.body;
  if (!artist || !title) return res.status(400).json({ error: 'Artist and Title required' });
  const songDuration = duration || 180;
  
  db.run(
    'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
    [artist, title, album || null, songDuration],
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
      COUNT(*) AS totalPlays,
      COALESCE(SUM(duration), 0) AS totalTime,
      COUNT(DISTINCT artist) AS totalArtists,
      COUNT(DISTINCT(title || ' - ' || artist)) AS totalSongs,
      COUNT(DISTINCT strftime('%Y-%m-%d', played_at)) AS activeDays,
      -- Estimate unique albums (approx 75% of unique songs, minimum 1 if songs > 0)
      CASE 
        WHEN COUNT(DISTINCT(title || ' - ' || artist)) > 0 
        THEN CAST(COUNT(DISTINCT(title || ' - ' || artist)) * 0.75 + 0.5 AS INTEGER) 
        ELSE 0 
      END AS totalAlbums
    FROM listening_history
  `;
  db.get(query, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const activeDays = row.activeDays || 1;
    const totalPlays = row.totalPlays || 0;
    const totalTime = row.totalTime || 0;
    
    const dailyAvgPlays = (totalPlays / activeDays).toFixed(1);
    const dailyAvgMinutes = (totalTime / 60 / activeDays).toFixed(1);
    
    res.json({
      totalPlays,
      totalSongs: row.totalSongs || 0,
      totalTime,
      totalArtists: row.totalArtists || 0,
      totalAlbums: row.totalAlbums || 0,
      dailyAvgPlays: parseFloat(dailyAvgPlays),
      dailyAvgMinutes: parseFloat(dailyAvgMinutes)
    });
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

app.get('/api/stats/top-artists', (req, res) => {
  const query = `
    SELECT artist, COUNT(*) AS play_count, SUM(duration) AS total_duration
    FROM listening_history
    GROUP BY artist
    ORDER BY play_count DESC
    LIMIT 5
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

app.get('/api/leaderboard', (req, res) => {
  const { type, range } = req.query;
  const validTypes = ['tracks', 'artists', 'albums'];
  const validRanges = ['all', '6m', '1m'];
  
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type parameter' });
  if (!validRanges.includes(range)) return res.status(400).json({ error: 'Invalid range parameter' });
  
  let dateFilter = '';
  if (range === '6m') {
    dateFilter = "WHERE played_at >= datetime('now', '-180 days')";
  } else if (range === '1m') {
    dateFilter = "WHERE played_at >= datetime('now', '-30 days')";
  }
  
  let query = '';
  if (type === 'tracks') {
    query = `
      SELECT artist, title, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY artist, title
      ORDER BY count DESC
      LIMIT 50
    `;
  } else if (type === 'artists') {
    query = `
      SELECT artist, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY artist
      ORDER BY count DESC
      LIMIT 50
    `;
  } else if (type === 'albums') {
    query = `
      SELECT COALESCE(album, title || ' - Single') AS album, artist, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY album, artist
      ORDER BY count DESC
      LIMIT 50
    `;
  }
  
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
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

// 7. Editor APIs
app.get('/api/lyrics/raw', (req, res) => {
  const { title, artist } = req.query;
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ lyrics: row ? row.lyrics : "" });
  });
});

app.post('/api/lyrics/update', (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 8. Export Playlist API
app.get('/api/export-playlist', (req, res) => {
  const query = `
    SELECT artist, title
    FROM listening_history
    GROUP BY artist, title
    ORDER BY COUNT(*) DESC
    LIMIT 50
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).send('Database Error');
    let m3uContent = "#EXTM3U\n";
    rows.forEach(row => {
      m3uContent += `#EXTINF:-1,${row.artist} - ${row.title}\n${row.artist} - ${row.title}.mp3\n`;
    });
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="top50.m3u"');
    res.send(m3uContent);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Web Server running on http://localhost:${PORT}`);
});
