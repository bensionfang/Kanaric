/**
 * Floating-Lyrics 網頁管理後台 (Node.js + Express)
 * 負責提供網頁版的介面，包含：
 * 1. 橋接與攔截 Python 媒體監聽腳本的輸出。
 * 2. 將即時媒體狀態透過 WebSocket 廣播給網頁前端與動態島。
 * 3. 處理 SQLite 資料庫的存取 (聽歌歷史、歌詞快取)。
 * 4. 提供 RESTful API 供前端介面使用。
 */
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
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
/**
 * 啟動 Python 媒體監聽橋接器
 * 將 media_monitor.py 作為子進程啟動，並攔截其 stdout 輸出。
 * 解析出的 JSON 資料會更新到 currentMediaState，並存入歷史紀錄。
 */
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
          currentMediaState = { ...currentMediaState, ...state };
          
          if (global.broadcast) {
            global.broadcast({ type: 'media_state', state: currentMediaState });
          }
          
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
// 1. 取得目前音樂的狀態 (供前端初次載入時同步)
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
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.island_lines === undefined) data.island_lines = 2;
      res.json(data);
    } else {
      res.json({ island_lines: 2 });
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
    if (global.broadcast) {
      global.broadcast({ type: 'settings_updated', settings: newSettings });
    }
    res.json({ success: true, settings: newSettings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function autoMarkTitleLines(lrcText) {
  if (!lrcText) return lrcText;
  const keywords = ["作詞", "作词", "作曲", "編曲", "编曲", "製作", "制作", "混音", "演唱", "原唱", "vocal", "lyric", "music", "arrange", "mix", "mastering", "和聲", "和声", "企劃", "企划"];
  const lines = lrcText.split('\n');
  const newLines = [];
  for (let line of lines) {
    let stripped = line.trim();
    if (!stripped) {
      newLines.push(line);
      continue;
    }
    const match = stripped.match(/^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$/);
    if (match) {
      const tags = match[1];
      let text = match[2].trim();
      if (!text.startsWith("#TITLE#")) {
        const lowerText = text.toLowerCase();
        let isTitle = false;
        for (let kw of keywords) {
          if (lowerText.includes(kw) && text.length < 40) {
            // Ensure it's acting like a label
            const kwRegex = new RegExp(`${kw}\\s+`, 'i');
            if (/[:：]/.test(text) || kwRegex.test(lowerText) || text.length < kw.length + 5) {
              isTitle = true;
              break;
            }
          }
        }
        if (isTitle) {
          text = "#TITLE#" + text;
        }
      }
      newLines.push(`${tags}${text}`);
    } else {
      newLines.push(stripped);
    }
  }
  return newLines.join('\n');
}

function injectFurigana(artist, title, lyrics) {
  return new Promise((resolve) => {
    console.log("injectFurigana called for:", title, artist);
    const scriptPath = path.join(PARENT_DIR, 'furigana_inject.py');
    
    if (!fs.existsSync(scriptPath)) {
      console.log("scriptPath does not exist:", scriptPath);
      return resolve(lyrics);
    }
    
    const pyProcess = spawn(pythonCmd, [scriptPath], {
      cwd: PARENT_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    pyProcess.stdin.write(JSON.stringify({ artist, title, lyrics }));
    pyProcess.stdin.end();
    
    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    
    pyProcess.on('close', (code) => {
      console.log('Python script exited with code:', code, 'Output:', output.substring(0, 200));
      try {
        const parsed = JSON.parse(output);
        if (parsed.success && parsed.lyrics) {
          resolve(parsed.lyrics);
        } else {
          console.error("Python script failed:", parsed.error);
          resolve(lyrics);
        }
      } catch (e) {
        console.error('Error parsing furigana output:', e);
        console.error('Raw output was:', output);
        resolve(lyrics);
      }
    });
  });
}

function fetchFallback(title, artist, fetchAll = false) {
  return new Promise((resolve) => {
    const args = ['search_fallback.py', title, artist];
    if (fetchAll) args.push('--all');
    const pyProcess = spawn(pythonCmd, args, {
      cwd: PARENT_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    
    pyProcess.on('close', () => {
      try {
        const parsed = JSON.parse(output);
        if (fetchAll && parsed.success && parsed.results) {
            resolve(parsed.results);
        } else if (!fetchAll && parsed.success && parsed.lyrics) {
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

// 1.4 Get Furigana Candidates
app.get('/api/furigana/candidates', async (req, res) => {
  const { word } = req.query;
  if (!word) return res.json({ candidates: [] });
  try {
    const resp = await fetch('https://jisho.org/api/v1/search/words?keyword=' + encodeURIComponent(word));
    if (!resp.ok) return res.json({ candidates: [] });
    const data = await resp.json();
    let c = new Set();
    if (data && data.data) {
      data.data.forEach(item => {
        if (item.japanese) {
          item.japanese.forEach(j => {
            if (j.word === word && j.reading) c.add(j.reading);
          });
        }
      });
    }
    
    // Add pykakasi default reading
    const pyProcess = spawn(pythonCmd, ['-c', 'import sys, pykakasi; kks=pykakasi.kakasi(); res=kks.convert(sys.argv[1]); print("".join([item["hira"] for item in res]))', word]);
    let out = '';
    pyProcess.stdout.on('data', d => out += d.toString('utf-8'));
    pyProcess.on('close', () => {
      const kksRes = out.trim();
      let arr = [...c];
      if (kksRes && kksRes !== word) {
        if (arr.includes(kksRes)) arr = arr.filter(x => x !== kksRes);
        arr.unshift(kksRes);
      }
      res.json({ candidates: arr });
    });
  } catch(e) {
    res.json({ candidates: [] });
  }
});

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
    
    if (global.broadcast) {
      global.broadcast({ type: 'sync_offset_updated', title, artist, offset });
    }
    
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
        bestLyric = autoMarkTitleLines(bestLyric);
        await new Promise((resolve, reject) => {
          db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, bestLyric], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        const injected = await injectFurigana(artist, title, bestLyric);
        if (global.broadcast) {
            global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
        }
        return res.json({ lyrics: injected, source: sourceName });
      }
      
      if (global.broadcast) {
        global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
      }
      return res.json({ lyrics: "", source: 'not_found' });
    } catch (e) {
      console.error('Error fetching lyrics:', e);
      if (global.broadcast) {
        global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
      }
      return res.json({ lyrics: "", source: 'error' });
    }
  };

  if (force === 'true') {
    return performFetch();
  }
  
  // 1. Check DB first
  console.log("Querying DB for:", title, artist);
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    console.log("DB returned:", row ? "found" : "not found");
    if (row && row.lyrics) {
      const injected = await injectFurigana(artist, title, row.lyrics);
      return res.json({ lyrics: injected, source: 'cache' });
    }
    
// Not found, fetch
    return performFetch();
  });
});

app.get('/api/lyrics/options', async (req, res) => {
  const { title, artist, searchTitle, searchArtist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });
  
  try {
    const qTitle = searchTitle || title;
    const qArtist = searchArtist || artist;
    const cleanTitle = qTitle.replace(/\(feat\..*?\)|\- Remastered.*|\- Live.*/ig, '').trim();
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + qArtist)}`;
    
    let valid_lyrics = [];
    
    // Fetch from all fallback options
    try {
      const fbResults = await fetchFallback(qTitle, qArtist, true);
      if (fbResults && Array.isArray(fbResults)) {
        for (const fb of fbResults) {
            valid_lyrics.push({
              title: qTitle,
              artist: qArtist,
              album: '',
              duration: 0,
              lyrics: autoMarkTitleLines(`[source:${fb.source}]\n${fb.lyrics}`),
              isSynced: /\[\d{2}:\d{2}/.test(fb.lyrics),
              provider: fb.source,
              score: fb.source === 'Musixmatch' ? 2000 : 1500
            });
        }
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
          lyrics: autoMarkTitleLines(`[source:Lrclib]\n${best}`),
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
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
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
      dailyAvgMinutes: parseFloat(dailyAvgMinutes),
      appUptime: process.uptime(),
      activeDays: row.activeDays || 0
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
    SELECT strftime('%Y-%m-%d', played_at) AS play_date, COUNT(*) AS play_count, SUM(duration) AS duration_sum
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
      timelineData[dateString] = { count: 0, duration: 0 };
    }
    rows.forEach(row => {
      if (timelineData[row.play_date] !== undefined) {
        timelineData[row.play_date] = { count: row.play_count, duration: Math.round(row.duration_sum / 60) || 0 };
      }
    });
    
    const formattedData = Object.keys(timelineData).map(date => ({
      play_date: date,
      play_count: timelineData[date].count,
      duration_mins: timelineData[date].duration
    }));
    res.json(formattedData);
  });
});

app.get('/api/stats/advanced', (req, res) => {
  const p1 = new Promise((resolve) => {
    db.get('SELECT MAX(cnt) AS maxLoop FROM (SELECT COUNT(*) AS cnt FROM listening_history GROUP BY artist, title)', [], (err, row) => resolve(row ? row.maxLoop : 0));
  });
  const p2 = new Promise((resolve) => {
    db.all("SELECT strftime('%H', played_at) AS hour, COUNT(*) AS count FROM listening_history GROUP BY hour ORDER BY hour", [], (err, rows) => resolve(rows || []));
  });
  const p3 = new Promise((resolve) => {
    db.all("SELECT strftime('%w', played_at) AS dow, COUNT(*) AS count FROM listening_history GROUP BY dow ORDER BY dow", [], (err, rows) => resolve(rows || []));
  });
  
  Promise.all([p1, p2, p3]).then(results => {
    res.json({
      maxLoopCount: results[0] || 0,
      hourlyData: results[1],
      dowData: results[2]
    });
  });
});

app.get('/api/leaderboard', (req, res) => {
  const { type, range } = req.query;
  const validTypes = ['tracks', 'artists', 'albums'];
  const validRanges = ['all', 'year', '6m', '3m', '1m', '7d'];
  
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type parameter' });
  if (!validRanges.includes(range)) return res.status(400).json({ error: 'Invalid range parameter' });
  
  let dateFilter = '';
  if (range === '6m') {
    dateFilter = "WHERE played_at >= datetime('now', '-180 days')";
  } else if (range === '3m') {
    dateFilter = "WHERE played_at >= datetime('now', '-90 days')";
  } else if (range === '1m') {
    dateFilter = "WHERE played_at >= datetime('now', '-30 days')";
  } else if (range === '7d') {
    dateFilter = "WHERE played_at >= datetime('now', '-7 days')";
  } else if (range === 'year') {
    dateFilter = "WHERE strftime('%Y', played_at) = strftime('%Y', 'now')";
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

// 6. Launch/Toggle PyQt6
app.get('/api/desktop-status', (req, res) => {
  const pidFile = path.join(PARENT_DIR, 'app.pid');
  let isRunning = false;
  if (fs.existsSync(pidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      process.kill(existingPid, 0);
      isRunning = true;
    } catch (e) {
      isRunning = false;
    }
  }
  res.json({ isRunning });
});

app.post('/api/launch-pyqt6', (req, res) => {
  try {
    const pidFile = path.join(PARENT_DIR, 'app.pid');
    let isRunning = false;
    let existingPid = null;
    
    if (fs.existsSync(pidFile)) {
      try {
        existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        process.kill(existingPid, 0); // Check if process exists
        isRunning = true;
      } catch (e) {
        isRunning = false;
      }
    }
    
    if (isRunning) {
      try {
        process.kill(existingPid); // Terminate the process
      } catch (e) {}
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      return res.json({ success: true, action: 'stopped' });
    }

    const exePath = path.join(PARENT_DIR, 'DynamicIslandUI', 'bin', 'Release', 'net8.0-windows', 'DynamicIslandUI.exe');
    if (!fs.existsSync(exePath)) return res.status(404).json({ error: 'C# UI not found. Please build it first.' });
    
    // Minimize the active window (browser) using ctypes
    spawn(pythonCmd, ['-c', 'import ctypes; ctypes.windll.user32.ShowWindow(ctypes.windll.user32.GetForegroundWindow(), 6)'], { windowsHide: false });
    
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.join(PARENT_DIR, 'DynamicIslandUI', 'bin', 'Release', 'net8.0-windows') });
    child.unref();
    fs.writeFileSync(pidFile, child.pid.toString());
    res.json({ success: true, pid: child.pid, action: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Editor APIs
app.get('/api/lyrics/raw', (req, res) => {
  const { title, artist, plain } = req.query;
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row && row.lyrics) {
      let showFurigana = true;
      if (fs.existsSync(SETTINGS_FILE)) {
        try {
          const setts = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
          if (setts.show_furigana === false || setts.show_furigana === "false") {
            showFurigana = false;
          }
        } catch(e) {}
      }
      if (plain === 'true' || !showFurigana) {
        res.json({ lyrics: row.lyrics });
      } else {
        const injected = await injectFurigana(artist, title, row.lyrics);
        res.json({ lyrics: injected });
      }
    } else {
      res.json({ lyrics: "" });
    }
  });
});

app.post('/api/lyrics/update', (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (global.broadcast) {
      const injected = await injectFurigana(artist, title, lyrics);
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket client connected (Dynamic Island)');
  
  let currentSettings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try { currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
  }
  if (currentSettings.island_lines === undefined) currentSettings.island_lines = 2;
  
  ws.send(JSON.stringify({ type: 'init', state: currentMediaState, settings: currentSettings }));

  ws.on('close', () => {
    console.log('🔗 WebSocket client disconnected');
  });
});

global.broadcast = function(message) {
  const msgStr = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(msgStr);
    }
  });
};

server.listen(PORT, () => {
  console.log(`🚀 Web Server & WebSocket running on http://localhost:${PORT}`);
});
