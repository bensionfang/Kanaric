import sys

def modify():
    with open('main.py', 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    start_idx = -1
    end_idx = -1
    
    for i, line in enumerate(lines):
        if line.startswith("# ================= 3. 媒體擷取 ================="):
            start_idx = i
        elif line.startswith("# ================= 5. 事件穿透捲動區塊 ================="):
            end_idx = i
            break
            
    if start_idx != -1 and end_idx != -1:
        new_lines = lines[:start_idx] + lines[end_idx:]
        with open('main.py', 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        print("Success")
    else:
        print(f"Failed. start: {start_idx}, end: {end_idx}")

modify()
