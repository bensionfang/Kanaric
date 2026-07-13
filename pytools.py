"""
統一的 Python 工具入口 (dispatcher)。
Node.js 後端以子命令呼叫本腳本;打包發布時由 PyInstaller 將此檔編譯為單一 pytools.exe。
用法:
  pytools.py monitor                        持續監聽系統媒體狀態 (stdout JSON)
  pytools.py furigana                       stdin 收 JSON、stdout 回注音後歌詞
  pytools.py fallback <title> <artist> [--all]  備用歌詞搜尋
  pytools.py cnlyrics                       stdin 收 JSON、抓網易/酷狗歌詞 (順便存讀音提示)
  pytools.py romaji <text>                  羅馬拼音轉平假名 (jaconv)
  pytools.py minimize                       最小化目前前景視窗
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')

    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]

    if cmd == "monitor":
        import asyncio
        from media_monitor import poll_media
        asyncio.run(poll_media())
    elif cmd == "furigana":
        import furigana_inject
        furigana_inject.main()
    elif cmd == "fallback":
        sys.argv = [sys.argv[0]] + args  # search_fallback.main() 直接讀 sys.argv
        import search_fallback
        search_fallback.main()
    elif cmd == "cnlyrics":
        import json
        import cn_music
        from db import db

        data = json.loads(sys.stdin.read())
        # 搜尋用的名稱可能經過別名替換/清理,但存 DB 一律用原始名稱當 key
        title = data.get("title", "")
        artist = data.get("artist", "")
        q_title = data.get("searchTitle") or title
        q_artist = data.get("searchArtist") or artist
        source = data.get("source", "auto")
        duration = data.get("duration") or None  # 秒;拿來擋同名歌/翻唱

        try:
            if source == "all":
                results = cn_music.fetch_all(q_artist, q_title, duration)
                # 讀音提示搭歌詞的便車存起來,注音時就不用再打一次網路
                for r in results:
                    if r.get("hints"):
                        db.save_romaji_hints(artist, title, r["hints"])
                        break
                print(json.dumps({
                    "success": True,
                    "results": [{"lyrics": r["lyrics"], "source": r["source"]} for r in results]
                }, ensure_ascii=False))
            else:
                r = cn_music.fetch(q_artist, q_title, source, duration)
                if r.get("lyrics"):
                    db.save_romaji_hints(artist, title, r.get("hints") or {})
                    print(json.dumps({
                        "success": True, "lyrics": r["lyrics"], "source": r["source"]
                    }, ensure_ascii=False))
                else:
                    print(json.dumps({"success": False, "error": "Not found"}))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
    elif cmd == "romaji":
        import jaconv
        print(jaconv.alphabet2kana(args[0]))
    elif cmd == "minimize":
        import ctypes
        ctypes.windll.user32.ShowWindow(ctypes.windll.user32.GetForegroundWindow(), 6)
    elif cmd == "diff":
        import json
        import difflib
        import re
        import fugashi
        import jaconv

        tagger = fugashi.Tagger()

        def normalize_romaji(text):
            text = re.sub(r'\[.*?\]', '', text)
            text = text.replace('#TITLE#', '')
            katakana = ''
            for w in tagger(text):
                kana = getattr(w.feature, 'kana', None)
                if not kana: kana = w.surface
                katakana += kana
            
            try:
                hira = jaconv.kata2hira(katakana)
                r = jaconv.kana2alphabet(hira).lower()
            except Exception:
                r = katakana.lower()
                
            r = re.sub(r'[^a-z0-9]', '', r)
            r = r.replace('ou', 'o').replace('oo', 'o').replace('uu', 'u').replace('ee', 'e').replace('aa', 'a').replace('ii', 'i')
            r = r.replace('wa', 'ha').replace('wo', 'o').replace('ye', 'e')
            r = r.replace('tsu', 'tu').replace('chi', 'ti').replace('shi', 'si')
            r = r.replace('fu', 'hu').replace('ji', 'zi').replace('zu', 'du')
            return r, text.strip()

        data = json.loads(sys.stdin.read())
        curr_lines = data.get("current", "").split("\n")
        ref_lines = data.get("reference", "").split("\n")

        curr_parsed = [normalize_romaji(l) for l in curr_lines if l.strip()]
        ref_parsed = [normalize_romaji(l) for l in ref_lines if l.strip()]

        curr_norm = [p[0] for p in curr_parsed]
        ref_norm = [p[0] for p in ref_parsed]

        sm = difflib.SequenceMatcher(None, curr_norm, ref_norm)
        diffs = []
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag != 'equal':
                c_chunk = [curr_parsed[i][1] for i in range(i1, i2)]
                r_chunk = [ref_parsed[j][1] for j in range(j1, j2)]
                if any(c_chunk) or any(r_chunk):
                    diffs.append({
                        "type": tag,
                        "curr": c_chunk,
                        "ref": r_chunk
                    })
        print(json.dumps(diffs, ensure_ascii=False))
    elif cmd == "seek":
        import asyncio
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
        async def do_seek(sec):
            sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            sess = None
            for s in sessions.get_sessions():
                if "spotify" in (s.source_app_user_model_id or "").lower():
                    sess = s
                    break
            if sess:
                try:
                    await sess.try_change_playback_position_async(int(float(sec) * 10000000))
                except Exception:
                    pass
        asyncio.run(do_seek(args[0]))
    elif cmd == "media-action":
        import asyncio
        import winrt.windows.media as wm
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
        async def do_media_action(action):
            sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            sess = None
            for s in sessions.get_sessions():
                if "spotify" in (s.source_app_user_model_id or "").lower():
                    sess = s
                    break
            if sess:
                try:
                    if action == "play":
                        await sess.try_play_async()
                    elif action == "pause":
                        await sess.try_pause_async()
                    elif action == "playpause":
                        await sess.try_toggle_play_pause_async()
                    elif action == "next":
                        await sess.try_skip_next_async()
                    elif action == "prev":
                        await sess.try_skip_previous_async()
                    elif action == "shuffle":
                        pi = sess.get_playback_info()
                        await sess.try_change_shuffle_active_async(not bool(pi.is_shuffle_active))
                    elif action == "repeat":
                        # 照 Spotify 的循環：關閉 -> 整張清單 -> 單曲
                        pi = sess.get_playback_info()
                        curr = int(pi.auto_repeat_mode) if pi.auto_repeat_mode is not None else 0
                        nxt = {0: 2, 2: 1, 1: 0}[curr]
                        await sess.try_change_auto_repeat_mode_async(wm.MediaPlaybackAutoRepeatMode(nxt))
                except Exception:
                    pass
        asyncio.run(do_media_action(args[0]))
    else:
        print(f"Unknown command: {cmd!r}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
