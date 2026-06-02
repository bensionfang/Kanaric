import sys
import json
import logging
import syncedlyrics

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Missing title or artist"}))
        return
        
    title = sys.argv[1]
    artist = sys.argv[2]
    
    try:
        query = f"{title} {artist}"
        # Specify multiple providers for comprehensive search
        lyric = syncedlyrics.search(query, providers=["Musixmatch", "NetEase", "Megalobiz"])
        
        if lyric:
            print(json.dumps({"success": True, "lyrics": lyric}))
        else:
            print(json.dumps({"success": False, "error": "Not found"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
