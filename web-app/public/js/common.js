// 從 views/footer.ejs 原樣搬出來的每頁共用邏輯 (設定選單 / 播放列 / WebSocket / 導覽)。
// 搬出來的唯一理由是快取:內嵌在 footer 時這 1000 行每次換頁都要重傳一次 (~60KB)。
// 需要 EJS 插值的那幾行 (window.__initialMedia 等) 留在 footer.ejs 裡,在這支之前跑。
// 這支刻意**不加 defer** —— 它要在原本內嵌的那個位置同步執行,順序與時機才跟改版前一致。

        window.__karaokeWindowSettings = { compact: true, top: true, autoCollapse: true };
        const karaokeWindowSettingKeys = {
            karaoke_compact_on_start: 'compact',
            karaoke_always_on_top: 'top',
            karaoke_auto_collapse: 'autoCollapse',
        };

        function updateKaraokeWindowSetting(key, checked) {
            const name = karaokeWindowSettingKeys[key];
            if (!name || !window.karaokeWindow) return;
            window.__karaokeWindowSettings[name] = checked;
            window.dispatchEvent(new CustomEvent('karaoke-window-settings-changed', { detail: window.__karaokeWindowSettings }));
            saveSettingsToServer(key, checked);
        }

        function toggleSettingsMenu(e) {
            if (e) e.stopPropagation();
            const menu = document.getElementById('settings-menu');
            if (!menu) return;
            if (menu.classList.contains('show')) {
                closeSettingsMenu();
            } else {
                menu.classList.add('show');
            }
        }

        // 收設定選單時,飛出去的子選單也要一起收,否則下次打開它還開著。
        // 名單一律走 MENU_SECTIONS —— 以前這裡寫死三個 key,新增小節就會漏收。
        function closeSettingsMenu() {
            const menu = document.getElementById('settings-menu');
            if (menu) menu.classList.remove('show');
            MENU_SECTIONS.forEach(k => {
                const sec = document.getElementById(k + '-section');
                if (sec) sec.classList.remove('show');
                const btn = document.getElementById(k + '-toggle');
                if (btn) btn.classList.remove('open');
            });
        }

        document.addEventListener('click', (e) => {
            // 迷你導覽進行中要框住選單裡的元素,點導覽卡 (在選單外) 不能把選單收掉
            if (tourIndex >= 0 && currentTour !== tourSteps) return;
            const menu = document.getElementById('settings-menu');
            if (!menu || !menu.classList.contains('show')) return;
            // `.sel-pop` 是 select-menu.js 自己畫的下拉清單,為了 position: fixed 不被選單的
            // overflow 裁掉,它掛在 <body> 底下而不是選單裡 —— 所以點選項時 `menu.contains`
            // 是 false,整個設定選單會跟著被收掉 (它在畫面上明明就疊在選單裡面)。
            // 判斷加一條:清單本身算選單的一部分。
            if (e.target.closest && e.target.closest('.sel-pop')) return;
            if (!menu.contains(e.target)) closeSettingsMenu();
        });

        // 子選單直接在設定選單旁展開。三個飛出面板共用同一個定位點,
        // 同時開會疊在一起,所以開新的要把其他的收掉 (手風琴)。
        const MENU_SECTIONS = ['island', 'hotkeys', 'source', 'data'];
        function toggleMenuSection(e, key) {
            if (e) e.stopPropagation();
            const sec = document.getElementById(key + '-section');
            const btn = document.getElementById(key + '-toggle');
            if (!sec) return;
            const open = sec.classList.toggle('show');
            if (btn) btn.classList.toggle('open', open);
            if (open) {
                MENU_SECTIONS.filter(k => k !== key).forEach(k => {
                    const s = document.getElementById(k + '-section');
                    if (s) s.classList.remove('show');
                    const b = document.getElementById(k + '-toggle');
                    if (b) b.classList.remove('open');
                });
                // 音訊來源:每次展開才掃一次媒體 session,關掉的 app 不會留在清單
                if (key === 'source') loadMediaSources();
                // 資料用量要掃全表,展開才查 —— 每次開設定選單都算沒必要
                if (key === 'data') loadDbUsage();
                // 島可能被系統匣或播放列那顆按鈕開關過,展開時問一次現況
                if (key === 'island') refreshIslandToggle();
            }
        }
        function toggleHotkeysSection(e) { toggleMenuSection(e, 'hotkeys'); }
        function toggleSourceSection(e) { toggleMenuSection(e, 'source'); }
        function toggleDataSection(e) { toggleMenuSection(e, 'data'); }
        function toggleIslandSection(e) { toggleMenuSection(e, 'island'); }

        // -------------------------------------------------------------
        // 靈動島
        // -------------------------------------------------------------
        // 選單裡的「顯示靈動島」跟播放列那顆按鈕、系統匣選單是同一個狀態,三邊都要對得上
        async function refreshIslandToggle() {
            const el = document.getElementById('setting-island-on');
            if (!el) return;
            try {
                const d = await (await fetch('/api/island/status')).json();
                el.checked = !!d.isRunning;
                el.disabled = d.available === false;   // 純 node 模式沒有島
            } catch (e) {}
        }

        // 滑桿是整數百分比,設定存 0–1 的小數 (島的 CSS 直接吃這個值)
        let islandOpacityTimer = null;
        function updateIslandOpacity(pct) {
            const label = document.getElementById('island-opacity-value');
            if (label) label.textContent = pct + '%';
            // 拖曳中每一格都存會狂打 API,停手 200ms 才寫
            clearTimeout(islandOpacityTimer);
            islandOpacityTimer = setTimeout(() => saveSettingsToServer('island_opacity', pct / 100), 200);
        }

        async function resetIslandPosition() {
            try {
                const d = await (await fetch('/api/island/reset-position', { method: 'POST' })).json();
                showToast(d.success ? '靈動島已回到螢幕上方置中' : '靈動島需要桌面版 Kanaric',
                          d.success ? 'fa-solid fa-crosshairs' : 'fa-solid fa-circle-info');
            } catch (e) {}
        }

        // -------------------------------------------------------------
        // 聆聽紀錄與資料
        // -------------------------------------------------------------
        function updateTrackHistory(checked) {
            saveSettingsToServer('track_history', checked);
            // 側欄 SSR 時就決定好了,這裡只處理「當下這一頁」不用重新整理也會跟著變
            document.querySelectorAll('.nav-stats-item').forEach(el => el.classList.toggle('hidden', !checked));
        }

        function fmtBytes(n) {
            if (!n) return '0 KB';
            return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
        }

        async function loadDbUsage() {
            const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
            set('usage-lyrics', '…'); set('usage-history', '…'); set('usage-manual', '…');
            set('usage-game', '…'); set('usage-file', '…');
            try {
                const d = await (await fetch('/api/db-usage', { cache: 'no-store' })).json();
                set('usage-lyrics', `${d.lyrics.rows} 首 · ${fmtBytes(d.lyrics.bytes)}`);
                set('usage-history', `${d.history.rows} 筆 · ${fmtBytes(d.history.bytes)}`);
                set('usage-game', `${d.game.rows} 題`);
                set('usage-manual', `${d.manual.rows} 筆`);
                set('usage-file', fmtBytes(d.file));
            } catch (e) {
                set('usage-lyrics', '讀取失敗'); set('usage-history', '讀取失敗');
                set('usage-game', '—'); set('usage-manual', '—'); set('usage-file', '—');
            }
        }

        async function clearDbData(target) {
            // 聆聽紀錄與猜歌紀錄清了回不來,歌詞快取只是要重抓 —— 文案要讓使用者分得出差別
            const PROMPTS = {
                history: '確定清除全部聆聽紀錄嗎？\n\n統計數據與排行榜會歸零，這個動作無法復原。',
                game: '確定清除全部猜歌紀錄嗎？\n\n這個動作無法復原。',
                lyrics: '確定清除歌詞快取嗎？\n\n之後播到的歌會重新上網抓一次。\n你手動修正過的假名與時間軸校正不會被清掉。',
            };
            const DONE = { history: '聆聽紀錄已清除', game: '猜歌紀錄已清除', lyrics: '歌詞快取已清除' };
            if (!confirm(PROMPTS[target])) return;
            try {
                const r = await fetch('/api/db-clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target })
                });
                if (!r.ok) throw new Error((await r.json()).error || r.status);
                showToast(DONE[target], 'fa-solid fa-circle-check', 2500);
                loadDbUsage();
            } catch (e) {
                showToast('清除失敗：' + e.message, 'fa-solid fa-triangle-exclamation', 4000);
            }
        }

        // 備份是 server 現做的 (VACUUM INTO),幾百 ms 到幾秒都有可能,按鈕要有在動的樣子。
        // 用 blob 而不是直接把 href 指過去:失敗時才有辦法把錯誤訊息顯示出來
        async function downloadBackup(btn) {
            const label = btn.textContent;
            btn.disabled = true; btn.textContent = '準備中…';
            try {
                const r = await fetch('/api/backup');
                if (!r.ok) throw new Error((await r.json()).error || r.status);
                const blob = await r.blob();
                const name = (r.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name ? name[1] : 'Kanaric-backup.db';
                a.click();
                URL.revokeObjectURL(a.href);
                showToast('備份已下載', 'fa-solid fa-circle-check', 2500);
            } catch (e) {
                showToast('備份失敗：' + e.message, 'fa-solid fa-triangle-exclamation', 4000);
            } finally {
                btn.disabled = false; btn.textContent = label;
            }
        }

        // CSV 走同一套 blob 下載 (理由同 downloadBackup:直接指 href 就看不到錯誤訊息)。
        // 沒有紀錄時只有標題列,那不是錯誤 —— 吐司說清楚,不然使用者會以為下載壞了
        async function downloadHistoryCsv(btn) {
            const label = btn.textContent;
            btn.disabled = true; btn.textContent = '準備中…';
            try {
                const r = await fetch('/api/history.csv');
                if (!r.ok) throw new Error((await r.json()).error || r.status);
                const blob = await r.blob();
                const name = (r.headers.get('Content-Disposition') || '').match(/filename="?([^"]+)"?/);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name ? name[1] : 'Kanaric-history.csv';
                a.click();
                URL.revokeObjectURL(a.href);
                const rows = (await blob.text()).trim().split('\n').length - 1;
                showToast(rows > 0 ? `已匯出 ${rows} 筆聆聽紀錄` : '目前還沒有聆聽紀錄，CSV 只有標題列',
                          'fa-solid fa-circle-check', 2500);
            } catch (e) {
                showToast('匯出失敗：' + e.message, 'fa-solid fa-triangle-exclamation', 4000);
            } finally {
                btn.disabled = false; btn.textContent = label;
            }
        }

        async function restoreBackup(input) {
            const file = input.files && input.files[0];
            input.value = '';   // 清掉才能連續選同一個檔案
            if (!file) return;
            if (!confirm(`確定用「${file.name}」還原嗎？\n\n目前的歌詞快取、聆聽紀錄與所有手動修正都會被備份檔的內容取代。\n（現有資料會先另存一份救援檔，但請確認你選對檔案。）`)) return;
            try {
                const r = await fetch('/api/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: file
                });
                const d = await r.json();
                if (!r.ok || !d.success) throw new Error(d.error || r.status);
                if (d.relaunching) {
                    showToast('還原完成，Kanaric 正在重新啟動…', 'fa-solid fa-circle-check', 8000);
                } else {
                    // 純 node 模式沒有主進程可以自己重開,而 db 連線已經關掉了
                    showToast('還原完成，請手動重新啟動 Kanaric', 'fa-solid fa-circle-check', 10000);
                }
            } catch (e) {
                showToast('還原失敗：' + e.message, 'fa-solid fa-triangle-exclamation', 5000);
            }
        }



        // 新版提醒:一個 session 只查一次 (server 端本身也快取 1 小時),
        // 同一個版號只用吐司提示一次,不然每換一次頁 (index/stats/editor
        // 都是整頁重載) 就跳一次會很煩。動作掛在吐司右側的按鈕上,不是整塊吐司 ——
        // 整塊可點的話,使用者只想關掉提示也會誤觸下載/安裝。
        function checkForUpdate() {
            if (sessionStorage.getItem('updateChecked')) return;
            sessionStorage.setItem('updateChecked', '1');
            fetch('/api/update-check').then(r => r.json()).then(d => {
                const actionToast = (text, icon, label, onClick) => {
                    showToast(text, icon, 10000);   // showToast 會先把上一顆按鈕關掉
                    const btn = document.getElementById('toast-action');
                    if (!btn) return;
                    btn.textContent = label;
                    btn.classList.remove('hidden');
                    btn.onclick = onClick;
                };

                // 桌面版:新版已經自己下載好了,只差重開。這則比「去下載」有用得多,所以不看
                // updateSeenVersion 的已讀記錄 —— 沒裝之前每次開都該提醒
                if (d.ready) {
                    actionToast(`新版 v${d.ready} 已下載`, 'fa-solid fa-circle-up', '立即安裝', async () => {
                        try {
                            const r = await fetch('/api/update-install', { method: 'POST' });
                            const j = await r.json();
                            if (j.success) showToast('正在安裝更新，Kanaric 會自動重新啟動…', 'fa-solid fa-circle-check', 10000);
                        } catch (e) {}
                    });
                    return;
                }
                if (!d.hasUpdate || localStorage.getItem('updateSeenVersion') === d.latest) return;
                // 打包版會自己在背景下載,叫使用者去手動下載反而是錯的指示 —— 安靜等 ready
                if (d.autoUpdate) return;
                localStorage.setItem('updateSeenVersion', d.latest);
                actionToast(`有新版 v${d.latest} 可更新`, 'fa-solid fa-circle-up', '前往下載',
                            () => window.open(d.url, '_blank', 'noopener'));
            }).catch(() => {});
        }


        function loadMediaSources() {
            const sec = document.getElementById('source-section');
            sec.innerHTML = '<div class="hk-label">掃描中…</div>';
            fetch('/api/media-sources')
                .then(r => r.json())
                .then(data => {
                    const rows = [{ app_id: 'auto', name: '自動 (預設)' }].concat(data.sources || []);
                    sec.innerHTML = rows.map(s => {
                        const now = s.app_id === 'auto' ? '優先選擇音樂播放器'
                            // ▷ / ‖ 刻意選沒有 emoji 變體的碼位 (U+25B7 / U+2016),
                            // ▶ U+25B6 與 ⏸ U+23F8 在 Windows 會被 Segoe UI Emoji 接管變成彩色圖示
                            : [s.is_playing ? '▷' : '‖', [s.title, s.artist].filter(Boolean).join(' - ')].join(' ').trim();
                        const checked = (data.current || 'auto') === s.app_id ? ' checked' : '';
                        return `<label class="src-row">
                            <input type="radio" name="media-source" value="${escapeAttr(s.app_id)}"${checked}
                                   onchange="selectMediaSource(this.value)">
                            <span class="menu-label">${escapeAttr(s.name)}
                                ${now ? `<span class="src-now">${escapeAttr(now)}</span>` : ''}
                            </span>
                        </label>`;
                    }).join('');
                    // 清單載入後高度會變,迷你導覽的高亮框要重量一次
                    if (tourIndex >= 0) renderTourStep();
                })
                .catch(() => { sec.innerHTML = '<div class="hk-label">無法取得來源清單</div>'; });
        }

        function escapeAttr(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g,
                c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function selectMediaSource(appId) {
            saveSettingsToServer('media_source', appId);
        }

        // ── 使用說明:引導式導覽 ──
        const tourSteps = [
            { page: '/',       el: '.nav-menu',      title: '側欄導覽',   text: '這裡可以切換頁面：歌詞、統計數據、排行榜、卡拉OK、歌詞編輯器、猜歌。要進入卡拉OK模式，請從側欄點「卡拉OK」。滑鼠移到圖示上會顯示名稱。' },
            { page: '/',       el: '#menu-dots-btn', title: '設定選單',   text: '常用的開關直接列在上面：日文假名、片假名標平假名、顯示中文翻譯、顯示羅馬拼音、文字大小、歌詞對齊、優先搜尋來源。下半部收成幾個小節——靈動島、音訊來源、自訂快捷鍵、聆聽紀錄與資料，點一下往旁邊展開。讀不了片假名的話打開「片假名標平假名」，サヨナラ 上方會多標一行 さよなら；打開「顯示中文翻譯」或「顯示羅馬拼音」則會在每句日文歌詞下面多標一行，兩者網頁與靈動島同時生效。' },
            { page: '/',       el: '#lyrics-scroll', title: '歌詞區',     text: '歌詞會隨播放自動同步捲動，漢字上方標示假名注音。點任一句歌詞可以直接跳轉到該時間點。' },
            { page: '/',       el: '.player-center', title: '播放控制',   text: '控制播放/暫停、上下一首，拖曳進度條可跳轉。' },
            { page: '/',       el: '.player-right',  title: '工具列',     text: '由左至右：備選歌詞、段落循環、編輯假名、重新載入歌詞、桌面靈動島、放大模式。每顆都可以在設定選單的「自訂快捷鍵」裡改快捷鍵,也能按眼睛圖示把不需要的工具從這排隱藏。接下來由左到右細講。' },
            { page: '/',       el: '#lyrics-opt-btn', title: '備選歌詞',  text: '歌詞抓錯或時間軸不對時按這裡。它會直接在背景搜尋各個來源（按鈕轉圈中），找到後變成綠色打勾並跳出提醒，點打勾即可挑選要套用的版本。想讓它每次換歌都自動搜，到設定選單打開「自動搜尋備選歌詞」。' },
            { page: '/',       el: '#loop-mode-btn', title: '段落循環', text: '想反覆練唱某一段就按這顆書籤。進入循環模式後，點歌詞選出起點那一句，再點一句當終點，就會立刻跳到起點開始無限循環——唱完終點那一句會自動跳回起點。同一句連點兩次就是單句循環。選好的範圍會用綠色底標示出來。再按一次書籤（或快捷鍵，預設 A）結束循環。' },
            { page: '/',       el: '#toggle-ruby-mode-btn', title: '編輯假名', text: '假名偶爾會標錯（人名、罕見讀音）。按下這顆筆進入編輯模式，點任一個漢字，它的假名就地變成可打字的欄位——打羅馬拼音會自動轉成假名。Enter 儲存、Esc 取消、雙擊該字則回復成自動判讀的讀音。修改只套用在這首歌。' },
            { page: '/',       el: '#desktop-toggle-btn', title: '桌面靈動島', text: '開啟一個永遠置頂的懸浮歌詞條，切到別的視窗也看得到歌詞，適合一邊工作一邊聽歌。再按一次關閉，它也會跟著 Kanaric 一起結束。島可以直接拖著走，拖到螢幕最上緣會自動吸附；在島上單擊一下可以在「貼齊頂端」與「浮在下面一點」之間切換。歌詞行數、第二行要顯示下一句還是本句翻譯/羅馬拼音、透明度、鎖定位置、重置位置、開機自動顯示都在設定選單的「靈動島」小節。' },
            { page: '/',       el: '#offset-panel', reveal: true, title: '微調時間軸', text: '歌詞跟音樂對不上時用這裡校正。歌詞太晚出現就按「−」讓它提早，太早出現就按「+」讓它延遲，一次 0.1 秒；點中間的數字可以歸零。每首歌的偏移量會各自記住，下次播同一首自動套用，桌面靈動島也會跟著校正。平常它是半透明的，滑鼠移過去才會變清楚，也可以用快捷鍵調整（預設方向鍵左右）。' },
            { page: '/',       el: 'a.nav-item[href="/editor"]', title: '歌詞編輯器', text: '找不到歌詞、時間軸不準？歌詞編輯器可以手動修正。點「下一步」帶你進去看看。' },
            { page: '/editor', el: '.editor-grid > .dashboard-card:first-child', title: '選擇歌曲',
              text: '聽過的歌都存在這裡，可用歌名或歌手搜尋，點選後載入歌詞開始編輯。也可以直接按「編輯正在播放的歌」載入現在在放的那首——連還沒被快取的歌也能編。這裡已經先幫你載入第一首當範例。',
              emptyText: '聽過的歌會存在這裡，可用歌名或歌手搜尋。清單還是空的沒關係——按「編輯正在播放的歌」就能直接載入現在在放的那首來編。' },
            { page: '/editor', el: '.editor-grid > .dashboard-card:nth-child(2)', title: '編輯歌詞',
              text: '直接修改每句歌詞與時間戳，改完按最右邊的儲存鈕（磁碟片圖示）。右上角一排圖示鈕，滑鼠移上去會顯示名稱：刪除歌詞、標記為無歌詞、設定歌手別名、尋找更多歌詞、貼上自訂歌詞、儲存。「尋找更多歌詞」跟播放頁的備選歌詞一樣，展開就能挑別的來源套用。「標記為無歌詞」是給那種各站都沒收錄、老是抓到別首同名歌的冷門歌用的——標了就不再自動亂抓，日後真的被收錄會自動幫你換上。',
              emptyText: '選了歌之後，這裡可以直接修改每句歌詞與時間戳。右上角一排圖示鈕（移上去看名稱）：刪除、標記無歌詞、歌手別名、尋找更多歌詞、貼上自訂歌詞、儲存。先去聽幾首歌，或按上一步的「編輯正在播放的歌」。' },
            { page: '/editor', el: null,             title: '完成！',     text: '就是這些！開始享受你的音樂吧。想重看說明，隨時從左上角選單點「使用說明」。' }
        ];
        // 「音訊來源」問號的迷你導覽
        const sourceTourSteps = [
            { el: '#source-section', title: '音訊來源',
              text: '決定歌詞跟著哪個 app 走。「自動」優先選正在播放的音樂 app；音樂暫停時也不會被背景影片搶走歌詞。' },
            { el: '#source-section', title: '在瀏覽器聽歌',
              text: '想看 YouTube 的歌詞，請在這裡直接選那個瀏覽器。「自動」永遠讓音樂 app 優先——Spotify 開著但暫停時，正在播的瀏覽器會被忽略。' },
            { el: '#source-section', title: '指定 app',
              text: '選了特定 app 就只跟它——app 沒開啟時不顯示任何內容，也不會自動換到別的來源。清單每次展開時重新掃描，切換立即生效。' }
        ];
        let currentTour = tourSteps;
        let tourIndex = -1;
        let tourNoSongs = false; // 資料庫沒有任何快取歌曲時,編輯器的步驟要換一套說法

        function startTour() {
            closeSettingsMenu();
            if (!document.getElementById('lyrics-scroll')) {
                location.href = '/?tour=1';
                return;
            }
            localStorage.setItem('tourSeen', '1');
            currentTour = tourSteps;
            tourIndex = 0;
            renderTourStep();
            document.addEventListener('keydown', tourEscHandler);
        }

        // 問號啟動的迷你導覽:設定選單與該子選單保持展開,讓步驟框得到它們
        function startMiniTour(e, steps, sectionKey) {
            if (e) e.stopPropagation();
            const sec = document.getElementById(sectionKey + '-section');
            if (sec && !sec.classList.contains('show')) {
                toggleMenuSection(null, sectionKey);   // 順便收掉其他展開中的子選單
            }
            currentTour = steps;
            tourIndex = 0;
            renderTourStep();
            document.addEventListener('keydown', tourEscHandler);
        }

        function startSourceTour(e) { startMiniTour(e, sourceTourSteps, 'source'); }

        function endTour() {
            const wasMiniTour = currentTour !== tourSteps;
            tourIndex = -1;
            currentTour = tourSteps;
            if (wasMiniTour) closeSettingsMenu();
            const hl = document.getElementById('tour-highlight');
            const po = document.getElementById('tour-popover');
            if (hl) hl.remove();
            if (po) po.remove();
            document.querySelectorAll('.tour-reveal').forEach(el => el.classList.remove('tour-reveal'));
            document.removeEventListener('keydown', tourEscHandler);
        }

        function tourEscHandler(e) {
            if (e.key === 'Escape') endTour();
        }

        function tourStepMove(delta) {
            tourIndex += delta;
            if (tourIndex < 0 || tourIndex >= currentTour.length) { endTour(); return; }
            renderTourStep();
        }

        // 編輯器沒選歌時卡片是空的,框住空白的說明看不懂 → 自動幫使用者載入第一首
        function tourEnsureSongSelected(attempt = 0) {
            const sel = document.getElementById('song-select');
            if (!sel) return;

            const firstIdx = [...sel.options].findIndex(o => o.value);
            if (firstIdx < 0) {
                // 完全沒有 option = 歌曲清單還在抓 (非同步);
                // 有 option 但都沒有 value = 抓回來了,但資料庫是空的 (全新安裝、還沒聽過歌)
                if (sel.options.length > 0) {
                    if (!tourNoSongs) {
                        tourNoSongs = true;
                        renderTourStep();
                    }
                } else if (attempt < 20) {
                    setTimeout(() => tourEnsureSongSelected(attempt + 1), 100);
                }
                return;
            }

            tourNoSongs = false;
            if (sel.value) return; // 使用者已經選了歌,不要蓋掉

            sel.selectedIndex = firstIdx;
            sel.dispatchEvent(new Event('change'));
            // 歌詞載入後卡片高度會變,重畫高亮框
            setTimeout(() => { if (tourIndex >= 0) renderTourStep(); }, 500);
        }

        function renderTourStep() {
            const step = currentTour[tourIndex];
            // 跨頁步驟:記住進度後跳轉,載入後由 DOMContentLoaded 恢復 (迷你導覽不設 page,不跨頁)
            if (step.page && step.page !== location.pathname) {
                sessionStorage.setItem('tourResume', tourIndex);
                location.href = step.page;
                return;
            }
            if (step.page === '/editor') tourEnsureSongSelected();
            let hl = document.getElementById('tour-highlight');
            if (!hl) {
                hl = document.createElement('div');
                hl.id = 'tour-highlight';
                document.body.appendChild(hl);
            }
            let po = document.getElementById('tour-popover');
            if (!po) {
                po = document.createElement('div');
                po.id = 'tour-popover';
                document.body.appendChild(po);
            }

            // 平常半透明的元素 (如微調時間軸面板) 在被框住時要強制現形
            document.querySelectorAll('.tour-reveal').forEach(el => el.classList.remove('tour-reveal'));

            // display:none 的元素 querySelector 仍然找得到,但 getBoundingClientRect 全是 0 ——
            // 高亮框會縮成左上角一個看不懂的小點。工具列的按鈕可以在設定裡用眼睛藏起來,
            // 那時退回「無目標」那條:卡片置中、不畫框,並在說明下面附一行原因。
            // 步驟不跳過 —— 使用者仍該知道有這個功能。
            let target = step.el ? document.querySelector(step.el) : null;
            const rect0 = target && target.getBoundingClientRect();
            const targetMissing = !!step.el && !(rect0 && (rect0.width > 0 || rect0.height > 0));
            if (targetMissing) target = null;
            if (target && step.reveal) target.classList.add('tour-reveal');
            if (target) {
                // highlight 與說明卡都是 position:fixed(視窗座標),目標在畫面外就會框到螢幕外。
                // 先把目標捲到畫面中央再量測;用 instant 捲動,量到的才是最終位置。
                const r0 = target.getBoundingClientRect();
                if (r0.top < 80 || r0.bottom > window.innerHeight - 80) {
                    target.scrollIntoView({ behavior: 'instant', block: 'center' });
                }
            }

            if (target) {
                const r = target.getBoundingClientRect();
                const pad = 8;
                hl.style.display = 'block';
                hl.style.top = (r.top - pad) + 'px';
                hl.style.left = (r.left - pad) + 'px';
                hl.style.width = (r.width + pad * 2) + 'px';
                hl.style.height = (r.height + pad * 2) + 'px';
            } else {
                // 無目標:整頁遮罩,卡片置中
                hl.style.display = 'block';
                hl.style.top = '50%';
                hl.style.left = '50%';
                hl.style.width = '0';
                hl.style.height = '0';
            }

            const isLast = tourIndex === currentTour.length - 1;
            let stepText = (tourNoSongs && step.emptyText) ? step.emptyText : step.text;
            if (targetMissing) {
                stepText += '<div class="tour-note">這個東西目前不在畫面上。工具列的按鈕可以在設定選單的'
                    + '「自訂快捷鍵」用眼睛圖示收起來,點回來就會出現。</div>';
            }
            po.innerHTML = `
                <div class="tour-title">${step.title}</div>
                <div class="tour-text">${stepText}</div>
                <div class="tour-footer">
                    <span class="tour-count">${tourIndex + 1}/${currentTour.length}</span>
                    <div class="tour-btns">
                        ${!isLast ? '<button class="tour-btn" onclick="endTour()">跳過</button>' : ''}
                        ${tourIndex > 0 ? '<button class="tour-btn" onclick="tourStepMove(-1)">上一步</button>' : ''}
                        ${isLast
                            ? '<button class="tour-btn tour-btn-primary" onclick="endTour()">完成</button>'
                            : '<button class="tour-btn tour-btn-primary" onclick="tourStepMove(1)">下一步</button>'}
                    </div>
                </div>`;

            // 定位說明卡:目標下方,放不下改上方;無目標置中
            po.style.visibility = 'hidden';
            po.style.display = 'block';
            const poH = po.offsetHeight, poW = po.offsetWidth;
            if (target) {
                const r = target.getBoundingClientRect();
                let top = r.bottom + 16;
                if (top + poH > window.innerHeight - 10) top = r.top - poH - 16;
                if (top < 10) top = Math.max(10, (window.innerHeight - poH) / 2);
                let left = Math.min(Math.max(10, r.left), window.innerWidth - poW - 10);
                po.style.top = top + 'px';
                po.style.left = left + 'px';
                po.style.transform = 'none';
            } else {
                po.style.top = '50%';
                po.style.left = '50%';
                po.style.transform = 'translate(-50%, -50%)';
            }
            po.style.visibility = 'visible';
        }

        // 視窗大小改變會讓 fixed 座標失準,重畫目前這一步
        window.addEventListener('resize', () => {
            if (tourIndex >= 0) renderTourStep();
        });

        async function saveSettingsToServer(key, val) {
            try {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [key]: val })
                });
            } catch (e) { console.error(e); }
        }
        
        // class 只是即時反應,真相在 settings.json (由 header.ejs 直接渲染)
        function updateFuriganaSetting(checked) {
            if (checked) {
                document.documentElement.classList.remove('hide-furigana');
            } else {
                document.documentElement.classList.add('hide-furigana');
            }
            saveSettingsToServer('show_furigana', checked);
        }

        // 片假名 ruby 與中文譯文都是 server 產內容時決定的,不像 show_furigana 有 CSS 可切。
        // 網頁現在有 WS 聽 lyrics_updated,但那是被動的 —— 切設定得先主動重抓一次,server 才會
        // 用新設定重產內容 (重產完的廣播才有東西可聽)。所以這裡照舊自己抓一次重畫。
        // 兩個開關共用這條路徑 —— 少一個就是「切了沒反應,要重整才生效」。
        // 不用 fetchAndParseLyrics:那會先塞「正在搜尋歌詞」的轉圈,切個開關不該閃一下。
        async function updateLyricsContentSetting(key, checked) {
            if (key === 'show_romaji' || key === 'show_translation') {
                window.__lyricsPaneSettings = { ...window.__lyricsPaneSettings, [key]: checked };
            }
            await saveSettingsToServer(key, checked);
            const { title, artist } = currentSong();
            if (!title || typeof parseLrcLyrics !== 'function') return;   // 只有首頁有歌詞面板
            try {
                const resp = await fetch(`/api/lyrics/fetch?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`);
                const data = await resp.json();
                if (data.lyrics) { parseLrcLyrics(data.lyrics); renderLyrics(); }
            } catch (e) { console.error(e); }
        }

        function updateAutoLyricsOptions(checked) {
            localStorage.setItem('auto_lyrics_options', checked);
            saveSettingsToServer('auto_lyrics_options', checked);
        }

        // 播放列的曲名/歌手太長:複製一份接尾巴,連續捲、無縫接回頭 (不來回)。
        // 平常停在歌名頭。游標移入捲一輪:立刻開始,移開也捲完才停回頭。
        // autoScroll=true (換歌) 時等 1 秒自動捲一次再停回頭;換頁只是重掛 (autoScroll=false),不捲。
        window.setMarqueeText = function(el, text, autoScroll = true) {
            if (!el) return;
            if (el._marqueeTimer) { clearTimeout(el._marqueeTimer); el._marqueeTimer = null; }
            el.classList.remove('marquee', 'play-once', 'delayed');
            el.onmouseenter = null;                       // 沒溢出的歌名不留上一首的 hover 捲動
            el.style.removeProperty('--marquee-shift');
            el.style.removeProperty('--marquee-duration');

            const span = document.createElement('span');
            span.textContent = text;
            el.replaceChildren(span);

            requestAnimationFrame(() => {
                if (span.scrollWidth - el.clientWidth <= 2) return;   // 沒溢出就不捲
                const gap = parseFloat(getComputedStyle(el).fontSize) * 1.5;  // 尾與頭之間的間距:1.5em,隨字級縮放
                const shift = span.scrollWidth + gap;
                const clone = span.cloneNode(true);
                clone.setAttribute('aria-hidden', 'true');
                clone.style.paddingLeft = gap + 'px';
                el.appendChild(clone);                                // 第二份緊接在後,捲一整份就無縫接回
                const durSec = Math.max(4, shift / 24);               // 慢一點:約 24px/s
                el.style.setProperty('--marquee-shift', `-${shift}px`);
                el.style.setProperty('--marquee-duration', `${durSec}s`);
                el.classList.add('marquee');
                // 捲一輪就停回頭。換歌 (delayed) 先等 1 秒;hover 立刻捲。捲動中不重來。
                const playOnce = (delayMs) => {
                    if (el._marqueeTimer) return;
                    el.classList.toggle('delayed', delayMs > 0);
                    el.classList.add('play-once');
                    el._marqueeTimer = setTimeout(() => {             // 捲完拿掉,停回歌名頭
                        el.classList.remove('play-once', 'delayed');
                        el._marqueeTimer = null;
                    }, durSec * 1000 + delayMs);
                };
                el.onmouseenter = () => playOnce(0);                  // 游標移入捲一次,移開也捲完
                if (autoScroll) {
                    playOnce(1000);
                }
            });
        };

        // 字級數字框:一點進去就清空讓人直接打;沒改就跳出時回填原本的數字 (不套用、不變預設)
        function fontsizeFocus(el) {
            el.dataset.prev = el.value;
            el.value = '';
        }
        function fontsizeBlur(el) {
            if (el.value.trim() === '') { el.value = el.dataset.prev; return; }
            updateFontSize(el.value);   // 會 clamp 20–100 並回寫欄位
        }

        function updateFontSize(val) {
            let num = parseInt(val);
            if (isNaN(num)) num = 26;
            num = Math.max(20, Math.min(100, num));
            
            document.documentElement.style.setProperty('--lyrics-fs', num + 'px');
            localStorage.setItem('fontsize', num);
            
            const slider = document.getElementById('setting-fontsize');
            if (slider && slider.value != num) slider.value = num;
            
            const input = document.getElementById('fontsize-input');
            if (input && input.value != num) input.value = num;
            
            saveSettingsToServer('font_size', num);
        }

        function changeTextAlign(alignValue, btn) {
            localStorage.setItem('lyricsAlignMode', alignValue);
            const pane = document.getElementById('lyrics-scroll');
            if (pane) {
                pane.classList.remove('align-left', 'align-right');
                if (alignValue === 'left') pane.classList.add('align-left');
                if (alignValue === 'right') pane.classList.add('align-right');
            }
            if (btn) {
                const group = btn.parentElement;
                group.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }
        }
        
        // Hotkey logic
        const defaultHkMap = {
            'hk-advance': 'ArrowLeft', 'hk-delay': 'ArrowRight',
            'hk-plain-prev': 'ArrowUp', 'hk-plain-next': 'ArrowDown',
            // 右下角工具列 (預設鍵與 app.js 的 TOOLBAR_HOTKEYS 一致)
            'hk-ab-loop': 'A', 'hk-ruby-edit': 'E', 'hk-lyrics-opt': 'L', 'hk-reload': 'R',
            'hk-island': 'D', 'hk-fullscreen': 'F'
        };
        let activeHotkeyInput = null;

        function resetHotkeys() {
            Object.keys(defaultHkMap).forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = defaultHkMap[id];
                localStorage.setItem(id, defaultHkMap[id]);
                saveSettingsToServer(id, defaultHkMap[id]);
            });
            if (window.updateActiveHotkeys) window.updateActiveHotkeys();
            if (window.resetToolVisibility) window.resetToolVisibility();
            hkToast('快捷鍵已恢復預設');
        }

        // showToast 只定義在首頁的 app.js,其他頁沒有
        function hkToast(msg) {
            if (typeof showToast === 'function') showToast(msg, 'fa-solid fa-keyboard');
        }

        function recordHotkey(inputEl, settingKey) {
            if (activeHotkeyInput) {
                activeHotkeyInput.value = activeHotkeyInput.dataset.prevValue || '';
            }
            activeHotkeyInput = inputEl;
            inputEl.dataset.prevValue = inputEl.value;
            inputEl.value = '請按下按鍵...';
            inputEl.focus();
            
            const handler = function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                    inputEl.value = inputEl.dataset.prevValue || '';
                } else {
                    let keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                    if (keyName === ' ') keyName = 'Space';
                    
                    let prefix = '';
                    if (e.ctrlKey) prefix += 'Ctrl+';
                    if (e.altKey) prefix += 'Alt+';
                    if (e.shiftKey && e.key.length > 1) prefix += 'Shift+';
                    
                    inputEl.value = prefix + keyName;
                    localStorage.setItem(settingKey, inputEl.value);
                    saveSettingsToServer(settingKey, inputEl.value);
                    const label = inputEl.closest('.hk-row')?.querySelector('.hk-label')?.textContent || '快捷鍵';
                    hkToast(`${label} 已設為 ${inputEl.value}`);
                }
                activeHotkeyInput = null;
                window.removeEventListener('keydown', handler, true);
                inputEl.blur();
                if (window.updateActiveHotkeys) window.updateActiveHotkeys();
            };
            window.addEventListener('keydown', handler, true);
        }

        function saveSettings() {
            const as = document.getElementById('setting-autoscroll');
            if (as) {
                localStorage.setItem('autoscroll', as.checked);
                saveSettingsToServer('autoscroll', as.checked);
            }
            if (window.updateActiveHotkeys) window.updateActiveHotkeys();
        }

        document.addEventListener('DOMContentLoaded', () => {
            const savedAlign = localStorage.getItem('lyricsAlignMode') || 'center';
            document.querySelectorAll('#align-segmented .segment-btn').forEach(b => {
                if (b.dataset.align === savedAlign) b.classList.add('active');
                else b.classList.remove('active');
            });
            
            const savedFs = localStorage.getItem('fontsize') || 26;
            const fsSlider = document.getElementById('setting-fontsize');
            if (fsSlider) fsSlider.value = savedFs;
            const fsInput = document.getElementById('fontsize-input');
            if (fsInput) fsInput.value = savedFs;
            
            fetch('/api/settings')
            .then(res => res.json())
            .then(data => {
                // class 已由 header.ejs 用同一份 server 值渲染好,這裡只補 checkbox
                window.__karaokeWindowSettings = {
                    compact: data.karaoke_compact_on_start !== false,
                    top: data.karaoke_always_on_top !== false,
                    autoCollapse: data.karaoke_auto_collapse !== false,
                };
                for (const [key, id] of Object.entries({
                    compact: 'setting-karaoke-compact',
                    top: 'setting-karaoke-top',
                    autoCollapse: 'setting-karaoke-auto-collapse',
                })) {
                    const input = document.getElementById(id);
                    if (input) input.checked = window.__karaokeWindowSettings[key];
                }
                const windowSettings = document.getElementById('karaoke-window-settings');
                const windowNote = document.getElementById('karaoke-window-desktop-note');
                if (!window.karaokeWindow) {
                    if (windowSettings) windowSettings.hidden = true;
                    if (windowNote) windowNote.hidden = false;
                }
                window.dispatchEvent(new CustomEvent('karaoke-window-settings-changed', { detail: window.__karaokeWindowSettings }));
                if (data.show_furigana !== undefined) {
                    const fEl = document.getElementById('setting-furigana');
                    if (fEl) fEl.checked = data.show_furigana;
                }
                const krEl = document.getElementById('setting-katakana-ruby');
                if (krEl) krEl.checked = data.katakana_ruby === true;
                const trEl = document.getElementById('setting-translation');
                if (trEl) trEl.checked = data.show_translation === true;
                const roEl = document.getElementById('setting-romaji');
                if (roEl) roEl.checked = data.show_romaji === true;
                window.__lyricsPaneSettings = { show_romaji: data.show_romaji === true, show_translation: data.show_translation === true };
                if (data.auto_lyrics_options !== undefined) {
                    const alEl = document.getElementById('setting-auto-lyrics-options');
                    if (alEl) alEl.checked = data.auto_lyrics_options;
                    localStorage.setItem('auto_lyrics_options', data.auto_lyrics_options);
                }
                const iaEl = document.getElementById('setting-island-auto');
                if (iaEl) iaEl.checked = data.dynamic_island === true;
                const ioEl = document.getElementById('setting-island-opacity');
                if (ioEl) {
                    const pct = Math.round((data.island_opacity === undefined ? 1 : Number(data.island_opacity)) * 100);
                    ioEl.value = String(pct);
                    const lab = document.getElementById('island-opacity-value');
                    if (lab) lab.textContent = pct + '%';
                }
                const ilkEl = document.getElementById('setting-island-locked');
                if (ilkEl) ilkEl.checked = data.island_locked === true;
                if (data.island_lines !== undefined) {
                    const ilEl = document.getElementById('setting-island-lines');
                    if (ilEl) ilEl.value = data.island_lines;
                }
                const il2El = document.getElementById('setting-island-line2');
                // 三個選項都要認 —— 漏掉 'romaji' 的話,設成「本句羅馬拼音」的人一開設定選單
                // 就看到「下一句歌詞」(島上其實還是羅馬拼音),再碰一下這個 select 就真的被改掉了
                if (il2El) il2El.value = ['translation', 'romaji'].includes(data.island_line2) ? data.island_line2 : 'next';
                const thEl = document.getElementById('setting-track-history');
                if (thEl) thEl.checked = data.track_history !== false;
                

                if (data.font_size !== undefined) {
                    const savedFs = data.font_size;
                    document.documentElement.style.setProperty('--lyrics-fs', savedFs + 'px');
                    localStorage.setItem('fontsize', savedFs);
                    const fsSlider = document.getElementById('setting-fontsize');
                    if (fsSlider) fsSlider.value = savedFs;
                    const fsInput = document.getElementById('fontsize-input');
                    if (fsInput) fsInput.value = savedFs;
                }
            });
            
            const prefSource = localStorage.getItem('preferred_source') || 'NetEase';
            const srcSelect = document.getElementById('setting-preferred-source');
            if (srcSelect) srcSelect.value = prefSource;
            
            const asEnable = localStorage.getItem('autoscroll') !== 'false';
            const asToggle = document.getElementById('setting-autoscroll');
            if (asToggle) asToggle.checked = asEnable;

            const autoOptToggle = document.getElementById('setting-auto-lyrics-options');
            if (autoOptToggle) autoOptToggle.checked = localStorage.getItem('auto_lyrics_options') === 'true';
            
            Object.keys(defaultHkMap).forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = localStorage.getItem(id) || defaultHkMap[id];
            });
            if (window.refreshToolEyes) window.refreshToolEyes();

            if (window.updateActiveHotkeys) window.updateActiveHotkeys();

            checkForUpdate();

            // 跨頁導覽:上一頁跳轉過來時恢復進度
            const tourResume = sessionStorage.getItem('tourResume');
            if (tourResume !== null) {
                sessionStorage.removeItem('tourResume');
                tourIndex = parseInt(tourResume);
                setTimeout(() => {
                    renderTourStep();
                    document.addEventListener('keydown', tourEscHandler);
                }, 500);
            } else if (document.getElementById('lyrics-scroll')) {
                // 首頁:首次進站或帶 ?tour=1 時自動播放使用說明
                const params = new URLSearchParams(location.search);
                if (params.get('tour') === '1' || !localStorage.getItem('tourSeen')) {
                    // 使用者可能已經先開了別的導覽 (例如音訊來源的問號),不要蓋掉
                    setTimeout(() => { if (tourIndex < 0) startTour(); }, 800);
                }
            }
        });

        // ───────────────────────────────────────────────────────────────
        // 播放狀態的**唯一**連線。footer 每一頁都會載入,所以 socket 開在這裡,首頁的
        // app.js 靠 window.onMediaMessage 掛上去 (它自己不再 new WebSocket)。
        //
        // **這段必須在下面那個 `if (!lyrics-scroll)` 之外** —— 那個判斷是「非首頁」,
        // 包進去的話首頁就沒有 onMediaMessage,app.js 一呼叫就是 TypeError,整支腳本死掉。
        //
        // **也不要退回輪詢 /api/current-media。** 那支回的是整份 currentMediaState —— 含
        // base64 封面,一則約 171 KB。播放列以前是**每 1 秒**打一次、而且每一頁都在跑
        // (統計、排行榜、編輯器…),等於常態 171 KB/s;首頁還要再加 app.js 自己那條 100ms 的。
        // server 的 broadcastMediaState 早就節流過 (1 秒一次、封面沒變就不送那個鍵)。
        // ───────────────────────────────────────────────────────────────
        window.__mediaHandlers = [];
        window.onMediaMessage = (fn) => window.__mediaHandlers.push(fn);
        // 連線活著時保底輪詢整個不要打 —— 那支回的是整份狀態,問一次就是 171 KB,
        // 「反正只有 2 秒一次」仍然是常態 85 KB/s。兩個輪詢 (這裡與 app.js) 都看這個旗標。
        window.__mediaSocketAlive = false;
        // 「這一頁正開著」這類旗標要送回 server (卡拉OK頁靠它讓靈動島讓開)。**一定要 sticky** ——
        // 連線 3 秒後會自動重連,只送一次的話重連後 server 那邊的旗標就永遠是關的,
        // 而斷線本身沒有任何徵兆 (症狀:島自己跑回來)。重連時整份重送。
        window.__stickyMsgs = new Map();
        window.sendMediaSocket = (msg, stickyKey) => {
            if (stickyKey) window.__stickyMsgs.set(stickyKey, msg);
            const ws = window.__mediaSocket;
            if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        };
        (function connectMediaSocket() {
            const connect = () => {
                let ws;
                try { ws = new WebSocket(`ws://${location.host}`); } catch (e) { return setTimeout(connect, 3000); }
                window.__mediaSocket = ws;
                ws.onopen = () => {
                    window.__mediaSocketAlive = true;
                    window.dispatchEvent(new Event('kanaric-media-socket-open'));
                    window.__stickyMsgs.forEach((m) => { try { ws.send(JSON.stringify(m)); } catch (e) {} });
                };
                ws.onmessage = (ev) => {
                    let msg;
                    try { msg = JSON.parse(ev.data); } catch (e) { return; }
                    // 一個 handler 丟例外不能害其他 handler 收不到訊息
                    window.__mediaHandlers.forEach((fn) => { try { fn(msg); } catch (e) {} });
                };
                ws.onclose = () => {
                    window.__mediaSocketAlive = false;
                    window.dispatchEvent(new Event('kanaric-media-socket-close'));
                    setTimeout(connect, 3000);
                };
                ws.onerror = () => { try { ws.close(); } catch (e) {} };
            };
            connect();
        })();

        // ── 非首頁:同步下方播放列(歌曲資訊/播放狀態/進度/靈動島狀態) ──
        // 首頁由 app.js 全權處理;這裡只給其他頁面輕量版
        if (!document.getElementById('lyrics-scroll') && !window.__youtubeKaraokeOnly) {
            window.mediaAction = function(action) {
                fetch('/api/media-control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action })
                });
            };
            window.toggleIsland = async function() {
                const toggle = document.getElementById('desktop-toggle-btn');
                if (toggle) toggle.disabled = true;
                try {
                    const resp = await fetch('/api/island/toggle', { method: 'POST' });
                    const result = await resp.json();
                    if (resp.ok && result.success && toggle) toggle.classList.toggle('active', result.action === 'started');
                    else if (result.available === false) showToast('靈動島需要桌面版 Kanaric', 'fa-solid fa-circle-info');
                } catch (e) {}
                setTimeout(() => { if (toggle) toggle.disabled = false; }, 1000);
            };
            // 需要歌詞面板才有意義的功能:點了帶回首頁
            // (備選歌詞、重新載入歌詞、吐司來自 lyrics-tools.js,每頁都能直接用)
            window.toggleRubyEditMode = window.toggleLoopMode = () => { location.href = '/'; };

            // 這兩個模式是跨頁保留的 (app.js 存在 localStorage),按鈕在其他頁也要亮著
            const modeBtns = [['loopMode', 'loop-mode-btn'], ['rubyEditMode', 'toggle-ruby-mode-btn']];
            modeBtns.forEach(([key, id]) => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.toggle('active', localStorage.getItem(key) === 'true');
            });
            // 放大模式:回首頁時直接進入 (app.js 載入時會讀這個旗標)
            window.toggleFullscreen = () => {
                localStorage.setItem('zoomModeActive', 'true');
                location.href = '/';
            };

            const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
            let barTitle = window.__initialMedia.title || '';   // server 已經渲染好了,別再重寫一次同樣的內容
            let barThumb;   // 已經套用的封面 (undefined = 還沒收到過),同 app.js 的 lastThumbnail

            // WS 斷線時的保底輪詢,正常情況是 applyPlayerBar 被廣播叫起來的
            async function syncPlayerBar() {
                if (window.__mediaSocketAlive) return;
                try {
                    const r = await fetch('/api/current-media', { cache: 'no-store' });
                    if (!r.ok) return;
                    applyPlayerBar(await r.json());
                } catch (e) {}
            }

            function applyPlayerBar(d) {
                try {
                    const ppIcon = document.getElementById('play-pause-icon');
                    if (ppIcon) ppIcon.className = 'fa-solid ' + (d.is_playing ? 'fa-pause' : 'fa-play');

                    // 隨機播放 / 清單循環的亮燈 (首頁由 app.js 處理,其他頁靠這裡)
                    const shuffleBtn = document.getElementById('shuffle-btn');
                    if (shuffleBtn) shuffleBtn.classList.toggle('active', !!d.shuffle);
                    const repeatBtn = document.getElementById('repeat-btn');
                    if (repeatBtn) {
                        const mode = d.repeat || 0;
                        repeatBtn.classList.toggle('active', mode !== 0);
                        repeatBtn.dataset.mode = mode;
                    }

                    // lyrics-tools.js (備選歌詞 / 重新載入) 從這裡讀現在在播什麼
                    window.currentSongInfo = { title: d.title || '', artist: d.artist || '' };
                    // 封面自己比對前後值,**不掛在換歌分支底下** (同 app.js 的 lastThumbnail):
                    // 廣播在封面沒變時整個不送 thumbnail 這個鍵,而封面也可能比歌名晚幾則才到 ——
                    // 掛在換歌分支裡的話那首歌會一直顯示上一首的封面
                    if (d.thumbnail !== undefined && d.thumbnail !== barThumb) {
                        barThumb = d.thumbnail;
                        const cov = document.getElementById('album-cover');
                        if (cov && d.thumbnail) cov.src = 'data:image/jpeg;base64,' + d.thumbnail;
                    }

                    if (d.title !== barTitle) {
                        barTitle = d.title || '';
                        setMarqueeText(document.getElementById('current-title'), d.title || '--');
                        setMarqueeText(document.getElementById('current-artist'), d.title ? (d.artist || 'Unknown Artist') : '--');
                        // 換歌 = 上一首的備選歌詞失效;新歌若在 server 上搜過/搜尋中,把狀態接回來
                        window._lyricsOptions = [];
                        resetLyricsOptBtn();
                        restoreOptionsState();
                    }
                    if (d.title && d.duration > 0) {
                        barDuration = d.duration;
                        // 拖曳中或剛 seek 完 (系統回報還是舊位置) 不回寫滑桿
                        if (!barScrubbing && performance.now() > barSeekMuteUntil) {
                            const pct = Math.min(100, d.position / d.duration * 100);
                            document.getElementById('progress-slider').value = pct;
                            document.getElementById('progress-fill').style.width = pct + '%';
                            document.getElementById('current-time').textContent = fmtTime(d.position);
                        }
                        document.getElementById('total-time').textContent = fmtTime(d.duration);
                    }
                } catch (e) {}
            }

            // 進度條跳轉:點擊/拖曳放開時 seek (首頁由 app.js 處理,這裡給其他頁)
            let barDuration = window.__initialMedia.duration || 0;
            let barScrubbing = false;
            let barSeekMuteUntil = 0;
            const barSlider = document.getElementById('progress-slider');
            if (barSlider) {
                barSlider.addEventListener('pointerdown', () => { barScrubbing = true; });
                barSlider.addEventListener('input', () => {
                    document.getElementById('progress-fill').style.width = barSlider.value + '%';
                    document.getElementById('current-time').textContent = fmtTime(barSlider.value / 100 * barDuration);
                });
                barSlider.addEventListener('change', () => {
                    barScrubbing = false;
                    barSeekMuteUntil = performance.now() + 3000;
                    fetch('/api/seek', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ position: barSlider.value / 100 * barDuration })
                    });
                });
            }
            // 換頁載入:把 server 渲染的曲名/歌手包成 span 並開啟 hover 捲動 (不自動捲,換頁不算換歌)
            setMarqueeText(document.getElementById('current-title'), (window.__initialMedia.title || '--'), false);
            setMarqueeText(document.getElementById('current-artist'), (window.__initialMedia.title ? (window.__initialMedia.artist || 'Unknown Artist') : '--'), false);
            // 播放狀態走上面那條 socket;輪詢只是 WS 斷線時的保底,所以是 2 秒不是 1 秒
            window.onMediaMessage((msg) => {
                if ((msg.type === 'media_state' || msg.type === 'init') && msg.state) applyPlayerBar(msg.state);
            });
            syncPlayerBar();
            setInterval(syncPlayerBar, 2000);
            // 播放列的歌名由 server 渲染,上面的「換歌」分支不會在載入時觸發,
            // 所以備選歌詞的按鈕狀態 (綠色打勾/搜尋中) 要自己接回來。
            // lyrics-tools.js 是 defer 載入的,這支行內 script 跑的時候它還不存在 → 等 DOMContentLoaded
            document.addEventListener('DOMContentLoaded', () => restoreOptionsState());
            fetch('/api/island/status').then(r => r.json()).then(d => {
                const t = document.getElementById('desktop-toggle-btn');
                if (t) t.classList.toggle('active', d.isRunning);
            }).catch(() => {});
        }
