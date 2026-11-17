"""Draw Ebb's toolbar icons: a teal rounded square with a white wave.

Usage: python3 scripts/make-icons.py   (needs Pillow)
Writes extension/icons/icon{16,32,48,128}.png and docs/icon.png.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TEAL = (15, 118, 110, 255)
TEAL_LIGHT = (20, 184, 166, 255)
WHITE = (255, 255, 255, 255)
SCALE = 8  # draw large, then downsample for smooth edges


def wave_points(size, y_center, amplitude, periods, margin):
    points = []
    steps = 600
    for i in range(steps + 1):
        t = i / steps
        x = margin + t * (size - 2 * margin)
        y = y_center - amplitude * math.sin(t * periods * 2 * math.pi)
        points.append((x, y))
    return points


def brush(d, points, width, color):
    """Stamp a round brush along the path: smooth caps and joins at any size."""
    r = width / 2
    for x, y in points:
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw(size):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(big * 0.24)
    # Vertical gradient from light teal to teal inside a rounded square.
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    gradient = Image.new("RGBA", (big, big))
    gd = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / (big - 1)
        color = tuple(int(TEAL_LIGHT[i] * (1 - t) + TEAL[i] * t) for i in range(3)) + (255,)
        gd.line([(0, y), (big, y)], fill=color)
    img.paste(gradient, (0, 0), mask)

    # Small sizes get one bold wave; larger ones a second, fainter one (the tide going out).
    width = big * (0.13 if size <= 16 else 0.105)
    margin = big * 0.21
    brush(d, wave_points(big, big * 0.47, big * 0.075, 1.0, margin), width, WHITE)
    if size >= 32:
        brush(d, wave_points(big, big * 0.69, big * 0.05, 1.0, margin * 1.3), width * 0.6, (255, 255, 255, 150))
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = ROOT / "extension" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        draw(size).save(out / f"icon{size}.png")
    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    draw(256).save(docs / "icon.png")
    print("wrote", ", ".join(f"icon{s}.png" for s in (16, 32, 48, 128)), "and docs/icon.png")


if __name__ == "__main__":
    main()
