from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
out.mkdir(exist_ok=True)
for size in (16, 32, 48, 128):
    scale = 4
    s = size * scale
    image = Image.new('RGBA', (s, s))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * .25, fill='#286b56')
    # A single folded leaf; supersampling preserves the small toolbar silhouette.
    points = [(s * .25, s * .67), (s * .23, s * .49), (s * .35, s * .32), (s * .54, s * .24), (s * .77, s * .23), (s * .77, s * .44), (s * .69, s * .64), (s * .52, s * .76), (s * .34, s * .75)]
    draw.polygon(points, fill='#edf5e8')
    draw.line([(s * .24, s * .79), (s * .62, s * .40)], fill='#b5d1aa', width=max(2, int(s * .048)))
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / f'icon{size}.png')
print('Generated 4 extension icons.')
