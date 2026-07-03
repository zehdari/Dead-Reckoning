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
import { resolveMeshDir } from '../src/core/mesh'
import { applySidecar, buildSidecar, defaultLines } from '../src/core/sidecar'

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
    const lines = { ...defaultLines(), shortCount: 15, showGrid: true }
    const json = buildSidecar(objects, order, tag, lines, '/home/ubuntu')
    expect(JSON.parse(json).props.a.image_path).toBe(
      '/home/ubuntu/.cache/dead_reckoning/topdown/gate.png',
    )

    const fresh = scene()
    const applied = applySidecar(json, fresh.objects, ['gate', 'bin'])
    expect(applied.objects.a.locked).toBe(true)
    expect(applied.objects.a.hidden).toBe(true)
    expect(applied.objects.a.color).toBe('#123456')
    expect(applied.objects.a.mesh).toBe('gate')
    expect(applied.objects.a.bbox).toEqual([0, 1, -1, 1])
    expect(applied.tag).toEqual(tag)
    expect(applied.lines.shortCount).toBe(15)
    expect(applied.lines.showGrid).toBe(true)
  })

  it('reads prototype sidecars (mesh via image_path, no mesh key)', () => {
    const { objects } = scene()
    const json = JSON.stringify({
      props: { a: { length: 1, width: 2, color: '#abcdef', image_path: '/x/.cache/dead_reckoning/topdown/bin.png', image_rot: 0, img_bbox: [0, 1, 0, 1], locked: false, hidden: false } },
      apriltag: null,
      lines: {},
    })
    const applied = applySidecar(json, objects, ['bin'])
    expect(applied.objects.a.mesh).toBe('bin')
    expect(applied.tag).toBeNull()
  })
})
