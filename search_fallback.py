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

# QQ 音樂歌詞由 cn_music.py 的 musicu.fcg 端點處理,這裡不再自行抓 QQ。

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

    # syncedlyrics 只認得這幾家;Kugou / QQMusic 由我們自己的 client 處理,別塞進來白跑一輪
    supported = ["NetEase", "Lrclib", "Musixmatch", "Megalobiz"]
    providers = [preferred_source] if preferred_source in supported else []
    for p in supported:
        if p not in providers:
            providers.append(p)
    
    if return_all:
        # 獲取所有可能的備用歌詞列表
        results = []
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

    # 預設行為：透過 syncedlyrics 支援的平台搜尋 (QQ 由 cn_music.py 處理)
    try:
        lyric, source = None, None
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
