import { describe, expect, it } from 'vitest'
import { Tag, compose, mapToWorld, worldToMap } from '../src/core/math'
import {
  Objects,
  computeMapPoses,
  descendants,
  hitTest,
  localRect,
  makeProp,
  relativeUnder,
  subtreeOrder,
  uniqueName,
} from '../src/core/model'
import { TopdownManifest, resolveMeshDir } from '../src/core/mesh'
import { DEFAULT_POOL, poolById } from '../src/core/pools'
import { applySidecar, buildSidecar, defaultLines, defaultSidecarJson } from '../src/core/sidecar'

function scene(): { objects: Objects; order: string[] } {
  const objects: Objects = {
    a: makeProp('a', { x: 10, y: 5, z: -1, yaw: 90 }),
    b: makeProp('b', { parent: 'a', x: 2, y: 0, z: -0.5, yaw: 0 }),
    c: makeProp('c', { parent: 'b', x: 1, y: 1, z: 0.25, yaw: 45 }),
    d: makeProp('d', { x: 1, y: 1, z: 0, yaw: 0 }),
  }
  return { objects, order: ['a', 'b', 'c', 'd'] }
}

describe('computeMapPoses', () => {
  it('composes chains and adds z', () => {
    const { objects, order } = scene()
    const poses = computeMapPoses(objects, order)
    expect(poses.b[0]).toBeCloseTo(10, 9) // 2 m along a's +X (=world... map +Y here)
    expect(poses.b[1]).toBeCloseTo(7, 9)
    expect(poses.b[2]).toBeCloseTo(-1.5, 9)
    expect(poses.b[3]).toBeCloseTo(90, 9)
    expect(poses.c[3]).toBeCloseTo(135, 9)
  })

  it('guards against cycles', () => {
    const objects: Objects = {
      a: makeProp('a', { parent: 'b', x: 1, y: 0, z: 0, yaw: 0 }),
      b: makeProp('b', { parent: 'a', x: 1, y: 0, z: 0, yaw: 0 }),
    }
    const poses = computeMapPoses(objects, ['a', 'b'])
    expect(Number.isFinite(poses.a[0])).toBe(true)
    expect(Number.isFinite(poses.b[0])).toBe(true)
  })

  it('treats missing parents as map-relative', () => {
    const objects: Objects = { x: makeProp('x', { parent: 'ghost', x: 3, y: 4, z: 0, yaw: 10 }) }
    const poses = computeMapPoses(objects, ['x'])
    expect(poses.x).toEqual([3, 4, 0, 10])
  })
})

describe('reparent preserves world/pool position', () => {
  it('recomputes the relative pose under the new parent', () => {
    const { objects, order } = scene()
    const tag: Tag = { x: 0, y: 11.43, basePhi: 0, wall: 'W', yawOffset: 15, mode: 'apriltag' }
    const before = computeMapPoses(objects, order)
    const worldBefore = mapToWorld(before.c[0], before.c[1], before.c[3], tag)

    // reparent c from b to d
    const rel = relativeUnder('d', before, before.c)
    objects.c = { ...objects.c, parent: 'd', x: rel[0], y: rel[1], z: rel[2], yaw: rel[3] }
    const after = computeMapPoses(objects, order)
    const worldAfter = mapToWorld(after.c[0], after.c[1], after.c[3], tag)

    for (let i = 0; i < 3; i++) expect(after.c[i]).toBeCloseTo(before.c[i], 6)
    expect(after.c[3]).toBeCloseTo(before.c[3], 6)
    for (let i = 0; i < 3; i++) expect(worldAfter[i]).toBeCloseTo(worldBefore[i], 6)
  })
})

describe('drag decompose keeps children rigid', () => {
  it('dragging a parent leaves child relative poses unchanged and moves child map pose', () => {
    const { objects, order } = scene()
    const tag: Tag = { x: 20, y: 0, basePhi: 90, wall: 'S', yawOffset: 0, mode: 'apriltag' }
    const childRelBefore = [objects.b.x, objects.b.y, objects.b.z, objects.b.yaw]

    // simulate a drag of 'a' to world (30, 12): world -> map, keep z & yaw
    const poses = computeMapPoses(objects, order)
    const [mx, my] = worldToMap(30, 12, 0, tag)
    const rel = relativeUnder(objects.a.parent, poses, [mx, my, poses.a[2], poses.a[3]])
    objects.a = { ...objects.a, x: rel[0], y: rel[1], z: rel[2], yaw: rel[3] }

    const after = computeMapPoses(objects, order)
    expect([objects.b.x, objects.b.y, objects.b.z, objects.b.yaw]).toEqual(childRelBefore)
    const expectedB = compose(after.a, [objects.b.x, objects.b.y, objects.b.z, objects.b.yaw])
    for (let i = 0; i < 4; i++) expect(after.b[i]).toBeCloseTo(expectedB[i], 9)
    const [wx, wy] = mapToWorld(after.a[0], after.a[1], after.a[3], tag)
    expect(wx).toBeCloseTo(30, 6)
    expect(wy).toBeCloseTo(12, 6)
  })
})

describe('tree helpers', () => {
  it('descendants and subtree order', () => {
    const { objects, order } = scene()
    expect(descendants(objects, order, 'a')).toEqual(new Set(['b', 'c']))
    expect(subtreeOrder(objects, order, 'a')).toEqual(['a', 'b', 'c'])
  })
  it('unique names', () => {
    const { objects } = scene()
    expect(uniqueName(objects, 'e')).toBe('e')
    expect(uniqueName(objects, 'a')).toBe('a_2')
  })
})

describe('footprint & hit test', () => {
  it('uses mesh bbox with origin offset (gate extends to one side)', () => {
    const p = makeProp('gate', { bbox: [-0.04, 0.04, -0.04, 3.09] })
    const r = localRect(p)
    expect(r.y).toBeCloseTo(-0.04, 9)
    expect(r.h).toBeCloseTo(3.13, 9)
    // point 3 m to the local +Y side is inside; -1 m is not
    expect(hitTest(p, 0, 0, 0, 0, 3)).toBe(true)
    expect(hitTest(p, 0, 0, 0, 0, -1)).toBe(false)
    // rotate 90° CCW: +Y side now points along world -X
    expect(hitTest(p, 0, 0, 90, -3, 0)).toBe(true)
  })
})

describe('mesh resolver', () => {
  const dirs = [
    'bin', 'bin_magnet', 'bin_vinyl', 'gate', 'gate_repair', 'gate_rescue', 'liltank',
    'octagon_buoy', 'octagon_compass', 'octagon_hammer_and_wrench', 'octagon_sos', 'reefshark',
    'sawfish', 'slalom', 'table', 'table_bandage', 'table_basket_helmet', 'table_basket_warning',
    'table_nut_and_bolt', 'table_pill', 'table_plug', 'talos', 'torpedo',
  ]
  it('resolves exact, digits, suffix and alias names', () => {
    expect(resolveMeshDir('gate', dirs)).toBe('gate')
    expect(resolveMeshDir('bin_vinyl1', dirs)).toBe('bin_vinyl')
    expect(resolveMeshDir('pill', dirs)).toBe('table_pill')
    expect(resolveMeshDir('buoy', dirs)).toBe('octagon_buoy')
    expect(resolveMeshDir('compass', dirs)).toBe('octagon_compass')
    expect(resolveMeshDir('sos', dirs)).toBe('octagon_sos')
    expect(resolveMeshDir('plug', dirs)).toBe('table_plug')
    expect(resolveMeshDir('warning', dirs)).toBe('table_basket_warning')
    expect(resolveMeshDir('helmet', dirs)).toBe('table_basket_helmet')
    expect(resolveMeshDir('nut_and_bolt', dirs)).toBe('table_nut_and_bolt')
    expect(resolveMeshDir('hammer_and_wrench', dirs)).toBe('octagon_hammer_and_wrench')
    expect(resolveMeshDir('bandage', dirs)).toBe('table_bandage')
    expect(resolveMeshDir('slalom_parent', dirs)).toBe('slalom')
    expect(resolveMeshDir('magnet1', dirs)).toBe('bin_magnet')
    expect(resolveMeshDir('magnet_target2', dirs)).toBe('bin_magnet')
    expect(resolveMeshDir('fire_hole_large', dirs)).toBeNull()
    expect(resolveMeshDir('bin_cad_geometry', dirs)).toBeNull()
    expect(resolveMeshDir('slalom_front', dirs)).toBeNull()
  })
})

describe('sidecar', () => {
  it('round-trips lock/hide/color/mesh/tag/lines', () => {
    const { objects, order } = scene()
    objects.a = { ...objects.a, locked: true, hidden: true, color: '#123456', mesh: 'gate', bbox: [0, 1, -1, 1] }
    const tag: Tag = { x: 50, y: 4.5, basePhi: 180, wall: 'E', yawOffset: -5, mode: 'apriltag' }
    const lines = { ...defaultLines(DEFAULT_POOL), shortCount: 15, showGrid: true }
    const json = buildSidecar(objects, order, tag, lines, '/home/ubuntu', DEFAULT_POOL)
    expect(JSON.parse(json).props.a.image_path).toBe(
      '/home/ubuntu/.cache/dead_reckoning/topdown/gate.png',
    )

    const fresh = scene()
    const manifest: TopdownManifest = { gate: { bbox: [0, 2, -1, 1] }, bin: { bbox: [0, 1, 0, 1] } }
    const applied = applySidecar(json, fresh.objects, manifest)
    expect(applied.objects.a.locked).toBe(true)
    expect(applied.objects.a.hidden).toBe(true)
    expect(applied.objects.a.color).toBe('#123456')
    expect(applied.objects.a.mesh).toBe('gate')
    // manifest bbox wins over the sidecar's stale img_bbox
    expect(applied.objects.a.bbox).toEqual([0, 2, -1, 1])
    expect(applied.tag).toEqual(tag)
    expect(applied.lines.shortCount).toBe(15)
    expect(applied.lines.showGrid).toBe(true)
    expect(applied.pool?.id).toBe(DEFAULT_POOL.id)
  })

  it('round-trips anchors, per-line runs, per-family tees and crossCut', () => {
    const { objects, order } = scene()
    const tag: Tag = { x: 0, y: 8.5, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }
    const lines = {
      ...defaultLines(DEFAULT_POOL),
      shortAnchor: 4.2672,
      shortRuns: [{ start: 1, length: 10 }, null, { start: 2, length: 8 }],
      shortTee: false,
      longTee: true,
      crossCut: false,
    }
    const json = buildSidecar(objects, order, tag, lines, null, DEFAULT_POOL)
    const raw = JSON.parse(json).lines
    expect(raw.short_anchor).toBeCloseTo(4.2672, 9)
    expect(raw.short_runs).toEqual([{ start: 1, length: 10 }, null, { start: 2, length: 8 }])
    expect(raw.short_tee_show).toBe(false)
    expect(raw.long_tee_show).toBe(true)
    expect(raw.cross_cut).toBe(false)
    // legacy mirror: old readers show tees when any family has them
    expect(raw.tee_show).toBe(true)

    const applied = applySidecar(json, scene().objects, {})
    const merged = { ...defaultLines(DEFAULT_POOL), ...applied.lines }
    expect(merged.shortAnchor).toBeCloseTo(4.2672, 9)
    expect(merged.shortRuns).toEqual([{ start: 1, length: 10 }, null, { start: 2, length: 8 }])
    expect(merged.longAnchor).toBeNull()
    expect(merged.shortTee).toBe(false)
    expect(merged.longTee).toBe(true)
    expect(merged.crossCut).toBe(false)
  })

  it('round-trips per-pool line layouts (lines_by_pool)', () => {
    const { objects, order } = scene()
    const tag: Tag = { x: 0, y: 8.5, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }
    const rpac = poolById('rpac-divewell')
    const rpacLines = { ...defaultLines(rpac), shortAnchor: 4.5, shortCount: 3 }
    const woolLines = { ...defaultLines(DEFAULT_POOL), longCount: 9 }
    // active pool = RPAC; Woollett edits ride along in linesByPool
    const json = buildSidecar(objects, order, tag, rpacLines, null, rpac, { woollett: woolLines })
    const raw = JSON.parse(json)
    expect(Object.keys(raw.lines_by_pool).sort()).toEqual(['rpac-divewell', 'woollett'])
    // legacy flat block mirrors the active pool
    expect(raw.lines.short_count).toBe(3)
    expect(raw.lines_by_pool['rpac-divewell'].short_anchor).toBe(4.5)
    expect(raw.lines_by_pool.woollett.long_count).toBe(9)

    const applied = applySidecar(json, scene().objects, {})
    expect(applied.pool?.id).toBe('rpac-divewell')
    expect(applied.linesByPool['rpac-divewell'].shortAnchor).toBe(4.5)
    expect(applied.linesByPool.woollett.longCount).toBe(9)
  })

  it('sidecars without lines_by_pool yield an empty per-pool map', () => {
    const json = JSON.stringify({ props: {}, apriltag: null, lines: { short_show: true, short_count: 17, short_spacing: 2.7432, long_show: true, long_count: 8, long_spacing: 2.7432, show_grid: false, show_children: true } })
    const applied = applySidecar(json, {}, {})
    expect(applied.linesByPool).toEqual({})
    expect(applied.lines.shortCount).toBe(17)
  })

  it('legacy sidecar lines fall back to today\'s behavior', () => {
    const legacy = (extra: object) =>
      JSON.stringify({
        props: {},
        apriltag: null,
        lines: {
          short_show: true,
          short_count: 17,
          short_spacing: 2.7432,
          long_show: true,
          long_count: 8,
          long_spacing: 2.7432,
          show_grid: false,
          show_children: true,
          ...extra,
        },
      })
    const merged = (extra: object) => ({
      ...defaultLines(DEFAULT_POOL),
      ...applySidecar(legacy(extra), {}, {}).lines,
    })
    // no new fields: centered, no overrides, cutting on, tees from pool default
    const m = merged({})
    expect(m.shortAnchor).toBeNull()
    expect(m.longAnchor).toBeNull()
    expect(m.shortRuns).toEqual([])
    expect(m.longRuns).toEqual([])
    expect(m.crossCut).toBe(true)
    expect(m.shortTee).toBe(true)
    expect(m.longTee).toBe(true)
    // legacy shared tee_show drives both families
    const off = merged({ tee_show: false })
    expect(off.shortTee).toBe(false)
    expect(off.longTee).toBe(false)
  })

  it('round-trips extra lines, including an emptied list', () => {
    const { objects, order } = scene()
    const tag: Tag = { x: 0, y: 8.5, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }
    const rpac = poolById('rpac-divewell')
    const extras = [
      { dir: 'along' as const, pos: 2.4, start: 1.5, length: 8.0, tee: false },
      { dir: 'across' as const, pos: 20.0, start: 3.0, length: 10.0, tee: true },
    ]
    const lines = { ...defaultLines(rpac), extras }
    const applied = applySidecar(buildSidecar(objects, order, tag, lines, null, rpac), scene().objects, {})
    expect({ ...defaultLines(rpac), ...applied.lines }.extras).toEqual(extras)

    // deleting every extra must survive the round trip (not fall back to pool defaults)
    const cleared = { ...defaultLines(rpac), extras: [] }
    const applied2 = applySidecar(buildSidecar(objects, order, tag, cleared, null, rpac), scene().objects, {})
    expect(applied2.lines.extras).toEqual([])
    expect({ ...defaultLines(rpac), ...applied2.lines }.extras).toEqual([])
  })

  it('rpac-divewell defaults carry the measured layout', () => {
    const pool = poolById('rpac-divewell')
    expect(pool.lengthM).toBe(25)
    expect(pool.widthM).toBe(17)
    const ln = defaultLines(pool)
    expect(ln.shortCount).toBe(4)
    expect(ln.shortSpacing).toBeCloseTo(3.81, 6)
    expect(ln.shortAnchor).toBeCloseTo(4.2672, 6)
    expect(ln.shortTee).toBe(false)
    expect(ln.shortRuns).toHaveLength(4)
    expect(ln.longCount).toBe(6)
    expect(ln.longSpacing).toBe(3)
    expect(ln.longAnchor).toBeNull()
    expect(ln.longTee).toBe(true)
    expect(ln.crossCut).toBe(false)
  })

  it('woollett defaults are unchanged by the line-model extension', () => {
    const ln = defaultLines(DEFAULT_POOL)
    expect(DEFAULT_POOL.id).toBe('woollett')
    expect(ln.shortAnchor).toBeNull()
    expect(ln.longAnchor).toBeNull()
    expect(ln.shortRuns).toEqual([])
    expect(ln.longRuns).toEqual([])
    expect(ln.shortTee).toBe(true)
    expect(ln.longTee).toBe(true)
    expect(ln.crossCut).toBe(true)
  })

  it('defaultLines deep-copies per-line runs from the shared PoolDef', () => {
    const pool = poolById('rpac-divewell')
    const a = defaultLines(pool)
    a.shortRuns[0]!.start = 99
    const b = defaultLines(pool)
    expect(b.shortRuns[0]!.start).not.toBe(99)
  })

  it('reads prototype sidecars (mesh via image_path, no mesh key)', () => {
    const { objects } = scene()
    const json = JSON.stringify({
      props: { a: { length: 1, width: 2, color: '#abcdef', image_path: '/x/.cache/dead_reckoning/topdown/bin.png', image_rot: 0, img_bbox: [0, 1, 0, 1], locked: false, hidden: false } },
      apriltag: null,
      lines: {},
    })
    const applied = applySidecar(json, objects, { bin: { bbox: [0, 1, 0, 1] } })
    expect(applied.objects.a.mesh).toBe('bin')
    expect(applied.tag).toBeNull()
    expect(applied.pool).toBeNull() // pre-pool sidecars fall back to the default
  })

  it('bundled first-run defaults carry the team viz state', () => {
    const objects: Objects = {
      gate: makeProp('gate'),
      gate_rescue: makeProp('gate_rescue', { parent: 'gate' }),
      table: makeProp('table'),
      bin_target1: makeProp('bin_target1', { parent: 'bin' }),
    }
    const manifest: TopdownManifest = { gate: { bbox: [-0.1, 0.1, -1.5, 1.5] } }
    const applied = applySidecar(defaultSidecarJson(), objects, manifest)
    expect(applied.objects.gate.color).toBe('#8752c8')
    expect(applied.objects.gate.mesh).toBe('gate')
    expect(applied.objects.gate.locked).toBe(false)
    expect(applied.objects.gate_rescue.locked).toBe(true)
    expect(applied.objects.bin_target1.hidden).toBe(true)
    expect(applied.tag).toMatchObject({ x: 22.2568, y: 0, basePhi: 90, wall: 'S' })
    expect(applied.lines.shortCount).toBe(17)
    expect(applied.lines.longCount).toBe(8)
    // machine-specific render-cache paths must not ship in the bundle
    const raw = JSON.parse(defaultSidecarJson()) as { props: Record<string, { image_path: unknown }> }
    for (const p of Object.values(raw.props)) expect(p.image_path).toBeNull()
  })
})
