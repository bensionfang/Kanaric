import sys
import json
import logging
import syncedlyrics
import requests
import base64

def fetch_qqmusic(title, artist):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://y.qq.com/"
    }
    search_url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
    params = {"p": 1, "n": 3, "w": f"{title} {artist}", "format": "json"}
    try:
        resp = requests.get(search_url, params=params, headers=headers, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            songs = data.get("data", {}).get("song", {}).get("list", [])
            if not songs: return None, None
            
            best_song = songs[0]
            songmid = best_song.get("songmid")
            if not songmid: return None, None
            
            lyric_url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"
            l_params = {"songmid": songmid, "format": "json", "nobase64": 0}
            l_resp = requests.get(lyric_url, params=l_params, headers=headers, timeout=5)
            
            if l_resp.status_code == 200:
                l_data = l_resp.json()
                lyric_b64 = l_data.get("lyric", "")
                if lyric_b64:
                    lyric_text = base64.b64decode(lyric_b64).decode("utf-8", errors="ignore")
                    return lyric_text, "QQMusic"
    except Exception as e:
        pass
    return None, None

def fetch_single_provider(query, provider):
    try:
        return syncedlyrics.search(query, providers=[provider])
    except:
        return None

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Missing title or artist"}))
        return
        
    title = sys.argv[1]
    artist = sys.argv[2]
    return_all = len(sys.argv) > 3 and sys.argv[3] == "--all"
    
    query = f"{title} {artist}"
    
    if return_all:
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

    try:
        lyric, source = fetch_qqmusic(title, artist)
        
        if not lyric:
            query = f"{title} {artist}"
            lyric = syncedlyrics.search(query, providers=["NetEase", "Musixmatch", "Megalobiz"])
            source = "NetEase" # rough approximation for UI
            
        if lyric:
            print(json.dumps({"success": True, "lyrics": lyric, "source": source}))
        else:
            print(json.dumps({"success": False, "error": "Not found"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
