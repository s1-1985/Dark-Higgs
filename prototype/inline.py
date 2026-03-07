import re
with open('index.html', 'r', encoding='utf-8') as f:
    h = f.read()
with open('game.js', 'r', encoding='utf-8') as f:
    j = f.read()
h = re.sub(r'<script src="game\.js"></script>', '<script>\n' + j + '\n</script>', h)
with open('index.html', 'w', encoding='utf-8') as f:
    f.write(h)
