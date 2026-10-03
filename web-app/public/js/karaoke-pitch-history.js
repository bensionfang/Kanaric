(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.KanaricPitchHistory = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

    function noteName(value) {
        const midi = Math.round(Number(value));
        if (!Number.isFinite(midi)) return '—';
        return `${NOTES[(midi % 12 + 12) % 12]}${Math.floor(midi / 12) - 1}`;
    }

    function formatDate(value) {
        const date = new Date(String(value).replace(' ', 'T') + 'Z');
        return Number.isNaN(date.getTime()) ? String(value || '') : new Intl.DateTimeFormat('zh-TW', {
            dateStyle: 'short',
            timeStyle: 'short',
        }).format(date);
    }

    function formatRange(summary) {
        if (!summary || summary.lowestMidi === null || summary.highestMidi === null) return '音域 —';
        return `音域 ${noteName(summary.lowestMidi)}–${noteName(summary.highestMidi)}`;
    }

    function formatKey(key) {
        const value = Number(key) || 0;
        return `Key ${value > 0 ? '+' : ''}${value}`;
    }

    function formatRatio(value) {
        return `有效 ${(Math.max(0, Number(value) || 0) * 100).toFixed(0)}%`;
    }

    function drawPitchCurve(canvas, take) {
        if (!canvas || !take || !Array.isArray(take.frames)) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        const width = canvas.clientWidth || 480;
        const height = canvas.clientHeight || 220;
        const scale = window.devicePixelRatio || 1;
        canvas.width = width * scale;
        canvas.height = height * scale;
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, width, height);

        const midiValues = take.frames.map(frame => Number(frame[1]) / 100).filter(Number.isFinite);
        if (!midiValues.length) return;
        const low = Math.floor(Math.min(...midiValues) - 3);
        const high = Math.ceil(Math.max(...midiValues) + 3);
        const duration = Math.max(Number(take.durationMs) || 0, Number(take.frames.at(-1)?.[0]) || 1);
        const pad = { left: 38, right: 8, top: 8, bottom: 20 };
        const plotWidth = width - pad.left - pad.right;
        const plotHeight = height - pad.top - pad.bottom;
        const x = time => pad.left + (Math.max(0, Number(time) || 0) / duration) * plotWidth;
        const y = midi => pad.top + (1 - (midi - low) / Math.max(1, high - low)) * plotHeight;

        context.font = '10px sans-serif';
        context.fillStyle = 'rgba(255,255,255,0.58)';
        context.strokeStyle = 'rgba(255,255,255,0.12)';
        context.lineWidth = 1;
        for (let midi = low; midi <= high; midi += 3) {
            const lineY = y(midi) + 0.5;
            context.beginPath();
            context.moveTo(pad.left, lineY);
            context.lineTo(width - pad.right, lineY);
            context.stroke();
            context.fillText(noteName(midi), 4, lineY + 3);
        }
        context.fillText('0:00', pad.left, height - 4);
        context.fillText(`${Math.round(duration / 1000)}s`, width - 28, height - 4);

        context.strokeStyle = '#6ee7b7';
        context.lineWidth = 2;
        context.beginPath();
        let previousTime = null;
        take.frames.forEach(frame => {
            const time = Number(frame[0]);
            const midi = Number(frame[1]) / 100;
            if (!Number.isFinite(time) || !Number.isFinite(midi)) return;
            if (previousTime === null || time - previousTime > 250) context.moveTo(x(time), y(midi));
            else context.lineTo(x(time), y(midi));
            previousTime = time;
        });
        context.stroke();
    }

    function createKaraokePitchHistory(options = {}) {
        const fetchImpl = options.fetchImpl || window.fetch.bind(window);
        const rootEl = options.root || document.getElementById('karaoke-pitch-history');
        const listEl = options.list || document.getElementById('karaoke-pitch-history-list');
        const detailEl = options.detail || document.getElementById('karaoke-pitch-history-detail');
        const canvas = options.canvas || document.getElementById('karaoke-pitch-history-canvas');
        const summaryEl = options.summary || document.getElementById('karaoke-pitch-history-summary');
        const statusEl = options.status || document.getElementById('karaoke-pitch-history-status');
        const openEl = options.open || document.getElementById('karaoke-pitch-history-open');
        const closeEl = options.close || document.getElementById('karaoke-pitch-history-close');
        const backEl = options.back || document.getElementById('karaoke-pitch-history-back');
        let currentVideoId = '';
        let loadSerial = 0;

        function status(text) {
            if (statusEl) statusEl.textContent = text || '';
        }

        function showList() {
            detailEl?.classList.add('hidden');
            listEl?.classList.remove('hidden');
        }

        function renderList(rows) {
            if (!listEl) return;
            listEl.textContent = '';
            rows.forEach(row => {
                const item = document.createElement('div');
                item.className = 'karaoke-pitch-history-row';
                const open = document.createElement('button');
                open.type = 'button';
                open.className = 'karaoke-pitch-history-item';
                open.textContent = `${formatDate(row.performedAt)} · ${formatKey(row.keySemitones)} · ${formatRange(row.summary)} · ${formatRatio(row.summary?.voicedRatio)}`;
                open.addEventListener('click', () => openDetail(row.id));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'karaoke-pitch-history-delete';
                remove.textContent = '刪除';
                remove.addEventListener('click', () => deleteTake(row.id));
                item.append(open, remove);
                listEl.appendChild(item);
            });
        }

        async function load(videoId) {
            currentVideoId = videoId || '';
            if (!currentVideoId) return [];
            const serial = ++loadSerial;
            try {
                const response = await fetchImpl(`/api/karaoke/pitch-takes?videoId=${encodeURIComponent(currentVideoId)}`);
                if (!response.ok) throw new Error('history list failed');
                const rows = await response.json();
                if (serial !== loadSerial) return rows;
                renderList(Array.isArray(rows) ? rows : []);
                rootEl?.classList.toggle('hidden', !rows.length);
                showList();
                status(rows.length ? '' : '');
                return rows;
            } catch (_) {
                if (serial === loadSerial) status('演唱紀錄暫時無法載入');
                return [];
            }
        }

        async function save(payload) {
            try {
                const response = await fetchImpl('/api/karaoke/pitch-takes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true,
                });
                if (!response.ok) throw new Error('history save failed');
                const result = await response.json();
                await load(payload.videoId);
                rootEl?.classList.remove('hidden');
                status('本次演唱摘要已保存');
                return result;
            } catch (_) {
                status('本次演唱紀錄保存失敗');
                return null;
            }
        }

        async function openDetail(id) {
            try {
                const response = await fetchImpl(`/api/karaoke/pitch-takes/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error('history detail failed');
                const take = await response.json();
                listEl?.classList.add('hidden');
                detailEl?.classList.remove('hidden');
                if (summaryEl) {
                    summaryEl.textContent = `${formatKey(take.keySemitones)} · ${formatRange(take.summary)} · 主要音域 ${take.summary?.comfortableLowMidi === null ? '—' : `${noteName(take.summary.comfortableLowMidi)}–${noteName(take.summary.comfortableHighMidi)}`} · ${formatRatio(take.summary?.voicedRatio)}`;
                }
                drawPitchCurve(canvas, take);
            } catch (_) {
                status('這筆演唱紀錄已不存在');
                await load(currentVideoId);
            }
        }

        async function deleteTake(id) {
            if (!window.confirm('確定刪除這筆演唱紀錄？')) return;
            try {
                const response = await fetchImpl(`/api/karaoke/pitch-takes/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('history delete failed');
                await load(currentVideoId);
            } catch (_) {
                status('演唱紀錄刪除失敗');
            }
        }

        openEl?.addEventListener('click', () => {
            rootEl?.classList.remove('hidden');
            load(currentVideoId);
        });
        closeEl?.addEventListener('click', () => rootEl?.classList.add('hidden'));
        backEl?.addEventListener('click', showList);
        return { load, save, openDetail, drawPitchCurve };
    }

    return { createKaraokePitchHistory, drawPitchCurve, formatRange };
});
