/**
 * loadFromPath viz-state resolution: saved state wins, and a config with no
 * saved viz state (first run after install) gets the bundled defaults.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import manifest from '../public/topdown/manifest.json'
import { useStore } from '../src/state/store'

const CONFIG = readFileSync(new URL('./fixtures/config.yaml', import.meta.url), 'utf-8')
let vizState: string | null = null

vi.mock('../src/api', () => ({
  isDesktop: false,
  readFile: vi.fn(async () => CONFIG),
  writeFile: vi.fn(async () => {}),
  readViz: vi.fn(async () => vizState),
  writeViz: vi.fn(async () => {}),
}))

const st = () => useStore.getState()

beforeEach(() => {
  vizState = null
  useStore.setState({ manifest: manifest as never })
})

describe('loadFromPath viz state', () => {
  it('applies the bundled defaults when no viz state is saved', async () => {
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    const s = st()
    expect(s.order.length).toBeGreaterThan(0)
    expect(s.objects.gate.color).toBe('#8752c8')
    expect(s.objects.gate.mesh).toBe('gate')
    expect(s.objects.gate_rescue.locked).toBe(true)
    expect(s.objects.bin_target1.hidden).toBe(true)
    expect(s.tag).toMatchObject({ x: 22.2568, y: 0, basePhi: 90, wall: 'S' })
    expect(s.lines.shortCount).toBe(17)
    expect(s.lines.longCount).toBe(8)
  })

  it('prefers saved viz state over the bundled defaults', async () => {
    vizState = JSON.stringify({
      props: { gate: { length: 1, width: 2, color: '#010203', image_rot: 0, img_bbox: null, locked: true, hidden: false, mesh: null } },
      apriltag: { x: 1, y: 2, base_phi: 0, wall: 'W', yaw_offset: 0, mode: 'apriltag' },
      lines: { short_count: 3 },
    })
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    const s = st()
    expect(s.objects.gate.color).toBe('#010203')
    expect(s.objects.gate.locked).toBe(true)
    expect(s.tag).toMatchObject({ x: 1, y: 2, wall: 'W' })
    expect(s.lines.shortCount).toBe(3)
  })
})

describe('dirty tracking across pool swaps', () => {
  it('swapping pools without editing never dirties', async () => {
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    expect(st().dirty).toBe(false)
    const homeTag = st().tag

    st().setPool('rpac-divewell')
    expect(st().dirty).toBe(false) // viewing another venue is not a modification
    st().setPool('woollett')
    expect(st().dirty).toBe(false)
    expect(st().tag).toEqual(homeTag) // origin placement survived the trip

    // a real edit made while visiting dirties and stays dirty after swapping
    st().setPool('rpac-divewell')
    st().setLines({ shortAnchor: 4.5 })
    expect(st().dirty).toBe(true)
    st().setPool('woollett')
    expect(st().dirty).toBe(true)
    st().undo() // back onto RPAC, anchor edit still applied
    expect(st().dirty).toBe(true)
    st().undo() // revert the anchor edit -> everything matches the load again
    expect(st().dirty).toBe(false)
  })

  it('the user repro: save on both pools, swap back and forth — stays clean', async () => {
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    st().setPool('rpac-divewell')
    await st().saveToPath('/tmp/anywhere/config.yaml')
    expect(st().dirty).toBe(false)
    st().setPool('woollett')
    expect(st().dirty).toBe(false)
    st().setPool('rpac-divewell')
    expect(st().dirty).toBe(false)
  })

  it('moving the origin dirties; per-pool tags round-trip through the sidecar', async () => {
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    st().setOriginPos(5, 5)
    expect(st().dirty).toBe(true)
    st().setPool('rpac-divewell')
    expect(st().dirty).toBe(true) // the woollett origin edit is still unsaved
    await st().saveToPath('/tmp/anywhere/config.yaml')
    expect(st().dirty).toBe(false)

    // the save recorded both pools' origins — reload lands on RPAC and the
    // woollett placement comes back when swapping to it
    const api = await import('../src/api')
    const written = vi.mocked(api.writeViz).mock.calls.at(-1)?.[1]
    expect(written).toBeTruthy()
    const raw = JSON.parse(written!)
    expect(Object.keys(raw.apriltag_by_pool).sort()).toEqual(['rpac-divewell', 'woollett'])
    vizState = written!
    await st().loadFromPath('/tmp/anywhere/config.yaml')
    expect(st().pool.id).toBe('rpac-divewell')
    expect(st().dirty).toBe(false)
    st().setPool('woollett')
    expect(st().tag).toMatchObject({ x: 5, y: 5 })
    expect(st().dirty).toBe(false)
  })
})
