/**
 * Viz sidecar: tool-only state persisted next to the config as
 * `<config>.dr_viz.json` — per-object footprint/color/image/lock/hide, the
 * AprilTag placement and the line layout. Format-compatible with the PySide6
 * prototype (image_path points at its render cache; we additionally store the
 * mesh name). Never blocks a config save if it fails.
 */
import { LINE_THICKNESS_M, OriginMode, Tag } from './math'
import { TopdownManifest, meshFootprint } from './mesh'
import { Objects, PropObj } from './model'

export interface LinesConfig {
  shortShow: boolean
  shortCount: number
  shortSpacing: number
  /** stripe thickness of the "across" (short-side-parallel) lines, m */
  shortThickness: number
  longShow: boolean
  longCount: number
  longSpacing: number
  /** stripe thickness of the "along" (long-side-parallel) lines, m */
  longThickness: number
  showGrid: boolean
  showChildren: boolean
}

export interface SidecarData {
  props: Record<string, SidecarProp>
  apriltag: {
    x: number
    y: number
    base_phi: number
    wall: string
    yaw_offset: number
    mode?: string
  } | null
  lines: {
    short_show: boolean
    short_count: number
    short_spacing: number
    short_thickness?: number
    long_show: boolean
    long_count: number
    long_spacing: number
    long_thickness?: number
    show_grid: boolean
    show_children: boolean
  }
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

export function buildSidecar(
  objects: Objects,
  order: string[],
  tag: Tag,
  lines: LinesConfig,
  home: string | null,
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
  const data: SidecarData = {
    props,
    apriltag: {
      x: tag.x,
      y: tag.y,
      base_phi: tag.basePhi,
      wall: tag.wall,
      yaw_offset: tag.yawOffset,
      mode: tag.mode,
    },
    lines: {
      short_show: lines.shortShow,
      short_count: lines.shortCount,
      short_spacing: lines.shortSpacing,
      short_thickness: lines.shortThickness,
      long_show: lines.longShow,
      long_count: lines.longCount,
      long_spacing: lines.longSpacing,
      long_thickness: lines.longThickness,
      show_grid: lines.showGrid,
      show_children: lines.showChildren,
    },
  }
  return JSON.stringify(data, null, 2)
}

export interface AppliedSidecar {
  objects: Objects
  tag: Tag | null
  lines: Partial<LinesConfig>
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
  const tag: Tag | null = tg
    ? {
        x: tg.x,
        y: tg.y,
        basePhi: tg.base_phi,
        wall: (tg.wall as Tag['wall']) ?? 'W',
        yawOffset: tg.yaw_offset ?? 0,
        mode: (tg.mode as OriginMode) === 'robot' ? 'robot' : 'apriltag',
      }
    : null
  const ln = data.lines
  const lines: Partial<LinesConfig> = ln
    ? {
        ...(ln.short_show !== undefined && { shortShow: !!ln.short_show }),
        ...(ln.short_count !== undefined && { shortCount: ln.short_count }),
        ...(ln.short_spacing !== undefined && { shortSpacing: ln.short_spacing }),
        ...(typeof ln.short_thickness === 'number' && { shortThickness: ln.short_thickness }),
        ...(ln.long_show !== undefined && { longShow: !!ln.long_show }),
        ...(ln.long_count !== undefined && { longCount: ln.long_count }),
        ...(ln.long_spacing !== undefined && { longSpacing: ln.long_spacing }),
        ...(typeof ln.long_thickness === 'number' && { longThickness: ln.long_thickness }),
        ...(ln.show_grid !== undefined && { showGrid: !!ln.show_grid }),
        ...(ln.show_children !== undefined && { showChildren: !!ln.show_children }),
      }
    : {}
  return { objects: out, tag, lines }
}

export function defaultLines(): LinesConfig {
  return {
    shortShow: true,
    shortCount: 17,
    shortSpacing: 2.7432,
    shortThickness: LINE_THICKNESS_M,
    longShow: true,
    longCount: 8,
    longSpacing: 2.7432,
    longThickness: LINE_THICKNESS_M,
    showGrid: false,
    showChildren: true,
  }
}
