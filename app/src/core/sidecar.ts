/**
 * Viz state: tool-only per-config data — per-object footprint/color/image/
 * lock/hide, the AprilTag placement and the line layout. Stored per config in
 * the app-data dir on desktop, as a `<config>.dr_viz.json` sidecar in the
 * browser build (see api.ts). Format-compatible with the PySide6 prototype
 * (image_path points at its render cache; we additionally store the mesh
 * name). Never blocks a config save if it fails.
 */
import { ExtraLine, LINE_THICKNESS_M, LineRun, OriginMode, Tag, TagLineFamily } from './math'
import defaultVizData from './defaultViz.json'
import { TopdownManifest, meshFootprint } from './mesh'
import { Objects, PropObj } from './model'
import { PoolDef, poolById } from './pools'

export interface LinesConfig {
  shortShow: boolean
  shortCount: number
  shortSpacing: number
  /** first "across" line center from the x=0 wall, m; null = centered */
  shortAnchor: number | null
  /** stripe thickness of the "across" (short-side-parallel) lines, m */
  shortThickness: number
  /** run length of the "across" lines, m (centered on the pool width) */
  shortLength: number
  /** sparse per-line run overrides along Y; null/missing entry = family default */
  shortRuns: (LineRun | null)[]
  /** T crossbar length at each end of an "across" line, m */
  shortTeeLength: number
  /** draw T ends on the "across" lines */
  shortTee: boolean
  longShow: boolean
  longCount: number
  longSpacing: number
  /** first "along" line center from the y=0 wall, m; null = centered */
  longAnchor: number | null
  /** stripe thickness of the "along" (long-side-parallel) lines, m */
  longThickness: number
  /** run length of the "along" lines, m (centered on the pool length) */
  longLength: number
  /** sparse per-line run overrides along X; null/missing entry = family default */
  longRuns: (LineRun | null)[]
  /** T crossbar length at each end of an "along" line, m */
  longTeeLength: number
  /** draw T ends on the "along" lines */
  longTee: boolean
  /** "across" stems cut windows out of "along" lines where they cross */
  crossCut: boolean
  /** air gap between a cut "along" line end and the crossing "across" line, m */
  crossGap: number
  /** free-form one-off lines outside the two uniform families */
  extras: ExtraLine[]
  showGrid: boolean
  showChildren: boolean
}

/** LinesConfig -> the two family descriptors tagCandidates wants. */
export function lineFamilies(ln: LinesConfig): { short: TagLineFamily; long: TagLineFamily } {
  return {
    short: { show: ln.shortShow, count: ln.shortCount, spacing: ln.shortSpacing, anchor: ln.shortAnchor },
    long: { show: ln.longShow, count: ln.longCount, spacing: ln.longSpacing, anchor: ln.longAnchor },
  }
}

/**
 * Effective painted run of line `i` in a family: its override if set, else the
 * family default run (length `defLen`) centered in `dim`; clamped to the pool.
 */
export function effectiveRun(
  runs: (LineRun | null)[],
  i: number,
  defLen: number,
  dim: number,
): LineRun {
  const r = runs[i]
  if (r) {
    const a = Math.max(r.start, 0)
    const b = Math.min(r.start + r.length, dim)
    return { start: a, length: Math.max(b - a, 0) }
  }
  const L = Math.min(defLen, dim)
  return { start: (dim - L) / 2, length: L }
}

export interface SidecarLines {
  short_show: boolean
  short_count: number
  short_spacing: number
  short_anchor?: number | null
  short_thickness?: number
  short_length?: number
  short_runs?: ({ start: number; length: number } | null)[] | null
  short_tee_length?: number
  short_tee_show?: boolean
  long_show: boolean
  long_count: number
  long_spacing: number
  long_anchor?: number | null
  long_thickness?: number
  long_length?: number
  long_runs?: ({ start: number; length: number } | null)[] | null
  long_tee_length?: number
  long_tee_show?: boolean
  /** legacy shared T flag — read as a fallback, written for old readers */
  tee_show?: boolean
  cross_cut?: boolean
  cross_gap?: number
  extra_lines?: { dir: string; pos: number; start: number; length: number; tee?: boolean }[] | null
  show_grid: boolean
  show_children: boolean
}

export interface SidecarTag {
  x: number
  y: number
  base_phi: number
  wall: string
  yaw_offset: number
  mode?: string
}

export interface SidecarData {
  props: Record<string, SidecarProp>
  /** which venue the layout was made in (see pools.ts) */
  pool?: { id: string } | null
  /** the active pool's origin (also kept for pre-multi-pool readers) */
  apriltag: SidecarTag | null
  /** per-venue origin placement so it survives switching pools; keyed by pool id */
  apriltag_by_pool?: Record<string, SidecarTag>
  /** the active pool's line layout (also kept for pre-multi-pool readers) */
  lines: SidecarLines
  /** per-venue line layouts so edits survive switching pools; keyed by pool id */
  lines_by_pool?: Record<string, SidecarLines>
}

interface SidecarProp {
  length: number
  width: number
  color: string
  image_path: string | null
  image_rot: number
  img_bbox: number[] | null
  locked: boolean
  hidden: boolean
  mesh?: string | null
}

export function sidecarPath(configPath: string): string {
  return `${configPath}.dr_viz.json`
}

function linesToSidecar(lines: LinesConfig): SidecarLines {
  return {
    short_show: lines.shortShow,
    short_count: lines.shortCount,
    short_spacing: lines.shortSpacing,
    short_anchor: lines.shortAnchor,
    short_thickness: lines.shortThickness,
    short_length: lines.shortLength,
    short_runs: lines.shortRuns.length ? lines.shortRuns : undefined,
    short_tee_length: lines.shortTeeLength,
    short_tee_show: lines.shortTee,
    long_show: lines.longShow,
    long_count: lines.longCount,
    long_spacing: lines.longSpacing,
    long_anchor: lines.longAnchor,
    long_thickness: lines.longThickness,
    long_length: lines.longLength,
    long_runs: lines.longRuns.length ? lines.longRuns : undefined,
    long_tee_length: lines.longTeeLength,
    long_tee_show: lines.longTee,
    // legacy mirror so pre-anchor readers still show tees when any family has them
    tee_show: lines.shortTee || lines.longTee,
    cross_cut: lines.crossCut,
    cross_gap: lines.crossGap,
    // always written (even []) so "user deleted all extras" survives a reload
    extra_lines: lines.extras.map((e) => ({ ...e })),
    show_grid: lines.showGrid,
    show_children: lines.showChildren,
  }
}

const tagToSidecar = (tag: Tag): SidecarTag => ({
  x: tag.x,
  y: tag.y,
  base_phi: tag.basePhi,
  wall: tag.wall,
  yaw_offset: tag.yawOffset,
  mode: tag.mode,
})

const tagFromSidecar = (tg: SidecarTag): Tag => ({
  x: tg.x,
  y: tg.y,
  basePhi: tg.base_phi,
  wall: (tg.wall as Tag['wall']) ?? 'W',
  yawOffset: tg.yaw_offset ?? 0,
  mode: (tg.mode as OriginMode) === 'robot' ? 'robot' : 'apriltag',
})

export function buildSidecar(
  objects: Objects,
  order: string[],
  tag: Tag,
  lines: LinesConfig,
  home: string | null,
  pool: PoolDef,
  /** line layouts of other visited pools, so a save keeps every venue's edits */
  linesByPool: Record<string, LinesConfig> = {},
  /** origin placements of other visited pools, saved for the same reason */
  tagsByPool: Record<string, Tag> = {},
): string {
  const props: Record<string, SidecarProp> = {}
  for (const name of order) {
    const p = objects[name]
    if (!p) continue
    props[name] = {
      length: p.length,
      width: p.width,
      color: p.color,
      // prototype-compatible pointer into its top-down render cache
      image_path: p.mesh && home ? `${home}/.cache/dead_reckoning/topdown/${p.mesh}.png` : null,
      image_rot: p.imageRot,
      img_bbox: p.bbox ? [...p.bbox] : null,
      locked: p.locked,
      hidden: p.hidden,
      mesh: p.mesh,
    }
  }
  // every visited pool's layout rides along; the active pool always wins
  const byPool: Record<string, SidecarLines> = {}
  for (const [id, ln] of Object.entries(linesByPool)) byPool[id] = linesToSidecar(ln)
  byPool[pool.id] = linesToSidecar(lines)
  const tagByPool: Record<string, SidecarTag> = {}
  for (const [id, t] of Object.entries(tagsByPool)) tagByPool[id] = tagToSidecar(t)
  tagByPool[pool.id] = tagToSidecar(tag)
  const data: SidecarData = {
    props,
    pool: { id: pool.id },
    apriltag: tagToSidecar(tag),
    apriltag_by_pool: tagByPool,
    lines: linesToSidecar(lines),
    lines_by_pool: byPool,
  }
  return JSON.stringify(data, null, 2)
}

export interface AppliedSidecar {
  objects: Objects
  tag: Tag | null
  lines: Partial<LinesConfig>
  /** per-pool line layouts (empty for pre-multi-pool sidecars); keyed by pool id */
  linesByPool: Record<string, Partial<LinesConfig>>
  /** per-pool origin placements (empty for pre-multi-pool sidecars); keyed by pool id */
  tagsByPool: Record<string, Tag>
  /** null when the sidecar predates pool selection (old files -> default pool) */
  pool: PoolDef | null
}

/** Parse one sidecar lines block; unknown/missing fields are simply absent. */
function linesFromSidecar(ln: SidecarLines | undefined | null): Partial<LinesConfig> {
  if (!ln) return {}
  // per-line run entries from disk: keep well-formed objects, null out the rest
  const readRuns = (
    raw: ({ start: number; length: number } | null)[] | null | undefined,
  ): (LineRun | null)[] | null =>
    Array.isArray(raw)
      ? raw.map((r) =>
          r && typeof r.start === 'number' && typeof r.length === 'number'
            ? { start: r.start, length: r.length }
            : null,
        )
      : null
  const shortRuns = readRuns(ln.short_runs)
  const longRuns = readRuns(ln.long_runs)
  return {
    ...(ln.short_show !== undefined && { shortShow: !!ln.short_show }),
    ...(ln.short_count !== undefined && { shortCount: ln.short_count }),
    ...(ln.short_spacing !== undefined && { shortSpacing: ln.short_spacing }),
    ...(typeof ln.short_anchor === 'number' && { shortAnchor: ln.short_anchor }),
    ...(typeof ln.short_thickness === 'number' && { shortThickness: ln.short_thickness }),
    ...(typeof ln.short_length === 'number' && { shortLength: ln.short_length }),
    ...(shortRuns && { shortRuns }),
    ...(typeof ln.short_tee_length === 'number' && { shortTeeLength: ln.short_tee_length }),
    // per-family T flags, falling back to the legacy shared tee_show
    ...(ln.short_tee_show !== undefined
      ? { shortTee: !!ln.short_tee_show }
      : ln.tee_show !== undefined
        ? { shortTee: !!ln.tee_show }
        : {}),
    ...(ln.long_show !== undefined && { longShow: !!ln.long_show }),
    ...(ln.long_count !== undefined && { longCount: ln.long_count }),
    ...(ln.long_spacing !== undefined && { longSpacing: ln.long_spacing }),
    ...(typeof ln.long_anchor === 'number' && { longAnchor: ln.long_anchor }),
    ...(typeof ln.long_thickness === 'number' && { longThickness: ln.long_thickness }),
    ...(typeof ln.long_length === 'number' && { longLength: ln.long_length }),
    ...(longRuns && { longRuns }),
    ...(typeof ln.long_tee_length === 'number' && { longTeeLength: ln.long_tee_length }),
    ...(ln.long_tee_show !== undefined
      ? { longTee: !!ln.long_tee_show }
      : ln.tee_show !== undefined
        ? { longTee: !!ln.tee_show }
        : {}),
    ...(ln.cross_cut !== undefined && { crossCut: !!ln.cross_cut }),
    ...(typeof ln.cross_gap === 'number' && { crossGap: ln.cross_gap }),
    ...(Array.isArray(ln.extra_lines) && {
      extras: ln.extra_lines.flatMap((e): ExtraLine[] =>
        e &&
        (e.dir === 'across' || e.dir === 'along') &&
        typeof e.pos === 'number' &&
        typeof e.start === 'number' &&
        typeof e.length === 'number'
          ? [{ dir: e.dir, pos: e.pos, start: e.start, length: e.length, tee: !!e.tee }]
          : [],
      ),
    }),
    ...(ln.show_grid !== undefined && { showGrid: !!ln.show_grid }),
    ...(ln.show_children !== undefined && { showChildren: !!ln.show_children }),
  }
}

/** Overlay sidecar state onto freshly loaded objects (unknown names ignored). */
export function applySidecar(
  json: string,
  objects: Objects,
  manifest: TopdownManifest,
): AppliedSidecar {
  const meshDirs = Object.keys(manifest)
  const data = JSON.parse(json) as Partial<SidecarData>
  const out: Objects = { ...objects }
  for (const [name, v] of Object.entries(data.props ?? {})) {
    const p = out[name]
    if (!p || !v) continue
    const meshFromPath = v.image_path ? (v.image_path.split('/').pop() ?? '').replace(/\.png$/, '') : null
    const rawMesh =
      v.mesh !== undefined
        ? v.mesh
        : meshFromPath && meshDirs.includes(meshFromPath)
          ? meshFromPath
          : null
    const mesh = rawMesh && meshDirs.includes(rawMesh) ? rawMesh : null
    const next: PropObj = {
      ...p,
      length: typeof v.length === 'number' ? v.length : p.length,
      width: typeof v.width === 'number' ? v.width : p.width,
      color: v.color || p.color,
      imageRot: typeof v.image_rot === 'number' ? v.image_rot : 0,
      // the manifest is the source of truth for mesh footprints (sprite origin
      // offsets may change between renders); img_bbox is only a fallback
      bbox: mesh
        ? meshFootprint(manifest[mesh]).bbox
        : Array.isArray(v.img_bbox) && v.img_bbox.length === 4
          ? [v.img_bbox[0], v.img_bbox[1], v.img_bbox[2], v.img_bbox[3]]
          : null,
      locked: !!v.locked,
      hidden: !!v.hidden,
      mesh,
    }
    out[name] = next
  }
  const tg = data.apriltag
  const tag: Tag | null = tg ? tagFromSidecar(tg) : null
  const tagsByPool: Record<string, Tag> = {}
  if (data.apriltag_by_pool && typeof data.apriltag_by_pool === 'object') {
    for (const [id, t] of Object.entries(data.apriltag_by_pool)) {
      if (t && typeof t.x === 'number' && typeof t.y === 'number') tagsByPool[id] = tagFromSidecar(t)
    }
  }
  const lines = linesFromSidecar(data.lines)
  const linesByPool: Record<string, Partial<LinesConfig>> = {}
  if (data.lines_by_pool && typeof data.lines_by_pool === 'object') {
    for (const [id, ln] of Object.entries(data.lines_by_pool)) linesByPool[id] = linesFromSidecar(ln)
  }
  const pool = data.pool?.id ? poolById(data.pool.id) : null
  return { objects: out, tag, lines, linesByPool, tagsByPool, pool }
}

/** Bundled first-run viz state — a snapshot of the team's
 *  `config.yaml.dr_viz.json` (image paths stripped; the mesh field drives
 *  sprite lookup). Applied when a config has no saved viz state yet. */
export function defaultSidecarJson(): string {
  return JSON.stringify(defaultVizData)
}

export function defaultLines(pool: PoolDef): LinesConfig {
  const pl = pool.lines
  return {
    shortShow: true,
    shortCount: pl.shortCount,
    shortSpacing: pl.shortSpacing,
    shortAnchor: pl.shortAnchor ?? null,
    shortThickness: LINE_THICKNESS_M,
    // FINA-style: lines stop 2 m short of each wall, 1 m T crossbar
    shortLength: Math.max(pool.widthM - 4.0, pool.widthM / 2),
    // deep-copy: PoolDef is shared static data, LinesConfig entries get edited
    shortRuns: (pl.shortRuns ?? []).map((r) => (r ? { ...r } : null)),
    shortTeeLength: 1.0,
    shortTee: pl.shortTee ?? true,
    longShow: true,
    longCount: pl.longCount,
    longSpacing: pl.longSpacing,
    longAnchor: pl.longAnchor ?? null,
    longThickness: LINE_THICKNESS_M,
    longLength: Math.max(pool.lengthM - 4.0, pool.lengthM / 2),
    longRuns: (pl.longRuns ?? []).map((r) => (r ? { ...r } : null)),
    longTeeLength: 1.0,
    longTee: pl.longTee ?? true,
    crossCut: pl.crossCut ?? true,
    crossGap: 0.25,
    extras: (pl.extras ?? []).map((e) => ({ ...e })),
    showGrid: false,
    showChildren: true,
  }
}
