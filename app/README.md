# Dead Reckoning — RoboSub Pool Layout Editor

Fresh implementation of the dead-reckoning tool per [`../SPEC.md`](../SPEC.md): a top-down 2D
editor of the Woollett 50 m pool for placing the AprilTag (map origin) and the task props,
reading/writing the team's real `riptide_mapping` `config.yaml`.

Built as a web app (SPEC §9, option 2): **PixiJS (WebGL)** retained-GPU canvas +
**React/zustand** UI + **eemeli `yaml`** for the comment-preserving config round-trip, served
by Vite with a tiny localhost file API for config/sidecar/CSV I/O.

## Run (browser dev server)

```sh
nvm use          # needs Node ≥ 18 (a .nvmrc pinning 22 is provided)
npm install
npm run dev      # → http://localhost:5173
```

The default config
(`~/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml`)
auto-loads on startup when present, together with its viz state.

## Run (desktop app — Tauri)

The same frontend ships as a native desktop app via [Tauri](https://tauri.app) 2
(`src-tauri/`). Sprites and the UI are baked into the binary; `config.yaml` stays an
external file opened/saved through native file dialogs.

One-time setup — Rust plus, on Ubuntu, the WebKitGTK stack:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # any platform
# Ubuntu only:
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
                 libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

(macOS needs only the Xcode command-line tools; Windows needs the VS C++ Build Tools —
WebView2 is preinstalled on Windows 10/11. Same commands below on all three.)

```sh
npm run tauri:dev     # dev app (starts vite itself; hot-reloads the frontend)
npm run tauri:build   # release bundles → src-tauri/target/release/bundle/
                      #   Ubuntu: .deb / .rpm / .AppImage · macOS: .app / .dmg · Windows: .msi / .exe
```

How the desktop runtime differs from the browser (all switching lives in `src/api.ts`,
which picks Tauri commands vs the dev-server HTTP API at runtime):

- **File dialogs are native** (`tauri-plugin-dialog`); the browser build keeps the
  in-app path prompt.
- **File access** goes through three tiny Rust commands (`src-tauri/src/lib.rs`),
  restricted to `$HOME` and `/tmp` — the same policy as the dev server's API.
- **Settings live with the app.** UI settings (theme, panel layout, checkboxes) persist
  in the WebView's localStorage under the app identifier; per-config viz state
  (hidden/locked items, colors, footprints, tag placement, lines) is stored in the
  app-data dir (`~/.local/share/edu.osu.uwrt.deadreckoning/state/` on Linux) instead of
  a sidecar file next to the config — nothing is written into the external config's
  directory. Legacy `<config>.dr_viz.json` sidecars are still read as a fallback.
- **Closing with unsaved changes** asks for confirmation via a native dialog.

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

## Tool-only state (viz state)

Lock/hide, colors, footprints, mesh assignment, the AprilTag placement and the line layout are
persisted per config, in the PySide6-prototype-compatible sidecar format: the desktop app keeps
it in its app-data dir (keyed by config path; legacy `<config>.dr_viz.json` sidecars are read
as a fallback), the browser build writes `<config>.dr_viz.json` next to the config. It never
blocks a config save. On config load, every object whose parent ≠ map starts **locked**
(immovable *and* click-through — e.g. the table never swallows clicks meant for the small
props on it); the saved viz state then overrides with saved choices. Locked/hidden objects
remain selectable and editable via the objects list.

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

## Packaging (SPEC §2.4)

Done via Tauri — see *Run (desktop app)* above. The renderer/UI is plain web; the only
native surface is `src/api.ts` (env/read/write/viz-state/dialogs), backed by
`server/fsApi.ts` in the browser and `src-tauri/src/lib.rs` on desktop. App icons are
generated from a single source PNG with `npx tauri icon` (committed under
`src-tauri/icons/`).
