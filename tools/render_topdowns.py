#!/usr/bin/env python3
"""Pre-render every riptide_meshes model.dae to a transparent top-down PNG.

Reuses the proven pipeline from the reference implementation
(dead_reckoning.py: render_dae_topdown / ensure_topdown, cached in
~/.cache/dead_reckoning/topdown) and copies the results into the web app's
static assets: app/public/topdown/<dir>.png + manifest.json with the model XY
bounding boxes (meters, origin at model 0,0).

The bbox is shifted by the marker pose offset from riptide_rviz's markers.yaml
(e.g. the gate mesh is drawn 1.5 m in -Y of gate_frame), so the manifest bbox
is in FRAME coordinates — the app's pose point matches where RViz/mapping puts
the frame, not the mesh's own origin.

Run whenever meshes change:
    python3 tools/render_topdowns.py [mesh_root] [markers_yaml]
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dead_reckoning import MESH_ROOT_DEFAULT, ensure_topdown  # noqa: E402

OUT = ROOT / "app" / "public" / "topdown"


def markers_yaml_default(mesh_root: Path) -> Path:
    # riptide_gui/riptide_meshes/meshes -> riptide_gui/riptide_rviz/...
    return mesh_root.parents[1] / "riptide_rviz" / "riptide_rviz" / "config" / "markers.yaml"


def marker_offsets(markers_yaml: Path) -> dict:
    """mesh dir -> (dx, dy) offset of the mesh relative to its TF frame, from the
    RViz marker publisher config (pose is xyzrpw; rotations are ignored — every
    marker in the file has rpw = 0)."""
    try:
        import yaml

        data = yaml.safe_load(markers_yaml.read_text())
    except Exception as e:  # missing file / no pyyaml — render without offsets
        print(f"  note: no marker offsets ({markers_yaml}: {e})", file=sys.stderr)
        return {}
    out = {}
    params = (data or {}).get("/**/marker_publisher", {}).get("ros__parameters", {})
    for m in (params.get("markers") or {}).values():
        mesh = m.get("mesh")
        pose = m.get("pose") or []
        if mesh and len(pose) >= 2 and (pose[0] or pose[1]):
            out[mesh] = (float(pose[0]), float(pose[1]))
    return out


def main() -> int:
    mesh_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(MESH_ROOT_DEFAULT)
    if not mesh_root.exists():
        print(f"mesh root not found: {mesh_root}", file=sys.stderr)
        return 1
    markers_yaml = Path(sys.argv[2]) if len(sys.argv) > 2 else markers_yaml_default(mesh_root)
    offsets = marker_offsets(markers_yaml)
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
        dx, dy = offsets.get(d.name, (0.0, 0.0))
        bbox = [bbox[0] + dx, bbox[1] + dx, bbox[2] + dy, bbox[3] + dy]
        manifest[d.name] = {"bbox": [round(v, 6) for v in bbox]}
        off = f"  (marker offset {dx}, {dy})" if dx or dy else ""
        print(f"  ok   {d.name}  bbox={manifest[d.name]['bbox']}{off}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(manifest)} sprites -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
