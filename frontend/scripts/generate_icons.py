"""Build every logo asset from the gym's logo (brand/xavion-logo.png: white artwork on black).

    uv run --with pillow python scripts/generate_icons.py      (or: npm run icons)

Writes, in public/:
    icons/icon-192.png, icons/icon-512.png      app icons (the mark on black)
    icons/maskable-512.png                      Android adaptive icon (extra safe-zone padding)
    icons/apple-touch-icon.png                  iPhone home screen (180 px)
    favicon.svg                                 browser tab (the mark, embedded PNG)
    brand/mark.png                              the mark used inside the app (header, login ...)
    brand/logo-dark.png                         full logo, white on transparent (dark screens)
    receipt-logo.jpg                            full logo, black on white (receipts and PDF reports)

Replace brand/xavion-logo.png with a new logo (same style: light artwork on a dark background)
and run this again.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "brand" / "xavion-logo.png"
PUBLIC = ROOT / "public"
INK_THRESHOLD = 60  # brighter than this = artwork


def artwork_box(gray: Image.Image, top: int = 0, bottom: int | None = None) -> tuple[int, int, int, int]:
    region = gray.crop((0, top, gray.width, bottom or gray.height))
    box = region.point(lambda v: 255 if v > INK_THRESHOLD else 0).getbbox()
    if not box:
        raise SystemExit("No artwork found in the logo image.")
    return box[0], box[1] + top, box[2], box[3] + top


def mark_bottom(gray: Image.Image) -> int:
    """The mark sits above the wordmark: the first empty band of rows after the artwork starts."""
    rows = [gray.crop((0, y, gray.width, y + 1)).getextrema()[1] > INK_THRESHOLD for y in range(gray.height)]
    started = False
    for y, on in enumerate(rows):
        if on:
            started = True
        elif started and not any(rows[y:y + 8]):
            return y
    return gray.height


def square_on(mark: Image.Image, size: int, padding: float, background: tuple[int, int, int]) -> Image.Image:
    """The white mark centred on a square of ``background``; ``padding`` = share of the side left empty."""
    inner = round(size * (1 - 2 * padding))
    scale = inner / max(mark.width, mark.height)
    art = mark.resize((max(1, round(mark.width * scale)), max(1, round(mark.height * scale))), Image.LANCZOS)
    tile = Image.new("RGB", (size, size), background)
    white = Image.new("RGB", art.size, (255, 255, 255))
    tile.paste(white, ((size - art.width) // 2, (size - art.height) // 2), art)  # the gray level is the alpha
    return tile


def rounded(tile: Image.Image, radius_share: float) -> Image.Image:
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tile.width - 1, tile.height - 1), radius=round(tile.width * radius_share), fill=255)
    out = tile.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> None:
    gray = Image.open(SOURCE).convert("L")
    black = (0, 0, 0)

    # The mark (symbol only) and the full logo (mark + wordmark).
    mark = gray.crop(artwork_box(gray, 0, mark_bottom(gray)))
    full_box = artwork_box(gray)
    pad = 24
    full = gray.crop((max(0, full_box[0] - pad), max(0, full_box[1] - pad),
                      min(gray.width, full_box[2] + pad), min(gray.height, full_box[3] + pad)))

    (PUBLIC / "icons").mkdir(parents=True, exist_ok=True)
    (PUBLIC / "brand").mkdir(parents=True, exist_ok=True)
    square_on(mark, 192, 0.14, black).save(PUBLIC / "icons" / "icon-192.png", optimize=True)
    square_on(mark, 512, 0.14, black).save(PUBLIC / "icons" / "icon-512.png", optimize=True)
    square_on(mark, 512, 0.24, black).save(PUBLIC / "icons" / "maskable-512.png", optimize=True)  # Android safe zone
    square_on(mark, 180, 0.14, black).save(PUBLIC / "icons" / "apple-touch-icon.png", optimize=True)
    rounded(square_on(mark, 256, 0.12, black), 0.22).save(PUBLIC / "brand" / "mark.png", optimize=True)

    # Full logo: white on transparent (dark screens) and black on white (paper).
    light = Image.new("RGBA", full.size, (255, 255, 255, 0))
    light.putalpha(full)
    width = 720
    light.resize((width, round(full.height * width / full.width)), Image.LANCZOS).save(PUBLIC / "brand" / "logo-dark.png", optimize=True)
    paper = ImageOps.invert(full).point(lambda v: 255 if v > 235 else v)
    paper = paper.resize((640, round(full.height * 640 / full.width)), Image.LANCZOS)
    paper.convert("RGB").save(PUBLIC / "receipt-logo.jpg", "JPEG", quality=90, optimize=True)

    # Favicon: a 64 px rounded tile embedded in an SVG (keeps the existing /favicon.svg links).
    buffer = io.BytesIO()
    rounded(square_on(mark, 64, 0.12, black), 0.22).save(buffer, "PNG", optimize=True)
    data = base64.b64encode(buffer.getvalue()).decode()
    (PUBLIC / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">'
        f'<image width="64" height="64" href="data:image/png;base64,{data}" xlink:href="data:image/png;base64,{data}"/></svg>\n',
        encoding="utf-8",
    )
    print("Logo assets written to", PUBLIC)


if __name__ == "__main__":
    main()
