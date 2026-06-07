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

// Python Environment Detection
const venvPythonPath = path.join(PARENT_DIR, 'venv', 'Scripts', 'python.exe');
const pythonCmd = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

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
        if (!err) console.log('✓ Added album column to listening_history');
      });
    });
  }
});

// Start Media Monitor Bridge
function startMediaMonitor() {
  const monitorScript = path.join(PARENT_DIR, 'media_monitor.py');
  
  if (!fs.existsSync(monitorScript)) {
    console.error('media_monitor.py not found at', monitorScript);
    return;
  }
  
  console.log(`Starting media monitor bridge: ${pythonCmd} ${monitorScript}`);
  const monitorProcess = spawn(pythonCmd, [monitorScript], {
    cwd: PARENT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  
  let stdoutBuffer = '';
  let lastPlayedSongId = '';

  monitorProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Keep the last incomplete part in the buffer
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const state = JSON.parse(line.trim());
          currentMediaState = state;
          
          if (state.is_playing && state.title && state.artist) {
            const songId = `${state.title}-${state.artist}`;
            if (songId !== lastPlayedSongId) {
              lastPlayedSongId = songId;
              // default duration 180s since monitor doesn't provide it yet
              db.run(
                'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
                [state.artist, state.title, state.album || null, 180]
              );
            }
          } else if (!state.is_playing && !state.title) {
            // reset if nothing is playing to allow tracking same song if played again later
            lastPlayedSongId = '';
          }
        } catch (e) {
          // ignore parsing errors
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(currentMediaState);
});

const SETTINGS_FILE = path.join(PARENT_DIR, 'settings.json');

app.get('/api/settings', (req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      res.json(JSON.parse(data));
    } else {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    let currentSettings = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
    const newSettings = { ...currentSettings, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 4), 'utf8');
    res.json({ success: true, settings: newSettings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function injectFurigana(artist, title, lyrics) {
  return new Promise((resolve) => {
    const scriptPath = path.join(PARENT_DIR, 'furigana_inject.py');
    
    if (!fs.existsSync(scriptPath)) {
      return resolve(lyrics);
    }
    
    const pyProcess = spawn(pythonCmd, [scriptPath], {
      cwd: PARENT_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    
    pyProcess.on('close', (code) => {
      try {
        const parsed = JSON.parse(output);
        if (parsed.success && parsed.lyrics) {
          resolve(parsed.lyrics);
        } else {
          resolve(lyrics);
        }
      } catch (e) {
        console.error('Error parsing furigana output:', e);
        resolve(lyrics);
      }
    });
    
    pyProcess.stdin.write(JSON.stringify({ artist, title, lyrics }));
    pyProcess.stdin.end();
  });
}

function fetchFallback(title, artist) {
  return new Promise((resolve) => {
    const pyProcess = spawn(pythonCmd, ['search_fallback.py', title, artist], {
      cwd: PARENT_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    
    pyProcess.on('close', () => {
      try {
        const parsed = JSON.parse(output);
        if (parsed.success && parsed.lyrics) {
          resolve({ lyrics: parsed.lyrics, source: parsed.source || 'Fallback' });
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// 1.5 Update Furigana Correction
app.post('/api/furigana/correct', (req, res) => {
  const { artist, title, orig, hira } = req.body;
  if (!artist || !title || !orig) return res.status(400).json({ error: 'Missing parameters' });
  
  let finalHira = hira || '';
  if (finalHira) {
    const pyProcess = spawn(pythonCmd, ['-c', 'import sys, jaconv; print(jaconv.alphabet2kana(sys.argv[1]))', finalHira]);
    
    let out = '';
    pyProcess.stdout.on('data', (d) => out += d.toString());
    pyProcess.on('close', () => {
      finalHira = out.trim();
      saveCorrection();
    });
  } else {
    saveCorrection();
  }

  function saveCorrection() {
    db.run(
      'INSERT OR REPLACE INTO word_corrections (artist, title, word, hira) VALUES (?, ?, ?, ?)',
      [artist, title, orig, finalHira],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, hira: finalHira });
      }
    );
  }
});

// 2. Fetch lyrics (checks DB, if missing fetches from lrclib)

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

app.get('/api/lyrics/fetch', async (req, res) => {
  const { title, artist, force, searchTitle, searchArtist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });
  
  const performFetch = async () => {
    // 2. Not in DB or force fetch, fetch from lrclib
    try {
      const qTitle = searchTitle || title;
      const qArtist = searchArtist || artist;
      
      const cleanTitle = qTitle.replace(/\(feat\..*?\)|\- Remastered.*|\- Live.*/ig, '').trim();
      const apiUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(qArtist)}&track_name=${encodeURIComponent(cleanTitle)}`;
      
      const lrclibResp = await fetch(apiUrl);
      let bestLyric = "";
      let isLrclib = false;
      if (lrclibResp.ok) {
        const data = await lrclibResp.json();
        bestLyric = data.syncedLyrics || data.plainLyrics || "";
        if (bestLyric) isLrclib = true;
      }
      
      // Fallback to syncedlyrics & QQMusic
      if (!bestLyric) {
        const fbData = await fetchFallback(cleanTitle, qArtist);
        if (fbData && fbData.lyrics) {
          bestLyric = fbData.lyrics;
          isLrclib = false;
          // pass source to caller via side-effect or just handle below
          lrclibResp.fallbackSource = fbData.source;
        }
      }
      
      // Save to DB under ORIGINAL title/artist
      if (bestLyric) {
        const sourceName = isLrclib ? 'Lrclib' : (lrclibResp.fallbackSource || 'Fallback');
        bestLyric = `[source:${sourceName}]\n${bestLyric}`;
        db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, bestLyric]);
        const injected = await injectFurigana(artist, title, bestLyric);
        return res.json({ lyrics: injected, source: sourceName });
      }
      
      return res.json({ lyrics: "", source: 'not_found' });
    } catch (e) {
      console.error('Error fetching lyrics:', e);
      return res.json({ lyrics: "", source: 'error' });
    }
  };

  if (force === 'true') {
    return performFetch();
  }
  
  // 1. Check DB first
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (row && row.lyrics) {
      const injected = await injectFurigana(artist, title, row.lyrics);
      return res.json({ lyrics: injected, source: 'cache' });
    }
    
// Not found, fetch
    return performFetch();
  });
});

app.get('/api/lyrics/options', async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });
  
  try {
    const cleanTitle = title.replace(/\(feat\..*?\)|\- Remastered.*|\- Live.*/ig, '').trim();
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + artist)}`;
    
    let valid_lyrics = [];
    
    // Fetch QQ Music Options via fallback python script
    try {
      const fbData = await fetchFallback(title, artist);
      if (fbData && fbData.lyrics) {
        valid_lyrics.push({
          title: title,
          artist: artist,
          album: '',
          duration: 0,
          lyrics: `[source:${fbData.source}]\n${fbData.lyrics}`,
          isSynced: /\[\d{2}:\d{2}/.test(fbData.lyrics),
          provider: fbData.source,
          score: 1500 // give high score to QQMusic fallback
        });
      }
    } catch(e) {}
    
    const resp = await fetch(searchUrl);
    if (!resp.ok) return res.json({ options: [] });
    
    const data = await resp.json();
    
    for (const t of data) {
      const best = t.syncedLyrics || t.plainLyrics;
      if (best) {
        valid_lyrics.push({
          title: t.trackName || '',
          artist: t.artistName || '',
          album: t.albumName || '',
          duration: t.duration || 0,
          lyrics: `[source:Lrclib]\n${best}`,
          isSynced: !!t.syncedLyrics,
          provider: 'Lrclib'
        });
      }
    }
    
    // Scoring logic (matching python fetcher.py)
    const penalty_keywords = ['translated', 'translation', 'romanized', '翻譯', '中文版', 'english version'];
    valid_lyrics.forEach(item => {
      let score = 0;
      const iTitle = item.title.toLowerCase();
      const iArtist = item.artist.toLowerCase();
      const tTitle = cleanTitle.toLowerCase();
      const tArtist = artist.toLowerCase();
      
      if (tTitle === iTitle) score += 1000;
      else if (iTitle.includes(tTitle) || tTitle.includes(iTitle)) score += 500;
      
      if (tArtist === iArtist) score += 500;
      else if (iArtist.includes(tArtist) || tArtist.includes(iArtist)) score += 200;
      
      if (/[\u3040-\u30FF]/.test(item.lyrics)) score += 100;
      
      if (penalty_keywords.some(kw => iTitle.includes(kw))) score -= 800;
      if (penalty_keywords.some(kw => item.album.toLowerCase().includes(kw))) score -= 500;
      
      const lowerLyrics = item.lyrics.toLowerCase();
      if (lowerLyrics.includes('english translation') || lowerLyrics.includes('romanized') || lowerLyrics.includes('translation by')) score -= 800;
      
      item.score = score;
    });
    
    valid_lyrics.sort((a, b) => {
      if (a.isSynced !== b.isSynced) return b.isSynced ? 1 : -1;
      return b.score - a.score;
    });
    const top5 = valid_lyrics.slice(0, 5).map(x => ({
      title: x.title,
      artist: x.artist,
      album: x.album,
      duration: x.duration,
      lyrics: x.lyrics,
      score: x.score,
      provider: x.provider,
      isSynced: x.isSynced
    }));
    
    res.json({ options: top5 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/lyrics/custom', async (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing parameters' });
  
  try {
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    const injected = await injectFurigana(artist, title, lyrics);
    res.json({ success: true, lyrics: injected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    if (!fs.existsSync(mainPyPath)) return res.status(404).json({ error: 'main.py not found' });
    
    const venvPythonW = path.join(PARENT_DIR, 'venv', 'Scripts', 'pythonw.exe');
    const launchCmd = fs.existsSync(venvPythonW) ? venvPythonW : pythonCmd;
    
    // Minimize the active window (browser) using ctypes
    spawn(pythonCmd, ['-c', 'import ctypes; ctypes.windll.user32.ShowWindow(ctypes.windll.user32.GetForegroundWindow(), 6)'], { windowsHide: true });
    
    const child = spawn(launchCmd, [mainPyPath], { detached: true, stdio: 'ignore', cwd: PARENT_DIR, windowsHide: true });
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
