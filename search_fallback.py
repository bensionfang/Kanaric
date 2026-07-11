"""
歌詞搜尋備用模組
當主要的 syncedlyrics 庫找不到合適結果，或需要取得其他來源的歌詞時，
此腳本作為 CLI 供其他語言(或需要獨立執行時)呼叫，主要封裝了 QQMusic 等搜尋邏輯。
"""
import sys
import json
import logging
import syncedlyrics
import requests
import base64

def fetch_qqmusic(title, artist):
    """
    透過 QQMusic API 搜尋並抓取歌詞
    回傳: (歌詞字串, 來源名稱) 或 (None, None)
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://y.qq.com/"
    }
    # 搜尋歌曲 API
    search_url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
    params = {"p": 1, "n": 3, "w": f"{title} {artist}", "format": "json"}
    try:
        resp = requests.get(search_url, params=params, headers=headers, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            songs = data.get("data", {}).get("song", {}).get("list", [])
            if not songs: return None, None
            
            # 取第一首 (最相關) 歌曲的 songmid
            best_song = songs[0]
            songmid = best_song.get("songmid")
            if not songmid: return None, None
            
            # 透過 songmid 取得歌詞 API
            lyric_url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"
            l_params = {"songmid": songmid, "format": "json", "nobase64": 0}
            l_resp = requests.get(lyric_url, params=l_params, headers=headers, timeout=5)
            
            if l_resp.status_code == 200:
                l_data = l_resp.json()
                lyric_b64 = l_data.get("lyric", "")
                if lyric_b64:
                    # QQMusic 返回的歌詞是 Base64 編碼，需要解碼
                    lyric_text = base64.b64decode(lyric_b64).decode("utf-8", errors="ignore")
                    return lyric_text, "QQMusic"
    except Exception as e:
        pass
    return None, None

def fetch_single_provider(query, provider):
    """透過 syncedlyrics 套件向單一供應商請求歌詞"""
    try:
        return syncedlyrics.search(query, providers=[provider])
    except:
        return None

from utils import text_to_romaji_query, romaji_to_hiragana
from db import db

def generate_queries(t, a):
    # 先過濾別名
    a = db.get_artist_alias(a)
    
    queries = []
    seen = set()
    def add_q(qt, qa):
        if (qt, qa) not in seen and qt and qa:
            seen.add((qt, qa))
            queries.append((qt, qa))
    rt = text_to_romaji_query(t)
    ra = text_to_romaji_query(a)
    ht = romaji_to_hiragana(t)
    ha = romaji_to_hiragana(a)
    
    rt_valid = rt and rt.lower() != t.lower()
    ra_valid = ra and ra.lower() != a.lower()
    ht_valid = ht and ht != t
    ha_valid = ha and ha != a

    # 1. 優先：原始歌名 + 平假名歌手
    if ha_valid:
        add_q(t, ha)
        
    # 2. 原始歌名 + 原始歌手
    add_q(t, a)
    
    # 3. 平假名歌名 + 平假名歌手
    if ht_valid and ha_valid:
        add_q(ht, ha)
        
    # 4. 平假名歌名 + 原始歌手
    if ht_valid:
        add_q(ht, a)
        
    # 5. 羅馬音處理
    if rt_valid:
        add_q(rt, a)
        add_q(rt.replace(" ", ""), a)
    if ra_valid:
        add_q(t, ra)
    if rt_valid and ra_valid:
        add_q(rt, ra)
        add_q(rt.replace(" ", ""), ra)
    return queries

def main():
    """
    主程式入口，負責解析命令列參數並輸出 JSON 格式的結果
    支援 `--all` 參數來取得所有來源的備用選項
    """
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Missing title or artist"}))
        return
        
    title = sys.argv[1]
    artist = sys.argv[2]
    return_all = len(sys.argv) > 3 and sys.argv[3] == "--all"
    
    query = f"{title} {artist}"
    
    preferred_source = "NetEase"
    try:
        import os
        settings_path = os.environ.get('LYRICS_SETTINGS_PATH') or os.path.join(os.path.dirname(__file__), 'settings.json')
        if os.path.exists(settings_path):
            with open(settings_path, 'r', encoding='utf-8') as f:
                s = json.load(f)
                preferred_source = s.get("preferred_source", "NetEase")
    except:
        pass

    providers = [preferred_source]
    for p in ["NetEase", "Lrclib", "Musixmatch", "Megalobiz"]:
        if p != preferred_source and p not in providers:
            providers.append(p)
    
    if return_all:
        # 獲取所有可能的備用歌詞列表
        results = []
        qq_lyric, _ = fetch_qqmusic(title, artist)
        if qq_lyric:
            results.append({"lyrics": qq_lyric, "source": "QQMusic"})
            
        queries = generate_queries(title, artist)
        for p in providers:
            for q_title, q_artist in queries:
                query = f"{q_title} {q_artist}"
                lyric = fetch_single_provider(query, p)
                if lyric:
                    results.append({"lyrics": lyric, "source": p})
                    break # 找到該平台的一個結果即可，跳出 query 迴圈
                    
        if len(results) == 0:
            try:
                itunes_url = "https://itunes.apple.com/search"
                params = {"term": f"{title} {artist}", "entity": "song", "limit": 1, "country": "jp"}
                resp = requests.get(itunes_url, params=params, timeout=5)
                if resp.status_code == 200:
                    it_results = resp.json().get("results", [])
                    if it_results:
                        jp_title = it_results[0].get("trackName", title)
                        jp_artist = it_results[0].get("artistName", artist)
                        if jp_title != title or jp_artist != artist:
                            it_queries = generate_queries(jp_title, jp_artist)
                            for p in providers:
                                for q_title, q_artist in it_queries:
                                    query = f"{q_title} {q_artist}"
                                    lyric = fetch_single_provider(query, p)
                                    if lyric:
                                        results.append({"lyrics": lyric, "source": f"iTunes_Fallback({p})"})
                                        break
            except:
                pass
                
        print(json.dumps({"success": True, "results": results}))
        return

    # 預設行為：先嘗試 QQMusic，失敗再嘗試 syncedlyrics 預設的平台
    try:
        lyric, source = fetch_qqmusic(title, artist)
        
        if not lyric:
            queries = generate_queries(title, artist)
            for q_title, q_artist in queries:
                query = f"{q_title} {q_artist}"
                lyric = syncedlyrics.search(query, providers=providers)
                if lyric:
                    source = "NetEase"
                    break
        if not lyric:
            try:
                itunes_url = "https://itunes.apple.com/search"
                params = {"term": f"{title} {artist}", "entity": "song", "limit": 1, "country": "jp"}
                resp = requests.get(itunes_url, params=params, timeout=5)
                if resp.status_code == 200:
                    results = resp.json().get("results", [])
                    if results:
                        jp_title = results[0].get("trackName", title)
                        jp_artist = results[0].get("artistName", artist)
                        if jp_title != title or jp_artist != artist:
                            query = f"{jp_title} {jp_artist}"
                            lyric = syncedlyrics.search(query, providers=providers)
                            if lyric:
                                source = "iTunes_Fallback"
            except:
                pass
            
        if lyric:
            print(json.dumps({"success": True, "lyrics": lyric, "source": source}))
        else:
            print(json.dumps({"success": False, "error": "Not found"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
