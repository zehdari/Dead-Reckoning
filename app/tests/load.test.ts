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
