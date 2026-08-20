#!/usr/bin/env python3
"""Generate the four bundled virtual-background images.

The artwork is generated rather than sourced, so there is nothing to license
and the result is reproducible from this file alone. Everything is deliberately
soft and low-contrast: a background that competes with the person in front of
it is a worse background.

    pip install Pillow
    python3 resources/make-backgrounds.py

Writes 1280x720 WebP into src/assets/backgrounds/.
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1280, 720
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'backgrounds')


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vertical_gradient(stops):
    """stops: [(position 0..1, (r, g, b)), ...] sorted by position."""
    img = Image.new('RGB', (1, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        lo, hi = stops[0], stops[-1]
        for i in range(len(stops) - 1):
            if stops[i][0] <= t <= stops[i + 1][0]:
                lo, hi = stops[i], stops[i + 1]
                break
        span = (hi[0] - lo[0]) or 1
        px[0, y] = lerp(lo[1], hi[1], (t - lo[0]) / span)
    return img.resize((W, H), Image.BILINEAR)


def add_glow(img, cx, cy, radius, color, strength):
    """Screen-blend a soft radial glow over img."""
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)
    glow = glow.filter(ImageFilter.GaussianBlur(radius * 0.55))
    base, over = img.load(), glow.load()
    for y in range(0, H):
        for x in range(0, W):
            b, o = base[x, y], over[x, y]
            base[x, y] = tuple(
                min(255, int(b[i] + o[i] * strength)) for i in range(3)
            )
    return img


def grain(img, amount, seed):
    """A trace of noise — flat gradients band badly once a codec gets hold of them."""
    rnd = random.Random(seed)
    px = img.load()
    for y in range(H):
        for x in range(W):
            n = rnd.randint(-amount, amount)
            r, g, b = px[x, y]
            px[x, y] = (
                max(0, min(255, r + n)),
                max(0, min(255, g + n)),
                max(0, min(255, b + n)),
            )
    return img


def aurora():
    img = vertical_gradient([
        (0.0, (14, 22, 48)),
        (0.45, (18, 46, 78)),
        (1.0, (10, 28, 44)),
    ])
    img = add_glow(img, 300, 180, 460, (46, 152, 168), 0.55)
    img = add_glow(img, 980, 420, 520, (86, 62, 150), 0.42)
    img = add_glow(img, 640, 700, 400, (30, 110, 130), 0.25)
    img = img.filter(ImageFilter.GaussianBlur(28))
    return grain(img, 2, 1)


def dusk():
    img = vertical_gradient([
        (0.0, (58, 38, 74)),
        (0.5, (128, 66, 78)),
        (1.0, (196, 118, 78)),
    ])
    img = add_glow(img, 900, 560, 520, (210, 140, 80), 0.45)
    img = add_glow(img, 240, 140, 400, (90, 60, 120), 0.35)
    img = img.filter(ImageFilter.GaussianBlur(32))
    return grain(img, 2, 2)


def studio():
    img = vertical_gradient([
        (0.0, (58, 60, 66)),
        (0.6, (42, 44, 50)),
        (1.0, (26, 27, 32)),
    ])
    img = add_glow(img, 640, 300, 620, (150, 152, 160), 0.30)
    img = img.filter(ImageFilter.GaussianBlur(24))
    return grain(img, 2, 3)


def linen():
    img = vertical_gradient([
        (0.0, (238, 234, 226)),
        (0.55, (226, 220, 210)),
        (1.0, (206, 199, 188)),
    ])
    # A faint diagonal weave, then blurred until it is only a texture.
    weave = Image.new('L', (W, H), 128)
    d = ImageDraw.Draw(weave)
    for i in range(-H, W, 9):
        d.line([(i, 0), (i + H, H)], fill=142, width=2)
    for i in range(-H, W, 13):
        d.line([(i + H, 0), (i, H)], fill=116, width=1)
    weave = weave.filter(ImageFilter.GaussianBlur(1.6))
    base, wv = img.load(), weave.load()
    for y in range(H):
        for x in range(W):
            delta = (wv[x, y] - 128) * 0.22
            r, g, b = base[x, y]
            base[x, y] = (
                max(0, min(255, int(r + delta))),
                max(0, min(255, int(g + delta))),
                max(0, min(255, int(b + delta))),
            )
    img = add_glow(img, 520, 220, 560, (40, 36, 30), 0.10)
    img = img.filter(ImageFilter.GaussianBlur(6))
    return grain(img, 2, 4)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (('aurora', aurora), ('dusk', dusk),
                     ('studio', studio), ('linen', linen)):
        path = os.path.join(OUT, name + '.webp')
        fn().save(path, 'WEBP', quality=82, method=6)
        print('%-10s %6.1f KB' % (name, os.path.getsize(path) / 1024.0))


if __name__ == '__main__':
    main()
