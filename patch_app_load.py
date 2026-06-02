import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add document.addEventListener('DOMContentLoaded', loadSettings); at the bottom of the file
if 'document.addEventListener(\'DOMContentLoaded\', loadSettings);' not in text:
    text += "\ndocument.addEventListener('DOMContentLoaded', loadSettings);\n"

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
