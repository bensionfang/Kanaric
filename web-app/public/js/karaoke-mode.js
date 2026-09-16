/*
 * 卡拉OK字幕機模式 (/karaoke) 的頁面邏輯。
 *
 * 與首頁 (app.js) 的三個關鍵差別:
 *
 * 1. **沒有提前量。** 首頁的 WEB_APP_LYRICS_ADVANCE 是為了讓下一句早 0.25 秒上畫面,
 *    而字幕機的下一句本來就一直在畫面上。所以換行與填色吃同一個位置值,不必像首頁那樣
 *    在填色前再減回去 (那一減曾經漏掉,整首歌的填色比聽到的快了 0.25 秒都沒人發現)。
 * 2. **整份歌詞一次渲染,靠 class 切換顯示哪兩行。** karaokeSplit 把字元 span memo 在
 *    root.__kc 上且不還原,所以換行時重寫 innerHTML 必須手動作廢那個 memo (靈動島踩過)。
 *    每行各自一顆 .kline 就沒有這個問題,換行那一幀零重建。
 * 3. **控制列是自己一條 (#karaoke-bar),不是 footer 的播放列。** 播放列是播放器版面
 *    (封面/歌名/隨機/循環/上一首/進度條),唱歌時一項都用不到;這一頁要的是點歌機遙控器:
 *    重唱、切歌、字幕早晚。播放列整條 display:none —— 舊版不敢這樣做是因為備選歌詞浮層
 *    position:absolute 錨在它裡面那顆按鈕上,解法是把整塊 .lyrics-opt-wrap 搬進
 *    #kbar-tools (錨點跟著搬,浮層的 CSS 一個字都不用改)。
 */
// **一定要等 DOMContentLoaded**:這一頁的 <script> 排在 include('footer') 之前,而
// window.onMediaMessage (WebSocket 的 handler 註冊點) 與備選歌詞那塊都在 footer 裡,
// 立即執行的話是 `onMediaMessage is not a function`,整支腳本死掉、頁面空白。
// app.js 也是同樣的理由把初始化放在 DOMContentLoaded 裡。
document.addEventListener('DOMContentLoaded', function () {
    const stage = document.getElementById('karaoke-stage');
    if (!stage) return;

    const linesEl = document.getElementById('karaoke-lines');
    const statusEl = document.getElementById('karaoke-status');
    const countEl = document.getElementById('karaoke-countin');
    const degradedEl = document.getElementById('karaoke-degraded');
    const dots = Array.from(countEl.querySelectorAll('.kdot'));
    const introEl = document.getElementById('karaoke-intro');
    const nowEl = document.getElementById('k-now');

    // ── 歌詞狀態 ──
    let lines = [];
    let unsynced = false;
    let curIdx = -1;      // 正在唱的那一句 (填色的對象)
    let topIdx = -1;      // 上槽
    let botIdx = -1;      // 下槽
    let firstTime = Infinity;   // 第一句真歌詞的時間 = 前奏結束 = 資訊卡收掉的時機
    let fetchSeq = 0;
    let fitRaf = 0;

    // ── 播放狀態 (自己內插,理由同 app.js:廣播一秒才一則) ──
    let pos = 0;
    let playing = false;
    let lastServerPos = -1;
    let lastFrame = performance.now();
    let syncOffset = 0;
    let title = '';
    let artist = '';
    let lyricsKey = '';

    const m0 = window.__initialMedia;
    if (m0 && m0.title) {
        pos = m0.position || 0;
        playing = !!m0.is_playing;
    }

    // ===================== 畫面 =====================

    function setStatus(text, icon) {
        if (!text) { statusEl.classList.add('hidden'); return; }
        statusEl.classList.remove('hidden');
        statusEl.innerHTML = '';
        const i = document.createElement('i');
        i.className = 'fa-solid ' + (icon || 'fa-microphone-lines');
        const p = document.createElement('p');
        p.textContent = text;
        statusEl.append(i, p);
    }

    function renderLines() {
        curIdx = topIdx = botIdx = -1;
        const first = lines.find((l) => l.text && l.text !== '♫');
        firstTime = first ? first.time : Infinity;
        // 歌詞本體是 server 產好的 HTML (含 <ruby>),furigana_inject.py 在分詞前就逃逸過了。
        // **每一行畫兩份**:.kbase 是未唱的白字黑框,.kover 是唱過的紅字白框、絕對定位疊在
        // 上面,靠逐字的 clip-path 由左往右揭開 (見 style.css 那段說明)。
        linesEl.innerHTML = lines.map((l, i) =>
            `<div class="kline" id="kline-${i}"><span class="kbase">${l.text}</span><span class="kover">${l.text}</span></div>`).join('');
        // **兩層都要切成一字一顆 span,連只負責顯示白字的 .kbase 也要。** 只切 .kover 的話
        // 兩層在**換行的位置**會不一樣:Chrome 的禁則處理 (っ、小假名、標點不能在行首) 是看
        // 同一個文字 run 判斷的,拆成獨立 span 之後那個判斷跟著變,斷行點就差一個字 ——
        // 畫面上是「換行的那一列整個重影錯開」(2026-08-09 回報,docs/4.png)。
        // 結構一模一樣就一定排得一樣,不必去猜瀏覽器怎麼斷。**時機也必須是同一刻** ——
        // 先切一層、另一層等到唱到才切的話,中間那段時間照樣是錯開的。
        linesEl.querySelectorAll('.kline').forEach((el) => {
            karaokeSplit(el.querySelector('.kbase'));
            karaokeSplit(el.querySelector('.kover'));
        });
        // 沒有逐字時間的歌照樣進來,只是整句一起亮 —— 標一下,別讓人以為壞了
        degradedEl.classList.toggle('hidden', unsynced || !lines.length || lines.some(l => l.words));
    }

    function clearLyrics() {
        lines = [];
        linesEl.innerHTML = '';
        curIdx = topIdx = botIdx = -1;
        firstTime = Infinity;
        degradedEl.classList.add('hidden');
        introEl.classList.add('hidden');
        document.getElementById('ki-credits').innerHTML = '';
    }

    function setLyrics(lrc) {
        const r = parseLrc(lrc);
        lines = r.lines;
        unsynced = r.unsynced;
        setCredits(lrc);
        if (unsynced) {
            // 字幕機沒有時間軸就沒有意義:不硬撐,直接說清楚
            clearLyrics();
            setStatus('這份歌詞沒有時間軸,卡拉OK模式需要同步歌詞', 'fa-solid fa-clock');
            return;
        }
        renderLines();
        setStatus(lines.length ? '' : '找不到這首歌的歌詞', 'fa-solid fa-face-frown');
    }

    // 資訊卡的作詞/作曲:parseLrc 會把 #TITLE# 行整個丟掉 (那不是歌詞),所以在這裡自己
    // 從原始字串撈。判準是「有冒號」—— 那正好把歌名行 (沒有冒號) 與版權聲明 (又長又沒冒號)
    // 濾掉,剩下的就是 `作詞 : 某某` 這種製作人員列。
    // **用 innerHTML 是對的**:那幾行已經被 furigana_inject.py 逃逸過 (它不會給 #TITLE# 列
    // 標注音,所以裡面不會有標籤),textContent 反而會把 `&amp;` 原樣印出來。
    function setCredits(lrc) {
        const out = [];
        for (const raw of String(lrc || '').split('\n')) {
            const t = raw.replace(/\[\d+:\d+(?:[\.:]\d+)?\]/g, '').trim();
            if (!t.startsWith('#TITLE#')) continue;
            const s = t.slice(7).trim();
            if (!s || s.length > 40 || !/[:：]/.test(s)) continue;
            if (!out.includes(s)) out.push(s);
            if (out.length >= 4) break;
        }
        document.getElementById('ki-credits').innerHTML =
            out.map((s) => `<div>${s}</div>`).join('');
    }

    /**
     * 倒數的五個點。**掛在「即將唱的那一句」的左上角** (JOYSOUND) 而不是畫面上的固定位置 ——
     * 那一句在倒數期間本來就已經在畫面上了 (`karaokeSlots` 開口前 COUNT_IN 秒就把它提上來
     * 當活躍句),點跟著它走才看得出「等一下要唱的是這一句」。
     *
     * 點的兩個狀態刻意跟歌詞同一套:還沒走到 = 白底黑框 (未唱)、走過去 = 紅底白框 (唱過),
     * 所以倒數在視覺上就是「這一句的前導」。
     */
    function paintCountdown(cd) {
        if (!cd) { countEl.classList.add('hidden'); return; }
        const host = byIdx(curIdx);
        if (host && countEl.parentNode !== host) host.appendChild(countEl);
        countEl.classList.remove('hidden');
        const gone = Math.round((1 - cd.remain / cd.total) * dots.length);
        dots.forEach((d, i) => d.classList.toggle('on', i < gone));
    }

    const byIdx = (i) => (i >= 0 ? document.getElementById(`kline-${i}`) : null);

    // 上下槽永遠維持同字級、各一列。先回到 CSS 最大字級量自然寬度,再一起縮到
    // 較長那句放得下；只在換槽/縮放時做,不進逐幀填色的熱路徑。
    function fitVisibleLines() {
        fitRaf = 0;
        const visible = [...new Set([byIdx(topIdx), byIdx(botIdx)].filter(Boolean))];
        if (!visible.length) return;

        visible.forEach((el) => { el.style.fontSize = ''; });
        const maxPx = parseFloat(getComputedStyle(visible[0]).fontSize);
        const measurements = visible.map((el) => {
            const style = getComputedStyle(el);
            const natural = el.querySelector('.kbase')?.scrollWidth || 0;
            const available = linesEl.clientWidth
                - (parseFloat(style.marginLeft) || 0)
                - (parseFloat(style.marginRight) || 0);
            return { natural, available };
        });
        const size = karaokeFitFontSize(maxPx, measurements);
        if (size === null) return;
        visible.forEach((el) => { el.style.fontSize = `${size}px`; });
    }

    function scheduleLineFit() {
        cancelAnimationFrame(fitRaf);
        fitRaf = requestAnimationFrame(fitVisibleLines);
    }

    window.addEventListener('resize', scheduleLineFit);
    document.addEventListener('fullscreenchange', scheduleLineFit);
    document.fonts?.ready.then(scheduleLineFit);

    // 填色只動疊在上面那層。**karaokeSplit / karaokePaint / karaokeClear 三個都要收到
    // 同一顆元素** —— 它們把字元 span 與「正在唱的那顆」memo 在 root.__kc / root.__kcNow 上,
    // 傳不同的根等於各記各的,清除就清不到。
    const overOf = (el) => (el ? el.querySelector('.kover') : null);

    /**
     * 把 karaokeSlots 算出來的上下槽套到 DOM 上。
     *
     * **唱完的那句不清填色** —— 它會以 .done 留在原地紅著,直到這句唱到一半才被下一句
     * 換掉 (見 karaoke-slots.js 檔頭第 4 點)。清除的時機因此是「一句**進場**時」:
     * 往回 seek 會讓同一句再上場一次,那時舊的填色才要抹掉。
     */
    function applySlots(s) {
        const prev = [topIdx, botIdx];
        const now = [s.top, s.bottom];

        for (const i of prev) {
            if (i < 0 || now.includes(i)) continue;
            const el = byIdx(i);
            if (el) el.classList.remove('slot-top', 'slot-bottom', 'cur', 'done');
        }
        for (const i of now) {
            if (i < 0 || prev.includes(i)) continue;
            const over = overOf(byIdx(i));
            if (over) karaokeClear(over);
        }
        const top = byIdx(s.top);
        if (top) { top.classList.add('slot-top'); top.classList.remove('slot-bottom'); }
        const bottom = byIdx(s.bottom);
        if (bottom) { bottom.classList.add('slot-bottom'); bottom.classList.remove('slot-top'); }

        if (s.index !== curIdx) {
            const oldCur = byIdx(curIdx);
            if (oldCur) oldCur.classList.remove('cur');
            const cur = byIdx(s.index);
            if (cur) cur.classList.add('cur');
        }
        // 另一槽放的是「剛唱完那句」時要繼續紅著 (.done);放的是預覽的下一句就不能紅。
        // 序號比活躍句小 = 上一句 —— 往回 seek 的話它的填色已經被上面那圈 karaokeClear
        // 抹掉了,紅字被 clip 到 0% 等於看不見,不會有殘影。
        const other = s.top === s.index ? s.bottom : s.top;
        for (const i of now) {
            const el = byIdx(i);
            if (el) el.classList.toggle('done', i === other && i >= 0 && i < s.index);
        }
        topIdx = s.top;
        botIdx = s.bottom;
        curIdx = s.index;
        scheduleLineFit();
    }

    /**
     * 曲名/作詞作曲的資訊卡。
     *
     * **它不再是一個獨佔的畫面,而是畫面上緣的一塊** (見 style.css) —— 歌詞照舊在下緣顯示,
     * 兩者不重疊。改成這樣才解得開「前奏短的歌看不到資訊卡」與「卡片蓋住第一句連同倒數的點」
     * 這組互相矛盾的需求。
     *
     * 因此顯示時間可以**至少 `INFO_MIN_SEC` 秒**:前奏只有一兩秒的歌一閃而過等於沒顯示,
     * 而超出前奏繼續留著也不擋任何東西。
     */
    const INFO_MIN_SEC = 3;
    function paintIntro(p) {
        // firstTime 是 Infinity = 整份都是間奏行,那時沒有「前奏」可言,卡片會卡住不走
        const show = lines.length > 0 && firstTime < Infinity
            && p < Math.max(firstTime, INFO_MIN_SEC);
        introEl.classList.toggle('hidden', !show);
    }

    function frame() {
        const now = performance.now();
        const dt = (now - lastFrame) / 1000;
        lastFrame = now;
        if (playing) pos += dt;

        const p = pos - syncOffset;
        if (lines.length) {
            const s = karaokeSlots(lines, p, curIdx);
            if (s.index !== curIdx || s.top !== topIdx || s.bottom !== botIdx) applySlots(s);
            if (curIdx >= 0) {
                const over = overOf(byIdx(curIdx));
                // 位置沒有提前量,所以這裡不必再減回去 (見檔頭第 1 點)
                if (over) karaokePaint(over, lines[curIdx].words, (p - lines[curIdx].time) * 1000);
            }
            paintCountdown(s.countdown);
        } else {
            paintCountdown(null);
        }
        paintIntro(p);

        mvSync(pos, playing);
        requestAnimationFrame(frame);
    }

    // ===================== 播放狀態 =====================

    async function fetchLyrics(t, a) {
        const seq = ++fetchSeq;
        setStatus('正在搜尋歌詞...', 'fa-solid fa-spinner fa-spin');
        try {
            const r = await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(t)}&artist=${encodeURIComponent(a || '')}`);
            if (seq !== fetchSeq) return;
            const d = r.ok ? await r.json() : null;
            if (seq !== fetchSeq) return;
            setLyrics(d && d.lyrics ? d.lyrics : '');
        } catch (e) {
            if (seq === fetchSeq) setStatus('歌詞抓取失敗', 'fa-solid fa-triangle-exclamation');
        }
    }

    // 播放鍵自己更新:common.js 的 syncPlayerBar 改的是播放列裡那顆,那條在這一頁是藏著的
    function paintPlayBtn() {
        const icon = document.getElementById('kbar-play-icon');
        if (!icon) return;
        icon.className = 'fa-solid ' + (playing ? 'fa-pause' : 'fa-play');
        document.getElementById('kbar-play-label').textContent = playing ? '暫停' : '播放';
    }

    function applyState(d) {
        playing = !!d.is_playing;
        paintPlayBtn();

        if (d.title && d.position !== lastServerPos) {
            const diff = d.position - pos;
            // 換歌 / seek 就硬對齊,小漂移補一半 (同 app.js)
            if (Math.abs(diff) > 1.5 || d.title !== title) pos = d.position;
            else pos += diff * 0.5;
            lastServerPos = d.position;
        }

        if (d.title && (d.title !== title || d.artist !== artist)) {
            title = d.title;
            artist = d.artist || '';
            window.currentMediaDuration = d.duration || 0;
            clearLyrics();
            // 曲名/歌手是播放器給的原始字串 (沒逃逸過) —— 這兩顆一定要 textContent
            document.getElementById('ki-title').textContent = title;
            document.getElementById('ki-artist').textContent = artist;
            setStatus('正在搜尋歌詞...', 'fa-solid fa-spinner fa-spin');
            const requestedOffsetKey = offsetSongKey(title, artist);
            const applyLoadedOffset = (value) => {
                if (offsetSongKey(title, artist) !== requestedOffsetKey) return;
                syncOffset = value;
                window.karaokePaintOffset();
            };
            fetch(`/api/lyrics/offset?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)
                .then(r => r.json()).then(o => applyLoadedOffset(o.offset || 0))
                .catch(() => applyLoadedOffset(0));
            // 還在介紹頁時不要載 MV (`karaokeStart` 會補一次)
            if (started) karaokeOnSongChange(title, artist);
            nowEl.textContent = `現在播放:${title}${artist ? ' — ' + artist : ''}`;
        } else if (!d.title && title) {
            title = artist = lyricsKey = '';
            clearLyrics();
            setStatus('等待播放...');
            nowEl.textContent = '目前沒有偵測到播放';
            if (started) karaokeOnSongChange('', '');
        }
        if (d.duration !== undefined) window.currentMediaDuration = d.duration;

        // 名字定案 (iTunes 日文原名還原是非同步的) 才抓歌詞 —— 不等的話會用兩個不同的鍵
        // 各抓一次,第二次多半撞來源限流拿到空的,把已經抓對的歌詞蓋掉
        if (d.title && !d.resolving) {
            const key = `${d.title}|||${d.artist || ''}`;
            if (key !== lyricsKey) {
                lyricsKey = key;
                fetchLyrics(d.title, d.artist);
            }
        }
    }

    // ===================== 進入 / 離開 =====================
    //
    // 這一頁是「介紹頁 + 字幕機」兩個畫面 (同 /game),`body.karaoke-page` 才是字幕機那個。
    // **全螢幕只能在使用者手勢裡要**,所以 requestFullscreen 掛在「開始」那顆按鈕上,
    // 不是進頁面就要 —— 沒有手勢瀏覽器一律拒絕 (而且會在 console 留一則沒人看的警告)。
    let started = false;

    window.karaokeStart = function () {
        if (started) return;
        started = true;
        document.body.classList.add('karaoke-page');
        // 字幕機本身就是一個更大的歌詞畫面,置頂的靈動島是重複的而且會蓋在上面 —— 請 server
        // 把它收起來 (離開/重整/當掉時連線一斷,server 自己開回來,見 syncIslandHidden)。
        // **sticky**:連線斷掉重連後要重送,否則旗標歸零、島自己跑回來。
        window.sendMediaSocket({ type: 'karaoke_active', active: true }, 'karaoke');
        // 從頭唱:按下開始就把歌跳回 0 (= 控制列上的「重唱」),並且直接開始放。
        // **`play` 不是 `playpause`** —— 後者是 toggle,本來就在播的話會被關掉。
        // 本地狀態一起改,不然畫面要等下一則廣播 (一秒一則) 才開始跑。
        karaokeRestart();
        mediaAction('play');
        playing = true;
        paintPlayBtn();
        // MV 刻意等到這裡才載:介紹頁背後偷偷播一支 YouTube 影片沒有道理
        karaokeOnSongChange(title, artist);
        document.documentElement.requestFullscreen?.().catch(() => {});
        showBar();
    };

    window.karaokeExit = function () {
        if (!started) return;
        started = false;
        // 離開就停:不停的話使用者已經回到介紹頁,背景還在放沒人唱的歌 (同 game.js 的 endGame)
        mediaAction('pause');
        playing = false;
        paintPlayBtn();
        document.body.classList.remove('karaoke-page');
        window.sendMediaSocket({ type: 'karaoke_active', active: false }, 'karaoke');
        karaokeOnSongChange('', '');   // 停掉 MV
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };

    // 使用者用瀏覽器自己的方式離開全螢幕 (ESC、F11) 時也要回到介紹頁 ——
    // 全螢幕的 ESC 被瀏覽器吃掉,下面那個 keydown 收不到。
    // **控制列拆成獨立小視窗時不算** (karaoke-remote.js):開那扇窗本身就可能讓瀏覽器把
    // 主視窗退出全螢幕,不擋的話「按獨立視窗」等於直接離開卡拉OK模式。而且那時使用者本來
    // 就是刻意分兩個視窗在用,退出全螢幕不代表要收工。
    document.addEventListener('fullscreenchange', () => {
        if (window.karaokeRemoteIsOpen && window.karaokeRemoteIsOpen()) return;
        if (!document.fullscreenElement && started) karaokeExit();
    });

    window.onMediaMessage((msg) => {
        if (msg.type === 'media_state' || msg.type === 'init') {
            if (msg.state) applyState(msg.state);
            return;
        }
        const liveOffset = offsetFromMessage(offsetSongKey(title, artist), msg);
        if (liveOffset !== null) {
            syncOffset = liveOffset;
            paintOffset();
            return;
        }
        if (msg.type !== 'lyrics_updated' || !msg.lyrics) return;
        if (msg.title !== title || msg.artist !== artist) return;
        setLyrics(msg.lyrics);
    });

    // WebSocket 斷線時的保底 (同 app.js/common.js:連線活著就完全不打)
    setInterval(async () => {
        if (window.__mediaSocketAlive) return;
        try {
            const r = await fetch('/api/current-media', { cache: 'no-store' });
            if (r.ok) applyState(await r.json());
        } catch (e) {}
    }, 2000);

    // ===================== 控制列 (#karaoke-bar) =====================

    // 備選歌詞那顆連同它的浮層整塊搬過來:浮層是 absolute 錨在 .lyrics-opt-wrap 上,
    // 搬 wrapper 而不是只搬按鈕,錨點才跟著走 (只搬按鈕的話浮層會留在藏起來的播放列裡)。
    const tools = document.getElementById('kbar-tools');
    const optWrap = document.querySelector('.lyrics-opt-wrap');
    if (tools && optWrap) {
        tools.prepend(optWrap);
        // data-tip 在這一頁是常駐標籤 (見 style.css 的 #kbar-tools .ctrl-btn::before),
        // 而 server render 的字是「搜尋/查看備選歌詞」且之後只更新 title、不更新 data-tip ——
        // 留著就會是一個永遠停在初始狀態的標籤,改成固定名稱
        const optBtn = optWrap.querySelector('.ctrl-btn');
        if (optBtn) optBtn.dataset.tip = '備選歌詞';
    }

    // 頭出し:跳回 0 從頭唱。**本地 pos 也要一起歸零** —— 廣播一秒才一則,只送 seek 的話
    // 畫面會停在原本那句、等下一則廣播才跳,看起來像沒反應 (同 karaokeStart)。
    window.karaokeRestart = function () {
        fetch('/api/seek', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position: 0 }),
        }).catch(() => {});
        pos = 0;
        lastServerPos = -1;
    };

    // 字幕早晚 = 這首歌的 sync offset,跟首頁共用同一筆 (存 DB)。填色與換行都吃
    // frame() 的 `pos - syncOffset`,所以改完不必自己重畫,下一幀就對了。
    const offsetEl = document.getElementById('kbar-offset');
    const saveOffsetLater = createOffsetSaver((payload) => {
        fetch('/api/lyrics/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true,
        }).catch(() => {});
    });
    window.addEventListener('pagehide', saveOffsetLater.flush);

    function paintOffset() {
        const ms = Math.round(syncOffset * 1000);
        offsetEl.textContent = ms > 0 ? `+${ms} ms` : `${ms} ms`;
    }
    window.karaokePaintOffset = paintOffset;

    function saveOffset() {
        saveOffsetLater(title, artist, syncOffset);
    }

    window.karaokeAdjustOffset = function (delta) {
        syncOffset = Math.round((syncOffset + delta) * 10) / 10;   // 0.1 的浮點殘渣
        paintOffset();
        saveOffset();
    };

    window.karaokeResetOffset = function () {
        syncOffset = 0;
        paintOffset();
        saveOffset();
    };

    function offsetKeydown(e) {
        if (!started) return;
        const delta = karaokeOffsetHotkey(e,
            localStorage.getItem('hk-advance') || 'ArrowLeft',
            localStorage.getItem('hk-delay') || 'ArrowRight');
        if (delta === null) return;
        e.preventDefault();
        karaokeAdjustOffset(delta);
        showBar();
    }
    window.karaokeOffsetKeydown = offsetKeydown;
    document.addEventListener('keydown', offsetKeydown);

    let barTimer = null;
    let overBar = false;

    function barPinned() {
        if (overBar) return true;
        const opt = document.getElementById('lyrics-options-modal');
        if (opt && opt.classList.contains('show')) return true;
        return !document.getElementById('karaoke-mv-picker').classList.contains('hidden');
    }

    function showBar() {
        document.body.classList.add('bar-visible');
        clearTimeout(barTimer);
        barTimer = setTimeout(() => {
            if (barPinned()) { showBar(); return; }
            document.body.classList.remove('bar-visible');
        }, 3000);
    }
    window.karaokeShowBar = showBar;

    document.addEventListener('mousemove', showBar);
    const bar = document.getElementById('karaoke-bar');
    if (bar) {
        bar.addEventListener('mouseenter', () => { overBar = true; });
        bar.addEventListener('mouseleave', () => { overBar = false; });
    }
    showBar();

    // ESC 離開。浮層開著時先讓它們吃掉這一下 (備選歌詞的浮層自己有 ESC handler)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !started) return;
        const opt = document.getElementById('lyrics-options-modal');
        if (opt && opt.classList.contains('show')) return;
        if (!document.getElementById('karaoke-mv-picker').classList.contains('hidden')) {
            karaokeCloseMvPicker();
            return;
        }
        karaokeExit();
    });

    // 降級提示上那顆「找別份歌詞」:露出控制列再跑既有的備選歌詞流程 (lyrics-tools.js)
    window.karaokeFindLyrics = function () {
        showBar();
        searchLyricsOptions();
    };

    requestAnimationFrame(frame);
});
