/*
 * 卡拉OK控制列的「拆成獨立小視窗」(多螢幕:字幕機全螢幕投在電視/投影機上,
 * 遙控器留在筆電這一邊,調字幕早晚、換 MV 都不必動到主畫面)。
 *
 * **不是另做一個遙控頁面。** 那等於把播放鍵圖示、字幕/影片偏移、備選歌詞浮層各再寫一份,
 * 而兩份一定會漂 —— 漂掉的症狀是「小視窗上的數字不會動」,沒有錯誤訊息。
 * 這裡是把**同一顆** #karaoke-bar (連同 MV 挑選面板與它的遮罩) 用 adoptNode 搬進
 * window.open 出來的空白文件:節點物件沒變,addEventListener 掛的 handler 與
 * karaoke-mode.js / karaoke-mv.js 抓在閉包裡的 element 參照全部照舊有效,狀態只有一份。
 *
 * 用 window.open 而不是 Electron 的 BrowserWindow:純 node 模式 (npm start,用瀏覽器開)
 * 也要能用,而靈動島那條路只有打包版才有主進程。
 *
 * 搬過去之後有兩件事會斷,各修一次:
 *
 * 1. **行內 onclick 在小視窗的 realm 求值**,那裡沒有 karaokeRestart 這些全域函式。
 *    解法是把主視窗 window 上所有函式原樣掛過去 (同一個函式物件,閉包仍在主視窗) ——
 *    這樣連之後動態插進來的節點 (備選歌詞清單那些 onclick) 也一併涵蓋,
 *    不必每次重畫都回頭 rebind 一輪。
 * 2. **lyrics-tools.js 那批 `document.getElementById('lyrics-options-modal')` 是現查的**,
 *    節點已經不在主視窗的 document 裡。與其把十幾個呼叫點各改成先存參照 (漏一處就是
 *    靜默失效),在主視窗的 document 上補一層:自己找不到就去小視窗找。
 */
document.addEventListener('DOMContentLoaded', function () {
    const bar = document.getElementById('karaoke-bar');
    if (!bar) return;

    // 三塊一起搬:控制列 + MV 挑選面板 + 它的遮罩。備選歌詞浮層本來就在控制列裡面
    // (karaoke-mode.js 已經把整塊 .lyrics-opt-wrap 搬進 #kbar-tools)。
    const moved = [bar,
        document.getElementById('karaoke-mv-mask'),
        document.getElementById('karaoke-mv-picker')].filter(Boolean);
    // 回家的位置只記 parent:三塊都是 fixed 的浮層,兄弟順序不影響畫面,
    // 而記 nextSibling 會踩到「下一個兄弟自己也被搬走了」的 insertBefore 例外。
    const home = moved.map((el) => [el, el.parentNode]);

    // **一種尺寸,開了就不再動它。** 做過「平常只包住控制列、浮層展開才撐大」,
    // 結果是 resizeTo/resizeBy 在這種 about:blank 子視窗上不可靠 —— 實測撐得大、
    // 縮不回來,而且 outerWidth/innerWidth 互相矛盾 (785 vs 880)。與其跟瀏覽器搶,
    // 一種尺寸就好,想改大小使用者自己拉。
    // **窗就只有按鈕那麼大** (使用者要求):控制列 wrap 成三列,視窗剛好包住它,
    // 不留空白。備選歌詞與 MV 兩個浮層在這扇窗改成鋪滿整個視窗 (見 style.css),
    // 所以不必為了它們預留高度。
    // 高度含瀏覽器彈出視窗那條標題列 (實測約 57px);Electron 那邊是無邊框視窗,
    // `electron.js` 的 override 直接給內容區的 214,兩邊不是同一個數字是正常的。
    const SIZE = { w: 300, h: 271 };

    let popup = null;
    let watch = null;

    // ── 2. document.getElementById 的補丁 ──
    const rawGet = document.getElementById.bind(document);
    document.getElementById = (id) =>
        rawGet(id) || (popup && !popup.closed ? popup.document.getElementById(id) : null);

    function isOpen() {
        return !!(popup && !popup.closed);
    }
    window.karaokeRemoteIsOpen = isOpen;

    // 這顆鈕自己也跟著搬過去 (在 #kbar-tools 裡),所以在小視窗裡就變成「收回」
    function paintBtn() {
        const b = document.getElementById('kbar-detach');
        if (!b) return;
        // 開著時標籤要短:那顆鈕在小視窗裡跟偏移排擠同一列,四個字會撐出橫向捲動
        b.dataset.tip = isOpen() ? '收回' : '獨立視窗';
        const i = b.querySelector('i');
        if (i) i.className = 'fa-solid ' + (isOpen()
            ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-from-square');
    }

    /**
     * 第三列 = 字幕/影片兩排偏移 + 「收回」+ 「退出」(收回在中間,退出在最右)。
     *
     * 那兩顆鈕在字幕機那條橫的控制列裡自成一欄 (`#kbar-extra`),這扇窗要它們跟偏移排
     * 擠同一列 —— 用 CSS 搬不動同層以外的節點,所以這裡真的搬,`restore()` 再放回去。
     * 包一層 `.kbar-row3` 而不是絕對定位:偏移排的高度會隨「有沒有挑 MV」變 (一排或兩排),
     * 絕對定位的鈕會凸出去。
     */
    function layoutRow3(doc) {
        const offsets = bar.querySelector('.kbar-offsets');
        const extra = doc.getElementById('kbar-extra');
        if (!offsets || !extra) return;
        const row = doc.createElement('div');
        row.className = 'kbar-row3';
        offsets.replaceWith(row);
        row.append(offsets, ...extra.children);   // 收回 → 退出,順序照 DOM
        // 空掉的 #kbar-extra 連同它前面那條分隔線在這扇窗沒有意義,收起來
        extra.classList.add('hidden');
        extra.previousElementSibling?.classList.add('hidden');
    }

    function unlayoutRow3() {
        const row = bar.querySelector('.kbar-row3');
        if (!row) return;
        const offsets = row.querySelector('.kbar-offsets');
        const extra = document.getElementById('kbar-extra');
        const btns = [...row.querySelectorAll('.ctrl-btn')];
        row.replaceWith(offsets);
        if (extra) {
            extra.append(...btns);
            extra.classList.remove('hidden');
            extra.previousElementSibling?.classList.remove('hidden');
        }
    }

    function build() {
        const d = popup.document;
        d.open();
        // body 掛 karaoke-page + bar-visible 是為了直接吃控制列既有的樣式;karaoke-remote
        // 只把「畫面底部的自動隱藏浮條」那幾條幾何改掉 (見 style.css)
        d.write('<!doctype html><html><head><meta charset="utf-8"><title>Kanaric 遙控</title>'
            + '</head><body class="karaoke-page bar-visible karaoke-remote"></body></html>');
        d.close();

        for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
            const link = d.createElement('link');
            link.rel = 'stylesheet';
            // **一定要用 .href 這個絕對網址**:小視窗是 about:blank,base URL 不是 server,
            // 相對路徑 (/css/style.css?v=…) 在那邊一律解不出來,整個視窗會沒有樣式
            link.href = l.href;
            d.head.appendChild(link);
        }

        // 無邊框視窗沒有標題列可以抓,而控制列上幾乎整片都是按鈕 (按鈕必須 no-drag,
        // 否則按不下去) —— 上面補一條專門用來拖的細條,不然這扇窗搬不動。
        const grip = d.createElement('div');
        grip.className = 'kbar-drag';
        d.body.appendChild(grip);

        for (const el of moved) d.body.appendChild(d.adoptNode(el));
        layoutRow3(d);

        // 1. 主視窗的全域函式原樣掛過去。內建全域是 non-enumerable,Object.keys 不會撈到,
        //    所以這裡複製到的只有這個 app 自己定義的那些。
        for (const k of Object.keys(window)) {
            try { if (typeof window[k] === 'function') popup[k] = window[k]; } catch (e) {}
        }
        d.addEventListener('keydown', window.karaokeOffsetKeydown);

        popup.focus();
    }

    function restore() {
        clearInterval(watch);
        watch = null;
        popup = null;
        for (const [el, parent] of home) parent.appendChild(document.adoptNode(el));
        unlayoutRow3();   // 一定要在搬回主視窗之後,那顆鈕才回得到 #kbar-tools
        paintBtn();
    }

    window.karaokeToggleRemote = function () {
        if (isOpen()) { popup.close(); restore(); return; }
        // resizable=no 只有部分瀏覽器會理 (Chrome 忽略);桌面版是 electron.js 那邊
        // `resizable: false` 真的把它鎖住的
        popup = window.open('', 'kanaric-remote',
            `width=${SIZE.w},height=${SIZE.h},menubar=no,toolbar=no,location=no,status=no,resizable=no`);
        if (!popup) {
            showToast('瀏覽器擋掉了彈出視窗,請允許後再試', 'fa-solid fa-triangle-exclamation');
            return;
        }
        build();
        // 使用者用視窗自己的 ✕ 關掉時沒有可靠的事件 (unload 期間搬 DOM 也不安全),
        // 直接輪詢 —— 主畫面那幾百毫秒沒有控制列不影響唱歌
        watch = setInterval(() => { if (popup.closed) restore(); }, 300);
        paintBtn();
    };

    // 離開卡拉OK / 換頁就把遙控器收回來,不然控制列會留在一扇孤兒視窗裡
    const exit = window.karaokeExit;
    window.karaokeExit = function () {
        if (isOpen()) { popup.close(); restore(); }
        exit();
    };
    window.addEventListener('pagehide', () => { if (isOpen()) popup.close(); });
});
