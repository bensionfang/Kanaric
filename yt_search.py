"""
YouTube 搜尋 client —— 卡拉OK模式的 MV 背景用。

**為什麼是抓搜尋頁而不是 Data API**:官方 API 要 key,而使用者得自己去 Google Cloud 申請,
app 又多一個密鑰要保管 (BYOK 那套 2026-08-04 已經整組拆掉,不想再長回來)。搜尋頁的
`ytInitialData` 是伺服器端就渲染好的 JSON,拿得到 videoId/標題/頻道/時長,夠用。
代價是 YouTube 改版時會壞 —— 所以**解析失敗一律回空 list,絕不拋例外**:那時卡拉OK頁
安靜地退回純黑底,而不是整頁掛掉。

網路擷取 (`fetch_html`) 與解析 (`parse_results`) 刻意分開,測試只打後者、不打真站
(同 `tests/test_utaten.py` 的做法)。
"""
import json
import re

import requests

SEARCH_URL = "https://www.youtube.com/results"
# sp=EgIQAQ%3D%3D = 「類型:影片」的篩選,把播放清單與頻道濾掉
VIDEO_FILTER = "EgIQAQ%3D%3D"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"),
    "Accept-Language": "ja,en;q=0.8",
}
TIMEOUT = 10
MAX_RESULTS = 10
# 時長差在這個範圍內視為「就是這首歌」,排序時往前提
DURATION_TOLERANCE = 30

# 「明顯不是原版 MV」的字眼。搜尋結果本來就混著翻唱、演唱會、歌ってみた、鋼琴譜、AMV,
# 而卡拉OK頁**會自動套用第一支** —— 挑錯的代價是唱到一半畫面完全不對,所以這一類要排到最後,
# 而且整包結果的第一支若落在這一類就乾脆不自動套 (`ok` 旗標,使用者仍然可以自己挑)。
# 日文/中文那批直接比子字串;英文那批要 \b 邊界,否則 `live` 會吃到 `delivery`、`mad` 吃到 `made`。
_BAD_JA = re.compile(
    "歌ってみた|唄ってみた|弾いてみた|叩いてみた|踊ってみた|演奏してみた|弾き語り|"
    "歌い方|解説|ギター|ベース|ドラム|三味線|合唱|"
    "カバー|カラオケ|オフボーカル|ピアノ|オルゴール|ライブ|ライヴ|生放送|"
    "翻唱|伴奏|純音樂|純音楽|作業用|耳コピ|"
    # 字幕/歌詞卡那類轉載:畫面上本來就燒著一份字,跟我們自己的歌詞疊在一起會看不清楚
    "字幕|歌詞|歌词")
_BAD_EN = re.compile(
    r"\b(cover|covered|karaoke|instrumental|inst|off ?vocal|piano|acoustic|guitar|"
    r"remix|nightcore|8-?bit|mad|amv|reaction|live|concert|tour|"
    r"lyrics?|subtitle[sd]?|romaji|sub ?esp)\b", re.I)


def _is_bad(it):
    text = f"{it['title']} {it['channel']}"
    return bool(_BAD_JA.search(text) or _BAD_EN.search(text))


def _norm(s):
    """比對頻道名與歌手名用:去掉空白與常見的裝飾符號,大小寫不計。"""
    return re.sub(r"[\s\-_/&・,、。!！?？'\"“”‘’()（）\[\]【】]", "", (s or "")).lower()


def _title_matches(it, title):
    """搜尋結果的標題含這首歌的歌名。

    **這一項要排在「官方頻道」前面** —— 官方頻道底下當然還有別首歌,實測
    `ヨルシカ / 春泥棒` 會被排到同頻道的「晴る」、`米津玄師 / KICK BACK` 被排到「Plazma」。
    正規化後直接比包含,所以 `KICK BACK` 對得上 `KICKBACK`。
    """
    t = _norm(title)
    return bool(t) and t in _norm(it["title"])


def _is_official(it, artist):
    """頻道名含歌手名 = 官方頻道 (或至少是本人相關的上傳)。

    這是**最強的一個訊號**:實測 `米津玄師 / 春雷` 的官方頻道叫「Kenshi Yonezu 米津玄師」,
    而 YouTube 自己排在第一的常常是帶字幕的轉載或翻唱。沒有歌手名時只能表示未知,
    不應把它誤當成明確的非官方頻道。
    """
    a = _norm(artist)
    if not a:
        return None
    return a in _norm(it["channel"])


def fetch_html(query):
    """打搜尋頁,回 HTML 字串;失敗回空字串。"""
    try:
        r = requests.get(SEARCH_URL, params={"search_query": query, "sp": VIDEO_FILTER},
                         headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        return r.text
    except Exception:
        return ""


def extract_initial_data(html_text):
    """從搜尋頁 HTML 挖出 ytInitialData 那包 JSON;挖不到回 None。"""
    if not html_text:
        return None
    # 這個變數的寫法歷來有 `var ytInitialData =` 與 `window["ytInitialData"] =` 兩種
    m = re.search(r'(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.+?\});',
                  html_text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def _walk_video_renderers(node, out):
    """整包 JSON 的結構常改版,所以不寫死路徑,直接找出所有 videoRenderer。"""
    if isinstance(node, dict):
        vr = node.get("videoRenderer")
        if isinstance(vr, dict):
            out.append(vr)
        for v in node.values():
            _walk_video_renderers(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk_video_renderers(v, out)


def _text_of(node):
    """YouTube 的文字欄位有 simpleText 與 runs 兩種寫法。"""
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("simpleText"), str):
        return node["simpleText"]
    runs = node.get("runs")
    if isinstance(runs, list):
        return "".join(r.get("text", "") for r in runs if isinstance(r, dict))
    return ""


def _duration_sec(vr):
    """`4:21` / `1:02:33` → 秒。拿不到回 0 (直播沒有時長)。"""
    raw = _text_of(vr.get("lengthText")) or ""
    parts = [p for p in raw.strip().split(":") if p.isdigit()]
    if not parts:
        return 0
    sec = 0
    for p in parts:
        sec = sec * 60 + int(p)
    return sec


def _thumb(vr):
    thumbs = (vr.get("thumbnail") or {}).get("thumbnails") or []
    return thumbs[-1].get("url", "") if thumbs else ""


def parse_results(data, duration=None, limit=MAX_RESULTS, artist="", title=""):
    """ytInitialData → candidate metadata, including official/version checks.

    排序三件,其餘照 YouTube 自己的順序 (它的相關度對「歌手 + 歌名」本來就相當準):
      * 翻唱/演唱會/鋼琴/カラオケ 那一類排到最後,並標 `ok: False` —— 前端只在第一支
        `ok` 時才自動套用,不然寧可留黑底
      * 標題含歌名的往前,再來是頻道含歌手名 (官方頻道)
      * `- Topic` 頻道往後排 —— 那是自動產生的音訊上傳,畫面是一張靜態封面,當 MV 沒有意義
      * 有歌曲時長時,差在 DURATION_TOLERANCE 內的往前排
    """
    renderers = []
    try:
        _walk_video_renderers(data, renderers)
    except Exception:
        return []

    seen = set()
    items = []
    for vr in renderers:
        try:
            vid = vr.get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            channel = _text_of((vr.get("ownerText") or vr.get("longBylineText") or {}))
            items.append({
                "videoId": vid,
                "title": _text_of(vr.get("title")),
                "channel": channel,
                "durationSec": _duration_sec(vr),
                "thumb": _thumb(vr),
            })
        except Exception:
            continue

    for it in items:
        it["ok"] = not _is_bad(it)
        it["official"] = _is_official(it, artist)
        it["durationDeltaSec"] = (
            abs(it["durationSec"] - duration)
            if duration and it["durationSec"] else None
        )
        it["needsConfirmation"] = (
            not it["ok"]
            or it["official"] is False
            or (it["durationDeltaSec"] is not None
                and it["durationDeltaSec"] > DURATION_TOLERANCE)
        )

    def rank(it):
        topic = 1 if it["channel"].strip().endswith("- Topic") else 0
        close = 0
        if duration and it["durationSec"]:
            close = 0 if abs(it["durationSec"] - duration) <= DURATION_TOLERANCE else 1
        # 官方頻道排在乾淨結果之中的最前面,但**還是要先過 ok 那一關** ——
        # 官方頻道自己也會上傳 Live 版與 -Topic 音源
        return (0 if it["ok"] else 1,
                0 if _title_matches(it, title) else 1,
                0 if it["official"] else 1,
                topic, close)

    items.sort(key=rank)   # list.sort 是穩定的,同分維持 YouTube 的原順序
    return items[:limit]


def search(title, artist="", duration=None, limit=MAX_RESULTS):
    query = f"{artist} {title}".strip() if artist else (title or "").strip()
    if not query:
        return []
    return parse_results(extract_initial_data(fetch_html(query)),
                         duration=duration, limit=limit, artist=artist, title=title)


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    t = sys.argv[1] if len(sys.argv) > 1 else "春泥棒"
    a = sys.argv[2] if len(sys.argv) > 2 else "ヨルシカ"
    for it in search(t, a):
        print(f"{it['videoId']}  {it['durationSec']:>5}s  {it['channel']}  |  {it['title']}")
