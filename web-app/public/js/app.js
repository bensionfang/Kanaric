let lastMediaTitle = "";
let lastMediaArtist = "";
let parsedLyrics = [];
let activeLyricIndex = -1;
let songDurationSeconds = 180; // Estimated or default

document.addEventListener('DOMContentLoaded', () => {
    // Start polling the system media every 100ms for smooth updates
    setInterval(pollSystemMedia, 100);
    
    // Initial load and auto refresh of sidebar leaderboard
    loadSidebarLeaderboard();
    setInterval(loadSidebarLeaderboard, 15000);
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
            statusText.textContent = `⚡ 即時同步中...`;
            document.getElementById('vinyl-disc').classList.add('playing');
        } else {
            dot.classList.remove('active');
            statusText.textContent = data.title ? `音樂已暫停` : `等待播放...`;
            document.getElementById('vinyl-disc').classList.remove('playing');
        }
        
        // Track changed?
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
        
        // Update Progress
        if (data.title) {
            updatePlaybackProgress(data.position);
            syncLyricsToTime(data.position);
        }
        
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
    if (!lrcText) return;
    
    const lines = lrcText.split('\n');
    const timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
    
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        timeReg.lastIndex = 0;
        let match;
        const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
        
        timeReg.lastIndex = 0;
        while ((match = timeReg.exec(line)) !== null) {
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = match[3] ? parseInt(match[3]) : 0;
            const timeInSeconds = minutes * 60 + seconds + (ms / 100);
            parsedLyrics.push({ time: timeInSeconds, text: text || '♫' });
        }
    });
    parsedLyrics.sort((a, b) => a.time - b.time);
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
        return `<div class="lyrics-line" id="lyric-line-${index}">${lyric.text}</div>`;
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
    if (parsedLyrics.length === 0) return;
    
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
