
    const songSelect = document.getElementById('song-select');
    const editorTitle = document.getElementById('editor-title');
    const editorContainer = document.getElementById('lrc-editor-container');
    const saveBtn = document.getElementById('save-btn');
    const advancedBtn = document.getElementById('advanced-btn');

    let currentArtist = "";
    let currentTitle = "";
    
    function openEditorOptionsModal() {
        document.getElementById('editor-options-modal').classList.remove('hidden');
        document.getElementById('editor-manual-title').value = currentTitle || '';
        document.getElementById('editor-manual-artist').value = currentArtist || '';
    }

    function closeEditorOptionsModal() {
        document.getElementById('editor-options-modal').classList.add('hidden');
    }

    function applyLyricsToEditor(lyrics) {
        closeEditorOptionsModal();
        fetch('/api/lyrics/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: currentTitle, artist: currentArtist, lyrics: lyrics })
        })
        .then(res => res.json())
        .then(() => {
            loadRawLyrics();
        });
    }

    function editorForceRefetch() {
        if (!currentTitle) return;
        closeEditorOptionsModal();
        fetch(`/api/lyrics/fetch?force=true&title=${encodeURIComponent(currentTitle)}&artist=${encodeURIComponent(currentArtist)}`)
            .then(res => res.json())
            .then(data => {
                if(data.lyrics) loadRawLyrics();
            });
    }

    function editorCustomLyrics() {
        const text = document.getElementById('editor-custom-text').value.trim();
        if (text) applyLyricsToEditor(text);
    }

    function editorManualSearch() {
        const title = document.getElementById('editor-manual-title').value.trim();
        const artist = document.getElementById('editor-manual-artist').value.trim();
        if (!title) return;
        closeEditorOptionsModal();
        fetch(`/api/lyrics/fetch?force=true&title=${encodeURIComponent(currentTitle)}&artist=${encodeURIComponent(currentArtist)}&searchTitle=${encodeURIComponent(title)}&searchArtist=${encodeURIComponent(artist)}`)
            .then(res => res.json())
            .then(data => {
                if(data.lyrics) loadRawLyrics();
            });
    }

    async function editorGetOptions() {
        if (!currentTitle) return;
        const listEl = document.getElementById('editor-options-list');
        listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center;">搜尋中...</div>';
        
        try {
            const resp = await fetch(`/api/lyrics/options?title=${encodeURIComponent(currentTitle)}&artist=${encodeURIComponent(currentArtist)}`);
            const data = await resp.json();
            
            listEl.innerHTML = '';
            if (data.options && data.options.length > 0) {
                data.options.forEach(opt => {
                    const btn = document.createElement('button');
                    btn.className = 'nav-btn';
                    btn.style.flexDirection = 'column';
                    btn.style.alignItems = 'flex-start';
                    btn.style.padding = '8px 12px';
                    btn.innerHTML = `<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.title}</div><div style="font-size: 11px; color: var(--text-secondary);">${opt.artist} [${opt.album}] - ${opt.source}</div>`;
                    btn.onclick = () => { applyLyricsToEditor(opt.lyrics); };
                    listEl.appendChild(btn);
                });
            } else {
                listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center;">找不到備選歌詞</div>';
            }
        } catch (e) {
            listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center;">搜尋失敗</div>';
        }
    }

    const songSearch = document.getElementById('song-search');
    let allSongs = [];

    function renderSongList(filterText = "") {
        songSelect.innerHTML = '';
        if (allSongs.length === 0) {
            songSelect.innerHTML = '<option disabled>資料庫中沒有快取的歌曲</option>';
            return;
        }
        
        const lowerFilter = filterText.toLowerCase();
        const filteredSongs = allSongs.filter(song => 
            song.title.toLowerCase().includes(lowerFilter) || 
            song.artist.toLowerCase().includes(lowerFilter)
        );

        if (filteredSongs.length === 0) {
            songSelect.innerHTML = '<option disabled>找不到符合的歌曲</option>';
            return;
        }

        filteredSongs.forEach(song => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ artist: song.artist, title: song.title });
            opt.text = `${song.title} - ${song.artist}`;
            songSelect.appendChild(opt);
        });
    }

    fetch('/api/songs')
        .then(res => res.json())
        .then(data => {
            allSongs = data;
            renderSongList();
        });

    songSearch.addEventListener('input', (e) => {
        renderSongList(e.target.value);
    });

    function createRow(timeStr, textStr) {
        const row = document.createElement('div');
        row.className = 'lrc-row';
        
        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.className = 'lrc-time';
        timeInput.value = timeStr || '00:00.00';
        timeInput.placeholder = 'mm:ss.xx';
        
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'lrc-text';
        textInput.placeholder = '輸入歌詞...';
        
        const titleLabel = document.createElement('label');
        titleLabel.style.color = 'var(--text-secondary)';
        titleLabel.style.fontSize = '12px';
        titleLabel.style.cursor = 'pointer';
        titleLabel.style.display = 'flex';
        titleLabel.style.alignItems = 'center';
        titleLabel.style.gap = '4px';
        titleLabel.style.margin = '0 5px';
        titleLabel.title = '標記為標題行 (不顯示於靈動島且不標註假名)';
        
        const titleCheckbox = document.createElement('input');
        titleCheckbox.type = 'checkbox';
        titleCheckbox.className = 'lrc-title-cb';

        let actualText = textStr || '';
        if (actualText.startsWith('#TITLE#')) {
            titleCheckbox.checked = true;
            actualText = actualText.substring(7);
        }
        textInput.value = actualText;
        
        titleLabel.appendChild(titleCheckbox);
        titleLabel.appendChild(document.createTextNode('標題'));
        
        // Arrow key navigation
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevRow = row.previousElementSibling;
                if (prevRow) prevRow.querySelector('.lrc-text').focus();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextRow = row.nextElementSibling;
                if (nextRow) nextRow.querySelector('.lrc-text').focus();
            }
        });
        timeInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevRow = row.previousElementSibling;
                if (prevRow) prevRow.querySelector('.lrc-time').focus();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextRow = row.nextElementSibling;
                if (nextRow) nextRow.querySelector('.lrc-time').focus();
            }
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'lrc-btn add';
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        addBtn.title = "在此行下方插入新行";
        addBtn.onclick = () => {
            const newRow = createRow('', '');
            row.after(newRow);
            newRow.querySelector('.lrc-text').focus();
        };
        
        const delBtn = document.createElement('button');
        delBtn.className = 'lrc-btn del';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.title = "刪除此行";
        delBtn.onclick = () => row.remove();
        
        row.appendChild(timeInput);
        row.appendChild(textInput);
        row.appendChild(titleLabel);
        row.appendChild(addBtn);
        row.appendChild(delBtn);
        return row;
    }

    function parseAndRenderLRC(rawText) {
        editorContainer.innerHTML = '';
        const lines = rawText.split('\n');
        const regex = /^\[(\d{2}:\d{2}\.\d{2,3})\](.*)/;
        
        let hasContent = false;
        lines.forEach(line => {
            if (!line.trim()) return;
            const match = line.match(regex);
            if (match) {
                editorContainer.appendChild(createRow(match[1], match[2]));
                hasContent = true;
            } else {
                // Keep metadata or malformed lines as generic rows without time
                if (line.startsWith('[')) {
                    editorContainer.appendChild(createRow(line, ''));
                    hasContent = true;
                }
            }
        });
        
        if (!hasContent) {
            editorContainer.appendChild(createRow('00:00.00', '在此輸入歌詞...'));
        }
    }

    function loadRawLyrics() {
        editorTitle.innerText = `${currentTitle} - ${currentArtist}`;
        editorContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; margin-top: 200px;">載入中...</div>';
        saveBtn.disabled = true;
        advancedBtn.disabled = true;
        fetch(`/api/lyrics/raw?title=${encodeURIComponent(currentTitle)}&artist=${encodeURIComponent(currentArtist)}`)
            .then(res => res.json())
            .then(data => {
                editorContainer.innerHTML = '';
                if (data.lyrics) {
                    parseAndRenderLRC(data.lyrics);
                    saveBtn.disabled = false;
                    advancedBtn.disabled = false;
                } else {
                    editorContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; margin-top: 200px;">此歌曲沒有歌詞資料</div>';
                    saveBtn.disabled = true;
                    advancedBtn.disabled = false;
                }
            });
    }

    songSelect.addEventListener('change', (e) => {
        const selected = JSON.parse(e.target.value);
        currentArtist = selected.artist;
        currentTitle = selected.title;
        loadRawLyrics();
    });

    advancedBtn.addEventListener('click', () => {
        openEditorOptionsModal();
        editorGetOptions();
    });

    saveBtn.addEventListener('click', () => {
        saveBtn.innerText = "儲存中...";
        saveBtn.disabled = true;
        
        const rows = editorContainer.querySelectorAll('.lrc-row');
        let newLrcLines = [];
        
        rows.forEach(row => {
            const t = row.querySelector('.lrc-time').value.trim();
            const txt = row.querySelector('.lrc-text').value;
            const isTitle = row.querySelector('.lrc-title-cb') && row.querySelector('.lrc-title-cb').checked;
            const prefix = isTitle ? '#TITLE#' : '';
            // If it's a metadata tag like [ti:song], time field will have it
            if (t.startsWith('[') && t.endsWith(']')) {
                newLrcLines.push(t + prefix + txt);
            } else {
                newLrcLines.push(`[${t}]${prefix}${txt}`);
            }
        });
        
        const finalLrc = newLrcLines.join('\n');
        
        fetch('/api/lyrics/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: currentTitle, artist: currentArtist, lyrics: finalLrc })
        })
        .then(res => res.json())
        .then(data => {
            saveBtn.innerText = "已儲存！";
            setTimeout(() => {
                saveBtn.innerText = "儲存修改";
                saveBtn.disabled = false;
            }, 2000);
        });
    });
