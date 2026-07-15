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
let pendingSeekTarget = null;   // 剛送出 seek,等系統跳到位前先無視回報的位置
let pendingSeekUntil = 0;
let syncOffset = 0;
let isUserScrolling = false;

// 段落循環 (練唱):存 parsedLyrics 的 index,不是秒 —— 歌詞重畫後才有辦法把標記畫回去
let isLoopMode = false;
let loopA = null;
let loopB = null;

document.addEventListener('DOMContentLoaded', () => {
    // 用 server 渲染的播放狀態開場 (footer.ejs 的 window.__initialMedia),
    // 否則第一幀會用 0 秒 + 預設時長畫一次,換頁時看起來就是閃一下。
    // 注意:不要在這裡設 lastMediaTitle —— 它是「換歌」的判斷依據,設了就不會去抓歌詞。
    const m0 = window.__initialMedia;
    if (m0 && m0.title) {
        currentInterpolatedPosition = m0.position || 0;
        window.currentMediaDuration = m0.duration || 0;
        isCurrentlyPlaying = !!m0.is_playing;
    }

    // Start polling the system media every 100ms for smooth updates
    setInterval(pollSystemMedia, 100);
    
    // High-frequency rAF loop for smooth lyrics interpolation
    function syncLoop() {
        const now = performance.now();
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        
        // 只有播放中才推進時間，但畫面永遠要照著目前位置重繪 ——
        // 否則暫停時進度條停在 0 (剛載入首頁)，暫停中點歌詞 seek 也不會跟著跳。
        if (isCurrentlyPlaying) {
            currentInterpolatedPosition += dt;
        }
        if (parsedLyrics.length > 0) {
            // 隱藏的預設提前量，讓網頁版歌詞提早顯示 (補償視覺延遲，但不影響右下角調整值)
            const WEB_APP_LYRICS_ADVANCE = 0.25;
            syncLyricsToTime(currentInterpolatedPosition - syncOffset + WEB_APP_LYRICS_ADVANCE);
        }
        // 段落循環:唱完 B 句就跳回 A 句。pendingSeekTarget 還沒清掉代表上一次跳轉還沒到位,
        // 這時再送一次 seek 會變成每幀狂送。
        if (loopB !== null && isCurrentlyPlaying && pendingSeekTarget === null &&
            currentInterpolatedPosition >= loopEndTime()) {
            seekTo(parsedLyrics[loopA].time);
        }
        updatePlaybackProgress(currentInterpolatedPosition);
        requestAnimationFrame(syncLoop);
    }
    requestAnimationFrame(syncLoop);

    // Initialize zoom mode if persisted
    if (localStorage.getItem('zoomModeActive') === 'true') {
        document.body.classList.add('window-maximized');
    }

    // 段落循環 / 編輯假名:換頁後把模式接回來 (選好的段落在 renderLyrics 時還原)
    if (localStorage.getItem('loopMode') === 'true') toggleLoopMode();
    else if (localStorage.getItem('rubyEditMode') === 'true') toggleRubyEditMode();

    // Initialize alignment if persisted
    const alignMode = localStorage.getItem('lyricsAlignMode');
    if (alignMode === 'left' || alignMode === 'right') {
        document.getElementById('lyrics-scroll').classList.add('align-' + alignMode);
        const icon = document.getElementById('align-icon-modal');
        if (icon) { icon.classList.remove('fa-align-left'); icon.classList.add('fa-align-center'); }
    }
});







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
        }

        // Update interpolation state from server
        isCurrentlyPlaying = data.is_playing;
        if (data.duration !== undefined) {
            window.currentMediaDuration = data.duration;
        }
        if (pendingSeekTarget !== null &&
            (Math.abs(data.position - pendingSeekTarget) < 1.5 || performance.now() > pendingSeekUntil)) {
            pendingSeekTarget = null;   // 系統跳到位了 (或等太久),恢復正常同步
        }
        if (data.title && pendingSeekTarget === null) {
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
            const prevTitle = lastMediaTitle;
            lastMediaTitle = data.title;
            lastMediaArtist = data.artist;
            // 共用工具 (lyrics-tools.js) 從這裡讀「現在在播什麼」
            window.currentSongInfo = { title: lastMediaTitle, artist: lastMediaArtist };

            // 換歌 = 備選歌詞失效，按鈕回到搜尋狀態
            // 但首次載入 (prevTitle 空) 不重置:SSR 已給正確狀態,重置會閃一下綠勾
            window._lyricsOptions = [];
            if (prevTitle) resetLyricsOptBtn();
            restoreOptionsState();   // 這首歌若已在 server 上搜過/搜尋中,把按鈕狀態接回來
            // 真的換歌才作廢循環段落 (行號對不上新歌詞了)。
            // lastMediaTitle 是空的代表這是剛載入頁面的第一次回報,那份段落要留給 restoreLoopRange
            if (prevTitle) clearLoop();
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
            window.currentSongInfo = { title: '', artist: '' };
            window._lyricsOptions = [];
            resetLyricsOptBtn();
            setMarqueeText(document.getElementById('current-title'), "--");
            setMarqueeText(document.getElementById('current-artist'), "--");
            parsedLyrics = [];
            renderLyrics();
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
    restoreLoopRange();   // 換頁回來時把上次選好的段落接回來
    paintLoopRange();
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

// 右下角工具列按鈕的快捷鍵:設定 id → 按下要做的事 (預設鍵與 footer.ejs 的 defaultHkMap 一致)
const TOOLBAR_HOTKEYS = {
    'hk-ab-loop':    { def: 'A', run: () => toggleLoopMode() },
    'hk-ruby-edit':  { def: 'E', run: () => toggleRubyEditMode() },
    'hk-lyrics-opt': { def: 'L', run: () => searchLyricsOptions() },
    'hk-reload':     { def: 'R', run: () => reloadCurrentLyrics() },
    'hk-island':     { def: 'D', run: () => launchPyQt6() },
    'hk-fullscreen': { def: 'F', run: () => toggleFullscreen() },
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
    } else {
        for (const [id, hk] of Object.entries(TOOLBAR_HOTKEYS)) {
            if (fullKey === (localStorage.getItem(id) || hk.def)) {
                e.preventDefault();
                hk.run();
                break;
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


let currentEditingRuby = null;
let isRubyEditMode = false;

window.toggleRubyEditMode = function() {
    isRubyEditMode = !isRubyEditMode;
    const btn = document.getElementById('toggle-ruby-mode-btn');
    if (btn) btn.classList.toggle('active', isRubyEditMode);
    document.body.classList.toggle('ruby-edit-mode', isRubyEditMode);
    localStorage.setItem('rubyEditMode', isRubyEditMode ? 'true' : 'false');   // 換頁後接回
    // 跟段落循環互斥 (兩者都要吃歌詞的點擊)
    if (isRubyEditMode && isLoopMode) toggleLoopMode();
};

// -------------------------------------------------------------
// 段落循環 (練唱):選 A、B 兩句,唱完 B 就跳回 A
// -------------------------------------------------------------
window.toggleLoopMode = function() {
    isLoopMode = !isLoopMode;
    const btn = document.getElementById('loop-mode-btn');
    if (btn) btn.classList.toggle('active', isLoopMode);
    document.body.classList.toggle('loop-mode', isLoopMode);
    localStorage.setItem('loopMode', isLoopMode ? 'true' : 'false');   // 換頁後接回
    if (isLoopMode) {
        // 循環模式跟編輯假名模式互斥 (兩者都要吃歌詞的點擊)
        if (isRubyEditMode) toggleRubyEditMode();
    } else {
        clearLoop();
    }
};

function clearLoop() {
    loopA = null;
    loopB = null;
    localStorage.removeItem('loopRange');
    document.querySelectorAll('.lyrics-line.loop-range').forEach(el => el.classList.remove('loop-range'));
}

// 選好的段落也要跨頁保留。存歌名一起比對 —— 行號只對得上同一首歌的同一份歌詞
function saveLoopRange() {
    if (loopA === null) return;
    localStorage.setItem('loopRange', JSON.stringify({
        title: lastMediaTitle, artist: lastMediaArtist, a: loopA, b: loopB
    }));
}

function restoreLoopRange() {
    if (loopA !== null || !lastMediaTitle) return;
    try {
        const saved = JSON.parse(localStorage.getItem('loopRange') || 'null');
        if (!saved || saved.title !== lastMediaTitle || saved.artist !== lastMediaArtist) return;
        if (saved.a >= parsedLyrics.length || saved.b >= parsedLyrics.length) return;
        loopA = saved.a;
        loopB = saved.b;
    } catch (e) {}
}

// 循環到哪裡:B 唱完 = 下一句開頭;B 已是最後一句就唱到歌曲結束
function loopEndTime() {
    const next = parsedLyrics[loopB + 1];
    if (next) return next.time;
    return window.currentMediaDuration > 0 ? window.currentMediaDuration : songDurationSeconds;
}

function pickLoopLine(line) {
    const index = parseInt(line.id.replace('lyric-line-', ''), 10);
    if (isNaN(index)) return;

    if (loopA === null || loopB !== null) {
        // 第一次點,或已經選好一組要重選
        clearLoop();
        loopA = index;
    } else {
        loopB = index;   // 再點同一句 = 單句循環
        if (loopB < loopA) [loopA, loopB] = [loopB, loopA];   // 由下往上點也算數
        saveLoopRange();
        seekTo(parsedLyrics[loopA].time);
        showToast(loopA === loopB
            ? `循環第 ${loopA + 1} 句`
            : `循環第 ${loopA + 1} – ${loopB + 1} 句`, 'fa-solid fa-bookmark');
    }
    paintLoopRange();
}

// 歌詞重畫 (換假名、重新載入) 後 DOM 是全新的,標記要重上
function paintLoopRange() {
    if (loopA === null) return;
    const end = loopB === null ? loopA : loopB;
    for (let i = loopA; i <= end; i++) {
        const el = document.getElementById('lyric-line-' + i);
        if (el) el.classList.add('loop-range');
    }
}

// 跳到指定秒數:先在本地跳好,不等系統回報 —— 暫停時系統回報位置很慢甚至不回報
function seekTo(sec) {
    currentInterpolatedPosition = sec;
    updatePlaybackProgress(sec);
    // 在系統真的跳到位之前,別讓 pollSystemMedia 用舊位置把我們拉回去
    pendingSeekTarget = sec;
    pendingSeekUntil = performance.now() + 3000;
    fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: sec })
    });
}

document.getElementById('lyrics-scroll').addEventListener('click', (e) => {
    if (isRubyEditMode) {
        const ruby = e.target.closest('ruby');
        if (ruby && ruby !== currentEditingRuby) startRubyEdit(ruby);
        return;
    }

    const line = e.target.closest('.lyrics-line');
    if (!line) return;

    if (isLoopMode) {
        pickLoopLine(line);
        return;   // 循環模式下點歌詞是選 A/B,不是 seek
    }

    // Seek mode
    const timeSec = line.getAttribute('data-time');
    if (timeSec) seekTo(parseFloat(timeSec));
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
