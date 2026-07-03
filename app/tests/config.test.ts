import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { emptyConfigText, loadConfig, saveConfig } from '../src/core/config'
import { compose } from '../src/core/math'
import { computeMapPoses, makeProp } from '../src/core/model'

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'config.yaml'), 'utf-8')

function load() {
  return loadConfig(FIXTURE)
}

function noopSave(): string {
  const { ns, objects, loadedNames } = load()
  return saveConfig(FIXTURE, ns, objects, loadedNames)
}

describe('loadConfig', () => {
  it('loads the talos namespace, skipping liltank and prequal', () => {
    const { ns, namespaces, objects } = load()
    expect(ns).toBe('/talos/riptide_mapping2')
    expect(namespaces).toEqual(['/talos/riptide_mapping2'])
    const names = objects.map((o) => o.name)
    expect(names).not.toContain('prequal_gate')
    expect(names).not.toContain('prequal_pole')
    expect(names).not.toContain('table_reefshark')
    expect(names).toContain('gate')
    expect(names).toContain('sos')
    expect(objects.length).toBe(35)
  })

  it('parses hierarchy, flags, class and covar', () => {
    const { objects } = load()
    const by = Object.fromEntries(objects.map((o) => [o.name, o]))
    expect(by.gate_rescue.parent).toBe('gate')
    expect(by.magnet1.parent).toBe('bin_cad_geometry')
    expect(by.slalom_parent.lockOrientation).toBe(true)
    expect(by.pill.pointYawAtParent).toBe(true)
    expect(by.bin_vinyl1.cls).toBe('fire')
    expect(by.bin_vinyl2.cls).toBe('blood')
    expect(by.gate.covar).toEqual({ x: 20.0, y: 20.0, z: 1.0, yaw: 50.0 })
    expect(by.gate_rescue.x).toBe(0.0)
    expect(by.gate_rescue.y).toBe(0.75)
    expect(by.gate_rescue.yaw).toBe(180.0)
  })

  it('default lock: everything with parent != map starts locked', () => {
    const { objects } = load()
    for (const o of objects) expect(o.locked).toBe(o.parent !== 'map')
  })

  it("gate_rescue's map pose == compose(gate_map, gate_rescue_rel)", () => {
    const { objects } = load()
    const objMap = Object.fromEntries(objects.map((o) => [o.name, o]))
    const order = objects.map((o) => o.name)
    const poses = computeMapPoses(objMap, order)
    const g = objMap.gate
    const r = objMap.gate_rescue
    const expected = compose([g.x, g.y, g.z, g.yaw], [r.x, r.y, r.z, r.yaw])
    for (let i = 0; i < 4; i++) expect(poses.gate_rescue[i]).toBeCloseTo(expected[i], 9)
  })
})

describe('saveConfig round-trip', () => {
  it('no-op save is byte-identical to the original file', () => {
    expect(noopSave()).toBe(FIXTURE)
  })

  it('no-op save is semantically identical and preserves comments/sections', () => {
    const out = noopSave()
    expect(parse(out)).toEqual(parse(FIXTURE))
    for (const marker of [
      '# BOTH-ROBOTS SETTTINGS',
      '# Covariance filter parameters',
      '# Cursed ah bin geometry fit thresholds',
      "# DO NOT CHANGE THIS OR IT'S CHILDREN'S POSE! DIRECTLY FROM BIN CAD FILE.",
      '#NO TOUCH',
      '# SET PER RUN',
      '# Needs to be fairly accurate for bin fit to work',
      '/**/riptide_mapping2:',
      '/liltank/riptide_mapping2:',
      'prequal_gate:',
      'prequal_pole:',
      'table_reefshark:',
    ])
      expect(out).toContain(marker)
  })

  it('save is idempotent (second save is byte-identical)', () => {
    const first = noopSave()
    const { ns, objects, loadedNames } = load()
    const second = saveConfig(first, ns, objects, loadedNames)
    expect(second).toBe(first)
  })

  it('changing one pose value changes exactly that line (byte-level vs original)', () => {
    const { ns, objects, loadedNames } = load()
    const edited = objects.map((o) => (o.name === 'gate' ? { ...o, x: 3.25 } : o))
    const out = saveConfig(FIXTURE, ns, edited, loadedNames)
    const a = FIXTURE.split('\n')
    const b = out.split('\n')
    expect(b.length).toBe(a.length)
    const diffs = a.map((line, i) => [line, b[i], i] as const).filter(([x, y]) => x !== y)
    expect(diffs.length).toBe(1)
    expect(diffs[0][0].trim()).toBe('x: 2.0')
    expect(diffs[0][1].trim()).toBe('x: 3.25')
  })

  it('editing a value keeps its same-line comment byte-for-byte', () => {
    const { ns, objects, loadedNames } = load()
    const edited = objects.map((o) => (o.name === 'bin' ? { ...o, yaw: 12.5 } : o))
    const out = saveConfig(FIXTURE, ns, edited, loadedNames)
    expect(out).toContain('yaw: 12.5 # Needs to be fairly accurate for bin fit to work')
  })

  it('always writes floats (never bare ints), including negatives', () => {
    const { ns, objects, loadedNames } = load()
    const edited = objects.map((o) =>
      o.name === 'torpedo' ? { ...o, x: -12.0, y: 3.0, yaw: -90.0 } : o,
    )
    const out = saveConfig(FIXTURE, ns, edited, loadedNames)
    const torpedo = out.split('torpedo:')[1].split('fire_hole_large:')[0]
    expect(torpedo).toContain('x: -12.0')
    expect(torpedo).toContain('y: 3.0')
    expect(torpedo).toContain('yaw: -90.0')
    expect(torpedo).not.toMatch(/x: -12\s*$/m)
  })

  it('adds new objects with full float-formatted entries', () => {
    const { ns, objects, loadedNames } = load()
    const added = [
      ...objects,
      makeProp('marker_buoy', { parent: 'map', x: 7.5, y: -2, z: -1, yaw: 45.5 }),
    ]
    const out = saveConfig(FIXTURE, ns, added, loadedNames)
    expect(out).toContain('marker_buoy:')
    const entry = out.split('marker_buoy:')[1]
    expect(entry).toContain('parent: map')
    expect(entry).toContain('x: 7.5')
    expect(entry).toContain('y: -2.0')
    expect(entry).toContain('yaw: 45.5')
    const reloaded = loadConfig(out)
    expect(reloaded.objects.map((o) => o.name)).toContain('marker_buoy')
  })

  it('removes deleted objects but preserves deprecated prequal + liltank', () => {
    const { ns, objects, loadedNames } = load()
    const without = objects.filter((o) => o.name !== 'compass')
    const out = saveConfig(FIXTURE, ns, without, loadedNames)
    expect(out).not.toMatch(/^ {6}compass:/m)
    expect(out).toContain('prequal_gate:')
    expect(out).toContain('prequal_pole:')
    expect(out).toContain('/liltank/riptide_mapping2:')
    expect(out).toContain('buffer_size: 30')
  })

  it('flags are added when set and removed when cleared', () => {
    const { ns, objects, loadedNames } = load()
    const edited = objects.map((o) =>
      o.name === 'gate'
        ? { ...o, lockOrientation: true }
        : o.name === 'table'
          ? { ...o, lockOrientation: false }
          : o,
    )
    const out = saveConfig(FIXTURE, ns, edited, loadedNames)
    const gate = out.split(/^ {6}gate:/m)[1].split('gate_rescue:')[0]
    expect(gate).toContain('lock_orientation_to_config: true')
    const table = out.split(/^ {6}table:/m)[1].split('pill:')[0]
    expect(table).not.toContain('lock_orientation_to_config')
  })

  it('class edits round-trip (bin vinyls fire/blood)', () => {
    const { ns, objects, loadedNames } = load()
    const edited = objects.map((o) => (o.name === 'bin_vinyl1' ? { ...o, cls: 'blood' } : o))
    const out = saveConfig(FIXTURE, ns, edited, loadedNames)
    const v1 = out.split('bin_vinyl1:')[1].split('bin_vinyl2:')[0]
    expect(v1).toContain('class: blood')
    // comment on that line is preserved
    expect(v1).toContain('SET PER RUN')
  })

  it('can start from an empty config', () => {
    const text = emptyConfigText()
    const out = saveConfig(text, '/talos/riptide_mapping2', [makeProp('gate', { x: 2, z: -0.8 })], [])
    const reloaded = loadConfig(out)
    expect(reloaded.objects.length).toBe(1)
    expect(reloaded.objects[0].name).toBe('gate')
    expect(out).toContain('x: 2.0')
    expect(out).toContain('buffer_size: 60')
  })
})
