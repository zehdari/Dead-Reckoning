import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NINE_FT_M,
  M_PER_FT,
  POOL_LENGTH_M,
  POOL_WIDTH_M,
  Tag,
  centeredPositions,
  compose,
  decompose,
  linePositions,
  mapToWorld,
  nearestCandidate,
  normDeg,
  tagCandidates,
  worldToMap,
} from '../src/core/math'

const EPS = 1e-6

describe('normDeg', () => {
  it('wraps to (-180, 180]', () => {
    expect(normDeg(0)).toBe(0)
    expect(normDeg(180)).toBe(180)
    expect(normDeg(-180)).toBe(180)
    expect(normDeg(540)).toBe(180)
    expect(normDeg(-540)).toBe(180)
    expect(normDeg(190)).toBeCloseTo(-170, 9)
    expect(normDeg(-190)).toBeCloseTo(170, 9)
    expect(normDeg(720.5)).toBeCloseTo(0.5, 9)
  })
})

describe('world <-> map (REP-103 tag frame)', () => {
  it('west wall: x = distance into pool, y = left offset', () => {
    const tag: Tag = { x: 0, y: POOL_WIDTH_M / 2, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }
    const [mx, my, myaw] = worldToMap(5.0, POOL_WIDTH_M / 2 + 2.0, 30.0, tag)
    expect(mx).toBeCloseTo(5, 9)
    expect(my).toBeCloseTo(2, 9)
    expect(myaw).toBeCloseTo(30, 9)
    const [bx, by, byaw] = mapToWorld(mx, my, myaw, tag)
    expect(bx).toBeCloseTo(5, 9)
    expect(by).toBeCloseTo(POOL_WIDTH_M / 2 + 2, 9)
    expect(byaw).toBeCloseTo(30, 9)
  })

  it('round-trips on all four walls with yaw offsets to <= 1e-6', () => {
    const walls: Tag[] = [
      { x: 0, y: 10, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' },
      { x: POOL_LENGTH_M, y: 10, basePhi: 180, wall: 'E', yawOffset: 12.5, mode: 'apriltag' },
      { x: 20, y: 0, basePhi: 90, wall: 'S', yawOffset: -33, mode: 'apriltag' },
      { x: 20, y: POOL_WIDTH_M, basePhi: 270, wall: 'N', yawOffset: 90, mode: 'apriltag' },
    ]
    for (const tag of walls) {
      for (const [px, py, pyaw] of [
        [5, 5, 0],
        [42.1, 3.7, 123.4],
        [0.1, 22.0, -179.9],
        [25, 11.43, 90],
      ] as const) {
        const [mx, my, myaw] = worldToMap(px, py, pyaw, tag)
        const [bx, by, byaw] = mapToWorld(mx, my, myaw, tag)
        expect(Math.abs(bx - px)).toBeLessThanOrEqual(EPS)
        expect(Math.abs(by - py)).toBeLessThanOrEqual(EPS)
        expect(Math.abs(normDeg(byaw - pyaw))).toBeLessThanOrEqual(EPS)
      }
    }
  })

  it('south wall tag: +X points into the pool (world +Y)', () => {
    const tag: Tag = { x: 20, y: 0, basePhi: 90, wall: 'S', yawOffset: 0, mode: 'apriltag' }
    const [mx, my] = worldToMap(20, 4, 0, tag)
    expect(mx).toBeCloseTo(4, 9) // 4 m into the pool
    expect(my).toBeCloseTo(0, 9)
  })
})

describe('compose / decompose', () => {
  it('round-trips', () => {
    const parent = [3.0, 4.0, -1.0, 40.0] as const
    const child = [1.5, -0.5, -0.2, 25.0] as const
    const m = compose(parent, child)
    const back = decompose(parent, m)
    for (let i = 0; i < 4; i++) expect(Math.abs(back[i] - child[i])).toBeLessThanOrEqual(EPS)
  })

  it('z adds through the chain', () => {
    const m = compose([0, 0, -1, 90], [0, 0, -0.5, 0])
    expect(m[2]).toBeCloseTo(-1.5, 9)
  })

  it('2-level chain places a grandchild consistently', () => {
    const parent = [3.0, 4.0, -1.0, 40.0] as const
    const g = compose(parent, [2.0, 0.0, 0.0, 90.0])
    const gc = compose(g, [1.0, 0.0, 0.0, 0.0])
    const ang = (130.0 * Math.PI) / 180
    expect(gc[0]).toBeCloseTo(g[0] + Math.cos(ang), 9)
    expect(gc[1]).toBeCloseTo(g[1] + Math.sin(ang), 9)
    expect(gc[3]).toBeCloseTo(130, 9)
  })

  it('2-level round-trip through map frame to <= 1e-6', () => {
    const tag: Tag = { x: 20, y: 0, basePhi: 90, wall: 'S', yawOffset: -7, mode: 'apriltag' }
    const parentMap = [4, -2, -1, 77] as const
    const childRel = [1.25, 0.5, 0.25, -120] as const
    const childMap = compose(parentMap, childRel)
    const [wx, wy, wyaw] = mapToWorld(childMap[0], childMap[1], childMap[3], tag)
    const [mx, my, myaw] = worldToMap(wx, wy, wyaw, tag)
    const rel = decompose(parentMap, [mx, my, childMap[2], myaw])
    for (let i = 0; i < 4; i++) expect(Math.abs(rel[i] - childRel[i])).toBeLessThanOrEqual(EPS)
  })
})

describe('lane lines & tag candidates', () => {
  it('centered_positions spans symmetrically', () => {
    const pos = centeredPositions(50, 17, DEFAULT_NINE_FT_M)
    expect(pos.length).toBe(17)
    expect(pos[0] + pos[16]).toBeCloseTo(50, 9)
    expect(pos[1] - pos[0]).toBeCloseTo(DEFAULT_NINE_FT_M, 9)
    expect(centeredPositions(10, 0, 1)).toEqual([])
  })

  it('linePositions with no anchor matches centeredPositions', () => {
    expect(linePositions(50, 17, DEFAULT_NINE_FT_M)).toEqual(centeredPositions(50, 17, DEFAULT_NINE_FT_M))
    expect(linePositions(50, 17, DEFAULT_NINE_FT_M, null)).toEqual(centeredPositions(50, 17, DEFAULT_NINE_FT_M))
  })

  it('linePositions anchors the first center (RPAC cross lines)', () => {
    const pos = linePositions(25, 4, 12.5 * M_PER_FT, 14 * M_PER_FT)
    expect(pos.length).toBe(4)
    const expected = [4.2672, 8.0772, 11.8872, 15.6972]
    pos.forEach((p, i) => expect(p).toBeCloseTo(expected[i], 6))
  })

  const POOL = { lengthM: POOL_LENGTH_M, widthM: POOL_WIDTH_M }
  const allCands = () =>
    tagCandidates(
      POOL,
      { show: true, count: 17, spacing: DEFAULT_NINE_FT_M },
      { show: true, count: 8, spacing: DEFAULT_NINE_FT_M },
    )

  it('candidate count matches the prototype selftest plus the 4 corners', () => {
    expect(allCands().length).toBe((17 + 8) * 2 + 4 * 2)
  })

  it('snaps to the nearest candidate within 3 m, else null', () => {
    const cands = allCands()
    const c = nearestCandidate(cands, 0.4, POOL_WIDTH_M / 2 + 0.5)
    expect(c).not.toBeNull()
    expect(c!.wall).toBe('W')
    expect(nearestCandidate(cands, 25, 11, 3)).toBeNull() // pool center
  })

  it('corners are candidates even with all lines hidden', () => {
    const cands = tagCandidates(
      POOL,
      { show: false, count: 17, spacing: DEFAULT_NINE_FT_M },
      { show: false, count: 8, spacing: DEFAULT_NINE_FT_M },
    )
    expect(cands.length).toBe(8) // 4 corners x 2 walls
    const c = nearestCandidate(cands, 0.5, 0.5)
    expect(c).toMatchObject({ x: 0, y: 0 })
  })

  it('extra lines contribute wall candidates on their axis', () => {
    const rpac = { lengthM: 25, widthM: 17 }
    const none = { show: false, count: 0, spacing: 1 }
    const cands = tagCandidates(rpac, none, none, [
      { dir: 'along', pos: 2.4 },
      { dir: 'across', pos: 20.0 },
      { dir: 'along', pos: 99 }, // off-pool -> dropped
    ])
    const nonCorner = cands.filter((c) => (c.x !== 0 && c.x !== 25) || (c.y !== 0 && c.y !== 17))
    expect(nonCorner).toHaveLength(4) // 2 in-pool extras x 2 walls
    expect(nonCorner.filter((c) => c.y === 2.4).map((c) => c.wall).sort()).toEqual(['E', 'W'])
    expect(nonCorner.filter((c) => c.x === 20).map((c) => c.wall).sort()).toEqual(['N', 'S'])
  })

  it('anchored candidates sit at the anchored positions; off-pool ones are dropped', () => {
    const rpac = { lengthM: 25, widthM: 17 }
    const cands = tagCandidates(
      rpac,
      { show: true, count: 4, spacing: 12.5 * M_PER_FT, anchor: 14 * M_PER_FT },
      { show: false, count: 6, spacing: 3.0 },
    )
    const south = cands.filter((c) => c.wall === 'S' && !(c.x === 0 || c.x === 25))
    expect(south.map((c) => c.x)).toEqual(
      [4.2672, 8.0772, 11.8872, 15.6972].map((v) => expect.closeTo(v, 6) as unknown as number),
    )
    // an anchor pushing lines past the far wall drops those candidate pairs
    const far = tagCandidates(
      rpac,
      { show: true, count: 4, spacing: 12.5 * M_PER_FT, anchor: 20 },
      { show: false, count: 6, spacing: 3.0 },
    )
    // 20, 23.81 in-pool; 27.62, 31.43 dropped -> 2 lines x 2 walls + 8 corner cands
    expect(far.length).toBe(2 * 2 + 8)
  })

  it('a corner click picks the wall the click hugs', () => {
    const cands = allCands()
    // near (0,0), tight against the west wall -> tag on W, facing +X
    expect(nearestCandidate(cands, 0.15, 0.6)).toMatchObject({ x: 0, y: 0, wall: 'W', phi: 0 })
    // near (0,0), tight against the south wall -> tag on S, facing +Y
    expect(nearestCandidate(cands, 0.6, 0.15)).toMatchObject({ x: 0, y: 0, wall: 'S', phi: 90 })
    // far corner, hugging the east wall
    expect(
      nearestCandidate(cands, POOL_LENGTH_M - 0.1, POOL_WIDTH_M - 0.3),
    ).toMatchObject({ x: POOL_LENGTH_M, y: POOL_WIDTH_M, wall: 'E', phi: 180 })
  })
})
