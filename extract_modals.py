import re
import os

with open('old_index.ejs', 'r', encoding='utf-16le') as f:
    content = f.read()

# The lyrics-options-modal
m1 = re.search(r'<div id="lyrics-options-modal" class="modal-overlay hidden">.*?</div>\s*</div>\s*</div>', content, re.DOTALL)
if m1:
    os.makedirs('web-app/views/modals', exist_ok=True)
    with open('web-app/views/modals/lyrics-options.ejs', 'w', encoding='utf-8') as f:
        f.write(m1.group(0))
else:
    print("Could not find lyrics-options-modal")

# The ruby-edit-modal
m2 = re.search(r'<div id="ruby-edit-modal" class="modal-overlay hidden">.*?</div>\s*</div>', content, re.DOTALL)
if m2:
    os.makedirs('web-app/views/modals', exist_ok=True)
    with open('web-app/views/modals/ruby-edit.ejs', 'w', encoding='utf-8') as f:
        f.write(m2.group(0))
else:
    print("Could not find ruby-edit-modal")

print('Modals extracted!')
