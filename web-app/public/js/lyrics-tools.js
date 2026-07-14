/**
 * 各頁共用的歌詞工具:吐司、備選歌詞 (搜尋/視窗/套用)、重新載入歌詞。
 *
 * 首頁 (app.js) 與其他頁 (footer.ejs 的輕量播放列) 都載入這支。
 * 目前播放的歌從 window.currentSongInfo 讀 —— 首頁由 app.js 的輪詢寫入,
 * 其他頁由 footer.ejs 的 syncPlayerBar() 寫入。
 *
 * 首頁另外有歌詞面板要重畫,所以會定義 fetchAndParseLyrics / parseLrcLyrics /
 * renderLyrics;這裡用「有就呼叫」的方式接上,其他頁只靠 server 的 WebSocket 廣播
 * (lyrics_updated) 讓首頁與靈動島同步。
 */

function currentSong() {
    return window.currentSongInfo || { title: '', artist: '' };
}

function showToast(message, iconClass = 'fa-solid fa-circle-info', duration = 3500) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-message');
    if (!toast) return;
    icon.className = iconClass;
    msg.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function noSongToast() {
    showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
}

async function reloadCurrentLyrics() {
    const { title, artist } = currentSong();
    if (!title) return noSongToast();
    showToast(`重新載入: ${title}`, 'fa-solid fa-rotate', 2000);
    if (typeof fetchAndParseLyrics === 'function') {
        fetchAndParseLyrics(title, artist);   // 首頁:重抓並重畫歌詞面板
    } else {
        // 其他頁:讓 server 重抓 (force),結果會廣播給首頁與靈動島
        await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&force=1`);
    }
}

// -------------------------------------------------------------
// 備選歌詞
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

// 搜尋在 server 端跑 (見 server.js 的 optionJobs),這裡只負責問進度 ——
// 所以搜尋途中換頁不會中斷,新頁面載入時會自動接回同一份工作。
function setOptBtnSearching() {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn) return;
    btn.dataset.loading = '1';
    btn.classList.add('active');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.title = '搜尋備選歌詞中…';
}

function setOptBtnReady(count) {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn) return;
    delete btn.dataset.loading;
    if (count) {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.classList.add('active');
        btn.dataset.ready = '1';
        btn.title = '查看備選歌詞';
    } else {
        resetLyricsOptBtn();
    }
}

function showOptBubble(count) {
    const bubble = document.getElementById('lyrics-opt-bubble');
    if (!bubble) return;
    bubble.textContent = count ? `找到 ${count} 筆備選歌詞，點此查看` : '找不到備選歌詞';
    bubble.classList.add('show');
    clearTimeout(window._lyricsBubbleTimer);
    window._lyricsBubbleTimer = setTimeout(() => bubble.classList.remove('show'), 8000);
}

// 輪詢 server 的搜尋工作,完成後更新按鈕 (announce=false 用於換頁後靜靜接回,不再彈泡泡)
async function pollOptionsJob(announce = true) {
    const { title, artist } = currentSong();
    if (!title) return;
    clearInterval(window._optPollTimer);
    window._optPollTimer = setInterval(async () => {
        const now = currentSong();
        if (now.title !== title) { clearInterval(window._optPollTimer); return; }   // 中途換歌
        try {
            const q = new URLSearchParams({ title, artist });
            const r = await fetch(`/api/lyrics/options/state?${q}`, { cache: 'no-store' });
            const d = await r.json();
            if (d.status === 'searching') return;
            clearInterval(window._optPollTimer);
            window._lyricsOptions = d.options || [];
            setOptBtnReady(window._lyricsOptions.length);
            if (announce) showOptBubble(window._lyricsOptions.length);
        } catch (e) {}
    }, 1500);   // 一次完整搜尋大約 30–40 秒 (server 會跑多個來源),不用問太密
}

async function searchLyricsOptions(force = false, manual = false) {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn || btn.dataset.loading) return;
    if (btn.dataset.ready && !force) {
        const modal = document.getElementById('lyrics-options-modal');
        if (modal && modal.classList.contains('show')) closeLyricsModal();   // 再按一次收起來
        else openLyricsModal();
        return;
    }
    const { title, artist } = currentSong();
    if (!title) return noSongToast();

    document.getElementById('lyrics-opt-bubble')?.classList.remove('show');
    window._lyricsOptions = [];
    setOptBtnSearching();

    // 手動改過搜尋字串時走 performGetOptions (會帶 searchTitle/searchArtist 並直接填清單)
    if (manual || force) {
        try {
            await performGetOptions(manual, force);
        } finally {
            setOptBtnReady((window._lyricsOptions || []).length);
            showOptBubble((window._lyricsOptions || []).length);
        }
        return;
    }

    // 一般情況:叫 server 開工,不等它 —— 換頁也不影響
    const q = new URLSearchParams({ title, artist });
    fetch(`/api/lyrics/options?${q}`).catch(() => {});
    pollOptionsJob(true);
}

// 頁面載入 / 換歌後,把 server 上這首歌的搜尋狀態接回按鈕
async function restoreOptionsState() {
    const { title, artist } = currentSong();
    if (!title) return;
    try {
        const q = new URLSearchParams({ title, artist });
        const r = await fetch(`/api/lyrics/options/state?${q}`, { cache: 'no-store' });
        const d = await r.json();
        if (d.status === 'searching') {
            setOptBtnSearching();
            pollOptionsJob(true);   // 接手輪詢,搜完照樣彈泡泡
        } else if (d.status === 'done' && d.options.length) {
            window._lyricsOptions = d.options;
            setOptBtnReady(d.options.length);
        }
    } catch (e) {}
}

function openLyricsModal() {
    const bubble = document.getElementById('lyrics-opt-bubble');
    if (bubble) bubble.classList.remove('show');
    if (typeof closeSettingsMenu === 'function') closeSettingsMenu();   // 兩個浮層不要疊在一起

    const modal = document.getElementById('lyrics-options-modal');
    if (!modal) return;
    modal.classList.add('show');
    keepPanelInView(modal);

    // Pre-fill manual search fields with current song
    const { title, artist } = currentSong();
    if (title) {
        const titleInput = document.getElementById('manual-title');
        const artistInput = document.getElementById('manual-artist');
        if (titleInput && !titleInput.value) titleInput.value = title;
        if (artistInput && !artistInput.value) artistInput.value = artist;
    }

    if (window._lyricsOptions && window._lyricsOptions.length) {
        renderOptionsList(window._lyricsOptions);   // 已經有結果 (可能是背景工作搜到的) 就直接畫
    } else {
        performGetOptions();
    }
}

// 清單列的歌名太長會被「…」截掉,滑鼠移上去就來回滾動,把全名看完。
// 作法跟播放列的 setMarqueeText 一樣:量溢出量 → 設 CSS 變數 → 加 class 跑動畫。
document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.opt-scroll');
    if (!el || el.dataset.marqueeChecked) return;
    el.dataset.marqueeChecked = '1';
    const span = el.firstElementChild;
    if (!span) return;
    const overflow = span.scrollWidth - el.clientWidth;
    if (overflow <= 2) return;
    el.style.setProperty('--marquee-shift', `-${overflow}px`);
    el.style.setProperty('--marquee-duration', `${Math.max(2, overflow / 30)}s`);
    el.classList.add('opt-marquee');
});

// 把備選歌詞畫進視窗的清單
function renderOptionsList(options) {
    const listEl = document.getElementById('lyrics-options-list');
    if (!listEl) return;
    if (!options || !options.length) {
        listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-face-frown"></i> 找不到備選歌詞</div>`;
        return;
    }
    listEl.innerHTML = options.map((opt, i) => `
        <div class="opt-row" onclick="applyLyricsOption(${i})">
            <div class="opt-meta">
                <div class="opt-title opt-scroll"><span>${opt.title}</span></div>
                <div class="opt-sub opt-scroll"><span>${opt.artist}${opt.album ? ' [' + opt.album + ']' : ''}</span></div>
            </div>
            <div class="opt-tags">
                <div class="opt-badge ${opt.isSynced ? 'synced' : 'plain'}">${opt.isSynced ? 'LRC' : 'TXT'}</div>
                <div class="opt-provider">${opt.provider || 'Unknown'}</div>
            </div>
        </div>
    `).join('');
}

function closeLyricsModal() {
    const modal = document.getElementById('lyrics-options-modal');
    if (modal) modal.classList.remove('show');
}

// 浮層以按鈕為中心展開,但按鈕靠視窗右緣時會被切掉 —— 量出超出的量,往回推同樣的距離
function keepPanelInView(panel) {
    panel.style.setProperty('--panel-nudge', '0px');
    const MARGIN = 8;
    const rect = panel.getBoundingClientRect();
    let nudge = 0;
    if (rect.right > window.innerWidth - MARGIN) nudge = window.innerWidth - MARGIN - rect.right;
    else if (rect.left < MARGIN) nudge = MARGIN - rect.left;
    if (nudge) panel.style.setProperty('--panel-nudge', `${Math.round(nudge)}px`);
}

// 點浮層外面 / Esc 就收起來 (跟設定選單同一套)
document.addEventListener('click', (e) => {
    const modal = document.getElementById('lyrics-options-modal');
    if (!modal || !modal.classList.contains('show')) return;
    if (modal.contains(e.target)) return;
    if (e.target.closest('#lyrics-opt-btn, #lyrics-opt-bubble')) return;   // 這兩個自己會開關
    closeLyricsModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('lyrics-options-modal');
    if (modal && modal.classList.contains('show')) closeLyricsModal();
});

function manualSearchLyrics() {
    searchLyricsOptions(true, true);
}

async function performGetOptions(forceManual = false, force = false) {
    const { title: songTitle, artist: songArtist } = currentSong();
    if (!songTitle) return noSongToast();

    let searchTitle = songTitle;
    let searchArtist = songArtist;

    const titleInput = document.getElementById('manual-title');
    const artistInput = document.getElementById('manual-artist');
    if (titleInput && artistInput) {
        if (forceManual || titleInput.value.trim() !== songTitle) searchTitle = titleInput.value.trim() || songTitle;
        if (forceManual || artistInput.value.trim() !== songArtist) searchArtist = artistInput.value.trim() || songArtist;

        // Ensure inputs reflect what's being searched
        titleInput.value = searchTitle;
        artistInput.value = searchArtist;
    }

    const listEl = document.getElementById('lyrics-options-list');
    if (!listEl) return;
    listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</div>`;
    try {
        const queryParams = new URLSearchParams({
            title: songTitle,
            artist: songArtist,
            searchTitle: searchTitle,
            searchArtist: searchArtist
        });
        if (force || forceManual) queryParams.set('force', '1');   // 丟掉 server 上舊的搜尋結果重跑
        const resp = await fetch(`/api/lyrics/options?${queryParams.toString()}`);
        const data = await resp.json();
        window._lyricsOptions = data.options || [];
        renderOptionsList(window._lyricsOptions);
    } catch (e) {
        listEl.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-triangle-exclamation"></i> 載入失敗</div>`;
    }
}

async function applyLyricsOption(index) {
    const opt = window._lyricsOptions && window._lyricsOptions[index];
    if (!opt) return;
    const { title, artist } = currentSong();
    closeLyricsModal();
    showToast(`套用: ${opt.title}`, 'fa-solid fa-check', 2000);
    try {
        // server 會寫進快取並廣播 lyrics_updated (首頁與靈動島都會更新)
        const resp = await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist, lyrics: opt.lyrics })
        });
        const data = await resp.json();
        if (typeof parseLrcLyrics === 'function') {   // 首頁:立刻重畫歌詞面板
            parseLrcLyrics(data.lyrics || opt.lyrics);
            renderLyrics();
        }
    } catch (e) {
        showToast('套用失敗', 'fa-solid fa-xmark', 2000);
    }
}
