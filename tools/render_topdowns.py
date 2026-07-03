#!/usr/bin/env python3
"""Pre-render every riptide_meshes model.dae to a transparent top-down PNG.

Reuses the proven pipeline from the reference implementation
(dead_reckoning.py: render_dae_topdown / ensure_topdown, cached in
~/.cache/dead_reckoning/topdown) and copies the results into the web app's
static assets: app/public/topdown/<dir>.png + manifest.json with the model XY
bounding boxes (meters, origin at model 0,0).

Run whenever meshes change:
    python3 tools/render_topdowns.py
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dead_reckoning import MESH_ROOT_DEFAULT, ensure_topdown  # noqa: E402

OUT = ROOT / "app" / "public" / "topdown"


def main() -> int:
    mesh_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(MESH_ROOT_DEFAULT)
    if not mesh_root.exists():
        print(f"mesh root not found: {mesh_root}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for d in sorted(mesh_root.iterdir()):
        if not d.is_dir() or not (d / "model.dae").exists():
            continue
        res = ensure_topdown(d)
        if not res:
            print(f"  skip {d.name} (render failed)")
            continue
        png, bbox = res
        shutil.copyfile(png, OUT / f"{d.name}.png")
        manifest[d.name] = {"bbox": [round(v, 6) for v in bbox]}
        print(f"  ok   {d.name}  bbox={manifest[d.name]['bbox']}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(manifest)} sprites -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
