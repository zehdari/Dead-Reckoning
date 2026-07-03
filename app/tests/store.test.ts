import { beforeEach, describe, expect, it } from 'vitest'
import { Tag, mapToWorld } from '../src/core/math'
import { Objects, computeMapPoses, makeProp } from '../src/core/model'
import { useStore } from '../src/state/store'

const st = () => useStore.getState()

const TAG: Tag = { x: 0, y: 11.43, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }

function seed(): void {
  const objects: Objects = {
    gate: makeProp('gate', { x: 2, y: 0, z: -0.8, yaw: 0 }),
    child: makeProp('child', { parent: 'gate', x: 0, y: 0.75, z: 0.4, yaw: 180 }),
  }
  const order = ['gate', 'child']
  useStore.setState({
    objects,
    order,
    mapPoses: computeMapPoses(objects, order),
    tag: { ...TAG },
    savedTags: {},
    selected: null,
    past: [],
    future: [],
    dirty: false,
    poolLock: false,
  })
}

const worldOf = (name: string): [number, number, number] => {
  const s = st()
  const mp = s.mapPoses[name]
  return mapToWorld(mp[0], mp[1], mp[3], s.tag)
}

beforeEach(() => {
  seed()
  st().endGesture() // reset gesture + coalescing state between tests
})

describe('undo/redo', () => {
  it('round-trips a pose edit', () => {
    st().setRelPose('gate', { x: 5 })
    expect(st().objects.gate.x).toBe(5)
    expect(st().past.length).toBe(1)
    st().undo()
    expect(st().objects.gate.x).toBe(2)
    expect(st().future.length).toBe(1)
    st().redo()
    expect(st().objects.gate.x).toBe(5)
    expect(st().future.length).toBe(0)
  })

  it('coalesces rapid edits of the same field, not different actions', () => {
    st().setRelPose('gate', { x: 3 })
    st().setRelPose('gate', { x: 4 }) // same key within the window -> coalesced
    expect(st().past.length).toBe(1)
    st().setRelPose('gate', { y: 1 }) // different field -> new step
    expect(st().past.length).toBe(2)
    st().undo()
    expect(st().objects.gate.y).toBe(0)
    expect(st().objects.gate.x).toBe(4)
    st().undo()
    expect(st().objects.gate.x).toBe(2)
  })

  it('a new edit clears the redo stack', () => {
    st().setRelPose('gate', { x: 3 })
    st().undo()
    expect(st().future.length).toBe(1)
    st().setRelPose('gate', { yaw: 10 })
    expect(st().future.length).toBe(0)
  })

  it('restores structural changes (delete brings the object back)', () => {
    st().deleteObject('gate')
    expect(st().objects.gate).toBeUndefined()
    expect(st().objects.child.parent).toBe('map') // orphan re-rooted
    st().undo()
    expect(st().objects.gate).toBeDefined()
    expect(st().objects.child.parent).toBe('gate')
  })

  it('collapses a canvas gesture into one step and skips no-op gestures', () => {
    st().beginGesture()
    st().setWorldXY('gate', 10, 5)
    st().setWorldXY('gate', 12, 6)
    st().setWorldXY('gate', 14, 7)
    st().endGesture()
    expect(st().past.length).toBe(1)
    st().undo()
    expect(st().objects.gate.x).toBe(2)

    const before = st().past.length
    const futureBefore = st().future.length
    st().beginGesture() // click without moving: nothing recorded, redo preserved
    st().endGesture()
    expect(st().past.length).toBe(before)
    expect(st().future.length).toBe(futureBefore)
  })
})

describe('pin to pool (poolLock)', () => {
  it('objects follow the origin by default', () => {
    const before = worldOf('gate')
    st().rotateTag(90)
    const after = worldOf('gate')
    expect(after[0]).not.toBeCloseTo(before[0], 3)
  })

  it('pinned objects keep their pool pose when the origin moves/rotates', () => {
    useStore.setState({ poolLock: true })
    const gBefore = worldOf('gate')
    const cBefore = worldOf('child')
    st().rotateTag(90)
    st().setOriginPos(4, 4)
    st().setTagOffset(33)
    const gAfter = worldOf('gate')
    const cAfter = worldOf('child')
    for (let i = 0; i < 2; i++) {
      expect(gAfter[i]).toBeCloseTo(gBefore[i], 9)
      expect(cAfter[i]).toBeCloseTo(cBefore[i], 9)
    }
    // map-relative pose actually changed (it was re-expressed)
    expect(st().objects.gate.x).not.toBeCloseTo(2, 6)
    // child rel pose untouched: it rides on its parent
    expect(st().objects.child.x).toBe(0)
    expect(st().objects.child.y).toBe(0.75)
  })

  it('undo of a pinned origin move restores tag and objects together', () => {
    useStore.setState({ poolLock: true })
    const relBefore = st().objects.gate.x
    st().rotateTag(90)
    st().undo()
    expect(st().tag.yawOffset).toBe(0)
    expect(st().objects.gate.x).toBe(relBefore)
  })
})

describe('origin mode switching (separate Tag / Robot poses)', () => {
  it('robot edits do not leak into the tag pose', () => {
    st().setOriginMode('robot')
    st().rotateTag(90)
    st().setOriginPos(20, 8)
    st().setOriginMode('apriltag')
    expect(st().tag).toMatchObject({ ...TAG }) // untouched original tag pose
  })

  it('each mode remembers its own pose across switches', () => {
    st().setOriginMode('robot')
    st().rotateTag(90)
    st().setOriginPos(20, 8)
    const robotTag = st().tag
    st().setOriginMode('apriltag')
    st().setOriginMode('robot')
    expect(st().tag).toEqual(robotTag)
  })

  it('a mode switch never moves objects in the pool, even unpinned', () => {
    st().setOriginMode('robot')
    st().rotateTag(90)
    st().setOriginPos(20, 8)
    const gBefore = worldOf('gate')
    const cBefore = worldOf('child')
    st().setOriginMode('apriltag')
    const gAfter = worldOf('gate')
    const cAfter = worldOf('child')
    for (let i = 0; i < 3; i++) {
      expect(gAfter[i]).toBeCloseTo(gBefore[i], 9)
      expect(cAfter[i]).toBeCloseTo(cBefore[i], 9)
    }
    // child rel pose untouched: it rides on its parent
    expect(st().objects.child.x).toBe(0)
    expect(st().objects.child.y).toBe(0.75)
  })

  it('first robot visit seeds from the tag without moving anything', () => {
    const before = worldOf('gate')
    st().setOriginMode('robot')
    expect(st().tag.basePhi).toBe(0)
    expect(st().tag.x).toBe(TAG.x)
    const after = worldOf('gate')
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i], 9)
  })

  it('undo restores the pre-switch origin and objects together', () => {
    st().setOriginMode('robot')
    st().rotateTag(90)
    st().setOriginMode('apriltag')
    st().undo() // back to rotated robot frame
    expect(st().tag.mode).toBe('robot')
    expect(st().tag.yawOffset).toBe(90)
    expect(st().objects.gate.x).toBe(2)
  })
})
