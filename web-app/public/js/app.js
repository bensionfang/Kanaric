// 空狀態幽默句,各挑一句隨機顯示 (renderLyrics / fetchAndParseLyrics 各用一組)
const WAITING_MSGS = ['耳朵準備好了，音樂呢？', '按下播放，我就開工。', '安靜得有點過分，放首歌吧。'];
const NO_LYRICS_MSGS = ['這首歌把歌詞藏起來了。', '翻遍全網，還是撲了個空。', '歌詞放假去了，改天再來。'];
const pick = a => a[Math.floor(Math.random() * a.length)];

let lastMediaTitle = "";
let lastMediaArtist = "";
// 已經抓過歌詞的 (歌名|||歌手)。與 lastMediaTitle 分開:名字被 iTunes 還原改寫時
// lastMediaTitle 會變兩次,但歌詞只該抓最後定案的那一次
let lastLyricsKey = "";
// 目前畫面上顯示歌詞的「歌曲身分」—— 用原始名字 (original_*),跨 iTunes 還原改名保持一致。
// 同一首歌因還原/60 秒重試而重抓時,空結果不准蓋掉已顯示的歌詞 (見 fetchAndParseLyrics)。
let displayedTrackId = "";
let lyricsFetchSeq = 0;   // 併發/亂序保護:只採用最後一次請求的結果
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
let scrollLocked = false;   // 硬鎖自動捲動:編輯假名中 / 鍵盤手動切行中
let autoCenter = true;      // 逐句置中模式 (黏著):使用者自己捲才脫離,漂回中間帶才黏回去
let programmaticScrollUntil = 0;   // 這個時間點前的 scroll 事件是自己捲的,不算使用者操作

// 段落循環 (練唱):存 parsedLyrics 的 index,不是秒 —— 歌詞重畫後才有辦法把標記畫回去
let isLoopMode = false;
let loopA = null;
let loopB = null;
let medianLineGap = 4;   // 全曲行間隔中位數 (parseLrcLyrics 算),loopEndTime 用它估間奏
const LOOP_TAIL_FACTOR = 1.6;   // ponytail: B 之後容一句拖長音的倍數,幾首歌試了再調

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
    connectLyricsSocket();   // 另聽 lyrics_updated,讓同一首歌的歌詞變動 (背景重查等) 即時上畫面
    
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







// 硬鎖自動捲動 (鍵盤上下鍵手動切行、編輯假名時用)。滾輪/觸控不走這裡 ——
// 手動捲動不再停掉同步,改由 applyAutoScroll 依活動行在畫面上的位置決定 (三段規則)。
function handleManualScroll() {
    if (!scrollLocked) {
        scrollLocked = true;
        setSyncPanel(true);
    }
}

function setSyncPanel(show) {
    const panel = document.getElementById('sync-resume-panel');
    if (panel) panel.style.display = show ? 'flex' : 'none';
}

// 活動行是否還在歌詞可視區內
function isActiveLineVisible() {
    const pane = document.getElementById('lyrics-scroll');
    const line = document.getElementById(`lyric-line-${activeLyricIndex}`);
    if (!pane || !line) return true;
    const top = line.offsetTop - pane.scrollTop;
    return top + line.offsetHeight > 0 && top < pane.clientHeight;
}

// 只做按鈕的可見性判定,不捲動 —— 使用者手指還在滑時把畫面搶走很難用
function updateSyncPanel() {
    if (scrollLocked) return setSyncPanel(true);
    if (activeLyricIndex < 0) return setSyncPanel(false);   // 沒有活動行 (含無時間軸歌詞)
    setSyncPanel(!isActiveLineVisible());
}

// 換行時的三段判定:中間帶置中、上下半只換高亮、離開畫面就停手並跳按鈕。
// autoCenter 是黏著狀態 —— 一旦開始逐句置中就不再看幾何,只有使用者自己捲才會脫離
// (見 scroll-zone.js 的 nextScrollState:不黏的話置中後每句都會往下漂一行,最後漂出畫面)。
function applyAutoScroll(prevIndex) {
    if (scrollLocked) return;   // 按鈕已由 handleManualScroll 顯示
    const pane = document.getElementById('lyrics-scroll');
    const line = document.getElementById(`lyric-line-${activeLyricIndex}`);
    if (!pane || !line) return;
    const st = nextScrollState(
        autoCenter, line.offsetTop - pane.scrollTop, line.offsetHeight, pane.clientHeight,
        prevIndex >= 0 && activeLyricIndex === prevIndex + 1);
    autoCenter = st.autoCenter;
    if (st.action === 'center') centerActiveLine();
    setSyncPanel(st.action === 'offscreen');
}

// 捲動 (滾輪/觸控/拖捲軸/鍵盤) 只更新按鈕:歌詞捲回畫面內按鈕就自己消失,不必按恢復同步。
// 使用者捲動 = 脫離逐句置中,之後由 applyAutoScroll 的三段判定決定何時黏回去。
//
// **只認「真的有手勢」的 scroll 事件**:scroll 事件的來源分不出是誰捲的,而移動/縮放視窗、
// 點別的元素造成的重排都會發 scroll —— 光看 scroll 就會在使用者什麼都沒做時脫離同步,
// 歌詞接著一句句漂到下半部。自己的平滑捲動也另外用 programmaticScrollUntil 濾掉。
{
    let scrollRaf = 0;
    let gestureUntil = 0;
    const pane = document.getElementById('lyrics-scroll');
    const markGesture = () => { gestureUntil = performance.now() + 1000; };
    for (const ev of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown']) {
        pane.addEventListener(ev, markGesture, { passive: true });
    }
    pane.addEventListener('scrollend', () => { programmaticScrollUntil = 0; });
    pane.addEventListener('scroll', () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            const now = performance.now();
            if (now < programmaticScrollUntil || now > gestureUntil) return;
            autoCenter = false;
            updateSyncPanel();
        });
    }, { passive: true });
    // 視窗大小變了,原本置中的行會偏掉 —— 還在同步模式就重新對正
    window.addEventListener('resize', () => {
        if (autoCenter && !scrollLocked) centerActiveLine();
    });
}

// 重畫歌詞後 DOM 是全新的、捲軸回到最頂,這時再平滑捲動會從頭滑一大段才追上正在唱的那句。
// renderLyrics() 會立這個旗標,讓「下一次」置中直接跳過去,之後恢復平滑捲動。
let jumpToActiveLine = false;

// 把正在唱的那句捲到畫面正中 (唯一實作,五個呼叫點共用)
function centerActiveLine() {
    if (activeLyricIndex < 0) return;
    const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);
    const pane = document.getElementById('lyrics-scroll');
    if (!currentLine || !pane) return;
    const scrollOffset = currentLine.offsetTop - (pane.clientHeight / 2) + (currentLine.clientHeight / 2);
    // 自己捲的期間 scroll 事件不算使用者操作 (見 scroll listener)
    programmaticScrollUntil = performance.now() + 500;
    pane.scrollTo({ top: Math.max(0, scrollOffset), behavior: jumpToActiveLine ? 'auto' : 'smooth' });
    jumpToActiveLine = false;
}

function resumeSync() {
    scrollLocked = false;
    autoCenter = true;
    setSyncPanel(false);
    centerActiveLine();
}// -------------------------------------------------------------
// Live Sync Logic
// -------------------------------------------------------------
// 網頁靠輪詢 /api/current-media 更新,平常換歌才抓歌詞。但「無歌詞背景重查自動套用」
// 這種同一首歌的歌詞變動不會換歌 —— 輪詢不會重抓。所以另開一條 WebSocket 專聽 server 的
// lyrics_updated:是目前顯示這首、且內容非空,就即時重畫 (跟靈動島同一個廣播)。
function connectLyricsSocket() {
    let ws;
    const connect = () => {
        try { ws = new WebSocket(`ws://${location.host}`); } catch (e) { setTimeout(connect, 3000); return; }
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.type !== 'lyrics_updated' || !msg.lyrics) return;   // 空的交給既有抓取流程,不在這清畫面
            if (msg.title !== lastMediaTitle || msg.artist !== lastMediaArtist) return;   // 只認目前顯示的那首
            parseLrcLyrics(msg.lyrics);
            renderLyrics();
        };
        ws.onclose = () => setTimeout(connect, 3000);
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
    };
    connect();
}

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
            if (prevTitle && window.resetLlmWandBtn) resetLlmWandBtn();
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
            
            // 歌詞不在這裡抓 —— iTunes 日文原名還原是非同步的,這一刻的名字可能再過幾秒就變。
            // 等下面 resolving 為 false 再抓,整首歌只抓一次 (見 server.js handleMediaUpdate)
            const scrollPane = document.getElementById('lyrics-scroll');
            if (scrollPane) scrollPane.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> 正在搜尋歌詞...</div>`;
            parsedLyrics = [];
            window._lyricsOptions = [];
            const listEl = document.getElementById('lyrics-options-list');
            if (listEl) listEl.innerHTML = '';
            
            const manualTitleEl = document.getElementById('manual-title');
            const manualArtistEl = document.getElementById('manual-artist');
            if (manualTitleEl) manualTitleEl.value = data.title;
            if (manualArtistEl) manualArtistEl.value = data.artist || '';

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
            lastLyricsKey = "";
            displayedTrackId = "";
        }

        // 名字定案 (resolving=false) 才抓歌詞,而且同一個 (歌名, 歌手) 只抓一次。
        // 換歌與「iTunes 還原把名字改掉」都走這裡,不會重複發請求
        if (data.title && !data.resolving) {
            const lyricsKey = `${data.title}|||${data.artist || ''}`;
            if (lyricsKey !== lastLyricsKey) {
                lastLyricsKey = lyricsKey;
                // 歌曲身分用原始名字 (Spotify 每次都送同一份,跨還原穩定);還原前後是同一首
                const trackId = `${data.original_title || data.title}|||${data.original_artist || data.artist || ''}`;
                fetchAndParseLyrics(data.title, data.artist, trackId);
                // 開了自動搜尋就直接跑一輪 (轉圈 → 綠色打勾 → 泡泡提醒,與手動按下完全同一套流程)。
                // 跟抓歌詞綁在一起,才不會用還原前的名字先搜一次
                if (localStorage.getItem('auto_lyrics_options') === 'true') {
                    searchLyricsOptions();
                }
            }
        }

        // Progress is now handled by the rAF interpolation loop

    } catch (err) {
        // Ignore polling errors
    }
}

async function fetchAndParseLyrics(title, artist, trackId = "") {
    const scrollPane = document.getElementById('lyrics-scroll');
    const seq = ++lyricsFetchSeq;
    // 同一首歌的重抓 (iTunes 還原改名 / 60 秒重試觸發):不清畫面、不換 spinner ——
    // 換名後的重抓常撞來源限流拿到空的,先清畫面就會把已經抓對的歌詞蓋成「找不到」。
    // 只有換到別首歌 (trackId 不同) 才顯示搜尋中。
    const sameTrack = !!trackId && trackId === displayedTrackId;
    if (!sameTrack) {
        scrollPane.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> 正在搜尋歌詞...</div>`;
        parsedLyrics = [];
    }

    const stale = () => seq !== lyricsFetchSeq;   // 有更新的請求進來了,這個結果作廢
    try {
        const resp = await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
        if (stale()) return;
        const data = resp.ok ? await resp.json() : null;
        if (stale()) return;
        if (data && data.lyrics) {
            parseLrcLyrics(data.lyrics);
            renderLyrics();
            displayedTrackId = trackId;
            if (parsedLyrics.length > 0) {
                const lastLyricTime = parsedLyrics[parsedLyrics.length - 1].time;
                songDurationSeconds = Math.max(120, Math.round(lastLyricTime + 15));
            }
        } else {
            // 空結果:同一首已在畫面上就保留原歌詞 (暫時性的限流別蓋掉),換首才顯示找不到
            if (sameTrack) return;
            displayedTrackId = "";
            scrollPane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-face-frown"></i><p>${pick(NO_LYRICS_MSGS)}</p></div>`;
        }
    } catch (e) {
        if (stale() || sameTrack) return;
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
        // 譯文行 (server 端 mergeTranslations 插的) 掛到上一句歌詞上,不自成一行。
        // 它與原句共用時間戳,所以下面的 0.05s 合併也接得住,但顯式判斷比較穩 ——
        // 有些來源的歌詞本身就自帶譯文行,那條路徑仍然要留著。
        if (text.startsWith('#TRANS#')) {
            const prev = parsedLyrics[parsedLyrics.length - 1];
            if (prev) prev.translation = text.substring(7);
            return;
        }
        
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
                // translation 要帶過來 —— #TRANS# 行是在上面掛到物件上的,寫死 null 會把它洗掉
                mergedLyrics.push({ time: current.time, text: current.text, translation: current.translation || null });
            }
        }
        parsedLyrics = mergedLyrics;
    }

    // 段落循環用:相鄰行間隔的中位數 = 「一句大約多長」,估尾段間奏。
    // 只取正的間隔 (unsynced 的 -1 或同時間戳的 0 都跳過),沒有就用預設保底。
    const gaps = [];
    for (let i = 1; i < parsedLyrics.length; i++) {
        const d = parsedLyrics[i].time - parsedLyrics[i - 1].time;
        if (d > 0) gaps.push(d);
    }
    if (gaps.length) {
        gaps.sort((a, b) => a - b);
        medianLineGap = gaps[Math.floor(gaps.length / 2)];
    } else {
        medianLineGap = 4;
    }
}

function renderLyrics() {
    const pane = document.getElementById('lyrics-scroll');
    if (parsedLyrics.length === 0) {
        if (lastMediaTitle) {
            pane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-music"></i><p>純音樂，無人聲歌詞</p></div>`;
        } else {
            pane.innerHTML = `<div class="lyrics-empty"><i class="fa-solid fa-music"></i><p>${pick(WAITING_MSGS)}</p></div>`;
        }
        return;
    }
    
    let html = parsedLyrics.map((lyric, index) => {
        let content = `<span>${lyric.text}</span>`;
        if (lyric.translation) {
            // 內層再包一顆 span:段落循環的綠底只上在 span 上,好貼著文字而不是整行滿寬。
            // 直接給這顆 div 上底色會變方塊,而 width:fit-content 又會讓歌詞對齊 (text-align) 失效
            content += `<div class="lyrics-translation"><span>${lyric.translation}</span></div>`;
        }
        return `<div class="lyrics-line ${isUnsyncedLyrics ? 'active' : ''}" id="lyric-line-${index}" data-time="${lyric.time}">${content}</div>`;
    }).join('');
    
    if (window.currentSourceProvider) {
        html += `<div style="text-align: center; color: rgba(255,255,255,0.4); font-size: 14px; margin-top: 30px;">歌詞提供者: ${window.currentSourceProvider}</div>`;
    }
    
    pane.innerHTML = html;
    activeLyricIndex = -1;
    jumpToActiveLine = true;   // 重畫後第一次置中用瞬移,不要從頂端滑下來
    restoreLoopRange();   // 換頁回來時把上次選好的段落接回來
    paintLoopRange();
    if (isRubyEditMode) markLlmRubies();   // 編輯模式中收到重播 (如魔杖跑完) 也要補掛
    // 歌詞帶 LLM 修正標記 = 這首跑過 AI 校正 (自動模式或快取),魔杖亮勾。
    // 只點亮不熄滅:熄滅由換歌時的 resetLlmWandBtn 負責,免得手動跑完 0 修正的重播把勾洗掉
    if (pane.querySelector('ruby.llm-ruby') && window.setLlmWandDone) setLlmWandDone();
}

function updatePlaybackProgress(position) {
    if (isScrubbing) return;   // 拖曳進度條時別把滑桿拉回播放位置
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
    
    const prevIndex = activeLyricIndex;
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
                applyAutoScroll(prevIndex);
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
    'hk-llm-wand':   { def: 'W', run: () => { const b = document.getElementById('llm-wand-btn'); if (b && typeof runLlmFurigana === 'function') runLlmFurigana(b); } },
    'hk-reload':     { def: 'R', run: () => reloadCurrentLyrics() },
    'hk-island':     { def: 'D', run: () => toggleIsland() },
    'hk-fullscreen': { def: 'F', run: () => toggleFullscreen() },
};

// 右下角工具列可自訂顯示/隱藏:tool key → 按鈕元素 id (單一真相源)。
// 顯示狀態存 localStorage 'tool-vis-<key>','0'=隱藏,預設顯示 (跟快捷鍵同一套 per-browser)。
const TOOLBAR_TOOLS = [
    { key: 'lyrics-opt', id: 'lyrics-opt-btn' },
    { key: 'ab-loop',    id: 'loop-mode-btn' },
    { key: 'ruby-edit',  id: 'toggle-ruby-mode-btn' },
    { key: 'llm-wand',   id: 'llm-wand-btn' },
    { key: 'reload',     id: 'reload-btn' },
    { key: 'island',     id: 'desktop-toggle-btn' },
    { key: 'fullscreen', id: 'fullscreen-btn' },
];

function _toolHideTarget(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    // 備選歌詞/魔杖包在 .lyrics-opt-wrap (含浮層錨點),要連 wrapper 一起藏
    return el.closest('.lyrics-opt-wrap') || el;
}

window.applyToolbarVisibility = function() {
    TOOLBAR_TOOLS.forEach(({ key, id }) => {
        const target = _toolHideTarget(id);
        if (target) target.classList.toggle('tool-hidden', localStorage.getItem('tool-vis-' + key) === '0');
    });
};

// 設定選單裡的眼睛圖示反映目前狀態
window.refreshToolEyes = function() {
    TOOLBAR_TOOLS.forEach(({ key }) => {
        const eye = document.querySelector(`.hk-eye[data-tool="${key}"]`);
        if (!eye) return;
        const hidden = localStorage.getItem('tool-vis-' + key) === '0';
        eye.classList.toggle('off', hidden);
        const icon = eye.querySelector('i');
        if (icon) icon.className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });
};

window.toggleToolVisibility = function(key) {
    const hidden = localStorage.getItem('tool-vis-' + key) === '0';
    if (hidden) localStorage.removeItem('tool-vis-' + key); // 回到預設顯示
    else localStorage.setItem('tool-vis-' + key, '0');
    window.applyToolbarVisibility();
    window.refreshToolEyes();
};

window.resetToolVisibility = function() {
    TOOLBAR_TOOLS.forEach(({ key }) => localStorage.removeItem('tool-vis-' + key));
    window.applyToolbarVisibility();
    window.refreshToolEyes();
};

document.addEventListener('DOMContentLoaded', window.applyToolbarVisibility);

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
    
    // advance = 讓歌詞提早出現 = 負偏移,對應畫面左邊的「−」鈕 (預設 ArrowLeft);delay 反之。
    // 以前這兩個是反的:按 ArrowRight 會得到 -100ms,跟它正上方的「+」鈕相反。
    if (fullKey === activeHotkeys.advance) {
        e.preventDefault();
        adjustSyncOffset(-0.1);
    } else if (fullKey === activeHotkeys.delay) {
        e.preventDefault();
        adjustSyncOffset(0.1);
    } else if (fullKey === activeHotkeys.plainPrev) {
        e.preventDefault();
        if (activeLyricIndex > 0) {
            handleManualScroll();
            activeLyricIndex--;
            updateLyricsHighlight(activeLyricIndex);
            centerActiveLine();
        }
    } else if (fullKey === activeHotkeys.plainNext) {
        e.preventDefault();
        if (activeLyricIndex < parsedLyrics.length - 1) {
            handleManualScroll();
            activeLyricIndex++;
            updateLyricsHighlight(activeLyricIndex);
            centerActiveLine();
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
        const res = await fetch('/api/island/status');
        const data = await res.json();
        const toggle = document.getElementById('desktop-toggle-btn');
        if (toggle) {
            toggle.classList.toggle('active', data.isRunning);
        }
    } catch (e) {}
}

document.addEventListener('DOMContentLoaded', checkDesktopStatus);

async function toggleIsland() {
    const toggle = document.getElementById('desktop-toggle-btn');
    if (toggle) toggle.disabled = true;

    try {
        const resp = await fetch('/api/island/toggle', { method: 'POST' });
        const result = await resp.json();

        if (resp.ok && result.success) {
            showToast(result.action === 'started' ? '靈動島已啟動！' : '靈動島已關閉！', 'fa-solid fa-rocket');
            if (toggle) toggle.classList.toggle('active', result.action === 'started');
        } else if (result.available === false) {
            // 純 node (npm start) 沒有 Electron 主進程,島這個視窗不存在
            showToast('靈動島需要桌面版 Kanaric', 'fa-solid fa-circle-info');
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

// 進度條跳轉:點擊/拖曳放開時 seek。拖曳中只更新畫面,放開才真的跳
// (app.js 在 footer 的播放列之前載入,滑桿要等 DOM 齊了才抓得到)
let isScrubbing = false;
document.addEventListener('DOMContentLoaded', function initProgressSeek() {
    const slider = document.getElementById('progress-slider');
    if (!slider) return;
    slider.addEventListener('pointerdown', () => { isScrubbing = true; });
    slider.addEventListener('input', () => {
        const fill = document.getElementById('progress-fill');
        if (fill) fill.style.width = `${slider.value}%`;
        const t = document.getElementById('current-time');
        if (t) t.textContent = formatTime(slider.value / 100 * (window.currentSeekDuration || 0));
    });
    slider.addEventListener('change', () => {
        isScrubbing = false;
        seekTo(slider.value / 100 * (window.currentSeekDuration || 0));
    });
});

document.addEventListener('mousemove', (e) => {
    const wrapper = e.target.closest('.slider-wrapper');
    if (!wrapper) return;
    const tip = wrapper.querySelector('.seek-tooltip');
    if (!tip) return;
    const rect = wrapper.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    tip.style.left = `${ratio * 100}%`;
    tip.textContent = formatTime(ratio * (window.currentSeekDuration || 0));
    const hover = wrapper.querySelector('.progress-hover-fill');
    if (hover) hover.style.width = `${ratio * 100}%`;
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

// LLM 改過的字掛懸停說明 (title 只在編輯模式掛,平常滑過歌詞不跳 tooltip)
function markLlmRubies() {
    document.querySelectorAll('ruby.llm-ruby').forEach(r => {
        r.title = `AI 修正，原讀音：${r.dataset.llmPrev || ''}`;
    });
}

window.toggleRubyEditMode = function() {
    isRubyEditMode = !isRubyEditMode;
    const btn = document.getElementById('toggle-ruby-mode-btn');
    if (btn) btn.classList.toggle('active', isRubyEditMode);
    document.body.classList.toggle('ruby-edit-mode', isRubyEditMode);
    localStorage.setItem('rubyEditMode', isRubyEditMode ? 'true' : 'false');   // 換頁後接回
    if (isRubyEditMode) markLlmRubies();
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

// 循環到哪裡:B 唱完 = 下一句開頭;B 已是最後一句就唱到歌曲結束。
// 間奏防護:B 到下一句若遠超一句長 (= 尾段間奏),提早在「B + 一句長」跳回,不整段間奏跟著循環。
function loopEndTime() {
    const b = parsedLyrics[loopB];
    const next = parsedLyrics[loopB + 1];
    const hardEnd = next ? next.time
        : (window.currentMediaDuration > 0 ? window.currentMediaDuration : songDurationSeconds);
    const cap = b.time + medianLineGap * LOOP_TAIL_FACTOR;
    return hardEnd > cap ? cap : hardEnd;
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
        // 只認 editable-ruby:kata-ruby 沒有 data-orig/data-hira,讓它進編輯會存出一筆
        // word 是 undefined 的 word_corrections
        const ruby = e.target.closest('ruby.editable-ruby');
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
    scrollLocked = true;

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
    setTimeout(centerActiveLine, 300);
}



// Spotify Player Controls
function mediaAction(action) {
    fetch('/api/media-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
    });
}
