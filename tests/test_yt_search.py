# yt_search.parse_results 的回歸測試 (不打網路):venv\Scripts\python.exe tests/test_yt_search.py
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from yt_search import extract_initial_data, parse_results


def vr(vid, title, channel, length):
    """搜尋頁 JSON 裡一筆影片的最小形狀 (欄位名照真實回應)。"""
    return {"videoRenderer": {
        "videoId": vid,
        "title": {"runs": [{"text": title}]},
        "ownerText": {"runs": [{"text": channel}]},
        "lengthText": {"simpleText": length},
        "thumbnail": {"thumbnails": [{"url": "small.jpg"}, {"url": "big.jpg"}]},
    }}


# videoRenderer 埋在很深的巢狀結構裡,而且路徑會隨改版變 —— 解析是整包走訪出來的
DATA = {"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {
    "sectionListRenderer": {"contents": [{"itemSectionRenderer": {"contents": [
        vr("aaa", "官方 MV", "SomeLabel", "4:21"),
        {"adSlotRenderer": {"note": "廣告之類的雜物,不該被當成影片"}},
        vr("bbb", "音源", "Artist - Topic", "4:20"),
        vr("ccc", "現場版", "SomeChannel", "9:99"),
    ]}}]}}}}}

items = parse_results(DATA)
assert [i["videoId"] for i in items][:1] == ["aaa"], "第一筆是官方 MV"
assert items[0]["title"] == "官方 MV"
assert items[0]["channel"] == "SomeLabel"
assert items[0]["durationSec"] == 4 * 60 + 21, "mm:ss 換算成秒"
assert items[0]["thumb"] == "big.jpg", "縮圖取最大那張"
assert len(items) == 3, "非影片的節點不算進來"

# `- Topic` 是自動產生的音訊上傳 (畫面是一張靜態封面),當 MV 沒有意義 → 往後排
assert items[-1]["videoId"] == "bbb", "- Topic 排到最後"

# 有歌曲時長時,差 30 秒內的往前排;差太多的往後 (現場版/合輯)
close = parse_results(DATA, duration=261)
assert [i["videoId"] for i in close] == ["aaa", "ccc", "bbb"], "時長吻合的往前,但 Topic 仍最後"
far = parse_results(DATA, duration=600)
assert far[0]["videoId"] == "aaa", "都不吻合時維持 YouTube 的原順序"

# 時長換算:hh:mm:ss 與「拿不到」
one_hour = {"contents": [vr("ddd", "長片", "Ch", "1:02:33"), vr("eee", "直播中", "Ch", "")]}
r = parse_results(one_hour)
assert r[0]["durationSec"] == 3753, "hh:mm:ss"
assert r[1]["durationSec"] == 0, "沒有時長 (直播) 回 0 而不是炸掉"

# limit
assert len(parse_results(DATA, limit=2)) == 2

# ── `ok`:翻唱/演唱會/鋼琴/カラオケ 那一類排到最後並標記 ──
# 前端只在第一支 ok 時才自動套用 MV,所以這個旗標錯了就是「唱到一半畫面完全不對」
BAD = {"contents": [
    vr("cov", "春泥棒 歌ってみた", "誰か", "4:20"),
    vr("kar", "春泥棒 カラオケ", "Ch", "4:20"),
    vr("pia", "春泥棒 Piano Cover", "Ch", "4:20"),
    vr("liv", "春泥棒 (Live at 武道館)", "Ch", "4:20"),
    vr("off", "春泥棒", "ヨルシカ", "4:20"),
]}
r = parse_results(BAD)
assert r[0]["videoId"] == "off", "乾淨的那支排第一"
assert r[0]["ok"] is True
assert all(i["ok"] is False for i in r[1:]), "翻唱/カラオケ/鋼琴/演唱會全部標成非原版"

# 英文那批要 \b 邊界,否則會誤判正常歌名
for title in ["Made in Heaven", "Delivery", "Live and Let Die 的 MAD"]:
    got = parse_results({"contents": [vr("x", title, "Ch", "4:20")]})[0]["ok"]
    expect = "MAD" not in title      # 前兩個是誤判測試,第三個真的該擋
    assert got is expect, f"{title} → ok={got}"

# ── 標題含歌名 > 頻道含歌手名 (官方頻道) ──
# 這兩條是實測配出來的:只加「官方頻道」的話會挑到同一個頻道的**別首歌**
# (ヨルシカ/春泥棒 → 晴る、米津玄師/KICK BACK → Plazma)
PICK = {"contents": [
    vr("other", "ヨルシカ - 晴る（OFFICIAL VIDEO）", "ヨルシカ / n-buna Official", "4:37"),
    vr("reup", "【中文字幕】ヨルシカ「春泥棒」", "咲月Satsuki", "4:50"),
    vr("want", "ヨルシカ - 春泥棒（OFFICIAL VIDEO）", "ヨルシカ / n-buna Official", "5:00"),
]}
r = parse_results(PICK, artist="ヨルシカ", title="春泥棒", duration=261)
assert r[0]["videoId"] == "want", "官方頻道 + 標題對得上的那一支"
assert r[-1]["videoId"] == "reup", "帶字幕的轉載排到最後 (畫面上燒著另一份字)"

# 正規化過才比,所以空白/連字號的寫法不同也對得上
assert parse_results({"contents": [vr("k", "米津玄師 Kenshi Yonezu - KICKBACK", "Kenshi Yonezu 米津玄師", "3:48")]},
                     artist="米津玄師", title="KICK BACK")[0]["videoId"] == "k"

# **時長要排在最後**:官方 MV 常比音源長 (前奏/outro),實測 春泥棒 是 300s vs 261s,
# 差 39 秒 —— 時長排前面的話正版反而被踢掉
long_official = parse_results(PICK, artist="ヨルシカ", title="春泥棒", duration=261)
assert long_official[0]["durationSec"] == 300, "差 39 秒的官方版仍然排第一"

# Task 2:官方候選帶出版本分類與時長差；超過 30 秒只警告、不改排名
OFFICIAL_CHECK = {"contents": [
    vr("exact", "ヨルシカ - 春泥棒（OFFICIAL VIDEO）", "ヨルシカ / n-buna Official", "4:14"),
    vr("intro", "ヨルシカ - 春泥棒（OFFICIAL VIDEO）", "ヨルシカ / n-buna Official", "5:00"),
    vr("cover", "春泥棒 Cover", "誰か", "4:14"),
]}
official_exact = parse_results(OFFICIAL_CHECK, artist="ヨルシカ", title="春泥棒", duration=254)[0]
assert official_exact["official"] is True
assert official_exact["durationDeltaSec"] == 0
assert official_exact["needsConfirmation"] is False
official_long_intro = next(i for i in parse_results(OFFICIAL_CHECK, artist="ヨルシカ", title="春泥棒", duration=254)
                           if i["videoId"] == "intro")
assert official_long_intro["durationDeltaSec"] == 46
assert official_long_intro["needsConfirmation"] is True
cover_exact = next(i for i in parse_results(OFFICIAL_CHECK, artist="ヨルシカ", title="春泥棒", duration=254)
                   if i["videoId"] == "cover")
assert cover_exact["official"] is False

# One-search sends no separate artist.  An empty artist is unknown, not an
# explicit non-official channel; a clean, title-ranked, duration-matching
# result must remain safe to start without a redundant confirmation.
ONE_SEARCH = {"contents": [
    vr("one-search-exact", "春泥棒", "Some Uploader", "4:14"),
    vr("one-search-long", "春泥棒", "Some Uploader", "5:00"),
    vr("one-search-cover", "春泥棒 歌ってみた", "Some Uploader", "4:14"),
]}
one_search = parse_results(ONE_SEARCH, artist="", title="春泥棒", duration=254)
assert one_search[0]["official"] is None, "空歌手只能表示 official unknown"
assert one_search[0]["needsConfirmation"] is False, "乾淨的一欄搜尋候選不得被未知歌手誤警告"
one_search_long = next(i for i in one_search if i["videoId"] == "one-search-long")
assert one_search_long["official"] is None
assert one_search_long["needsConfirmation"] is True, "時長不符仍需確認"
one_search_bad = next(i for i in one_search if i["videoId"] == "one-search-cover")
assert one_search_bad["ok"] is False
assert one_search_bad["needsConfirmation"] is True, "壞候選仍需確認"

# 全部都是翻唱時第一支仍然是 not ok —— 前端據此決定「乾脆不套」
allbad = parse_results({"contents": [vr("c1", "歌ってみた", "A", "4:20"),
                                     vr("c2", "ピアノ", "B", "4:20")]})
assert allbad[0]["ok"] is False

# 壞掉的輸入一律回空 list,不拋例外 —— YouTube 改版時該安靜退回純黑底
assert parse_results(None) == []
assert parse_results({}) == []
assert parse_results({"contents": "不是預期的形狀"}) == []
assert parse_results([{"videoRenderer": {"title": {"runs": [{"text": "沒有 videoId"}]}}}]) == []

# HTML 挖 JSON 的兩種寫法都要認得
assert extract_initial_data('<script>var ytInitialData = {"a": 1};</script>') == {"a": 1}
assert extract_initial_data('window["ytInitialData"] = {"a": 2};') == {"a": 2}
assert extract_initial_data("") is None
assert extract_initial_data("<html>沒有那個變數</html>") is None
assert extract_initial_data("var ytInitialData = {壞掉的 JSON};") is None

print("test_yt_search: OK")
