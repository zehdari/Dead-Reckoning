# Dead Reckoning Tool — Specification & Build Plan

**Status:** requirements + recommended plan for a fresh implementation.
**Audience:** an engineer/agent implementing this from scratch, free to choose language/framework.
**Working reference implementation:** [`dead_reckoning.py`](dead_reckoning.py) (PySide6 prototype) — treat its _math, config I/O, and mesh logic as ground truth_; do **not** copy its UI. It has a `--selftest` that checks the coordinate transforms.

Requirements are labeled **MUST** (functional, keep exactly), **SHOULD** (strong preference), **MAY** (optional/nice-to-have). Per the product owner: **preserve all functional requirements; UI/UX specifics are flexible as long as functionality is maintained.**

---

## 1. What this tool is

A desktop app for the OSU Underwater Robotics Team (RoboSub 2026, at Woollett Aquatics Center). Before/at a competition, people ("reckoners") measure where task props physically sit in the pool and produce a **map of object poses** that the robot's `riptide_mapping` node loads as its _dead-reckoned_ prior.

The tool is a **top-down 2D editor of the pool**: place an AprilTag (which defines the map origin), drop/drag/rotate task props (or type exact poses), and read out each prop's pose **relative to its parent frame** — which is exactly what the mapping config stores. It loads and saves the team's real `riptide_mapping` `config.yaml`.

### Why the current prototype needs replacing

The prototype works and is functionally complete, but the **top-down canvas looks unpolished and is laggy when dragging props quickly over long distances**. Goal for the rewrite: a canvas that is **professional-looking, fast (60 fps drags anywhere in the pool), and extremely intuitive**, while keeping all functionality below.

---

## 2. Core goals (non-functional) — **MUST**

1. **Fast.** Dragging any prop (with its child sub-tree) across the entire pool at speed must stay smooth (~60 fps), regardless of scene complexity (50+ objects, lane lines, grid, mesh sprites).
2. **Professional & polished** visual design. Clean pool/wall/lane rendering, crisp at any zoom and on HiDPI, readable labels, tasteful theme.
3. **Intuitive.** Everything easy to see and interact with; obvious controls (pan/zoom/drag/rotate/select); minimal chrome; discoverable.
4. **Cross-platform desktop build** for macOS, Windows, and Linux (eventually). Prefer small, signable binaries.
5. **Correct.** Coordinate transforms round-trip to ≤1e-6; config round-trips preserving comments and unrelated keys.

### Root cause of the current lag (so the rewrite avoids it)

The prototype uses Qt `QGraphicsView` with the **software raster** paint engine. On each drag move it repaints the union of the moved item's old+new bounding rects; a fast long-distance drag damages a large region, forcing CPU re-rasterization of the grid, ~25 lane-line rects, and antialiased textured prop sprites every frame → jank. **Fix by construction:** use a **retained GPU scene graph** (WebGL / wgpu / GPU-accelerated view) where moving an object is a transform update uploaded to the GPU, _not_ a CPU re-rasterization of a damaged region. Then drag cost is O(1) in scene size and distance. Also: keep pose math in a plain data model, render on a rAF/vsync loop, and update side panels reactively (diff) rather than rebuilding tables each frame.

---

## 3. Domain: coordinate systems & math — **MUST (get this exact)**

All angles in **degrees**, positive **counter-clockwise (CCW)**, normalized to (−180, 180]. All distances in **meters**. This matches ROS **REP-103** and the mapping config.

### 3.1 Frames

- **Pool frame (world):** origin at a pool corner; **X** along the 50 m length, **Y** along the 22.86 m width, **Z** up. Right-handed, Y-up when viewed top-down (i.e., a standard math plane; do not bake in a screen Y-down convention at the model level).
- **Map frame == AprilTag frame (REP-103):** origin at the AprilTag, which sits **on a wall at the water line** (z = 0). Axes: **+X points from the wall straight into the pool** (the tag's forward/look direction), **+Y is 90° CCW from +X (to the left when facing into the pool)**, **+Z up**. Yaw is CCW about +Z from +X. This convention is **fixed** (no user-selectable convention).
- Each object also defines a child frame named **`<object_name>_frame`** used by its children (see config).

### 3.2 Tag placement geometry

The tag is placed at a **bottom-line / wall intersection** and faces into the pool along the wall's inward normal. With the world frame above (X∈[0,L], Y∈[0,W], Y-up):

| Wall  | Location | Inward-normal heading φ (deg) |
| ----- | -------- | ----------------------------- |
| West  | x = 0    | 0                             |
| East  | x = L    | 180                           |
| South | y = 0    | 90                            |
| North | y = W    | 270                           |

The tag's effective forward heading is `φ = base_wall_normal + yaw_offset` (user can nudge/rotate ±90° and fine-tune). L = 50.0, W = 22.86.

### 3.3 World ↔ map transforms

Let tag pool position be `(Tx, Ty)`, forward `φ` (deg), `c=cos φ`, `s=sin φ`.

```
world_to_map(px, py, pyaw):
    dx = px - Tx;  dy = py - Ty
    mx =  dx*c + dy*s
    my = -dx*s + dy*c
    myaw = normalize(pyaw - φ)
    return (mx, my, myaw)

map_to_world(mx, my, myaw):
    px = Tx + mx*c - my*s
    py = Ty + mx*s + my*c
    pyaw = normalize(myaw + φ)
    return (px, py, pyaw)
```

`normalize(a) = ((a + 180) mod 360) - 180`.

Sanity: a tag on the **west wall** (φ=0) reports an object as `x = distance into the pool`, `y = left offset`.

### 3.4 Parent/child composition (TF tree)

Frames only rotate about the vertical (Z) axis, so composition is a yaw-only rotation + translation, and **z adds**. Object poses in the config are stored **relative to the parent frame**.

```
compose(parent_map=(Px,Py,Pz,Pyaw), child_rel=(x,y,z,yaw)):
    a = radians(Pyaw); c=cos a; s=sin a
    mx = Px + x*c - y*s
    my = Py + x*s + y*c
    mz = Pz + z
    myaw = normalize(Pyaw + yaw)
    return (mx, my, mz, myaw)

decompose(parent_map=(Px,Py,Pz,Pyaw), child_map=(mx,my,mz,myaw)):
    a = radians(Pyaw); c=cos a; s=sin a
    dx = mx - Px; dy = my - Py
    x =  dx*c + dy*s
    y = -dx*s + dy*c
    z = mz - Pz
    yaw = normalize(myaw - Pyaw)
    return (x, y, z, yaw)
```

- An object with `parent == map` has its relative pose == its map-frame pose.
- To draw any object: **compose up the chain** from map to get its map pose, then `map_to_world` to get pool coords, then to screen. (`map` frame == AprilTag frame, so map (x,y,yaw) is exactly tag-relative.)
- To move an object by dragging in the pool: `world_to_map` (keep old z & yaw), then `decompose` against the parent's cached map pose to get the new relative pose; then recompose the object's subtree.

Guard against cycles when composing.

---

## 4. Pool geometry & bottom lines — **MUST**

- **Pool:** 50.000 m (long, world +X) × 25 yd = **22.860 m** (short, world +Y). Depth 7 ft = **2.1336 m** (z only; not needed for top-down interaction but useful context).
- **Bottom lines** (define AprilTag snap points and give visual reference):
  - Family A: lines **parallel to the short side**, spaced along the 50 m length. Default **17** lines, spacing **9 ft = 2.7432 m**, centered.
  - Family B: lines **parallel to the long side**, spaced along the 22.86 m width. Default **8** lines, spacing **9 ft = 2.7432 m**, centered.
  - Line thickness ~10 in = 0.254 m (cosmetic).
  - `centered_positions(dim, count, spacing)`: `span=(count-1)*spacing; start=(dim-span)/2; positions=[start+i*spacing for i in 0..count-1]`.
  - These defaults are approximate ("pretty close") and **SHOULD** be adjustable. A 5 m grid overlay is a **MAY**.
- **AprilTag candidate points** = bottom-line/wall intersections: Family-A lines (at x positions) intersect the south (y=0) & north (y=W) walls; Family-B lines (at y positions) intersect the west (x=0) & east (x=L) walls. Clicking near a wall snaps to the nearest candidate (reject if > ~3 m away).

---

## 5. The `riptide_mapping` config format — **MUST**

**File:** `/home/ubuntu/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml`

Structure (ROS 2 params YAML):

```yaml
/**/riptide_mapping2: # GLOBAL tuning (NOT object placement) — preserve untouched
  ros__parameters:
    cov_limit: 0.01
    k_value: 0.1
    detection_cov_factor: 7.0
    angle_cutoff: 15.0
    distance_limit: 10.0
    confidence_cutoff: 0.2
    quantile: [0.01, 0.99]
    minimum_distance: 1.0
    bin_fit:
      {
        residual_tol_m,
        baseline_tol_m,
        min_baseline_m,
        cov_floor_m2,
        z_consistency_tol_m,
      }

/talos/riptide_mapping2: # ACTIVE robot — this is what the tool edits
  ros__parameters:
    init_data:
      <object_name>:
        parent: map | <parent_object>_frame
        class: <string> # optional (e.g. bin_vinyl* = fire/blood), set per run
        lock_orientation_to_config: true # optional flag
        point_yaw_at_parent: true # optional flag
        covar: { x: <f>, y: <f>, z: <f>, yaw: <f> }
        pose: { x: <f>, y: <f>, z: <f>, yaw: <f-degrees> }
    buffer_size: 60

/liltank/riptide_mapping2: # DEPRECATED — ignore (do not load/edit)
  ...
```

### Rules

- **Only the `/talos/...` namespace is edited.** `/liltank/...` is **DEPRECATED — ignore it** (don't display/edit).
- The objects **`prequal_gate` and `prequal_pole` are DEPRECATED — ignore them** (don't require meshes; don't display).
- `parent: map` → object lives directly in the map/AprilTag frame. `parent: <X>_frame` → pose is relative to object `X` (which must exist). Object `X` implicitly owns frame `X_frame`.
- `pose.yaw` and `covar.yaw` are in **degrees**.
- **Round-trip on save (MUST):** preserve comments, key order, the global `/**/` section, the deprecated namespaces/objects, and any keys the tool doesn't model. Update only `parent/pose/covar/class/flags` for edited objects; add new objects; remove objects the user deleted. → Use a **comment-preserving YAML** approach (e.g. JS `yaml`/eemeli, Python `ruamel.yaml`; in Rust do CST/text-level edits). A naive load→dump that drops comments/reorders is **not acceptable**.

### Talos objects & hierarchy (excluding deprecated prequal)

Roots (`parent: map`): **gate, slalom_parent, torpedo, bin, table**.
Children by parent frame:

- `gate_frame`: gate_rescue, gate_repair
- `slalom_parent_frame`: slalom_front, slalom_middle, slalom_back
- `torpedo_frame`: fire_hole_large, fire_hole_small, blood_hole_large, blood_hole_small
- `bin_frame`: bin_target1, bin_target2, bin_cad_geometry
- `bin_cad_geometry_frame`: magnet_target1, magnet_target2, magnet1, magnet2, bin_vinyl1, bin_vinyl2, bin_vinyl3, bin_vinyl4
- `table_frame`: pill, bandage, nut_and_bolt, plug, helmet, warning, compass, hammer_and_wrench, buoy, sos

Flags in use: `lock_orientation_to_config` (slalom\__, bin_target_, magnet1/2, bin_vinyl\*, table, …), `point_yaw_at_parent` (table items pill/bandage/nut_and_bolt/plug/helmet/warning), `class` (bin_vinyl1..4 = fire/blood). **The tool need not interpret the runtime semantics of these flags** — it must display them, let them be toggled, and preserve them. Composition uses plain TF (translation + yaw) regardless of the flags.

---

## 6. Mesh assets & top-down rendering — **MUST (top-down visuals), method flexible**

**Meshes:** `/home/ubuntu/osu-uwrt/release/src/riptide_gui/riptide_meshes/meshes/<dir>/model.dae` — COLLADA, **Z-up, meters**.
Dirs with a `model.dae`: `bin, bin_magnet, bin_vinyl, gate, gate_repair, gate_rescue, liltank, octagon_buoy, octagon_compass, octagon_hammer_and_wrench, octagon_sos, reefshark, sawfish, slalom, table, table_bandage, table_basket_helmet, table_basket_warning, table_nut_and_bolt, table_pill, table_plug, talos, torpedo`.

**Requirement:** each object SHOULD render as its model's **top-down footprint** (not a generic rectangle), so the layout reads like the real pool. Two acceptable approaches:

1. **3D engine, orthographic top-down camera** (recommended if going 3D): load the real DAE meshes and view straight down. No separate image pipeline; looks great; also enables an optional perspective preview.
2. **Pre-rendered top-down PNG per mesh** (if pure 2D): render each `model.dae` to a transparent top-down image once and cache it; draw it scaled to the model footprint.

**Projection & footprint (both approaches):** Z-up → project to XY; **+X right, +Y up**. Footprint = the model's XY **bounding box**. Critically, **the model's local origin (0,0) is the object's pose point and may be off-center** — e.g. the gate's origin is at one post, so the gate extends ~3 m to one side of its placement point. Place/scale so model origin maps to the object position (store the bbox, not just width/height).

**Name → mesh resolver** (config object name → mesh dir), in priority order:

1. exact: dir == name
2. strip trailing digits: `bin_vinyl1` → `bin_vinyl`
3. unique `_<name>` suffix: `pill`→`table_pill`, `buoy`→`octagon_buoy`, `compass`→`octagon_compass`, `sos`→`octagon_sos`, `plug`→`table_plug`, `warning`→`table_basket_warning`, `helmet`→`table_basket_helmet`, `nut_and_bolt`→`table_nut_and_bolt`, `hammer_and_wrench`→`octagon_hammer_and_wrench`, `bandage`→`table_bandage`
4. alias table: `slalom_parent`→`slalom`; `magnet1/magnet2/magnet_target1/magnet_target2`→`bin_magnet`

Objects with **no** mesh (fine — render as a simple marker): slalom*front/middle/back (covered by the slalom_parent mesh), fire_hole*_, blood*hole*_, bin_target1/2, bin_cad_geometry.

**Colors:** the models are largely untextured plastic and task graphics live on _vertical_ faces (edge-on from above), so **gray/silhouette top-downs are acceptable**. Nice coloring is a **MAY**.

---

## 7. Functional requirements — **MUST unless noted**

1. **Render the pool to scale** — floor, walls, both bottom-line families; 5 m grid (**MAY**).
2. **Place the AprilTag / map origin** by clicking a bottom-line/wall intersection (snap to nearest candidate). Tag sits on the wall, faces into the pool. Provide rotate ±90° and a yaw fine-tune offset. Show its wall, pool position, and forward heading. Convention is fixed REP-103.
3. **Objects, hierarchical (parent/child TF tree).** Add, duplicate, delete, rename. Reparent (via a picker), which **preserves the object's world/pool position** (recompute its relative pose under the new parent). Prevent cycles.
4. **Move/rotate objects:** drag to translate; rotate via a handle/gizmo or modifier-drag; and/or type an exact pose. **Dragging a parent moves its entire subtree rigidly** (children keep their relative poses). Snapping to lane lines/grid/walls is a **MAY**.
5. **Report poses.** For the selected object and in an all-objects list, show pose **relative to parent** (= the config numbers) and also its **map-frame** pose and **pool** position. Live-updating.
6. **Objects list/tree** with the hierarchy, per-object **lock** and **hide** toggles, and pose columns. Selecting in the list selects on canvas and vice-versa. **Hidden objects must remain selectable/editable via the list** (don't tie selection to canvas visibility).
7. **Lock** = _immovable in the canvas AND click-through_ (mouse events pass to whatever is on top). This is so a big flat object (the **table**) can sit under its many small child props and you can always grab the small ones, never the table. Locked objects stay selectable via the list to edit/unlock. **Default on config load: every object whose `parent != map` starts locked** (reckoners position the root task assemblies; children ride along). The viz sidecar overrides this with saved choices.
8. **Hide** per object (removed from canvas, still in the list).
9. **Top-down mesh visuals** per §6, with a name→mesh resolver and footprint/origin handling; render or (re)load lazily and cache.
10. **Load** a `riptide_mapping` config (talos namespace; ignore liltank + prequal). **Auto-load** the default config on startup if present, else start with a few placeholder objects.
11. **Save** the config with comment/order-preserving round-trip (§5).
12. **Viz sidecar:** persist tool-only state that isn't part of the ROS config — per-object footprint/color/image assignment/lock/hide, plus the AprilTag placement and the line layout — in a sidecar next to the config (the prototype uses `<config>.dr_viz.json`). Reload it on load. Never block a config save if the sidecar fails.
13. **Export CSV** of all objects' poses (relative-to-parent + map-frame).
14. **Camera:** pan (drag empty background and/or middle-drag), zoom (wheel, about the cursor) with a **max zoom-out limit** = fit of (pool + small margin) unioned with the bounding box of the furthest object (whichever is larger); zoom-in unbounded; **fit-to-view** action. Smooth.
15. **Labels** legible and **constant on-screen size at every zoom** (don't scale with the world). To avoid clutter, label **root objects** on the canvas by default; child sub-frames are reachable via the list. (These label choices are **SHOULD**, adjust as taste dictates.)
16. **Units:** meters + degrees. Showing feet as a secondary readout is a **MAY**.

---

## 8. Data model (framework-agnostic) — **MUST (fields)**

```
Tag:
    x, y            # pool position (on a wall)
    base_phi        # inward wall-normal heading (deg): W=0,E=180,S=90,N=270
    wall            # 'N'|'S'|'E'|'W'
    yaw_offset      # user fine-tune (deg); effective phi = base_phi + yaw_offset

Object:
    name            # unique; also implicitly names frame "<name>_frame"
    parent          # "map" or another object's name
    x, y, z, yaw    # pose RELATIVE TO PARENT (deg for yaw)
    covar {x,y,z,yaw}
    lock_orientation_to_config  # bool (config flag; preserve)
    point_yaw_at_parent         # bool (config flag; preserve)
    cls             # optional "class" string (preserve)
    # --- tool-only (sidecar, NOT in ROS config) ---
    locked          # immovable + click-through
    hidden          # hidden from canvas
    footprint bbox  # model XY bbox (xmin,xmax,ymin,ymax) for image placement; origin at model 0,0
    color, image ref, image rotation
```

Derived per frame: cache each object's **map pose** (compose up the chain) for O(1) drag decompose and rendering.

---

## 9. Recommended technical approach (the "plan")

The implementer may choose, but here is a strong recommendation with rationale and alternatives, given the goals in §2 (polish + speed + intuitive + cross-platform binaries).

### 9.1 Primary recommendation — Web stack in a native shell

- **Renderer / canvas:** a **GPU 2D/3D web renderer**.
  - **Option 1 (recommended): three.js (WebGL2) with an orthographic top-down camera.** Load the real DAE meshes (three.js `ColladaLoader`) and view straight down for precise 2D interaction; optionally toggle a perspective camera for depth intuition. This gives professional mesh rendering _and_ eliminates a separate top-down-PNG pipeline. Drag = raycast the ground plane; rotate via a gizmo (`TransformControls` or custom). GPU transforms ⇒ silky drags at any distance.
  - **Option 2 (simpler, pure 2D): PixiJS (WebGL 2D).** Draw the pool/lanes and object sprites (pre-rendered top-down PNGs or vector footprints). Very fast and pretty, less code than 3D.
- **App UI (toolbar, inspector, objects tree):** a component framework — **React or Svelte/SolidJS** — with a small state store (e.g. zustand/immer or Svelte stores). This is where "professional & intuitive" is easy to achieve (theming, light/dark, accessible controls).
- **Config YAML:** the **`yaml`** package (eemeli) — preserves comments and supports document/CST editing for a clean round-trip (§5).
- **Packaging:** **Tauri** (Rust-hosted system webview) → small, signable native apps for macOS/Windows/Linux; native file dialogs & fs. (Electron is a heavier fallback.)
- **Why:** best ceiling on polish and UX, GPU rendering kills the drag lag by construction, comment-preserving YAML is first-class in JS, and Tauri yields small cross-platform binaries. Trade-off: it's a rewrite in TypeScript, and DAE meshes must be bundled/served locally.

### 9.2 Alternatives

- **A. Keep Python + PySide6, GPU-accelerate & polish (lowest migration effort).** Set the `QGraphicsView` viewport to a `QOpenGLWidget`; put `DeviceCoordinateCache` on textured items; tune `setViewportUpdateMode`; disable antialiasing during active drags; keep the drag hot-path minimal (already done in the prototype). Package with PyInstaller/Briefcase/Nuitka. Reuses all existing logic; lower polish/packaging ceiling; Python GUI packaging (esp. mac notarization) is fiddly.
- **B. Rust + egui/eframe (wgpu) — single tiny native binary, no webview.** Immediate-mode GUI, extremely fast, trivial cross-compile to one self-contained binary. Draw the canvas via the egui painter or a wgpu layer; DAE via `mesh-loader`/`collada` crates. Downsides: more work for visual polish and especially for **comment-preserving YAML** (no ruamel-equivalent; do CST/text-level edits).
- **C. Other web-native: Konva (2D canvas, easy interactive shapes) or a hand-rolled WebGL layer.** Fine substitutes for PixiJS in Option 2.

### 9.3 2D vs 3D

The task is placing objects at **x, y, yaw** at the water line, so a **top-down orthographic** interaction is the most precise and intuitive and **MUST** be the primary editing mode. Rendering that scene with a 3D engine (Option 1) is a clean way to get professional visuals and reuse the real meshes; a perspective/depth preview is a nice **MAY**. Do **not** make orbit-style 3D the primary interaction.

---

## 10. Suggested build order

1. **Model + transform math** with unit tests: `world_to_map`/`map_to_world`, `compose`/`decompose`, `normalize`, `centered_positions`, tag candidates. Round-trip on all four walls, with yaw offsets, and 2-level parent chains (mirror the prototype's `--selftest`).
2. **Config round-trip** against the real file as a fixture: load talos objects + hierarchy; save and diff — only intended changes, comments/global section/deprecated namespaces preserved.
3. **Static pool render** (floor, lane lines, optional grid) + **camera** (pan, zoom-about-cursor, fit, zoom-out limit).
4. **Objects render + select + inspector** (type exact relative pose; live readouts).
5. **Drag + rotate + parenting** (parent drag moves subtree; reparent preserves world pose). **Verify 60 fps** dragging across the whole pool.
6. **AprilTag placement** (snap to lane/wall intersections) + rotate/offset; all readouts update.
7. **Lock/hide** + default-lock non-map + click-through.
8. **Mesh top-down** (render or load) + name resolver + footprint/origin.
9. **Viz sidecar** persistence.
10. **CSV export.**
11. **Packaging** for mac/win/linux.
12. **Polish pass** (theme, gizmos, labels, keyboard nudges).

---

## 11. Acceptance criteria (concrete, verify each)

- Loading the real config shows all talos objects (excluding prequal; liltank ignored) with the correct hierarchy; **`gate_rescue`'s map pose == `compose(gate_map, gate_rescue_rel)`**.
- Saving produces a diff with **only intended changes**; comments, the `/**/` global section, and deprecated namespaces/objects are preserved.
- **Dragging `gate` across the full pool at speed stays smooth (~60 fps)**; its children follow rigidly; their _relative_ poses are unchanged.
- Reparenting an object leaves its pool position unchanged; its relative pose is recomputed.
- Placing the AprilTag on a lane/wall intersection makes **+X point into the pool**; a **west-wall** placement reports an object at pool `(5, W/2+2)` as **`x≈5` (into pool), `y≈2` (left)**.
- Locking the **table** makes clicks select the small objects on top of it, never the table; it's still selectable/unlockable via the list.
- Hiding an object removes it from the canvas but it stays selectable/editable via the list.
- Assigning meshes shows correct top-down footprints with the model origin at the object position (the gate extends to one side of its point).
- Zoom-out stops at pool+margin/furthest object; labels stay constant on-screen size; pan works by dragging empty space.
- Transform round-trip tests pass to ≤1e-6 on all walls and 2-level chains.

---

## 12. Reference material

- **Reference logic (ground truth):** [`dead_reckoning.py`](dead_reckoning.py) — a complete, tested PySide6 prototype. Reuse its transform math, `resolve_mesh_dir` rules, config round-trip behavior, and mesh footprint handling. Run `python3 dead_reckoning.py --selftest`. **Do not** reuse its UI.
- **Config:** `/home/ubuntu/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml`
- **Meshes:** `/home/ubuntu/osu-uwrt/release/src/riptide_gui/riptide_meshes/meshes/<name>/model.dae` (Z-up, meters)
- **Sidecar (prototype format):** `<config>.dr_viz.json` — per-object `{length,width,color,image_path,image_rot,img_bbox,locked,hidden}`, plus `apriltag {x,y,base_phi,wall,yaw_offset}` and the line layout. A fresh impl may define its own sidecar; keep the _intent_: persist tool-only viz + tag placement + line layout, separate from the ROS config.
- Context file used only to source pool dimensions/DAE export (not part of this tool): `pool_layout_qt_exportable_v3_separate_dae.py`.

---

## 13. Open decisions for the implementer

- **2D-only vs 3D-rendered top-down** (§9.3) — recommend 3D-rendered top-down (Option 1) if time allows, else PixiJS 2D.
- **Snapping** (grid/lane/wall) while dragging — nice-to-have; decide.
- **Multi-select / group move** — not required by current workflow; optional.
- **Deprecated `prequal_*` / `liltank`** on save — recommend **preserve untouched** (don't display, don't edit) to be safe; dropping them is acceptable if confirmed with the team.
- **Dark theme / secondary feet readout** — optional polish.
- **Snapping the AprilTag to only line/wall intersections vs. any wall point** — spec says intersections; confirm if free wall placement is also wanted.
