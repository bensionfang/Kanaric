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
let syncOffset = 0;
let isUserScrolling = false;

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
            // 隱藏的預設提前量，讓網頁版歌詞提早顯示 (補償視覺延遲，但不影響右下角調整值)
            const WEB_APP_LYRICS_ADVANCE = 0.25; 
            syncLyricsToTime(currentInterpolatedPosition - syncOffset + WEB_APP_LYRICS_ADVANCE);
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
    }

    // Initialize alignment if persisted
    const alignMode = localStorage.getItem('lyricsAlignMode');
    if (alignMode === 'left' || alignMode === 'right') {
        document.getElementById('lyrics-scroll').classList.add('align-' + alignMode);
        const icon = document.getElementById('align-icon-modal');
        if (icon) { icon.classList.remove('fa-align-left'); icon.classList.add('fa-align-center'); }
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
// 按鈕還原成原本的清單圖示
function resetLyricsOptBtn() {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-list"></i>';
    btn.classList.remove('active');
    delete btn.dataset.ready;
    btn.title = '搜尋備選歌詞';
}

// 直接在背景搜尋，完成後按鈕變綠色打勾 + 泡泡提醒；再按一次進備選歌詞視窗
async function searchLyricsOptions(force = false, manual = false) {
    const btn = document.getElementById('lyrics-opt-btn');
    const bubble = document.getElementById('lyrics-opt-bubble');
    if (btn.dataset.loading) return;
    if (btn.dataset.ready && !force) {
        openLyricsModal();
        return;
    }
    if (!lastMediaTitle) {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
        return;
    }

    bubble.classList.remove('show');
    window._lyricsOptions = [];
    btn.dataset.loading = '1';
    btn.classList.add('active');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        await performGetOptions(manual);
    } finally {
        delete btn.dataset.loading;
    }

    const count = (window._lyricsOptions || []).length;
    if (count) {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.dataset.ready = '1';
        btn.title = '查看備選歌詞';
    } else {
        resetLyricsOptBtn();
    }
    bubble.textContent = count ? `找到 ${count} 筆備選歌詞，點此查看` : '找不到備選歌詞';
    bubble.classList.add('show');
    clearTimeout(window._lyricsBubbleTimer);
    window._lyricsBubbleTimer = setTimeout(() => bubble.classList.remove('show'), 8000);
}

function openLyricsModal() {
    const bubble = document.getElementById('lyrics-opt-bubble');
    if (bubble) bubble.classList.remove('show');

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
    
    // Only fetch if options are empty
    if (!window._lyricsOptions || window._lyricsOptions.length === 0) {
        performGetOptions();
    }
}

function closeLyricsModal() {
    const modal = document.getElementById('lyrics-options-modal');
    modal.classList.remove('show');
    setTimeout(() => modal.classList.add('hidden'), 300);
}

function manualSearchLyrics() {
    searchLyricsOptions(true, true);
}

async function performGetOptions(forceManual = false) {
    if (!lastMediaTitle) {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
        return;
    }
    
    let searchTitle = lastMediaTitle;
    let searchArtist = lastMediaArtist;
    
    const titleInput = document.getElementById('manual-title');
    const artistInput = document.getElementById('manual-artist');
    if (titleInput && artistInput) {
        if (forceManual || titleInput.value.trim() !== lastMediaTitle) searchTitle = titleInput.value.trim() || lastMediaTitle;
        if (forceManual || artistInput.value.trim() !== lastMediaArtist) searchArtist = artistInput.value.trim() || lastMediaArtist;
        
        // Ensure inputs reflect what's being searched
        titleInput.value = searchTitle;
        artistInput.value = searchArtist;
    }

    const listEl = document.getElementById('lyrics-options-list');
    listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</div>`;
    try {
        const queryParams = new URLSearchParams({
            title: lastMediaTitle,
            artist: lastMediaArtist,
            searchTitle: searchTitle,
            searchArtist: searchArtist
        });
        const resp = await fetch(`/api/lyrics/options?${queryParams.toString()}`);
        const data = await resp.json();
        if (!data.options || data.options.length === 0) {
            listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-face-frown"></i> 找不到備選歌詞</div>`;
            return;
        }
        listEl.innerHTML = data.options.map((opt, i) => `
            <div style="background: var(--bg-main); border: 1px solid var(--panel-border); border-radius: 6px; padding: 10px 12px; cursor: pointer; transition: border-color 0.2s; display: flex; justify-content: space-between; align-items: center;"
                 onmouseenter="this.style.borderColor='var(--accent-main)'" onmouseleave="this.style.borderColor='var(--panel-border)'"
                 onclick="applyLyricsOption(${i})">
                <div style="display: flex; width: 100%; justify-content: space-between; align-items: center;">
                    <div style="flex: 1; min-width: 0; text-align: left;">
                        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.title}</div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.artist}${opt.album ? ' [' + opt.album + ']' : ''}</div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; flex-shrink: 0; margin-left: 10px;">
                        <div style="padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; ${opt.isSynced ? 'background: rgba(76, 175, 80, 0.15); color: #4caf50;' : 'background: rgba(158, 158, 158, 0.15); color: #9e9e9e;'}">
                            ${opt.isSynced ? 'LRC' : 'TXT'}
                        </div>
                        <div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; opacity: 0.8;">${opt.provider || 'Unknown'}</div>
                    </div>
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
        const resp = await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: lastMediaTitle, artist: lastMediaArtist, lyrics: opt.lyrics })
        });
        const data = await resp.json();
        if (data.lyrics) {
            parseLrcLyrics(data.lyrics);
        } else {
            parseLrcLyrics(opt.lyrics);
        }
        renderLyrics();
    } catch (e) {
        showToast('套用失敗', 'fa-solid fa-xmark', 2000);
    }
}




// Detect manual user scrolling
function handleManualScroll() {
    if (!isUserScrolling) {
        isUserScrolling = true;
        const panel = document.getElementById('sync-resume-panel');
        if (panel) panel.style.display = 'flex';
    }
}

document.getElementById('lyrics-scroll').addEventListener('wheel', handleManualScroll, { passive: true });
document.getElementById('lyrics-scroll').addEventListener('touchmove', handleManualScroll, { passive: true });

function resumeSync() {
    isUserScrolling = false;
    const panel = document.getElementById('sync-resume-panel');
    if (panel) panel.style.display = 'none';
    
    if (activeLyricIndex >= 0) {
        const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
        const pane = document.getElementById('lyrics-scroll');
        if (currentLine && pane) {
            const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
            pane.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' });
        }
    }
}// -------------------------------------------------------------
// Live Sync Logic
// -------------------------------------------------------------
async function pollSystemMedia() {
    try {
        const resp = await fetch('/api/current-media', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        
        const vd = document.getElementById('vinyl-disc');
        const ppIcon = document.getElementById('play-pause-icon');
        if (data.is_playing) {
            if (vd) vd.classList.add('playing');
            if (ppIcon) ppIcon.className = 'fa-solid fa-pause';
        } else {
            if (vd) vd.classList.remove('playing');
            if (ppIcon) ppIcon.className = 'fa-solid fa-play';
        }

        // 隨機播放 / 循環模式 (0=關閉, 1=單曲, 2=整張清單)
        const shuffleBtn = document.getElementById('shuffle-btn');
        if (shuffleBtn) shuffleBtn.classList.toggle('active', !!data.shuffle);
        const repeatBtn = document.getElementById('repeat-btn');
        if (repeatBtn) {
            const mode = data.repeat || 0;
            repeatBtn.classList.toggle('active', mode !== 0);
            repeatBtn.dataset.mode = mode;
            repeatBtn.title = mode === 1 ? '單曲循環' : (mode === 2 ? '清單循環' : '循環播放');
        }

        // Update interpolation state from server
        isCurrentlyPlaying = data.is_playing;
        if (data.duration !== undefined) {
            window.currentMediaDuration = data.duration;
        }
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

            // 換歌 = 備選歌詞失效，按鈕回到搜尋狀態
            window._lyricsOptions = [];
            resetLyricsOptBtn();
            // 清掉上一首殘留的手動捲動狀態，讓新歌恢復自動捲動
            resumeSync();

            setMarqueeText(document.getElementById('current-title'), data.title);
            setMarqueeText(document.getElementById('current-artist'), data.artist || 'Unknown Artist');
            
            const coverImg = document.getElementById('album-cover');
            // Extract dominant color from cover image once loaded
            coverImg.onload = function() {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = coverImg.width || 56;
                    canvas.height = coverImg.height || 56;
                    ctx.drawImage(coverImg, 0, 0, canvas.width, canvas.height);
                    
                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let r = 0, g = 0, b = 0;
                    for (let i = 0; i < imgData.length; i += 4) {
                        r += imgData[i];
                        g += imgData[i+1];
                        b += imgData[i+2];
                    }
                    const count = imgData.length / 4;
                    r = Math.floor(r / count);
                    g = Math.floor(g / count);
                    b = Math.floor(b / count);
                    
                    // Darken to ~65% brightness for Spotify-like vibrant background
                    const bgR = Math.floor(r * 0.65);
                    const bgG = Math.floor(g * 0.65);
                    const bgB = Math.floor(b * 0.65);
                    
                    // Luminance check for text contrast
                    const luminance = (0.299*bgR + 0.587*bgG + 0.114*bgB);
                    const inactiveColor = luminance > 80 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
                    
                    document.documentElement.style.setProperty('--lyrics-bg', `rgb(${bgR}, ${bgG}, ${bgB})`);
                    document.documentElement.style.setProperty('--lyrics-inactive', inactiveColor);
                } catch(e) {
                    document.documentElement.style.setProperty('--lyrics-bg', '#121212');
                    document.documentElement.style.setProperty('--lyrics-inactive', 'rgba(255, 255, 255, 0.5)');
                }
            };
            
            if (data.thumbnail) {
                coverImg.src = 'data:image/jpeg;base64,' + data.thumbnail;
            } else {
                coverImg.src = 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=300&auto=format&fit=crop';
            }


            fetch('/api/lyrics/offset?title=' + encodeURIComponent(data.title) + '&artist=' + encodeURIComponent(data.artist || ''))
                .then(r => r.json())
                .then(d => {
                    syncOffset = d.offset || 0;
                    updateOffsetDisplay();
                }).catch(e => { syncOffset = 0; updateOffsetDisplay(); });
            
            fetchAndParseLyrics(data.title, data.artist);
            loadSidebarLeaderboard();
            window._lyricsOptions = [];
            const listEl = document.getElementById('lyrics-options-list');
            if (listEl) listEl.innerHTML = '';
            
            const manualTitleEl = document.getElementById('manual-title');
            const manualArtistEl = document.getElementById('manual-artist');
            if (manualTitleEl) manualTitleEl.value = data.title;
            if (manualArtistEl) manualArtistEl.value = data.artist || '';

            // 開了自動搜尋就直接跑一輪 (轉圈 → 綠色打勾 → 泡泡提醒,與手動按下完全同一套流程)
            if (localStorage.getItem('auto_lyrics_options') === 'true') {
                searchLyricsOptions();
            }
        } else if (!data.title && lastMediaTitle) {
            // Stopped completely
            lastMediaTitle = "";
            lastMediaArtist = "";
            window._lyricsOptions = [];
            resetLyricsOptBtn();
            setMarqueeText(document.getElementById('current-title'), "--");
            setMarqueeText(document.getElementById('current-artist'), "--");
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
    const timeReg = /\[(\d+):(\d+)(?:[\.:](\d+))?\]/g;
    
    let hasTags = false;
    window.currentSourceProvider = "";
    
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        
        if (line.startsWith("[source:")) {
            window.currentSourceProvider = line.substring(8, line.length - 1);
            return;
        }
        
        let match;
        const text = line.replace(/\[\d+:\d+(?:[\.:]\d+)?\]/g, '').trim();
        if (text.startsWith('#TITLE#')) return;
        
        timeReg.lastIndex = 0;
        let lineHasTag = false;
        while ((match = timeReg.exec(line)) !== null) {
            hasTags = true;
            lineHasTag = true;
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            let msFraction = 0;
            if (match[3]) {
                msFraction = parseFloat('0.' + match[3]);
            }
            const timeInSeconds = minutes * 60 + seconds + msFraction;
            parsedLyrics.push({ time: timeInSeconds, text: text || '♫' });
        }
    });
    
    if (!hasTags) {
        // If no LRC tags were found, treat it as unsynced plain text
        isUnsyncedLyrics = true;
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#TITLE#') && !trimmed.startsWith('[source:')) {
                parsedLyrics.push({ time: -1, text: trimmed });
            }
        });
    } else {
        parsedLyrics.sort((a, b) => a.time - b.time);
        
        // Remove consecutive empty lines (♫)
        parsedLyrics = parsedLyrics.filter((item, index, arr) => {
            if (item.text === '♫') {
                if (index > 0 && arr[index - 1].text === '♫') {
                    return false;
                }
            }
            return true;
        });
        
        // Merge lines with similar time tags (translations/romaji)
        const mergedLyrics = [];
        for (let i = 0; i < parsedLyrics.length; i++) {
            const current = parsedLyrics[i];
            const prev = mergedLyrics[mergedLyrics.length - 1];
            
            // If time diff is very small (< 0.05s), treat as a translation line
            if (prev && Math.abs(current.time - prev.time) < 0.05) {
                if (!prev.translation) {
                    prev.translation = current.text;
                } else {
                    prev.translation += ' / ' + current.text;
                }
            } else {
                mergedLyrics.push({ time: current.time, text: current.text, translation: null });
            }
        }
        parsedLyrics = mergedLyrics;
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
    
    let html = parsedLyrics.map((lyric, index) => {
        let content = `<span>${lyric.text}</span>`;
        if (lyric.translation) {
            content += `<div class="lyrics-translation">${lyric.translation}</div>`;
        }
        return `<div class="lyrics-line ${isUnsyncedLyrics ? 'active' : ''}" id="lyric-line-${index}" data-time="${lyric.time}">${content}</div>`;
    }).join('');
    
    if (window.currentSourceProvider) {
        html += `<div style="text-align: center; color: rgba(255,255,255,0.4); font-size: 14px; margin-top: 30px;">歌詞提供者: ${window.currentSourceProvider}</div>`;
    }
    
    pane.innerHTML = html;
    activeLyricIndex = -1;
}

function updatePlaybackProgress(position) {
    const slider = document.getElementById('progress-slider');
    const fill = document.getElementById('progress-fill');
    const currentTimeEl = document.getElementById('current-time');
    
    // Estimate total time based on current position and song duration
    let durationToUse = window.currentMediaDuration > 0 ? window.currentMediaDuration : songDurationSeconds;
    const actualDuration = Math.max(durationToUse, position + 10);
    
    window.currentSeekDuration = actualDuration;

    const percentage = actualDuration > 0 ? (position / actualDuration) * 100 : 0;
    slider.value = percentage;
    fill.style.width = `${Math.min(100, percentage)}%`;
    currentTimeEl.textContent = formatTime(position);
    const totalTimeEl = document.getElementById('total-time');
    if (totalTimeEl) totalTimeEl.textContent = formatTime(actualDuration);
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
                
                // Only scroll if the user is not manually scrolling
                if (!isUserScrolling) {
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
}

// -------------------------------------------------------------
// Time Offset Adjustment Logic
// -------------------------------------------------------------
function updateOffsetDisplay() {
    const el = document.getElementById('offset-display');
    if (!el) return;
    const ms = Math.round(syncOffset * 1000);
    el.textContent = ms > 0 ? `+${ms} ms` : `${ms} ms`;
}

function adjustSyncOffset(delta) {
    syncOffset += delta;
    updateOffsetDisplay();
    saveSyncOffset();
    if (parsedLyrics.length > 0 && currentInterpolatedPosition >= 0) {
        syncLyricsToTime(currentInterpolatedPosition - syncOffset);
    }
}

function resetSyncOffset() {
    syncOffset = 0;
    updateOffsetDisplay();
    saveSyncOffset();
    if (parsedLyrics.length > 0 && currentInterpolatedPosition >= 0) {
        syncLyricsToTime(currentInterpolatedPosition - syncOffset);
    }
}

let _saveOffsetTimeout = null;
function saveSyncOffset() {
    if (!lastMediaTitle) return;
    clearTimeout(_saveOffsetTimeout);
    _saveOffsetTimeout = setTimeout(() => {
        fetch('/api/lyrics/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: lastMediaTitle, artist: lastMediaArtist, offset: syncOffset })
        }).catch(e => console.error("Failed to save offset", e));
    }, 500);
}

let activeHotkeys = {
    advance: '[',
    delay: ']',
    plainPrev: 'ArrowUp',
    plainNext: 'ArrowDown'
};

window.updateActiveHotkeys = function() {
    activeHotkeys.advance = localStorage.getItem('hk-advance') || 'ArrowLeft';
    activeHotkeys.delay = localStorage.getItem('hk-delay') || 'ArrowRight';
    activeHotkeys.plainPrev = localStorage.getItem('hk-plain-prev') || 'ArrowUp';
    activeHotkeys.plainNext = localStorage.getItem('hk-plain-next') || 'ArrowDown';
};
window.updateActiveHotkeys();

document.addEventListener('keydown', (e) => {
    // Ignore keydown if typing in an input, textarea, or an inline-editable ruby
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    
    let keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (keyName === ' ') keyName = 'Space';
    
    let prefix = '';
    if (e.ctrlKey) prefix += 'Ctrl+';
    if (e.altKey) prefix += 'Alt+';
    if (e.shiftKey && e.key.length > 1) prefix += 'Shift+';
    
    const fullKey = prefix + keyName;
    
    if (fullKey === activeHotkeys.delay) {
        e.preventDefault();
        adjustSyncOffset(-0.1);
    } else if (fullKey === activeHotkeys.advance) {
        e.preventDefault();
        adjustSyncOffset(0.1);
    } else if (fullKey === activeHotkeys.plainPrev) {
        e.preventDefault();
        if (activeLyricIndex > 0) {
            handleManualScroll();
            activeLyricIndex--;
            updateLyricsHighlight(activeLyricIndex);
            
            // Scroll to it
            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
            const pane = document.getElementById('lyrics-scroll');
            if (currentLine && pane) {
                const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
                pane.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' });
            }
        }
    } else if (fullKey === activeHotkeys.plainNext) {
        e.preventDefault();
        if (activeLyricIndex < parsedLyrics.length - 1) {
            handleManualScroll();
            activeLyricIndex++;
            updateLyricsHighlight(activeLyricIndex);
            
            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
            const pane = document.getElementById('lyrics-scroll');
            if (currentLine && pane) {
                const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
                pane.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' });
            }
        }
    }
});

// -------------------------------------------------------------
// Desktop Launch Logic
// -------------------------------------------------------------
async function checkDesktopStatus() {
    try {
        const res = await fetch('/api/desktop-status');
        const data = await res.json();
        const toggle = document.getElementById('desktop-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('active', data.isRunning);
        }
    } catch (e) {}
}

document.addEventListener('DOMContentLoaded', checkDesktopStatus);

async function launchPyQt6() {
    const toggle = document.getElementById('desktop-toggle-btn');
    if (toggle) toggle.disabled = true;
    
    try {
        const resp = await fetch('/api/launch-pyqt6', { method: 'POST' });
        const result = await resp.json();
        
        if (resp.ok && result.success) {
            showToast(result.action === 'started' ? '靈動島已啟動！' : '靈動島已關閉！', 'fa-solid fa-rocket');
            if (toggle) toggle.classList.toggle('active', result.action === 'started');
        } else {
            showToast('操作失敗。', 'fa-solid fa-circle-xmark');
            checkDesktopStatus();
        }
    } catch (err) {
        showToast('連線失敗。', 'fa-solid fa-circle-xmark');
        checkDesktopStatus();
    } finally {
        setTimeout(() => {
            if (toggle) toggle.disabled = false;
        }, 1000);
    }
}

document.addEventListener('mousemove', (e) => {
    const wrapper = e.target.closest('.slider-wrapper');
    if (!wrapper) return;
    const tip = wrapper.querySelector('.seek-tooltip');
    if (!tip) return;
    const rect = wrapper.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    tip.style.left = `${ratio * 100}%`;
    tip.textContent = formatTime(ratio * (window.currentSeekDuration || 0));
});

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
let isRubyEditMode = false;

window.toggleRubyEditMode = function() {
    isRubyEditMode = !isRubyEditMode;
    const btn = document.getElementById('toggle-ruby-mode-btn');
    if (btn) btn.classList.toggle('active', isRubyEditMode);
    document.body.classList.toggle('ruby-edit-mode', isRubyEditMode);
};

document.getElementById('lyrics-scroll').addEventListener('click', (e) => {
    if (isRubyEditMode) {
        const ruby = e.target.closest('ruby');
        if (ruby && ruby !== currentEditingRuby) startRubyEdit(ruby);
        return;
    }

    // Seek mode
    const line = e.target.closest('.lyrics-line');
    if (line) {
        const timeSec = line.getAttribute('data-time');
        if (timeSec) {
            fetch('/api/seek', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position: parseFloat(timeSec) })
            });
        }
    }
});

// 就地編輯假名:直接把 <rt> 變成可編輯,不開視窗
let editingRt = null;
let rubyEditOriginal = '';   // 整個斷詞的讀音,存進 DB 的單位
let rubyEditRtOriginal = ''; // 這個 <rt> 原本顯示的字,可能只是整詞讀音的一部分

function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function startRubyEdit(ruby) {
    finishRubyEdit(false);

    let rt = ruby.querySelector('rt');
    if (!rt) {
        rt = document.createElement('rt');
        ruby.appendChild(rt);
    }
    // 就地編輯這個 rt 自己的字,不要把整詞讀音塞進來 (噛み締め 的 噛 只該顯示 か)
    rubyEditRtOriginal = rt.textContent || '';
    rubyEditOriginal = ruby.dataset.hira || rubyEditRtOriginal;

    currentEditingRuby = ruby;
    editingRt = rt;
    ruby.classList.add('editing');
    rt.contentEditable = 'true';
    rt.spellcheck = false;
    // 編輯中別讓自動捲動把字帶走
    isUserScrolling = true;

    rt.focus();
    const range = document.createRange();
    range.selectNodeContents(rt);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    rt.addEventListener('blur', () => {
        if (editingRt === rt) finishRubyEdit(true);
    });
}

async function finishRubyEdit(save) {
    if (!currentEditingRuby || !editingRt) return;

    const ruby = currentEditingRuby;
    const rt = editingRt;
    const kanji = ruby.dataset.orig || '';
    const newPart = romajiToHiragana(rt.textContent.trim(), true);

    currentEditingRuby = null;
    editingRt = null;
    rt.contentEditable = 'false';
    ruby.classList.remove('editing');

    // word_corrections 的單位是整個斷詞,但這個 ruby 可能只佔整詞讀音的一段
    // (噛み締め=かみしめ 拆成 噛(か) 與 締(し)),所以把改過的那段拼回整詞
    const hs = parseInt(ruby.dataset.hs, 10);
    const hlen = parseInt(ruby.dataset.hlen, 10);
    const newHira = Number.isNaN(hs)
        ? newPart
        : rubyEditOriginal.slice(0, hs) + newPart + rubyEditOriginal.slice(hs + hlen);

    // 取消或沒改動:還原成這個 <rt> 原本的字
    if (!save || !kanji || newPart === rubyEditRtOriginal) {
        rt.textContent = rubyEditRtOriginal;
        if (!rubyEditRtOriginal) ruby.removeChild(rt);
        resumeSync();
        return;
    }

    // 先更新畫面,再去打 API (存檔成功後 reloadCurrentLyrics 會重新切一次)
    ruby.dataset.hira = newHira;
    if (!newPart) ruby.removeChild(rt);

    try {
        const resp = await fetch('/api/furigana/correct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                orig: kanji,
                hira: newHira
            })
        });
        if (resp.ok) {
            showToast('假名已更新', 'fa-solid fa-check', 1500);
            // 同一個斷詞可能在別行也出現,重載讓它們一起更新
            setTimeout(reloadCurrentLyrics, 500);
        } else {
            showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
        }
    } catch (e) {
        console.error(e);
        showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
    }
    resumeSync();
}

const lyricsScrollPane = document.getElementById('lyrics-scroll');

lyricsScrollPane.addEventListener('input', (e) => {
    if (!editingRt || e.target !== editingRt) return;
    const converted = romajiToHiragana(editingRt.textContent);
    if (converted !== editingRt.textContent) {
        editingRt.textContent = converted;
        placeCaretAtEnd(editingRt);
    }
});

lyricsScrollPane.addEventListener('keydown', (e) => {
    if (!editingRt) return;
    if (e.key === 'Enter') {
        e.preventDefault();
        finishRubyEdit(true);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        finishRubyEdit(false);
    }
});

// 雙擊:刪掉自訂讀音,回到自動判讀的假名
lyricsScrollPane.addEventListener('dblclick', async (e) => {
    if (!isRubyEditMode) return;
    const ruby = e.target.closest('ruby');
    if (!ruby) return;

    // 雙擊的第一下已經進入編輯狀態了,先取消掉
    if (currentEditingRuby === ruby) finishRubyEdit(false);

    const kanji = ruby.dataset.orig;
    if (!kanji) return;

    try {
        const resp = await fetch('/api/furigana/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: lastMediaTitle, artist: lastMediaArtist, orig: kanji })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        showToast(data.removed ? '已回復原本的假名' : '這個字沒有改過', 'fa-solid fa-rotate-left', 1500);
        if (data.removed) setTimeout(reloadCurrentLyrics, 300);
    } catch (err) {
        console.error(err);
        showToast('回復失敗', 'fa-solid fa-xmark', 2000);
    }
});

// final=true 代表輸入結束 (Enter/blur),此時結尾殘留的單一 n 才轉成 ん;
// 編輯中不能轉,否則 na 行永遠打不出來 (打 n 就先被吃掉)
function romajiToHiragana(text, final = false) {
    text = text.toLowerCase();
    // 促音:n 不算,nn 是 ん 不是 っん
    text = text.replace(/([bcdfghjklmpqrstvwxyz])\1/g, (m, c) => c === 'n' ? m : 'っ' + c);
    // nn 後面接母音時,第一個 n 是 ん,第二個留給 na 行 (onna → おんな)
    text = text.replace(/nn(?=[aiueoy])/g, 'んn');
    // 其餘的 nn 或 n+子音 = ん;n+母音/y 走 na/nya 行
    text = text.replace(/nn/g, 'ん').replace(/n(?=[^aiueoyん])/g, 'ん');
    if (final) text = text.replace(/n$/, 'ん');

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
        'wa':'わ', 'wo':'を',
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

// -------------------------------------------------------------
// Window Maximize / Zoom Mode Logic
// -------------------------------------------------------------
function toggleFullscreen() {
    const isMaximized = document.body.classList.toggle('window-maximized');
    localStorage.setItem('zoomModeActive', isMaximized ? 'true' : 'false');

    // Re-center the lyrics after the transition
    setTimeout(() => {
        if (activeLyricIndex >= 0) {
            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
            const pane = document.getElementById('lyrics-scroll');
            if (currentLine && pane) {
                const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
                pane.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' });
            }
        }
    }, 300);
}



// Spotify Player Controls
function mediaAction(action) {
    fetch('/api/media-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
    });
}
