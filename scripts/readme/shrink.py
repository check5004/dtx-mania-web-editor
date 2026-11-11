# README の画面写真を軽くする（256 色の PNG。見た目はほぼ同じで 1/3 ほどの大きさになる）。Pillow が要る。
# 使い方: python3 scripts/readme/shrink.py [入力フォルダ（既定 .readme-demo/shots）] [出力フォルダ（既定 docs/readme/shots）]
# iPad・iPhone の 1 枚ずつの写真は devices.png にまとめたので入れない。
import os
import sys

from PIL import Image

root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, '.readme-demo', 'shots')
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, 'docs', 'readme', 'shots')
SKIP = {'ipad.png', 'iphone.png', 'iphone-pad.png'}
os.makedirs(dst, exist_ok=True)
for name in sorted(os.listdir(src)):
    if not name.endswith('.png') or name in SKIP:
        continue
    im = Image.open(os.path.join(src, name))
    alpha = im.mode in ('RGBA', 'LA') or 'transparency' in im.info
    im = im.convert('RGBA' if alpha else 'RGB')
    q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE if alpha else Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    out = os.path.join(dst, name)
    q.save(out, optimize=True)
    print(f'{name}: {os.path.getsize(os.path.join(src, name)) // 1024} KB → {os.path.getsize(out) // 1024} KB')
