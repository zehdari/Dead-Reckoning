/**
 * Framework-agnostic data model: objects ("props") in a parent/child TF tree.
 * Poses are stored RELATIVE TO PARENT, exactly like the riptide_mapping config.
 */
import { MAP, Pose4, compose, decompose, normDeg } from './math'

export interface Covar {
  x: number
  y: number
  z: number
  yaw: number
}

export interface PropObj {
  /** unique; also implicitly names the frame "<name>_frame" */
  name: string
  /** "map" or another object's name */
  parent: string
  x: number
  y: number
  z: number
  /** deg */
  yaw: number
  covar: Covar
  /** -> lock_orientation_to_config (preserved, not interpreted) */
  lockOrientation: boolean
  /** -> point_yaw_at_parent (preserved, not interpreted) */
  pointYawAtParent: boolean
  /** -> class (preserved) */
  cls: string | null
  // ----- tool-only state (viz sidecar, never written to the ROS config) -----
  /** immovable in the canvas AND click-through */
  locked: boolean
  /** removed from the canvas, still in the list */
  hidden: boolean
  /** fallback footprint extent along +X, m (used when no mesh bbox) */
  length: number
  /** fallback footprint extent along +Y, m */
  width: number
  color: string
  /** top-down mesh sprite (riptide_meshes directory name), if assigned */
  mesh: string | null
  /** fine-tune rotation of the sprite about the model origin, deg */
  imageRot: number
  /** model XY bbox [xmin, xmax, ymin, ymax]; model origin (0,0) = pose point */
  bbox: [number, number, number, number] | null
}

export type Objects = Record<string, PropObj>

export function defaultCovar(): Covar {
  return { x: 1.0, y: 1.0, z: 1.0, yaw: 1.0 }
}

/** Stable pleasant color from a name (HSV h=hash, s≈0.59, v≈0.78). */
export function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return hsvHex(h % 360, 150 / 255, 200 / 255)
}

function hsvHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(5)}${f(3)}${f(1)}`
}

export function makeProp(name: string, partial: Partial<PropObj> = {}): PropObj {
  return {
    name,
    parent: MAP,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    covar: defaultCovar(),
    lockOrientation: false,
    pointYawAtParent: false,
    cls: null,
    locked: false,
    hidden: false,
    length: 0.6,
    width: 0.6,
    color: colorFor(name),
    mesh: null,
    imageRot: 0,
    bbox: null,
    ...partial,
  }
}

export function childrenOf(objects: Objects, order: string[], name: string): PropObj[] {
  return order.map((n) => objects[n]).filter((p) => p && p.parent === name)
}

export function descendants(objects: Objects, order: string[], name: string): Set<string> {
  const out = new Set<string>()
  const stack = [name]
  while (stack.length) {
    const cur = stack.pop()!
    for (const c of childrenOf(objects, order, cur)) {
      if (!out.has(c.name)) {
        out.add(c.name)
        stack.push(c.name)
      }
    }
  }
  return out
}

/** root + descendants, parents before children (BFS). */
export function subtreeOrder(objects: Objects, order: string[], root: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [root]
  while (queue.length) {
    const cur = queue.shift()!
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    for (const c of childrenOf(objects, order, cur)) if (!seen.has(c.name)) queue.push(c.name)
  }
  return out
}

/**
 * Map-frame pose of every object: compose up the parent chain.
 * Missing parents and cycles degrade gracefully (pose treated as map-relative),
 * mirroring the reference implementation.
 */
export function computeMapPoses(objects: Objects, order: string[]): Record<string, Pose4> {
  const memo: Record<string, Pose4> = {}
  const mp = (name: string, visiting: Set<string>): Pose4 => {
    if (memo[name]) return memo[name]
    const p = objects[name]
    let pose: Pose4
    if (!p) pose = [0, 0, 0, 0]
    else if (p.parent === MAP || !objects[p.parent] || visiting.has(p.parent))
      pose = [p.x, p.y, p.z, p.yaw]
    else pose = compose(mp(p.parent, new Set([...visiting, name])), [p.x, p.y, p.z, p.yaw])
    memo[name] = pose
    return pose
  }
  for (const n of order) mp(n, new Set())
  return memo
}

/** Relative pose that puts the object at `mapPose` under `parent` (identity for map). */
export function relativeUnder(
  parent: string,
  mapPoses: Record<string, Pose4>,
  mapPose: Pose4,
): Pose4 {
  if (parent === MAP || !mapPoses[parent]) return mapPose
  return decompose(mapPoses[parent], mapPose)
}

export function uniqueName(objects: Objects, base: string): string {
  if (!objects[base]) return base
  let i = 2
  while (objects[`${base}_${i}`]) i++
  return `${base}_${i}`
}

/** Footprint rect in the object's local frame (+X forward, +Y left), meters. */
export interface LocalRect {
  x: number
  y: number
  w: number
  h: number
}

export function localRect(p: PropObj): LocalRect {
  if (p.bbox) {
    const [x0, x1, y0, y1] = p.bbox
    return { x: x0, y: y0, w: Math.max(x1 - x0, 0.02), h: Math.max(y1 - y0, 0.02) }
  }
  return { x: -p.length / 2, y: -p.width / 2, w: p.length, h: p.width }
}

/** True if world point (wx,wy) is inside the object's footprint at world pose (ox,oy,oyaw°). */
export function hitTest(p: PropObj, ox: number, oy: number, oyawDeg: number, wx: number, wy: number): boolean {
  const a = (-oyawDeg * Math.PI) / 180
  const dx = wx - ox
  const dy = wy - oy
  const lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  const r = localRect(p)
  return lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h
}

/** Axis-aligned world bbox of the footprint at world pose (for the zoom-out limit). */
export function worldBBox(
  p: PropObj,
  ox: number,
  oy: number,
  oyawDeg: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const r = localRect(p)
  const a = (oyawDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [lx, ly] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ]) {
    const x = ox + lx * c - ly * s
    const y = oy + lx * s + ly * c
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}

export { normDeg }
