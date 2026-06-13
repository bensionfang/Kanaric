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
    
    if return_all:
        # 獲取所有可能的備用歌詞列表
        results = []
        qq_lyric, _ = fetch_qqmusic(title, artist)
        if qq_lyric:
            results.append({"lyrics": qq_lyric, "source": "QQMusic"})
        for p in ["Musixmatch", "NetEase", "Megalobiz", "Lrclib"]:
            lyric = fetch_single_provider(query, p)
            if lyric:
                results.append({"lyrics": lyric, "source": p})
        print(json.dumps({"success": True, "results": results}))
        return

    # 預設行為：先嘗試 QQMusic，失敗再嘗試 syncedlyrics 預設的平台
    try:
        lyric, source = fetch_qqmusic(title, artist)
        
        if not lyric:
            query = f"{title} {artist}"
            lyric = syncedlyrics.search(query, providers=["NetEase", "Musixmatch", "Megalobiz"])
            source = "NetEase" # 粗略地假設為網易雲
            
        if lyric:
            print(json.dumps({"success": True, "lyrics": lyric, "source": source}))
        else:
            print(json.dumps({"success": False, "error": "Not found"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
