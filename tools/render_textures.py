#!/usr/bin/env python3
"""Build clean top-down sprites from the DAE task-graphic textures.

Some task props carry their real graphic on a face that reads clearly from
straight overhead (the table pill/bandage/etc. and the bin fire/blood vinyls).
For those we prefer the actual texture PNG over the gray silhouette. This trims
each texture, knocks out its white background, pads it to a square so the icon
stays undistorted, and writes it to app/public/topdown/tex/, then records the
sprite + its square footprint (from the model XY bbox) into manifest.json.

Run after render_topdowns.py:
    python3 tools/render_textures.py
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MESH_ROOT = Path(
    "/home/ubuntu/osu-uwrt/release/src/riptide_gui/riptide_meshes/meshes"
)
OUT = ROOT / "app" / "public" / "topdown"
TEX = OUT / "tex"

# mesh dir -> single texture file (config objects resolve to these dirs)
TEXTURE_SPRITES = {
    "table_pill": "Task5_Pill_Fixed.png",
    "table_bandage": "Task5_BandAid_Fixed.png",
    "table_nut_and_bolt": "Task5_NutBolt_Fixed.png",
    "table_plug": "Task5_Electric_Fixed.png",
    "table_basket_warning": "Task5_Warning_Fixed.png",
    "table_basket_helmet": "Task5_RedCross_Fixed.png",
}
# mesh dir -> {class: texture file}; the vinyl class (fire/blood) is set per run
TEXTURE_BY_CLASS = {
    "bin_vinyl": {"fire": "Task3_Fire_Fixed.png", "blood": "Task3_Blood_Fixed.png"},
}


def knockout_white(im: Image.Image) -> Image.Image:
    """RGBA image with near-white, low-saturation pixels made transparent."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            mn, mx = min(r, g, b), max(r, g, b)
            if a and mn >= 235 and (mx - mn) <= 14:  # bright + gray => background
                px[x, y] = (r, g, b, 0)
    return im


def trim_and_square(im: Image.Image) -> Image.Image:
    bbox = im.getbbox()  # non-transparent bounds
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2))
    return canvas


def square_half_extent(bbox: list[float]) -> float:
    x0, x1, y0, y1 = bbox
    return max(abs(x0), abs(x1), abs(y0), abs(y1))


def process(src: Path, dst: Path) -> bool:
    if not src.exists():
        print(f"  MISSING {src}")
        return False
    trim_and_square(knockout_white(Image.open(src))).save(dst)
    return True


def main() -> int:
    if not OUT.exists():
        print("run render_topdowns.py first (public/topdown missing)", file=sys.stderr)
        return 1
    TEX.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((OUT / "manifest.json").read_text())

    for mesh, texfile in TEXTURE_SPRITES.items():
        entry = manifest.get(mesh)
        if not entry:
            continue
        dst = TEX / f"{mesh}.png"
        if process(MESH_ROOT / mesh / texfile, dst):
            entry["tex"] = f"tex/{mesh}.png"
            entry["texSquare"] = round(square_half_extent(entry["bbox"]), 6)
            print(f"  ok   {mesh}  <- {texfile}")

    for mesh, by_class in TEXTURE_BY_CLASS.items():
        entry = manifest.get(mesh)
        if not entry:
            continue
        entry["texByClass"] = {}
        for cls, texfile in by_class.items():
            dst = TEX / f"{mesh}__{cls}.png"
            if process(MESH_ROOT / mesh / texfile, dst):
                entry["texByClass"][cls] = f"tex/{mesh}__{cls}.png"
                print(f"  ok   {mesh} [{cls}]  <- {texfile}")
        entry["texSquare"] = round(square_half_extent(entry["bbox"]), 6)

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"updated {OUT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
