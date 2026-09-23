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

function isCurrentSong(title, artist) {
    const song = currentSong();
    return song.title === title && song.artist === artist;
}

function showToast(message, iconClass = 'fa-solid fa-circle-info', duration = 3500) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-message');
    if (!toast) return;
    icon.className = iconClass;
    msg.textContent = message;
    toast.classList.remove('hidden');
    // 吐司是共用元素,上一次呼叫留下的動作鈕(例如更新提醒的「前往下載」)
    // 不能沿用到這一次,所以每次都清乾淨,呼叫方要按鈕自己再掛 (見 footer.ejs 的 actionToast)
    const action = document.getElementById('toast-action');
    if (action) {
        action.classList.add('hidden');
        action.onclick = null;
    }
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
    // 刻意走快取:這顆是「重畫 + 重新套用假名修正」,不是強制上網重抓。
    // 真的要換一份歌詞請用「搜尋備選歌詞」。
    if (typeof fetchAndParseLyrics === 'function') {
        fetchAndParseLyrics(title, artist);   // 首頁:重新載入並重畫歌詞面板
    } else {
        // 其他頁:讓 server 重跑一次,結果會廣播給首頁與靈動島
        await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
    }
}

// -------------------------------------------------------------
// 備選歌詞
// -------------------------------------------------------------
// 按鈕還原成原本的清單圖示
// loading 一定要跟著清:searchLyricsOptions 看到它就整個提早 return,
// 漏清的話按鈕看起來是正常的清單圖示,按下去卻永遠沒反應 (要重整分頁才好)
function resetLyricsOptBtn() {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-list"></i>';
    btn.classList.remove('active');
    delete btn.dataset.ready;
    delete btn.dataset.loading;
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

function hasEditedLyricsSearch(title, artist) {
    const titleInput = document.getElementById('manual-title');
    const artistInput = document.getElementById('manual-artist');
    const searchTitle = (titleInput?.value || '').trim() || title;
    const searchArtist = (artistInput?.value || '').trim() || artist;
    return searchTitle !== title || searchArtist !== artist;
}

// 輪詢 server 的搜尋工作,完成後更新按鈕 (announce=false 用於換頁後靜靜接回,不再彈泡泡)
async function pollOptionsJob(announce = true) {
    const { title, artist } = currentSong();
    if (!title) return;
    clearInterval(window._optPollTimer);
    const generation = window._lyricsOptionsPollGeneration || 0;
    let failures = 0;
    let inFlight = false;
    let pollTimer;
    const stop = () => {
        clearInterval(pollTimer);
        if (window._optPollTimer === pollTimer) delete window._optPollTimer;
    };
    pollTimer = setInterval(async () => {
        if (!isCurrentSong(title, artist) || generation !== (window._lyricsOptionsPollGeneration || 0)) {
            stop();
            return;
        }
        if (inFlight) return;
        inFlight = true;
        try {
            const q = new URLSearchParams({ title, artist });
            const r = await fetch(`/api/lyrics/options/state?${q}`, {
                cache: 'no-store', signal: AbortSignal.timeout(8000)
            });
            if (!r.ok) throw new Error('state request failed');
            const d = await r.json();
            if (!isCurrentSong(title, artist) || generation !== (window._lyricsOptionsPollGeneration || 0)) {
                stop();
                return;
            }
            failures = 0;
            window._lyricsOptions = d.options || [];
            if (d.status === 'searching') {
                window._lyricsOptionsError = false;
                const modal = document.getElementById('lyrics-options-modal');
                if (modal && modal.classList.contains('show')) renderOptionsList(window._lyricsOptions, true);
                return;
            }
            stop();
            window._lyricsOptionsError = !!d.error;
            setOptBtnReady(window._lyricsOptions.length);
            const modal = document.getElementById('lyrics-options-modal');
            if (d.error) {
                if (modal && modal.classList.contains('show')) renderOptionsList(window._lyricsOptions, false, true);
                showToast('備選歌詞搜尋失敗，請重試', 'fa-solid fa-triangle-exclamation', 3500);
            } else if (announce) showOptBubble(window._lyricsOptions.length);
        } catch (e) {
            if (!isCurrentSong(title, artist) || generation !== (window._lyricsOptionsPollGeneration || 0)) {
                stop();
                return;
            }
            if (++failures >= 3) {
                stop();
                window._lyricsOptionsError = true;
                setOptBtnReady((window._lyricsOptions || []).length);
                const modal = document.getElementById('lyrics-options-modal');
                if (modal && modal.classList.contains('show')) renderOptionsList(window._lyricsOptions || [], false, true);
                showToast('備選歌詞連線失敗，請重試', 'fa-solid fa-triangle-exclamation', 3500);
            }
        } finally {
            inFlight = false;
        }
    }, 1500);   // 一次完整搜尋大約 30–40 秒 (server 會跑多個來源),不用問太密
    window._optPollTimer = pollTimer;
}

async function searchLyricsOptions(force = false, manual = false, defaultQuery = !manual, background = false) {
    const btn = document.getElementById('lyrics-opt-btn');
    if (!btn) return;
    if (btn.dataset.loading && !force && !manual) {
        if (!background) {
            openLyricsModal(false);
            renderOptionsList(window._lyricsOptions || [], true);
        }
        return;
    }
    if (btn.dataset.ready && !force) {
        if (background) return;
        const modal = document.getElementById('lyrics-options-modal');
        if (modal && modal.classList.contains('show')) closeLyricsModal();   // 再按一次收起來
        else openLyricsModal();
        return;
    }
    const { title, artist } = currentSong();
    if (!title) return noSongToast();
    defaultQuery = !!defaultQuery && !manual && !hasEditedLyricsSearch(title, artist);

    document.getElementById('lyrics-opt-bubble')?.classList.remove('show');
    window._lyricsOptions = [];
    window._lyricsOptionsError = false;
    window._lyricsOptionsSearch = { title, artist, manual, defaultQuery };
    setOptBtnSearching();
    if (!background) openLyricsModal(false);
    const result = await performGetOptions(manual, force, defaultQuery);
    if (!isCurrentSong(title, artist) || result === 'stale') return;
    setOptBtnReady((window._lyricsOptions || []).length);
    if (result === 'failed') {
        const modal = document.getElementById('lyrics-options-modal');
        if (!modal || !modal.classList.contains('show')) {
            showToast('備選歌詞搜尋失敗，請重試', 'fa-solid fa-triangle-exclamation', 3500);
        }
    } else {
        const modal = document.getElementById('lyrics-options-modal');
        if (!modal || !modal.classList.contains('show')) showOptBubble((window._lyricsOptions || []).length);
    }
}

function retryLyricsOptions() {
    const last = window._lyricsOptionsSearch;
    if (!last || !isCurrentSong(last.title, last.artist)) return searchLyricsOptions(true, false, true);
    return searchLyricsOptions(true, last.manual, last.defaultQuery);
}

// 頁面載入 / 換歌後,把 server 上這首歌的搜尋狀態接回按鈕
async function restoreOptionsState() {
    const { title, artist } = currentSong();
    if (!title) return;
    const generation = window._lyricsOptionsPollGeneration || 0;
    try {
        const q = new URLSearchParams({ title, artist });
        const r = await fetch(`/api/lyrics/options/state?${q}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (!isCurrentSong(title, artist) || generation !== (window._lyricsOptionsPollGeneration || 0)) return;
        if (d.status === 'searching') {
            window._lyricsOptionsError = false;
            setOptBtnSearching();
            pollOptionsJob(true);   // 接手輪詢,搜完照樣彈泡泡
        } else if (d.status === 'done') {
            window._lyricsOptions = d.options || [];
            window._lyricsOptionsError = !!d.error;
            setOptBtnReady(window._lyricsOptions.length);
            const modal = document.getElementById('lyrics-options-modal');
            if (modal && modal.classList.contains('show')) {
                renderOptionsList(window._lyricsOptions, false, !!d.error);
            }
            if (d.error) {
                showToast('備選歌詞搜尋失敗，請重試', 'fa-solid fa-triangle-exclamation', 3500);
            }
        }
    } catch (e) {}
}

function openLyricsModal(load = true) {
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
        renderOptionsList(window._lyricsOptions, false, !!window._lyricsOptionsError);
    } else if (load) {
        performGetOptions(false, false, !hasEditedLyricsSearch(title, artist));
    }
}

// 滑鼠進到某組備選歌詞的外框 (.opt-row) 內,該列過長的歌名/歌手就捲一輪
// (跟播放列同款:複製一份接尾巴、尾接頭無縫、不來回,移開也捲完才停回頭)。清單重畫不自動捲。
document.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.opt-row');
    if (!row || row.dataset.marqueeChecked) return;
    row.dataset.marqueeChecked = '1';
    const els = [];
    row.querySelectorAll('.opt-scroll').forEach(el => {
        const span = el.firstElementChild;
        if (!span || span.scrollWidth - el.clientWidth <= 2) return;
        const gap = parseFloat(getComputedStyle(el).fontSize) * 1.5;  // 尾與頭之間的間距:1.5em,隨字級縮放
        const shift = span.scrollWidth + gap;
        const clone = span.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        clone.style.paddingLeft = gap + 'px';
        el.appendChild(clone);                            // 第二份緊接在後,捲一整份就無縫接回
        const durSec = Math.max(4, shift / 24);
        el.style.setProperty('--marquee-shift', `-${shift}px`);
        el.style.setProperty('--marquee-duration', `${durSec}s`);
        el.classList.add('opt-marquee');
        el._durSec = durSec;
        els.push(el);
    });
    if (!els.length) return;
    // 捲一輪就停回頭,捲動中不重來
    const playOnce = () => els.forEach(el => {
        if (el._marqueeTimer) return;
        el.classList.add('play-once');
        el._marqueeTimer = setTimeout(() => {
            el.classList.remove('play-once');
            el._marqueeTimer = null;
        }, el._durSec * 1000);
    });
    row.onmouseenter = playOnce;
    playOnce();                                           // 掛好當下這次 hover 已錯過 mouseenter,直接捲
});

// 把備選歌詞畫進視窗的清單。searching=true 時 (server 還在問剩下的來源) 尾巴加一行提示,
// 讓「已有的結果先看」跟「還在補」分得出來。
/**
 * 這一份候選歌詞是什麼格式。三種:
 *   逐字 —— 帶每個字的起唱時間 (只有 QQ 的 QRC 有),卡拉OK填色最準
 *   LRC  —— 只有每一行的時間
 *   TXT  —— 沒有時間軸,整份純文字
 * 標的是**這份檔案本身**的格式。選了非逐字的那份不代表就沒有卡拉OK ——
 * 逐字時間是整首歌一份、跨來源比對回來的 (見 web-app/word-times.js)。
 */
function optFormat(opt) {
    if (opt.hasWords) return { cls: 'word', label: '逐字', hint: '每個字都有時間,卡拉OK填色最準' };
    if (opt.isSynced) return { cls: 'synced', label: 'LRC', hint: '每一行有時間' };
    return { cls: 'plain', label: 'TXT', hint: '純文字,沒有時間軸' };
}

function renderOptionsList(options, searching = false, failed = false) {
    const { title, artist } = currentSong();
    window._lyricsOptionsSong = { title, artist };
    const listEl = document.getElementById('lyrics-options-list');
    if (!listEl) return;
    if (!options || !options.length) {
        listEl.innerHTML = failed
            ? `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;">搜尋失敗，請重試<button class="lyrics-opt-search-btn" onclick="retryLyricsOptions()">重試</button></div>`
            : searching
            ? `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-spinner fa-spin"></i> 搜尋中...</div>`
            : `<div style="color: var(--text-secondary); font-size: 13px; text-align:center; padding: 10px;"><i class="fa-solid fa-face-frown"></i> 找不到備選歌詞</div>`;
        return;
    }
    let html = options.map((opt, i) => `
        <div class="opt-row" onclick="applyLyricsOption(${i})">
            <div class="opt-meta">
                <div class="opt-title opt-scroll"><span>${opt.title}</span></div>
                <div class="opt-sub opt-scroll"><span>${opt.artist}${opt.album ? ' [' + opt.album + ']' : ''}</span></div>
            </div>
            <div class="opt-tags">
                <div class="opt-badge ${optFormat(opt).cls}" title="${optFormat(opt).hint}">${optFormat(opt).label}</div>
                <div class="opt-provider">${opt.provider || 'Unknown'}</div>
            </div>
        </div>
    `).join('');
    if (failed) {
        html += `<div style="color: var(--text-secondary); font-size: 12px; text-align:center; padding: 8px;">搜尋失敗，請重試<button class="lyrics-opt-search-btn" onclick="retryLyricsOptions()">重試</button></div>`;
    } else if (searching) {
        html += `<div style="color: var(--text-secondary); font-size: 12px; text-align:center; padding: 8px;"><i class="fa-solid fa-spinner fa-spin"></i> 還在找更多來源…</div>`;
    }
    listEl.innerHTML = html;
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
    // 量的是**浮層自己那扇視窗**的寬 —— 卡拉OK的控制列可以被搬進獨立小視窗
    // (karaoke-remote.js),那時 rect 是小視窗的座標,拿主視窗的 innerWidth 比就全錯
    const vw = (panel.ownerDocument.defaultView || window).innerWidth;
    let nudge = 0;
    if (rect.right > vw - MARGIN) nudge = vw - MARGIN - rect.right;
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

// 把目前自訂欄的歌名/歌手記成這首歌 (原始名) 的搜尋覆蓋,下次自動套用。兩欄都空 = 清除。
async function rememberSearchOverride() {
    const { title, artist } = currentSong();
    if (!title) return noSongToast();
    const st = (document.getElementById('manual-title')?.value || '').trim();
    const sa = (document.getElementById('manual-artist')?.value || '').trim();
    try {
        const resp = await fetch('/api/search-override', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist, searchTitle: st, searchArtist: sa })
        });
        const data = await resp.json();
        showToast(data.cleared ? '已清除此歌覆蓋' : '已記住,重新抓取中', 'fa-solid fa-thumbtack', 2000);
        reloadCurrentLyrics();   // 快取已由 server 清掉,這次會用新關鍵字重抓
    } catch (e) {
        showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
    }
}

async function performGetOptions(forceManual = false, force = false, defaultQuery = false) {
    const { title: songTitle, artist: songArtist } = currentSong();
    if (!songTitle) return noSongToast();
    window._lyricsOptionsError = false;
    window._lyricsOptionsPollGeneration = (window._lyricsOptionsPollGeneration || 0) + 1;
    clearInterval(window._optPollTimer);
    delete window._optPollTimer;

    let searchTitle = songTitle;
    let searchArtist = songArtist;

    const titleInput = document.getElementById('manual-title');
    const artistInput = document.getElementById('manual-artist');
    if (titleInput && artistInput && !defaultQuery) {
        if (forceManual || titleInput.value.trim() !== songTitle) searchTitle = titleInput.value.trim() || songTitle;
        if (forceManual || artistInput.value.trim() !== songArtist) searchArtist = artistInput.value.trim() || songArtist;

        // Ensure inputs reflect what's being searched
        titleInput.value = searchTitle;
        artistInput.value = searchArtist;
    }

    const listEl = document.getElementById('lyrics-options-list');
    if (!listEl) return 'failed';
    renderOptionsList([], true);

    const queryParams = new URLSearchParams({ title: songTitle, artist: songArtist });
    if (!defaultQuery) {
        queryParams.set('searchTitle', searchTitle);
        queryParams.set('searchArtist', searchArtist);
    }
    if (force || forceManual) queryParams.set('force', '1');   // 丟掉 server 上舊的搜尋結果重跑

    if (window._finishModalOptPoll) window._finishModalOptPoll('stale');
    return new Promise((resolve) => {
        let settled = false;
        let inFlight = false;
        let failures = 0;
        let idlePolls = 0;
        let pollTimer;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearInterval(pollTimer);
            if (window._finishModalOptPoll === finish) delete window._finishModalOptPoll;
            resolve(result);
        };
        const fail = () => {
            if (!isCurrentSong(songTitle, songArtist)) return finish('stale');
            window._lyricsOptionsError = true;
            renderOptionsList(window._lyricsOptions || [], false, true);
            finish('failed');
        };
        window._finishModalOptPoll = finish;
        const stateParams = new URLSearchParams({ title: songTitle, artist: songArtist });
        pollTimer = setInterval(async () => {
            if (!isCurrentSong(songTitle, songArtist)) return finish('stale');
            if (inFlight) return;
            inFlight = true;
            try {
                const r = await fetch(`/api/lyrics/options/state?${stateParams}`, {
                    cache: 'no-store', signal: AbortSignal.timeout(8000)
                });
                if (!r.ok) throw new Error('state request failed');
                const d = await r.json();
                if (!isCurrentSong(songTitle, songArtist)) return finish('stale');
                if (d.status === 'idle') {
                    if (++idlePolls >= 4) fail();
                    return;
                }
                failures = 0;
                idlePolls = 0;
                window._lyricsOptions = d.options || [];
                if (d.status === 'searching') {
                    renderOptionsList(window._lyricsOptions, true);
                } else if (d.status === 'done') {
                    window._lyricsOptionsError = !!d.error;
                    renderOptionsList(window._lyricsOptions, false, !!d.error);
                    finish(d.error ? 'failed' : 'done');
                } else {
                    fail();
                }
            } catch (e) {
                if (!isCurrentSong(songTitle, songArtist)) return finish('stale');
                if (++failures >= 3) fail();
            } finally {
                inFlight = false;
            }
        }, 1200);
        window._modalOptPollTimer = pollTimer;

        fetch(`/api/lyrics/options?${queryParams.toString()}`).then((r) => {
            if (!r.ok) throw new Error('search request failed');
        }).catch(() => {
            if (!settled) fail();
        });
    });
}

let lyricsOptionApplyPending = false;
async function applyLyricsOption(index) {
    if (lyricsOptionApplyPending) return;
    const { title, artist } = currentSong();
    const optionsSong = window._lyricsOptionsSong;
    if (!optionsSong || optionsSong.title !== title || optionsSong.artist !== artist) return;
    const opt = window._lyricsOptions && window._lyricsOptions[index];
    if (!opt) return;
    lyricsOptionApplyPending = true;
    try {
        // server 會寫進快取並廣播 lyrics_updated (首頁與靈動島都會更新)
        const resp = await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist, lyrics: opt.lyrics })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'apply failed');
        if (!isCurrentSong(title, artist)) return;
        if (typeof parseLrcLyrics === 'function') {   // 首頁:立刻重畫歌詞面板
            parseLrcLyrics(data.lyrics || opt.lyrics);
            renderLyrics();
        }
        closeLyricsModal();
        showToast(`已套用: ${opt.title}`, 'fa-solid fa-check', 2000);
    } catch (e) {
        if (isCurrentSong(title, artist)) showToast('套用失敗，請重試', 'fa-solid fa-xmark', 3500);
    } finally {
        lyricsOptionApplyPending = false;
    }
}
