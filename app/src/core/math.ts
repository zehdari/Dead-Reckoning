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

export function centeredPositions(dimensionM: number, count: number, spacingM: number): number[] {
  if (count <= 0) return []
  const span = (count - 1) * spacingM
  const start = (dimensionM - span) / 2.0
  return Array.from({ length: count }, (_, i) => start + i * spacingM)
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

/**
 * AprilTag candidate points = bottom-line / wall intersections.
 * "short" lines are parallel to the short side (spaced along the length, hit S/N
 * walls); "long" lines are parallel to the long side (spaced along the width,
 * hit W/E walls).
 */
export function tagCandidates(
  shortShow: boolean,
  shortCount: number,
  shortSpacing: number,
  longShow: boolean,
  longCount: number,
  longSpacing: number,
): TagCandidate[] {
  const cands: TagCandidate[] = []
  if (shortShow) {
    for (const x of centeredPositions(POOL_LENGTH_M, shortCount, shortSpacing)) {
      if (x >= -0.01 && x <= POOL_LENGTH_M + 0.01) {
        cands.push({ x, y: 0.0, phi: 90.0, wall: 'S' })
        cands.push({ x, y: POOL_WIDTH_M, phi: 270.0, wall: 'N' })
      }
    }
  }
  if (longShow) {
    for (const y of centeredPositions(POOL_WIDTH_M, longCount, longSpacing)) {
      if (y >= -0.01 && y <= POOL_WIDTH_M + 0.01) {
        cands.push({ x: 0.0, y, phi: 0.0, wall: 'W' })
        cands.push({ x: POOL_LENGTH_M, y, phi: 180.0, wall: 'E' })
      }
    }
  }
  return cands
}

/** Nearest candidate to (x, y), or null if all are farther than maxDist. */
export function nearestCandidate(
  cands: TagCandidate[],
  x: number,
  y: number,
  maxDist = 3.0,
): TagCandidate | null {
  let best: TagCandidate | null = null
  let bestD = maxDist
  for (const c of cands) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (d <= bestD) {
      bestD = d
      best = c
    }
  }
  return best
}
