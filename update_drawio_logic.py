import xml.etree.ElementTree as ET

file_path = "C:\\Users\\USER\\Desktop\\Floating-Lyrics\\流程圖.drawio"
tree = ET.parse(file_path)
root = tree.getroot()

# Find the specific diagram root that contains 'back2'
mx_root = None
for diagram in root.findall('.//diagram'):
    graph_model = diagram.find('mxGraphModel')
    if graph_model is not None:
        r = graph_model.find('root')
        if r is not None:
            # check if back2 exists in this root
            has_back2 = False
            for cell in r.findall('mxCell'):
                if cell.get('id') == 'back2':
                    has_back2 = True
                    break
            if has_back2:
                mx_root = r
                break

if mx_root is None:
    print("Error: Could not find the root containing back2")
    exit(1)

# 1. Modify d2_fetch
for cell in mx_root.findall('mxCell'):
    if cell.get('id') == 'd2_fetch':
        cell.set('value', '向外部 API (Lrclib) 抓取歌詞<br>並寫入資料庫')

# 2. Add d2_cachecheck (parent="back2")
cachecheck = ET.Element('mxCell', {
    'id': 'd2_cachecheck',
    'parent': 'back2',
    'style': 'rhombus;whiteSpace=wrap;html=1;fontStyle=1;fillColor=#00838F;strokeColor=#FFFFFF;strokeWidth=2;fontColor=#FFFFFF;shadow=1;rounded=1;',
    'value': '檢查 SQLite<br>是否有歌詞快取？',
    'vertex': '1'
})
geo1 = ET.SubElement(cachecheck, 'mxGeometry', {'x': '20', 'y': '20', 'width': '180', 'height': '80', 'as': 'geometry'})
mx_root.append(cachecheck)

# 3. Add d2_cachehit (parent="back2")
cachehit = ET.Element('mxCell', {
    'id': 'd2_cachehit',
    'parent': 'back2',
    'style': 'whiteSpace=wrap;html=1;fontStyle=1;fillColor=#E65100;strokeColor=#FFFFFF;strokeWidth=2;fontColor=#FFFFFF;shadow=1;rounded=1;',
    'value': '直接使用資料庫快取<br>(0 延遲直出)',
    'vertex': '1'
})
geo2 = ET.SubElement(cachehit, 'mxGeometry', {'x': '20', 'y': '120', 'width': '180', 'height': '60', 'as': 'geometry'})
mx_root.append(cachehit)

# 4. Remove e2_7
for cell in mx_root.findall('mxCell'):
    if cell.get('id') == 'e2_7':
        mx_root.remove(cell)

# Edge styling
edge_style = "edgeStyle=orthogonalEdgeStyle;html=1;labelBorderColor=none;strokeColor=#999999;strokeWidth=2;fontColor=#FF0000;labelBackgroundColor=#FFFFFF;"

def add_edge(id_val, source, target, value):
    edge = ET.Element('mxCell', {
        'id': id_val,
        'parent': '1',
        'edge': '1',
        'source': source,
        'target': target,
        'style': edge_style,
        'value': value
    })
    geo = ET.SubElement(edge, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
    ET.SubElement(geo, 'mxPoint', {'x': '0', 'y': '0', 'as': 'sourcePoint'})
    ET.SubElement(geo, 'mxPoint', {'x': '0', 'y': '0', 'as': 'targetPoint'})
    mx_root.append(edge)

# 5-11. Add new edges
add_edge('e2_webapp_check', 'd2_webapp', 'd2_cachecheck', '主動呼叫 /api/lyrics/fetch')
add_edge('e2_check_fetch', 'd2_cachecheck', 'd2_fetch', '否 (查無資料)')
add_edge('e2_check_hit', 'd2_cachecheck', 'd2_cachehit', '是 (快取命中)')
add_edge('e2_node_webapp', 'd2_node', 'd2_webapp', '第二路：WebSocket 廣播新狀態')
add_edge('e2_fetch_webapp', 'd2_fetch', 'd2_webapp', '抓取後觸發 WebSocket 廣播')
add_edge('e2_hit_island', 'd2_cachehit', 'd2_island', '瞬間觸發 WebSocket 廣播')
add_edge('e2_hit_webapp', 'd2_cachehit', 'd2_webapp', '瞬間觸發 WebSocket 廣播')

tree.write(file_path, encoding='utf-8', xml_declaration=False)
print("Drawio logic updated correctly!")
