"""
統一的 Python 工具入口 (dispatcher)。
Node.js 後端以子命令呼叫本腳本;打包發布時由 PyInstaller 將此檔編譯為單一 pytools.exe。
用法:
  pytools.py monitor                        持續監聽系統媒體狀態 (stdout JSON)
  pytools.py furigana                       stdin 收 JSON、stdout 回注音後歌詞
  pytools.py fallback <title> <artist> [--all]  備用歌詞搜尋
  pytools.py cnlyrics                       stdin 收 JSON、抓網易/酷狗歌詞 (順便存讀音提示)
  pytools.py ytsearch                       stdin 收 JSON、搜 YouTube 回 MV 候選 (卡拉OK背景)
  pytools.py romaji <text>                  羅馬拼音轉平假名 (jaconv)
  pytools.py minimize                       最小化目前前景視窗
  pytools.py sessions                       列出目前系統上的媒體來源 (stdout JSON)
"""
import json
import os
from pathlib import Path
import re
import struct
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


NATIVE_PROTOCOL = "kanaric-youtube-v1"
NATIVE_MAX_BYTES = 16 * 1024
NATIVE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
NATIVE_EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}/$")


def _native_launch_origin(args):
    if not args or not args[0].startswith("chrome-extension://"):
        return None
    origin = args[0]
    if not NATIVE_EXTENSION_ORIGIN_RE.fullmatch(origin):
        return ""
    if any(not arg.startswith("--parent-window=") for arg in args[1:]):
        return ""
    return origin


def _native_reply(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(raw)) + raw)
    sys.stdout.buffer.flush()


def _native_discovery_path():
    explicit = os.environ.get("KANARIC_DISCOVERY_FILE")
    if explicit:
        return Path(explicit)
    app_data = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    return Path(app_data) / "Kanaric" / "youtube-karaoke-discovery.json"


def _native_pid_alive(pid):
    if not isinstance(pid, int) or pid < 1:
        return False
    if os.name == "nt":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def native_messaging_main(launch_origin=None):
    stream = sys.stdin.buffer
    if launch_origin == "":
        _native_reply({"ok": False, "error": "invalid-origin"})
        return
    header = stream.read(4)
    if len(header) != 4:
        _native_reply({"ok": False, "error": "invalid-frame"})
        return
    size = struct.unpack("<I", header)[0]
    if size > NATIVE_MAX_BYTES:
        _native_reply({"ok": False, "error": "request-too-large"})
        return
    raw = stream.read(size)
    if len(raw) != size:
        _native_reply({"ok": False, "error": "invalid-frame"})
        return
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _native_reply({"ok": False, "error": "invalid-request"})
        return
    if not isinstance(request, dict) or set(request) - {"type", "protocol", "origin"} \
            or request.get("type") != "discover" or request.get("protocol") != NATIVE_PROTOCOL:
        _native_reply({"ok": False, "error": "invalid-request"})
        return
    origin = request.get("origin")
    expected_origin = launch_origin
    if expected_origin is None:
        extension_id = os.environ.get("KANARIC_EXTENSION_ID", "")
        expected_origin = f"chrome-extension://{extension_id}/" if extension_id else ""
    if origin is not None and (not expected_origin or origin != expected_origin):
        _native_reply({"ok": False, "error": "invalid-origin"})
        return

    try:
        data = json.loads(_native_discovery_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        _native_reply({"ok": False, "error": "app-not-running"})
        return
    base_url = data.get("baseUrl") if isinstance(data, dict) else None
    token = data.get("token") if isinstance(data, dict) else None
    expires_at = data.get("expiresAt") if isinstance(data, dict) else None
    pid = data.get("pid") if isinstance(data, dict) else None
    parsed = urlparse(base_url or "")
    port = parsed.port if parsed.hostname else None
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
            or not isinstance(port, int) or not 1 <= port <= 65535
            or not isinstance(token, str) or not NATIVE_TOKEN_RE.fullmatch(token)
            or not isinstance(expires_at, int) or expires_at <= int(time.time() * 1000)
            or not _native_pid_alive(pid)):
        _native_reply({"ok": False, "error": "app-not-running"})
        return
    _native_reply({
        "ok": True,
        "baseUrl": f"http://127.0.0.1:{port}",
        "token": token,
        "expiresAt": expires_at,
        "pid": pid,
    })


def main():
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
    # stdin 一樣要救:node 以 UTF-8 寫入含日文的 JSON,但打包 exe 不吃 PYTHONIOENCODING,
    # 在非 UTF-8 codepage 的機器 (繁中預設 cp950) 會用 locale 解 stdin → 日文變亂碼 →
    # json.loads 崩 → 假名整個消失。開發機開了 Windows UTF-8 模式所以看不到,cp950 使用者才中。
    if sys.stdin and sys.stdin.encoding and sys.stdin.encoding.lower() != 'utf-8':
        sys.stdin.reconfigure(encoding='utf-8')

    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    launch_origin = _native_launch_origin(sys.argv[1:])

    if launch_origin is not None:
        native_messaging_main(launch_origin)
    elif cmd == "native-messaging":
        native_messaging_main()
    elif cmd == "monitor":
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
        # 譯文/逐字時間存的鍵是 (artist, title),查的卻是 searchTitle/searchArtist ——
        # 平常兩者是同一首歌的不同寫法,但備選歌詞視窗讓使用者打任何歌名,那時 server 會
        # 傳 stash=false,不然等於把別首歌的資料蓋到正在播的這首上 (見 server.js searchOptions)
        stash_ok = data.get("stash") is not False

        # 哪幾家的歌詞檔本身帶逐字時間 (見 cn_music._qrc_flow)
        WORD_TIME_SOURCES = {"QQMusic"}

        try:
            # 譯文與逐字時間都搭歌詞的便車存起來,之後就不用再打一次網路。
            # 兩者分開取第一個有東西的來源 —— 一家可能有翻譯卻沒逐字,反之亦然。
            # 譯文一定要寫入 (沒有就寫空的當負快取),否則 server 的 ensureTranslations
            # 會判斷成「還沒查過」,每次播這首歌都重抓一輪。
            def _stash(results, tried_all):
                if not stash_ok:
                    return
                # **譯文只有 `source:'all'` 那條路可以寫,而且要把三家合併起來。**
                #
                # 合併:鍵是 normalize_line 後的日文行,三家對同一首歌的**斷句與收錄範圍不同**,
                # 聯集嚴格地比任何單一家多 —— 實測 ツユ/やっぱり雨は降るんだね 網易 41 鍵 vs
                # QQ 64 鍵、NOMELON NOLEMON/moonshadow 網易 16 vs QQ 30。而 _SOURCES 是網易優先,
                # 舊寫法「第一個有譯文的就 break」每次都挑到少的那份,症狀是「這句有譯文、
                # 下一句沒有」(那些行根本沒有鍵可以查)。衝突時**前面的來源勝**,所以反著填。
                #
                # 只在 tried_all 寫:理由同下面的 word_times —— fetch() 拿到網易的歌詞就不會再問
                # QQ,那時寫下去等於拿一家的答案定案 (寫 {} 更慘,`applyTranslations` 只在
                # **沒有列**時才補抓,一個 {} 就讓那首歌永遠不再查譯文)。單一來源那條路乾脆
                # 不碰這張表,讓 ensureTranslations 的 source:'all' 來寫 —— 它本來就會跑:
                # word_times 的負快取同樣要 tried_all,所以單一來源抓完那首歌的 applyWordTimes
                # 一定查無資料、一定觸發它。
                if tried_all:
                    merged = {}
                    for r in reversed(results):
                        if r.get("translations"):
                            merged.update(r["translations"])
                    # 空 dict 仍然要寫 —— 那才是真的負快取 (三家都問過,都沒有翻譯軌)
                    db.save_translations(artist, title, merged)
                for r in results:
                    if r.get("word_times"):
                        db.save_word_times(artist, title, r["word_times"])
                        break
                else:
                    # 逐字時間**只有 QQ 給得出來**,所以負快取的條件是「QQ 真的回答了、
                    # 而且那份沒有逐字」,不是「三家都呼叫過」:
                    #  - fetch() 拿到網易的歌詞就不會再問 QQ (tried_all=False)
                    #  - QQ 的搜尋端點限流很兇,被擋時它整個不出現在 results 裡 —— 那時寫 {}
                    #    等於因為一次限流就把這首歌**永久**判成沒有逐字,而且不會再重試
                    if tried_all and any(r.get("source") in WORD_TIME_SOURCES for r in results):
                        db.save_word_times(artist, title, {})

            if source == "all":
                results = cn_music.fetch_all(q_artist, q_title, duration)
                _stash(results, True)
                print(json.dumps({
                    "success": True,
                    # word:這一份本身帶不帶逐字時間 (只有 QQ 的 QRC 有)。備選歌詞視窗
                    # 要標出格式,所以旗標得跟著每一筆走,不能只看有沒有 stash 進 DB
                    "results": [{"lyrics": r["lyrics"], "source": r["source"],
                                 "word": bool(r.get("word_times"))} for r in results]
                }, ensure_ascii=False))
            else:
                r = cn_music.fetch(q_artist, q_title, source, duration)
                if r.get("lyrics"):
                    _stash([r], False)
                    print(json.dumps({
                        # word:這一份本身帶不帶逐字時間 (同 source:'all' 那條路)。server 靠它決定
                        # 要不要連歌詞本體都用 QQ 那份 —— 本體與逐字同一份,行覆蓋率才會是 100%
                        "success": True, "lyrics": r["lyrics"], "source": r["source"],
                        "word": bool(r.get("word_times"))
                    }, ensure_ascii=False))
                else:
                    print(json.dumps({"success": False, "error": "Not found"}))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
    elif cmd == "ytsearch":
        # 卡拉OK模式的 MV 背景:用歌曲資訊搜 YouTube,回候選清單讓使用者挑。
        # 抓不到一律回空 list —— YouTube 改版時該安靜退回純黑底,不是讓那一頁掛掉
        import json
        import yt_search

        data = json.loads(sys.stdin.read())
        results = yt_search.search(
            data.get("title", ""), data.get("artist", ""),
            duration=data.get("duration") or None)
        print(json.dumps(results, ensure_ascii=False))
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
        from media_monitor import pick_session, load_media_source
        async def do_seek(sec):
            sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            sess = pick_session(sessions.get_sessions(), load_media_source())
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
        from media_monitor import pick_session, load_media_source
        async def do_media_action(action):
            sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            sess = pick_session(sessions.get_sessions(), load_media_source())
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
    elif cmd == "sessions":
        import asyncio
        import json
        import re
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
        from media_monitor import load_media_source

        def friendly_name(app_id):
            """Spotify.exe -> Spotify;AppleInc.AppleMusicWin_hash!App -> AppleMusicWin"""
            name = app_id.split('!')[0]
            name = re.sub(r'_[0-9a-z]{10,}$', '', name)  # UWP 套件的雜湊尾巴
            name = name.rsplit('\\', 1)[-1].split('/')[-1]
            name = re.sub(r'\.exe$', '', name, flags=re.I)
            return name.rsplit('.', 1)[-1] or app_id

        async def list_sessions():
            mgr = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            found = {}
            for s in mgr.get_sessions():
                app_id = s.source_app_user_model_id or ""
                if not app_id:
                    continue
                pb = s.get_playback_info()
                is_playing = bool(pb and pb.playback_status == 4)
                # 同一個 app 只列一筆,播放中的那筆優先當代表
                if app_id in found and not (is_playing and not found[app_id]["is_playing"]):
                    continue
                try:
                    info = await s.try_get_media_properties_async()
                    title, artist = info.title or "", info.artist or ""
                except Exception:
                    title, artist = "", ""
                found[app_id] = {
                    "app_id": app_id, "name": friendly_name(app_id),
                    "title": title, "artist": artist, "is_playing": is_playing
                }
            print(json.dumps({
                "current": load_media_source(),
                "sources": list(found.values())
            }, ensure_ascii=False))

        asyncio.run(list_sessions())
    else:
        print(f"Unknown command: {cmd!r}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
