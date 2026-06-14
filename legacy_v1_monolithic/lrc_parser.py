import sys
import re
import json

def parse_lrc(lrc_text):
    pattern = re.compile(r'\[(\d{2}):(\d{2}(?:[\.:]\d{1,3})?)\](.*)')
    has_time_tags = bool(re.search(r'\[\d{2}:\d{2}', lrc_text))
    
    source_provider = ""
    parsed_lines = []
    
    for line in lrc_text.split('\n'):
        line = line.strip()
        if not line:
            continue
            
        if line.startswith("[source:"):
            source_provider = line[8:-1]
            continue
            
        match = pattern.match(line)
        if match:
            m, s, text = match.groups()
            s = s.replace(':', '.')
            seconds = int(m) * 60 + float(s)
            text = text.strip()
        elif not has_time_tags:
            seconds = -1.0
            text = line
        else:
            text = ""
            
        if text:
            if "#TITLE#" in text:
                continue
            parsed_lines.append({"seconds": seconds, "text": text, "translation": None})
            
    # Sort and merge translations
    if has_time_tags:
        parsed_lines.sort(key=lambda x: x["seconds"])
        merged_lines = []
        for item in parsed_lines:
            if merged_lines and abs(item["seconds"] - merged_lines[-1]["seconds"]) < 0.05:
                if not merged_lines[-1]["translation"]:
                    merged_lines[-1]["translation"] = item["text"]
                else:
                    merged_lines[-1]["translation"] += " / " + item["text"]
            else:
                merged_lines.append(item)
        parsed_lines = merged_lines
        
    return {
        "source": source_provider,
        "lines": parsed_lines
    }

if __name__ == "__main__":
    raw_lrc = sys.stdin.read()
    parsed = parse_lrc(raw_lrc)
    print(json.dumps(parsed, ensure_ascii=False))
