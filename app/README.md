# Dead Reckoning — RoboSub Pool Layout Editor

Fresh implementation of the dead-reckoning tool per [`../SPEC.md`](../SPEC.md): a top-down 2D
editor of the Woollett 50 m pool for placing the AprilTag (map origin) and the task props,
reading/writing the team's real `riptide_mapping` `config.yaml`.

Built as a web app (SPEC §9, option 2): **PixiJS (WebGL)** retained-GPU canvas +
**React/zustand** UI + **eemeli `yaml`** for the comment-preserving config round-trip, served
by Vite with a tiny localhost file API for config/sidecar/CSV I/O.

## Run

```sh
nvm use          # needs Node ≥ 18 (a .nvmrc pinning 22 is provided)
npm install
npm run dev      # → http://localhost:5173
```

The default config
(`~/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml`)
auto-loads on startup when present, together with its `<config>.dr_viz.json` sidecar.

## Verify

```sh
npm test              # unit: transforms, model, YAML round-trip vs the real config fixture
npm run typecheck
node tests/e2e.mjs    # drives the real app in headless Chromium (needs `npm run dev` running):
                      # load/hierarchy, drag rigidity, rotate handle, lock click-through,
                      # hide, reparent, tag snapping, zoom limits, save/CSV round-trip
```

## Why drags are fast (SPEC §2)

The canvas is a retained GPU scene graph. A drag updates one container transform per moved
object per frame (O(1) in scene size and drag distance) — nothing is re-rasterized on the CPU.
Panels subscribe to the store via memoized selectors, so only the dragged subtree's rows
re-render. Labels are DOM chips repositioned per frame (crisp, constant on-screen size at any
zoom).

## Config round-trip guarantees (SPEC §5)

- Only the `/talos/...` namespace is edited; `/liltank/...` and `prequal_*` are preserved
  untouched (never displayed).
- Saves are applied as **byte-range splices** into the original text: a no-op save is
  **byte-identical**, and editing one pose changes exactly that line (same-line comments
  survive verbatim). The splice result is verified semantically against a full AST rewrite
  and falls back to it for unusual structures.
- Changed/new numbers are always written as YAML floats (`2.0`, never `2`) so ROS 2 param
  type inference stays `double`.
- `tests/config.test.ts` locks all of this against a copy of the real config.

## Top-down sprites

`../tools/render_topdowns.py` renders every `riptide_meshes/*/model.dae` (Z-up, meters) to a
transparent top-down PNG + model-XY bbox using the prototype's proven trimesh/matplotlib
pipeline, into `public/topdown/` (`manifest.json` holds the bboxes). Re-run it when meshes
change. The model origin — not the bbox center — lands on the object's pose point (the gate
extends ~3 m to one side of its point). Name→mesh resolution follows SPEC §6 (exact / strip
digits / unique `_name` suffix / alias table); objects without a mesh render as colored
footprint markers.

`../tools/render_textures.py` (run after the above) prefers the real **task-graphic textures**
for props whose graphic reads from straight overhead: pill, bandage, nut_and_bolt, plug,
warning, helmet, and the bin vinyls. It trims each PNG, knocks out the white background, and
records it in the manifest; textured props render on a centered square footprint so the icon
stays undistorted. `bin_vinyl*` sprites follow the object's **class** (fire ↔ blood), so
swapping classes per run updates the canvas immediately.

## Map origin: AprilTag or robot frame

Two origin modes (segmented control in the Scene inspector; persisted in the sidecar):

- **AprilTag** — origin on a wall at the water line; placement snaps to bottom-line/wall
  intersections; +X faces into the pool (REP-103); ±90° and a fine-tune yaw offset.
- **Robot frame** — for runs where the mapping origin is the sub's start pose: place the
  origin anywhere (no snap), shown with the talos footprint. Drag the marker to move it, drag
  its blue handle (or use the heading field / ±90° buttons) to rotate. The world↔map math is
  identical in both modes; config poses stay authoritative, so objects follow the origin.

## Swaps

With an object selected, the **Swap with sibling** card exchanges poses between two objects
that share a parent (world-preserving even across different parents internally) — e.g. the two
gate sides, or compass/hammer/buoy/sos around the table — and **Swap class** exchanges the
`class` field (bin vinyl fire/blood).

## Tool-only state (viz sidecar)

Lock/hide, colors, footprints, mesh assignment, the AprilTag placement and the line layout are
persisted in `<config>.dr_viz.json` next to the config (format-compatible with the PySide6
prototype). It never blocks a config save. On config load, every object whose parent ≠ map
starts **locked** (immovable *and* click-through — e.g. the table never swallows clicks meant
for the small props on it); the sidecar then overrides with saved choices. Locked/hidden
objects remain selectable and editable via the objects list.

## UI

The canvas is the primary surface (top-down/BEV-first): both sidebars collapse to thin rails
(`[` / `]` or the chevron buttons) and are drag-resizable at their inner edge; widths and
visibility persist in localStorage. Labels have three modes (roots / all / none — selection is
always labeled). **Light and dark themes** (toolbar toggle or the Scene inspector; follows the
OS preference on first run) restyle both the UI and the canvas palette.

## Controls

drag = move (children follow rigidly) · blue handle = rotate · background/middle drag = pan ·
wheel = zoom about cursor (zoom-out clamps at pool ∪ furthest object) · double-click = zoom to
object · `F` fit · arrows = nudge 1 cm (⇧ 10 cm) · `Q`/`E` = rotate 1° (⇧ 15°) · `L` lock ·
`H` hide · `Del` delete · `Esc` deselect/cancel · `[` / `]` toggle the side panels.

## Packaging (SPEC §2.4 — "eventually")

The renderer/UI is plain web; the only native dependency is the file API
(`server/fsApi.ts`, ~60 lines). To ship desktop binaries, wrap `dist/` in **Tauri** and remap
the four calls in `src/api.ts` (env/read/write) to Tauri's `fs`/`path` plugins — no other code
changes. Until then, `npm run dev` (or `vite preview` after a build) serves the tool locally
with full file access.
