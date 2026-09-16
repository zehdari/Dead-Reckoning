/**
 * Coordinate math — ported verbatim from the reference implementation
 * (dead_reckoning.py). All angles in degrees, CCW positive, normalized to
 * (-180, 180]; all distances in meters. REP-103 conventions.
 *
 * Frames:
 *  - Pool world: origin at a pool corner, +X along the 50 m length, +Y along
 *    the 22.86 m width (Y-up top-down math plane), +Z up.
 *  - Map == AprilTag frame: +X from the wall into the pool, +Y 90° CCW from
 *    +X, +Z up. Yaw CCW about +Z from +X.
 */

export const M_PER_FT = 0.3048
export const M_PER_YD = 0.9144

export const POOL_LENGTH_M = 50.0
export const POOL_WIDTH_M = 25.0 * M_PER_YD // 22.86
export const POOL_DEPTH_M = 7.0 * M_PER_FT // 2.1336
export const DEFAULT_NINE_FT_M = 9.0 * M_PER_FT // 2.7432
export const LINE_THICKNESS_M = 10.0 * 0.0254 // ~10 in
export const MAP = 'map'

/** (x, y, z, yaw°) */
export type Pose4 = readonly [number, number, number, number]

export type OriginMode = 'apriltag' | 'robot'

export interface Tag {
  x: number
  y: number
  /** inward wall-normal heading, deg CCW from world +X: W=0, E=180, S=90, N=270 */
  basePhi: number
  wall: 'N' | 'S' | 'E' | 'W'
  /** user fine-tune of the frame, deg */
  yawOffset: number
  /**
   * 'apriltag': origin is an AprilTag on a wall (snaps to line/wall intersections).
   * 'robot': the map origin is set in the robot frame (placed freely off the wall,
   * e.g. the sub's start pose); shown with the talos footprint. The world<->map
   * math is identical — only placement/snapping and the marker differ.
   */
  mode: OriginMode
}

export function tagPhi(tag: Tag): number {
  return normDeg(tag.basePhi + tag.yawOffset)
}

/** Wrap an angle to (-180, 180]. */
export function normDeg(a: number): number {
  a = ((((a + 180.0) % 360.0) + 360.0) % 360.0) - 180.0
  return a === -180.0 ? 180.0 : a
}

/** One line's painted run along its axis: start offset and length, m. */
export interface LineRun {
  start: number
  length: number
}

/**
 * A free-form bottom line outside the two uniform families — for venues with
 * odd one-off lines. 'across' runs along Y and is positioned on X (parallel to
 * the short-family lines); 'along' runs along X and is positioned on Y.
 * Thickness and T length are inherited from the parallel family.
 */
export interface ExtraLine {
  dir: 'across' | 'along'
  /** center offset along the positioning axis, m */
  pos: number
  /** painted run start along the run axis, m */
  start: number
  /** painted run length, m */
  length: number
  /** T crossbars at both ends */
  tee: boolean
}

/**
 * Evenly spaced line centers along a dimension. With an anchor, the first
 * center sits `anchorM` from the 0-wall; otherwise the run is centered.
 */
export function linePositions(
  dimensionM: number,
  count: number,
  spacingM: number,
  anchorM?: number | null,
): number[] {
  if (count <= 0) return []
  const start = anchorM ?? (dimensionM - (count - 1) * spacingM) / 2.0
  return Array.from({ length: count }, (_, i) => start + i * spacingM)
}

export function centeredPositions(dimensionM: number, count: number, spacingM: number): number[] {
  return linePositions(dimensionM, count, spacingM)
}

/** parent map pose ∘ child pose relative to parent -> child map pose (yaw-only rotation, z adds). */
export function compose(parent: Pose4, childRel: Pose4): Pose4 {
  const [px, py, pz, pyaw] = parent
  const [x, y, z, yaw] = childRel
  const a = (pyaw * Math.PI) / 180.0
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [px + x * c - y * s, py + x * s + y * c, pz + z, normDeg(pyaw + yaw)]
}

/** Inverse of compose: child map pose -> pose relative to parent. */
export function decompose(parent: Pose4, childMap: Pose4): Pose4 {
  const [px, py, pz, pyaw] = parent
  const [mx, my, mz, myaw] = childMap
  const a = (pyaw * Math.PI) / 180.0
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = mx - px
  const dy = my - py
  return [dx * c + dy * s, -dx * s + dy * c, mz - pz, normDeg(myaw - pyaw)]
}

/** Pool world pose -> map/AprilTag frame pose (REP-103). */
export function worldToMap(px: number, py: number, pyaw: number, tag: Tag): [number, number, number] {
  const phi = (tagPhi(tag) * Math.PI) / 180.0
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  const dx = px - tag.x
  const dy = py - tag.y
  return [dx * c + dy * s, -dx * s + dy * c, normDeg(pyaw - tagPhi(tag))]
}

/** Map/AprilTag frame pose -> pool world pose (REP-103). */
export function mapToWorld(xr: number, yr: number, yawr: number, tag: Tag): [number, number, number] {
  const phi = (tagPhi(tag) * Math.PI) / 180.0
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  return [tag.x + xr * c - yr * s, tag.y + xr * s + yr * c, normDeg(yawr + tagPhi(tag))]
}

export interface TagCandidate {
  x: number
  y: number
  phi: number
  wall: 'N' | 'S' | 'E' | 'W'
}

/** Pool extents needed by the placement math (see PoolDef in pools.ts). */
export interface PoolDims {
  lengthM: number
  widthM: number
}

/**
 * AprilTag candidate points = bottom-line / wall intersections, plus the four
 * pool corners. "short" lines are parallel to the short side (spaced along the
 * length, hit S/N walls); "long" lines are parallel to the long side (spaced
 * along the width, hit W/E walls). Each corner yields two candidates — one per
 * adjacent wall — so the tag can face into the pool along either; a click near
 * a corner picks the wall the click hugs (see nearestCandidate).
 */
export interface TagLineFamily {
  show: boolean
  count: number
  spacing: number
  /** first line center from the 0-wall; absent/null = centered */
  anchor?: number | null
}

export function tagCandidates(
  pool: PoolDims,
  short: TagLineFamily,
  long: TagLineFamily,
  extras: Pick<ExtraLine, 'dir' | 'pos'>[] = [],
): TagCandidate[] {
  const L = pool.lengthM
  const W = pool.widthM
  const cands: TagCandidate[] = []
  const acrossAt = (x: number): void => {
    if (x >= -0.01 && x <= L + 0.01) {
      cands.push({ x, y: 0.0, phi: 90.0, wall: 'S' })
      cands.push({ x, y: W, phi: 270.0, wall: 'N' })
    }
  }
  const alongAt = (y: number): void => {
    if (y >= -0.01 && y <= W + 0.01) {
      cands.push({ x: 0.0, y, phi: 0.0, wall: 'W' })
      cands.push({ x: L, y, phi: 180.0, wall: 'E' })
    }
  }
  if (short.show) for (const x of linePositions(L, short.count, short.spacing, short.anchor)) acrossAt(x)
  if (long.show) for (const y of linePositions(W, long.count, long.spacing, long.anchor)) alongAt(y)
  for (const e of extras) (e.dir === 'across' ? acrossAt : alongAt)(e.pos)
  // corners exist regardless of which line families are shown
  for (const [cx, cy] of [
    [0, 0],
    [L, 0],
    [0, W],
    [L, W],
  ]) {
    cands.push({ x: cx, y: cy, phi: cx === 0 ? 0.0 : 180.0, wall: cx === 0 ? 'W' : 'E' })
    cands.push({ x: cx, y: cy, phi: cy === 0 ? 90.0 : 270.0, wall: cy === 0 ? 'S' : 'N' })
  }
  return cands
}

/**
 * Nearest candidate to (x, y), or null if all are farther than maxDist.
 * Co-located candidates (the two walls of a pool corner) tie-break by which
 * wall the click point is closer to.
 */
export function nearestCandidate(
  cands: TagCandidate[],
  x: number,
  y: number,
  maxDist = 3.0,
): TagCandidate | null {
  // a candidate sits on its wall, so the click's distance to that wall's plane
  // is measurable from the candidate itself
  const wallDist = (c: TagCandidate): number =>
    c.wall === 'W' || c.wall === 'E' ? Math.abs(x - c.x) : Math.abs(y - c.y)
  let best: TagCandidate | null = null
  let bestD = Infinity
  for (const c of cands) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (d > maxDist) continue
    const tie = best !== null && Math.abs(d - bestD) < 1e-9
    if (best === null || d < bestD || (tie && wallDist(c) < wallDist(best))) {
      bestD = d
      best = c
    }
  }
  return best
}
