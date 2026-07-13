"""
中國音樂平台歌詞抓取 (網易雲 / 酷狗)

這兩個平台的一次 API 回應裡同時有「日文歌詞」與「逐音節羅馬字」,所以歌詞與讀音提示
一起抓回來,不用打兩次網路。

羅馬字的用途:fugashi + unidic-lite 這種小辭典遇到人名、罕見訓讀、同形異讀會挑錯讀音
(例如「君」被讀成 くん 而不是 きみ),用平台附的羅馬字轉回平假名當「正解讀音」校正。
校正邏輯在 furigana_inject.apply_hint()。

來源:
  1. 網易雲音樂 romalrc 欄位
  2. 酷狗音樂 krc 內嵌的 language 軌 (type=0 即羅馬字)

hints 用歌詞「文字」當 key 而非時間戳,因為歌詞可能來自 Lrclib,時間軸跟中國平台對不起來。
"""
import base64
import json
import re
import sys
import zlib

import jaconv
import requests

import qrc_decrypt

TIMEOUT = 8
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# 只留下日文/漢字/英數,用來比對兩邊的同一行歌詞
_STRIP = re.compile(r'[^\w぀-ヿ一-龯々]+')


def normalize_line(text: str) -> str:
    """把歌詞行正規化成比對用的 key (去空白與標點)"""
    return _STRIP.sub('', text or '')


def _loose_eq(query: str, found: str) -> bool:
    """正規化後互相包含就算命中 (歌名有 feat.、歌手名有樂團全稱等雜訊)"""
    q, f = normalize_line(query).lower(), normalize_line(found).lower()
    return bool(q and f and (q in f or f in q))


def _title_matches(query: str, found: str) -> bool:
    """
    確認搜尋結果真的是這首歌。歌詞抓錯整首都毀了,比讀音錯嚴重得多,
    所以正規化後兩邊必須互相包含才算數。
    """
    return _loose_eq(query, found)


def _pick_song(candidates, artist, duration=None):
    """
    從搜尋結果挑一首。candidates 為 [(song, 標題, 歌手, 時長秒)],呼叫端已先過 _title_matches。

    光比標題不夠:翻唱、同名曲、live 版都會撞。有歌手就比歌手,有時長就比時長 (±3 秒),
    兩者都只當「加分」,排序時平手就保留平台自己的相關性順序。

    只有在「歌手對不上 而且 時長差超過 10 秒」時才整個放棄 —— 歌手名在各平台寫法差異大
    (所以才有 artist_aliases 這張表),單憑歌手不合就退貨會誤殺太多。
    """
    if not candidates:
        return None

    def rank(item):
        _, _, f_artist, f_dur = item
        artist_ok = _loose_eq(artist, f_artist)
        dur_ok = bool(duration and f_dur and abs(f_dur - duration) <= 3)
        return (not artist_ok, not dur_ok)

    best = min(range(len(candidates)), key=lambda i: rank(candidates[i]) + (i,))
    song, _, f_artist, f_dur = candidates[best]

    if duration and f_dur and not _loose_eq(artist, f_artist) and abs(f_dur - duration) > 10:
        return None  # 歌手不合、長度也差一大截,幾乎確定是別首歌

    return song


def romaji_to_hira(romaji: str) -> str:
    """逐音節羅馬字 -> 平假名。空白是音節分隔,轉換前要拿掉"""
    r = re.sub(r'[^A-Za-z]+', '', romaji or '')
    if not r:
        return ''
    return jaconv.alphabet2kana(r.lower())


def _parse_lrc(text: str) -> dict:
    """LRC -> {時間(秒, 取到 0.1): 歌詞}"""
    out = {}
    for line in (text or '').split('\n'):
        m = re.match(r'\[(\d+):(\d+)[.:](\d+)\](.*)', line)
        if not m:
            continue
        ts = round(int(m.group(1)) * 60 + int(m.group(2)) + float('0.' + m.group(3)), 1)
        body = m.group(4).strip()
        if body:
            out[ts] = body
    return out


def _fetch_netease(artist: str, title: str, duration=None) -> dict:
    """網易雲：搜尋 -> 取 lrc + romalrc,用網易自己的時間戳把日文行與羅馬字行接起來"""
    headers = {"User-Agent": UA, "Referer": "https://music.163.com"}
    resp = requests.get(
        "https://music.163.com/api/search/get",
        params={"type": 1, "limit": 5, "s": f"{title} {artist}"},
        headers=headers, timeout=TIMEOUT,
    )
    songs = (resp.json().get("result") or {}).get("songs") or []
    cands = [
        (s,
         s.get("name", ""),
         ' '.join(a.get("name", "") for a in (s.get("artists") or [])),
         (s.get("duration") or 0) / 1000.0)  # 網易的 duration 是毫秒
        for s in songs if _title_matches(title, s.get("name", ""))
    ]
    song = _pick_song(cands, artist, duration)
    if not song:
        return {}

    lyric = requests.get(
        "https://music.163.com/api/song/lyric",
        params={"id": song["id"], "lv": 1, "tv": -1, "rv": -1},
        headers=headers, timeout=TIMEOUT,
    ).json()
    lrc = (lyric.get("lrc") or {}).get("lyric") or ''
    if not lrc:
        return {}

    hints = {}
    jp = _parse_lrc(lrc)
    roma = _parse_lrc((lyric.get("romalrc") or {}).get("lyric") or '')
    for ts, jp_line in jp.items():
        if ts not in roma:
            continue
        hira = romaji_to_hira(roma[ts])
        key = normalize_line(jp_line)
        if key and hira:
            hints[key] = hira

    return {"lyrics": lrc, "hints": hints, "source": "NetEase"}


# krc 是 XOR + zlib 壓縮過的,這把金鑰是公開的固定值
_KRC_KEY = bytes([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
                  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69])


def _krc_to_lrc(krc_lines: list) -> str:
    """
    krc 主軌 -> 標準 LRC。
    krc 行格式:[起始毫秒,長度毫秒]<偏移,長度,0>字<偏移,長度,0>字
    """
    out = []
    for start_ms, text in krc_lines:
        total = start_ms / 1000.0
        out.append(f"[{int(total // 60):02d}:{total % 60:05.2f}]{text}")
    return '\n'.join(out)


def _fetch_kugou(artist: str, title: str, duration=None) -> dict:
    """酷狗：krc 內含 language 軌,type=0 是逐音節羅馬字,行序與主歌詞一一對應"""
    headers = {"User-Agent": UA}
    # 這幾個端點的 https 憑證主機名對不上,只能走 http
    found = requests.get(
        "http://mobilecdn.kugou.com/api/v3/search/song",
        params={"format": "json", "keyword": f"{title} {artist}", "page": 1, "pagesize": 5},
        headers=headers, timeout=TIMEOUT,
    ).json()
    info = (found.get("data") or {}).get("info") or []
    cands = [
        (s, s.get("songname", ""), s.get("singername", ""), float(s.get("duration") or 0))
        for s in info if _title_matches(title, s.get("songname", ""))
    ]
    song = _pick_song(cands, artist, duration)
    if not song:
        return {}

    cand = requests.get(
        "http://krcs.kugou.com/search",
        params={"ver": 1, "man": "yes", "client": "mobi", "hash": song["hash"]},
        headers=headers, timeout=TIMEOUT,
    ).json().get("candidates") or []
    if not cand:
        return {}

    dl = requests.get(
        "http://lyrics.kugou.com/download",
        params={"ver": 1, "client": "pc", "id": cand[0]["id"],
                "accesskey": cand[0]["accesskey"], "fmt": "krc", "charset": "utf8"},
        headers=headers, timeout=TIMEOUT,
    ).json()
    if not dl.get("content"):
        return {}

    raw = base64.b64decode(dl["content"])
    # 前 4 bytes 是 "krc1" 檔頭,之後才是加密內容
    krc = zlib.decompress(
        bytes(b ^ _KRC_KEY[i % 16] for i, b in enumerate(raw[4:]))
    ).decode("utf-8", "ignore")

    # 抽出主歌詞行:去掉逐字時間標記,只留起始時間與文字
    jp_lines = []
    for line in krc.split('\n'):
        m = re.match(r'^\[(\d+),\d+\](.*)$', line)
        if not m:
            continue
        jp_lines.append((int(m.group(1)), re.sub(r'<[^>]*>', '', m.group(2)).strip()))
    if not jp_lines:
        return {}

    # language 軌:type=0 羅馬字, type=1 翻譯。行序與主歌詞對齊
    hints = {}
    lang_tag = re.search(r'\[language:(.*?)\]', krc)
    if lang_tag:
        lang = json.loads(base64.b64decode(lang_tag.group(1)).decode("utf-8"))
        roma_rows = next(
            (t.get("lyricContent") or [] for t in lang.get("content", []) if t.get("type") == 0),
            []
        )
        for (_, jp_line), row in zip(jp_lines, roma_rows):
            hira = romaji_to_hira(''.join(row))
            key = normalize_line(jp_line)
            if key and hira:
                hints[key] = hira

    return {"lyrics": _krc_to_lrc(jp_lines), "hints": hints, "source": "Kugou"}


def _qrc_lines(text: str) -> list:
    """QRC 主體 -> [(起始毫秒, 去掉逐字標記的文字)]。順便濾掉 [ti:]/[kana:] 之類的檔頭"""
    out = []
    for line in (text or '').split('\n'):
        m = re.match(r'^\[(\d+),\d+\](.*)$', line)
        if m:
            out.append((int(m.group(1)), re.sub(r'\(\d+,\d+\)', '', m.group(2)).strip()))
    return out


def _qq_track(resp: str, tag: str) -> list:
    """從 lyric_download 的回應裡取出某一軌並解密。空軌或解不開就回 []"""
    m = re.search(rf'<{tag}[^>]*><!\[CDATA\[(.*?)\]\]></{tag}>', resp, re.S)
    if not m or not m.group(1).strip():
        return []
    try:
        plain = qrc_decrypt.decrypt_qrc(m.group(1).strip())
    except Exception:
        return []  # 翻譯軌有時是明文 LRC 而非 hex,解不開很正常
    # QRC 可能再包一層 XML,真正的內容在 LyricContent 屬性裡
    inner = re.search(r'LyricContent="(.*?)"', plain, re.S)
    return _qrc_lines(inner.group(1) if inner else plain)


def _qq_lyrics(song_id) -> dict:
    """用 QQ 的數字 musicid 取歌詞 + 羅馬字提示"""
    resp = requests.post(
        "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg",
        data={"version": "15", "miniversion": "82", "lrctype": "4", "musicid": str(song_id)},
        headers={"User-Agent": UA, "Referer": "https://y.qq.com/"}, timeout=TIMEOUT,
    ).text.replace("<!--", "").replace("-->", "")

    jp_lines = _qq_track(resp, "content")
    if not jp_lines:
        return {}

    hints = {}
    for (_, jp_line), (_, roma_line) in zip(jp_lines, _qq_track(resp, "contentroma")):
        hira = romaji_to_hira(roma_line)
        key = normalize_line(jp_line)
        if key and hira:
            hints[key] = hira

    return {"lyrics": _krc_to_lrc(jp_lines), "hints": hints, "source": "QQMusic"}


def _fetch_qqmusic(artist: str, title: str, duration=None) -> dict:
    """
    QQ 音樂：逐字歌詞 (QRC) 另外附一條 contentroma 羅馬字軌,行序與主歌詞一一對應。
    網易雲有不少日文歌只有 lrc 沒有 romalrc,這時 QQ 是第三個機會。

    注意:搜尋端點 (u.y.qq.com) 限流很兇,連打幾次就開始回空結果。QQ 排在來源清單最後,
    被限流時就當作沒找到、自然降級,不必特別處理。
    """
    body = {
        "comm": {"ct": 24, "cv": 0},  # 少了這塊會被回 code 2001
        "req_1": {
            "method": "DoSearchForQQMusicDesktop",
            "module": "music.search.SearchCgiService",
            "param": {"num_per_page": 20, "page_num": 1, "query": f"{title} {artist}", "search_type": 0},
        },
    }
    found = requests.post(
        "https://u.y.qq.com/cgi-bin/musicu.fcg", json=body,
        headers={"User-Agent": UA, "Referer": "https://y.qq.com/"}, timeout=TIMEOUT,
    ).json()
    songs = (((found.get("req_1") or {}).get("data") or {}).get("body") or {}).get("song", {}).get("list") or []
    cands = [
        (s, s.get("name", ""),
         '/'.join(a.get("name", "") for a in (s.get("singer") or [])),
         float(s.get("interval") or 0))  # interval 單位是秒
        for s in songs if _title_matches(title, s.get("name", ""))
    ]
    song = _pick_song(cands, artist, duration)
    if not song:
        return {}

    return _qq_lyrics(song["id"])


# 順序即 fetch_hints 的取用優先序 (第一個有羅馬字的來源勝出)。
# QQ 排在酷狗前面:兩邊的羅馬字都是機器產的,但 QQ 明顯準一些 (例如 私,酷狗給 watakushi、
# QQ 給 watashi)。QQ 的搜尋端點會限流,被擋時自然落到酷狗,所以酷狗仍留著當保底。
_SOURCES = {"NetEase": _fetch_netease, "QQMusic": _fetch_qqmusic, "Kugou": _fetch_kugou}


def fetch(artist: str, title: str, source: str = "auto", duration=None) -> dict:
    """
    抓歌詞 + 讀音提示。source 可指定單一平台,"auto" 則依序試到有結果為止。
    任何一步失敗都退到下一個來源,全掛就回 {} (由呼叫端當負快取)。
    """
    if source in _SOURCES:
        order = [source] + [s for s in _SOURCES if s != source]
    else:
        order = list(_SOURCES)

    for name in order:
        try:
            result = _SOURCES[name](artist, title, duration)
            if result.get("lyrics"):
                return result
        except Exception as e:
            print(f"[cn_music] {name} failed: {e}", file=sys.stderr)
    return {}


def fetch_all(artist: str, title: str, duration=None) -> list:
    """每個平台各抓一筆,給備選歌詞視窗用"""
    results = []
    for name, fn in _SOURCES.items():
        try:
            result = fn(artist, title, duration)
            if result.get("lyrics"):
                results.append(result)
        except Exception as e:
            print(f"[cn_music] {name} failed: {e}", file=sys.stderr)
    return results


def fetch_hints(artist: str, title: str, duration=None) -> dict:
    """
    只要讀音提示 (furigana_inject 在歌詞來自其他平台時走這條)。

    一個平台可能有歌詞卻沒有羅馬字 (例如網易雲的某些歌只有 lrc,romalrc 是空的),
    這時要繼續問下一個平台 —— 讀音提示跟歌詞本來就不必來自同一家。
    """
    for name, fn in _SOURCES.items():
        try:
            hints = fn(artist, title, duration).get("hints") or {}
            if hints:
                return hints
        except Exception as e:
            print(f"[cn_music] {name} failed: {e}", file=sys.stderr)
    return {}


def _selftest():
    # (song, 標題, 歌手, 時長秒);呼叫端已過濾標題,這裡只驗歌手/時長的取捨
    real = ({"id": 1}, "夏風に溶ける", "りりあ。", 240.0)
    cover = ({"id": 2}, "夏風に溶ける", "某某翻唱", 300.0)

    # 歌手命中的優先,即使排在後面
    assert _pick_song([cover, real], "りりあ。")["id"] == 1
    # 沒有歌手線索時,時長對得上的勝出
    assert _pick_song([cover, real], "", 241.0)["id"] == 1
    # 歌手時長都對不上 -> 寧缺勿錯
    assert _pick_song([cover], "りりあ。", 240.0) is None
    # 但只有歌手不合 (沒時長可佐證) 仍然放行,歌手名各平台寫法差太多
    assert _pick_song([cover], "りりあ。")["id"] == 2
    # 時長差在容忍範圍內,歌手不合也放行
    assert _pick_song([({"id": 3}, "x", "別名寫法", 242.0)], "りりあ。", 240.0)["id"] == 3
    assert not _pick_song([], "a", 1)
    print("cn_music selftest ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["selftest"]:
        _selftest()
        sys.exit(0)
    artist = sys.argv[1] if len(sys.argv) > 2 else "サカナクション"
    title = sys.argv[2] if len(sys.argv) > 2 else "新宝島"
    source = sys.argv[3] if len(sys.argv) > 3 else "auto"
    r = fetch(artist, title, source)
    if not r:
        print(f"{artist} - {title}: 沒有結果", file=sys.stderr)
        sys.exit(1)
    lines = r["lyrics"].strip().split('\n')
    print(f"{artist} - {title} [{r['source']}]: {len(lines)} 行歌詞, {len(r['hints'])} 筆讀音提示", file=sys.stderr)
    print('\n'.join(lines[:3]))
