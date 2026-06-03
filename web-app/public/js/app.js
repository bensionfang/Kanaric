let lastMediaTitle = "";
let lastMediaArtist = "";
let parsedLyrics = [];
let activeLyricIndex = -1;
let songDurationSeconds = 180; // Estimated or default
let isUnsyncedLyrics = false;

// Client-side interpolation state
let currentInterpolatedPosition = 0;
let lastServerPosition = -1;
let lastFrameTime = performance.now();
let isCurrentlyPlaying = false;

document.addEventListener('DOMContentLoaded', () => {
    // Start polling the system media every 100ms for smooth updates
    setInterval(pollSystemMedia, 100);
    
    // High-frequency rAF loop for smooth lyrics interpolation
    function syncLoop() {
        const now = performance.now();
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        
        if (isCurrentlyPlaying && parsedLyrics.length > 0) {
            currentInterpolatedPosition += dt;
            syncLyricsToTime(currentInterpolatedPosition);
            updatePlaybackProgress(currentInterpolatedPosition);
        }
        requestAnimationFrame(syncLoop);
    }
    requestAnimationFrame(syncLoop);
    
    // Initial load and auto refresh of sidebar leaderboard
    loadSidebarLeaderboard();
    setInterval(loadSidebarLeaderboard, 15000);

    // Initialize zoom mode if persisted
    if (localStorage.getItem('zoomModeActive') === 'true') {
        document.body.classList.add('window-maximized');
        const playerCard = document.querySelector('.player-lyrics-card');
        if (playerCard) playerCard.classList.add('window-maximized');
    }
});



function showToast(message, iconClass = 'fa-solid fa-circle-info', duration = 3500) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-message');
    icon.className = iconClass;
    msg.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
}

function reloadCurrentLyrics() {
    if (lastMediaTitle) {
        showToast(`重新載入: ${lastMediaTitle}`, 'fa-solid fa-rotate', 2000);
        fetchAndParseLyrics(lastMediaTitle, lastMediaArtist);
    } else {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
    }
}

// -------------------------------------------------------------
// Advanced Lyrics Modal
// -------------------------------------------------------------
function openLyricsModal() {
    const modal = document.getElementById('lyrics-options-modal');
    modal.classList.remove('hidden');
    modal.classList.add('show');
    // Pre-fill manual search fields with current song
    if (lastMediaTitle) {
        const titleInput = document.getElementById('manual-title');
        const artistInput = document.getElementById('manual-artist');
        if (titleInput && !titleInput.value) titleInput.value = lastMediaTitle;
        if (artistInput && !artistInput.value) artistInput.value = lastMediaArtist;
    }
}

function closeLyricsModal() {
    const modal = document.getElementById('lyrics-options-modal');
    modal.classList.remove('show');
    setTimeout(() => modal.classList.add('hidden'), 300);
}

async function performGetOptions() {
    if (!lastMediaTitle) {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
        return;
    }
    const listEl = document.getElementById('lyrics-options-list');
    listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</div>`;
    try {
        const resp = await fetch(`/api/lyrics/options?title=${encodeURIComponent(lastMediaTitle)}&artist=${encodeURIComponent(lastMediaArtist)}`);
        const data = await resp.json();
        if (!data.options || data.options.length === 0) {
            listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-face-frown"></i> 找不到備選歌詞</div>`;
            return;
        }
        listEl.innerHTML = data.options.map((opt, i) => `
            <div style="background: var(--bg-main); border: 1px solid var(--panel-border); border-radius: 6px; padding: 10px 12px; cursor: pointer; transition: border-color 0.2s; display: flex; justify-content: space-between; align-items: center;"
                 onmouseenter="this.style.borderColor='var(--accent-main)'" onmouseleave="this.style.borderColor='var(--panel-border)'"
                 onclick="applyLyricsOption(${i})">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.title}</div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.artist}${opt.album ? ' · ' + opt.album : ''}</div>
                </div>
                <div style="margin-left: 10px; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; ${opt.isSynced ? 'background: rgba(76, 175, 80, 0.15); color: #4caf50;' : 'background: rgba(158, 158, 158, 0.15); color: #9e9e9e;'}">
                    ${opt.isSynced ? 'LRC' : 'TXT'}
                </div>
            </div>
        `).join('');
        // Store options for later use
        window._lyricsOptions = data.options;
    } catch (e) {
        listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-triangle-exclamation"></i> 載入失敗</div>`;
    }
}

async function applyLyricsOption(index) {
    const opt = window._lyricsOptions && window._lyricsOptions[index];
    if (!opt) return;
    closeLyricsModal();
    showToast(`套用: ${opt.title}`, 'fa-solid fa-check', 2000);
    // Save as custom lyrics for current song
    try {
        await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: lastMediaTitle, artist: lastMediaArtist, lyrics: opt.lyrics })
        });
        parseLrcLyrics(opt.lyrics);
        renderLyrics();
    } catch (e) {
        showToast('套用失敗', 'fa-solid fa-xmark', 2000);
    }
}

async function performManualSearch() {
    const title = document.getElementById('manual-title').value.trim();
    const artist = document.getElementById('manual-artist').value.trim();
    if (!title) { showToast('請輸入歌曲名稱', 'fa-solid fa-circle-exclamation', 2000); return; }
    closeLyricsModal();
    showToast(`搜尋: ${title}`, 'fa-solid fa-search', 2000);
    try {
        const resp = await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(lastMediaTitle || title)}&artist=${encodeURIComponent(lastMediaArtist || artist)}&force=true&searchTitle=${encodeURIComponent(title)}&searchArtist=${encodeURIComponent(artist)}`);
        const data = await resp.json();
        if (data.lyrics) {
            parseLrcLyrics(data.lyrics);
            renderLyrics();
            showToast('歌詞載入成功', 'fa-solid fa-check', 2000);
        } else {
            showToast('找不到歌詞', 'fa-solid fa-face-frown', 2500);
        }
    } catch (e) {
        showToast('搜尋失敗', 'fa-solid fa-xmark', 2000);
    }
}

async function performCustomLyrics() {
    const lyricsText = document.getElementById('custom-lyrics-text').value.trim();
    if (!lyricsText) { showToast('請貼上歌詞內容', 'fa-solid fa-circle-exclamation', 2000); return; }
    if (!lastMediaTitle) { showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000); return; }
    closeLyricsModal();
    try {
        const resp = await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: lastMediaTitle, artist: lastMediaArtist, lyrics: lyricsText })
        });
        const data = await resp.json();
        if (data.lyrics) {
            parseLrcLyrics(data.lyrics);
            renderLyrics();
            showToast('自訂歌詞套用成功', 'fa-solid fa-check', 2000);
        } else {
            parseLrcLyrics(lyricsText);
            renderLyrics();
            showToast('歌詞套用成功', 'fa-solid fa-check', 2000);
        }
    } catch (e) {
        showToast('套用失敗', 'fa-solid fa-xmark', 2000);
    }
}


// -------------------------------------------------------------
// Live Sync Logic
// -------------------------------------------------------------
async function pollSystemMedia() {
    try {
        const resp = await fetch('/api/current-media', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        
        const dot = document.getElementById('sync-dot');
        const statusText = document.getElementById('sync-status-text');
        
        if (data.is_playing) {
            dot.classList.add('active');
            statusText.textContent = `即時同步中...`;
            document.getElementById('vinyl-disc').classList.add('playing');
        } else {
            dot.classList.remove('active');
            statusText.textContent = data.title ? `音樂已暫停` : `等待播放...`;
            document.getElementById('vinyl-disc').classList.remove('playing');
        }

        // Update interpolation state from server
        isCurrentlyPlaying = data.is_playing;
        if (data.title) {
            if (data.position !== lastServerPosition) {
                const diff = data.position - currentInterpolatedPosition;
                if (Math.abs(diff) > 1.5 || data.title !== lastMediaTitle) {
                    // Hard sync on seek or track change
                    currentInterpolatedPosition = data.position;
                } else {
                    // Smoothly correct 50% of the small drift
                    currentInterpolatedPosition += diff * 0.5;
                }
                lastServerPosition = data.position;
            }
        }
        if (data.title && (data.title !== lastMediaTitle || data.artist !== lastMediaArtist)) {
            lastMediaTitle = data.title;
            lastMediaArtist = data.artist;
            
            document.getElementById('current-title').textContent = data.title;
            document.getElementById('current-artist').textContent = data.artist || 'Unknown Artist';
            
            const coverImg = document.getElementById('album-cover');
            if (data.thumbnail) {
                coverImg.src = 'data:image/jpeg;base64,' + data.thumbnail;
            } else {
                coverImg.src = 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=300&auto=format&fit=crop';
            }
            
            fetchAndParseLyrics(data.title, data.artist);
            loadSidebarLeaderboard();
        } else if (!data.title && lastMediaTitle) {
            // Stopped completely
            lastMediaTitle = "";
            lastMediaArtist = "";
            document.getElementById('current-title').textContent = "--";
            document.getElementById('current-artist').textContent = "--";
            parsedLyrics = [];
            renderLyrics();
            loadSidebarLeaderboard();
        }
        
        // Progress is now handled by the rAF interpolation loop
        
    } catch (err) {
        // Ignore polling errors
    }
}

async function fetchAndParseLyrics(title, artist) {
    const scrollPane = document.getElementById('lyrics-scroll');
    scrollPane.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> 正在搜尋歌詞...</div>`;
    parsedLyrics = [];
    
    try {
        const resp = await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.lyrics) {
                parseLrcLyrics(data.lyrics);
                renderLyrics();
                if (parsedLyrics.length > 0) {
                    const lastLyricTime = parsedLyrics[parsedLyrics.length - 1].time;
                    songDurationSeconds = Math.max(120, Math.round(lastLyricTime + 15));
                }
            } else {
                scrollPane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-face-frown"></i><p>找不到此歌曲的歌詞</p></div>`;
            }
        } else {
            scrollPane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-face-frown"></i><p>找不到歌詞</p></div>`;
        }
    } catch (e) {
        scrollPane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>載入歌詞出錯</p></div>`;
    }
}

function parseLrcLyrics(lrcText) {
    parsedLyrics = [];
    isUnsyncedLyrics = false;
    if (!lrcText) return;
    
    const lines = lrcText.split('\n');
    const timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
    
    let hasTags = false;
    
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        
        let match;
        const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
        
        timeReg.lastIndex = 0;
        let lineHasTag = false;
        while ((match = timeReg.exec(line)) !== null) {
            hasTags = true;
            lineHasTag = true;
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = match[3] ? parseInt(match[3]) : 0;
            const timeInSeconds = minutes * 60 + seconds + (ms / 100);
            parsedLyrics.push({ time: timeInSeconds, text: text || '♫' });
        }
    });
    
    if (!hasTags) {
        // If no LRC tags were found, treat it as unsynced plain text
        isUnsyncedLyrics = true;
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
                parsedLyrics.push({ time: -1, text: trimmed });
            }
        });
    } else {
        parsedLyrics.sort((a, b) => a.time - b.time);
    }
}

function renderLyrics() {
    const pane = document.getElementById('lyrics-scroll');
    if (parsedLyrics.length === 0) {
        if (lastMediaTitle) {
            pane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-music"></i><p>純音樂，無人聲歌詞</p></div>`;
        } else {
            pane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-music"></i><p>等待播放...</p></div>`;
        }
        return;
    }
    
    pane.innerHTML = parsedLyrics.map((lyric, index) => {
        return `<div class="lyrics-line ${isUnsyncedLyrics ? 'active' : ''}" id="lyric-line-${index}">${lyric.text}</div>`;
    }).join('');
    activeLyricIndex = -1;
}

function updatePlaybackProgress(position) {
    const slider = document.getElementById('progress-slider');
    const fill = document.getElementById('progress-fill');
    const currentTimeEl = document.getElementById('current-time');
    
    // Estimate total time based on current position and song duration
    const actualDuration = Math.max(songDurationSeconds, position + 10);
    
    const percentage = (position / actualDuration) * 100;
    slider.value = percentage;
    fill.style.width = `${Math.min(100, percentage)}%`;
    currentTimeEl.textContent = formatTime(position);
}

function syncLyricsToTime(position) {
    if (parsedLyrics.length === 0 || isUnsyncedLyrics) return;
    
    let foundIndex = -1;
    for (let i = 0; i < parsedLyrics.length; i++) {
        if (position >= parsedLyrics[i].time) {
            foundIndex = i;
        } else {
            break;
        }
    }
    
    if (foundIndex !== activeLyricIndex) {
        if (activeLyricIndex >= 0) {
            const prevLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
            if (prevLine) prevLine.classList.remove('active');
        }
        
        activeLyricIndex = foundIndex;
        
        if (activeLyricIndex >= 0) {
            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
            if (currentLine) {
                currentLine.classList.add('active');
                
                const pane = document.getElementById('lyrics-scroll');
                const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
                pane.scrollTo({
                    top: Math.max(0, scrollOffset),
                    behavior: 'smooth'
                });
            }
        }
    }
}

// -------------------------------------------------------------
// Desktop Launch Logic
// -------------------------------------------------------------
async function launchPyQt6() {
    const btn = document.getElementById('launch-desktop-btn');
    if (btn) {
        btn.setAttribute('disabled', 'true');
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 正在啟動...`;
    }
    
    try {
        const resp = await fetch('/api/launch-pyqt6', { method: 'POST' });
        const result = await resp.json();
        
        if (resp.ok && result.success) {
            showToast('桌面版已成功啟動！', 'fa-solid fa-rocket');
        } else {
            showToast('啟動桌面版失敗。', 'fa-solid fa-circle-xmark');
        }
    } catch (err) {
        showToast('連線失敗。', 'fa-solid fa-circle-xmark');
    } finally {
        setTimeout(() => {
            if (btn) {
                btn.removeAttribute('disabled');
                btn.innerHTML = `<i class="fa-solid fa-desktop"></i> 桌面版`;
            }
        }, 1500);
    }
}

function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

// -------------------------------------------------------------
// Sidebar Leaderboard Logic
// -------------------------------------------------------------
let sidebarType = 'tracks';
let sidebarRange = 'all';

async function loadSidebarLeaderboard() {
    const listContainer = document.getElementById('sidebar-leaderboard-list');
    if (!listContainer) return;

    try {
        const resp = await fetch(`/api/leaderboard?type=${sidebarType}&range=${sidebarRange}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.length === 0) {
                listContainer.innerHTML = `<div class="song-item-empty">此區間暫無播放紀錄</div>`;
                return;
            }

            listContainer.innerHTML = data.map((item, index) => {
                let displayTitle = '';
                let displaySub = '';

                if (sidebarType === 'tracks') {
                    displayTitle = item.title;
                    displaySub = item.artist;
                } else if (sidebarType === 'artists') {
                    displayTitle = item.artist;
                    displaySub = '不重複藝人';
                } else if (sidebarType === 'albums') {
                    displayTitle = item.album;
                    displaySub = item.artist;
                }

                // Make active playing song stand out on the leaderboard!
                const isActive = sidebarType === 'tracks' && 
                                 displayTitle === lastMediaTitle && 
                                 displaySub === lastMediaArtist;

                return `
                    <div class="song-item ${isActive ? 'active' : ''}">
                        <div class="song-icon">
                            ${index + 1}
                        </div>
                        <div class="song-meta-text">
                            <span class="song-item-title">${escapeHtml(displayTitle)}</span>
                            <span class="song-item-artist">${escapeHtml(displaySub)}</span>
                        </div>
                        <div style="font-size: 11px; font-weight: 500; color: var(--accent-main); text-align: right; min-width: 45px;">
                            ${item.count}次
                        </div>
                    </div>
                `;
            }).join('');
        }
    } catch (e) {
        listContainer.innerHTML = `<div class="song-item-empty" style="color: #f87171;">載入排行失敗</div>`;
    }
}

function changeSidebarType(type) {
    sidebarType = type;
    const tabs = document.querySelectorAll('#sidebar-type-tabs .mode-tab');
    tabs.forEach(tab => {
        if (tab.getAttribute('data-type') === type) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    loadSidebarLeaderboard();
}

function changeSidebarRange(range) {
    sidebarRange = range;
    const tabs = document.querySelectorAll('#sidebar-range-tabs .mode-tab');
    tabs.forEach(tab => {
        if (tab.getAttribute('data-range') === range) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    loadSidebarLeaderboard();
}

let currentEditingRuby = null;

document.getElementById('lyrics-scroll').addEventListener('click', (e) => {
    const ruby = e.target.closest('ruby');
    if (ruby) {
        currentEditingRuby = ruby;
        
        const clone = ruby.cloneNode(true);
        const rtNode = clone.querySelector('rt');
        if (rtNode) clone.removeChild(rtNode);
        const kanji = clone.textContent.trim();
        
        const currentRt = ruby.querySelector('rt') ? ruby.querySelector('rt').textContent : '';
        
        document.getElementById('ruby-edit-kanji').textContent = kanji;
        document.getElementById('ruby-edit-rt').value = currentRt;
        document.getElementById('ruby-edit-modal').classList.remove('hidden');
        document.getElementById('ruby-edit-modal').classList.add('show');
        
        setTimeout(() => document.getElementById('ruby-edit-rt').focus(), 100);
    }
});

function closeRubyModal() {
    const modal = document.getElementById('ruby-edit-modal');
    modal.classList.remove('show');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentEditingRuby = null;
}

function romajiToHiragana(text) {
    text = text.toLowerCase();
    text = text.replace(/([bcdfghjklmpqrstvwxyz])\1/g, 'っ$1');
    
    const mapping = {
        'kya':'きゃ', 'kyu':'きゅ', 'kyo':'きょ',
        'sha':'しゃ', 'shu':'しゅ', 'sho':'しょ',
        'cha':'ちゃ', 'chu':'ちゅ', 'cho':'ちょ',
        'nya':'にゃ', 'nyu':'にゅ', 'nyo':'にょ',
        'hya':'ひゃ', 'hyu':'ひゅ', 'hyo':'ひょ',
        'mya':'みゃ', 'myu':'みゅ', 'myo':'みょ',
        'rya':'りゃ', 'ryu':'りゅ', 'ryo':'りょ',
        'gya':'ぎゃ', 'gyu':'ぎゅ', 'gyo':'ぎょ',
        'ja':'じゃ', 'ju':'じゅ', 'jo':'じょ', 'jya':'じゃ', 'jyu':'じゅ', 'jyo':'じょ',
        'bya':'びゃ', 'byu':'びゅ', 'byo':'びょ',
        'pya':'ぴゃ', 'pyu':'ぴゅ', 'pyo':'ぴょ',
        'shi':'し', 'chi':'ち', 'tsu':'つ',
        'ka':'か', 'ki':'き', 'ku':'く', 'ke':'け', 'ko':'こ',
        'sa':'さ', 'su':'す', 'se':'せ', 'so':'そ',
        'ta':'た', 'te':'て', 'to':'と',
        'na':'な', 'ni':'に', 'nu':'ぬ', 'ne':'ね', 'no':'の',
        'ha':'は', 'hi':'ひ', 'fu':'ふ', 'hu':'ふ', 'he':'へ', 'ho':'ほ',
        'ma':'ま', 'mi':'み', 'mu':'む', 'me':'め', 'mo':'も',
        'ya':'や', 'yu':'ゆ', 'yo':'よ',
        'ra':'ら', 'ri':'り', 'ru':'る', 're':'れ', 'ro':'ろ',
        'wa':'わ', 'wo':'を', 'n':'ん',
        'ga':'が', 'gi':'ぎ', 'gu':'ぐ', 'ge':'げ', 'go':'ご',
        'za':'ざ', 'ji':'じ', 'zu':'ず', 'ze':'ぜ', 'zo':'ぞ',
        'da':'だ', 'de':'で', 'do':'ど',
        'ba':'ば', 'bi':'び', 'bu':'ぶ', 'be':'べ', 'bo':'ぼ',
        'pa':'ぱ', 'pi':'ぴ', 'pu':'ぷ', 'pe':'ぺ', 'po':'ぽ',
        'a':'あ', 'i':'い', 'u':'う', 'e':'え', 'o':'お',
        '-':'ー'
    };
    
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(keys.join('|'), 'g');
    
    return text.replace(pattern, m => mapping[m]);
}

document.getElementById('ruby-edit-rt').addEventListener('input', (e) => {
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const oldLength = input.value.length;
    
    input.value = romajiToHiragana(input.value);
    
    const newLength = input.value.length;
    const diff = newLength - oldLength;
    input.setSelectionRange(start + diff, end + diff);
});

async function saveRubyEdit() {
    if (!currentEditingRuby) return;
    
    const newRtText = document.getElementById('ruby-edit-rt').value.trim();
    const kanji = document.getElementById('ruby-edit-kanji').textContent.trim();
    
    // Optimistic update
    let rt = currentEditingRuby.querySelector('rt');
    if (!newRtText) {
        if (rt) currentEditingRuby.removeChild(rt);
    } else {
        if (!rt) {
            rt = document.createElement('rt');
            currentEditingRuby.appendChild(rt);
        }
        rt.textContent = newRtText;
    }
    
    closeRubyModal();
    showToast('儲存修改中...', 'fa-solid fa-spinner', 1000);
    
    try {
        const resp = await fetch('/api/furigana/correct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                orig: kanji,
                hira: newRtText
            })
        });
        
        if (resp.ok) {
            showToast('假名修改已同步至資料庫！', 'fa-solid fa-check', 2000);
            setTimeout(() => {
                reloadCurrentLyrics();
            }, 500);
        } else {
            showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
        }
    } catch (e) {
        console.error(e);
        showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
    }
}

// -------------------------------------------------------------
// Window Maximize / Zoom Mode Logic
// -------------------------------------------------------------
function toggleFullscreen() {
    const playerCard = document.querySelector('.player-lyrics-card');
    const btn = document.querySelector('.fullscreen-btn');
    const reloadBtn = document.querySelector('.reload-lyrics-btn');
    const isMaximized = playerCard.classList.contains('window-maximized');
    
    // Disable pointer events on the buttons container during transition to prevent accidental clicks
    const btnContainer = document.querySelector('.lyrics-header > div');
    if (btnContainer) {
        btnContainer.style.pointerEvents = 'none';
        setTimeout(() => {
            btnContainer.style.pointerEvents = 'auto';
        }, 400);
    }
    
    if (!isMaximized) {
        document.body.classList.add('window-maximized');
        playerCard.classList.add('window-maximized');
        localStorage.setItem('zoomModeActive', 'true');
    } else {
        document.body.classList.remove('window-maximized');
        playerCard.classList.remove('window-maximized');
        localStorage.setItem('zoomModeActive', 'false');
    }
}

