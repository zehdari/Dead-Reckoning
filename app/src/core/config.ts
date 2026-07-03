/**
 * riptide_mapping config.yaml I/O with a comment/order-preserving round-trip.
 *
 * Rules (per SPEC §5):
 *  - Only the selected `<ns>/riptide_mapping2` namespace is edited (talos by
 *    default); `/liltank/...` is deprecated and never offered.
 *  - `prequal_gate` / `prequal_pole` are deprecated: not loaded, not displayed,
 *    preserved untouched on save.
 *  - Save updates only parent/pose/covar/class/flags for edited objects, adds
 *    new objects, removes user-deleted ones. Comments, key order, the global
 *    `/**​/` section and unrelated keys are preserved (values that did not
 *    change are not re-written, so their exact source formatting survives).
 *  - pose.yaw / covar.yaw are degrees. Numbers are always written as YAML
 *    floats ("2.0", never "2") so ROS 2 param type inference stays `double`.
 */
import { parseDocument, parse, Document, YAMLMap, Pair, Scalar, isMap, isScalar } from 'yaml'
import { MAP } from './math'
import { Covar, PropObj, defaultCovar, makeProp } from './model'

export const DEPRECATED_OBJECTS = new Set(['prequal_gate', 'prequal_pole'])
export const DEPRECATED_NS_SUBSTRINGS = ['liltank']

export interface LoadedConfig {
  ns: string
  namespaces: string[]
  objects: PropObj[]
  /** names present in the file that the tool models (used to detect deletions) */
  loadedNames: string[]
}

function nsHasInitData(v: unknown): boolean {
  if (!isMap(v)) return false
  const rp = v.get('ros__parameters')
  return isMap(rp) && isMap(rp.get('init_data'))
}

export function findNamespaces(doc: Document): string[] {
  const out: string[] = []
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      const key = String((item.key as Scalar)?.value ?? '')
      if (nsHasInitData(item.value) && !DEPRECATED_NS_SUBSTRINGS.some((s) => key.includes(s)))
        out.push(key)
    }
  }
  return out
}

export function loadConfig(text: string, preferredNs?: string): LoadedConfig {
  const doc = parseDocument(text)
  const namespaces = findNamespaces(doc)
  if (!namespaces.length)
    throw new Error("No '<ns>/riptide_mapping2 -> ros__parameters -> init_data' found.")
  const ns =
    preferredNs && namespaces.includes(preferredNs)
      ? preferredNs
      : (namespaces.find((n) => n.includes('talos')) ?? namespaces[0])

  const init = doc.getIn([ns, 'ros__parameters', 'init_data'])
  if (!isMap(init)) throw new Error(`init_data is not a map in ${ns}`)

  const objects: PropObj[] = []
  const loadedNames: string[] = []
  for (const item of init.items) {
    const name = String((item.key as Scalar)?.value ?? '')
    if (!name || DEPRECATED_OBJECTS.has(name)) continue
    const entry = item.value
    if (!isMap(entry)) continue
    const rawParent = String(entry.get('parent') ?? MAP)
    const parent =
      rawParent === MAP ? MAP : rawParent.endsWith('_frame') ? rawParent.slice(0, -6) : rawParent
    const pose = isMap(entry.get('pose')) ? (entry.get('pose') as YAMLMap) : null
    const covar = isMap(entry.get('covar')) ? (entry.get('covar') as YAMLMap) : null
    const num = (m: YAMLMap | null, k: string, d: number) => {
      const v = m?.get(k)
      return typeof v === 'number' ? v : d
    }
    const covarObj: Covar = {
      x: num(covar, 'x', 1.0),
      y: num(covar, 'y', 1.0),
      z: num(covar, 'z', 1.0),
      yaw: num(covar, 'yaw', 1.0),
    }
    const clsRaw = entry.get('class')
    objects.push(
      makeProp(name, {
        parent,
        x: num(pose, 'x', 0),
        y: num(pose, 'y', 0),
        z: num(pose, 'z', 0),
        yaw: num(pose, 'yaw', 0),
        covar: covarObj,
        lockOrientation: entry.get('lock_orientation_to_config') === true,
        pointYawAtParent: entry.get('point_yaw_at_parent') === true,
        cls: clsRaw != null ? String(clsRaw) : null,
        // Default on load: everything that is not a direct child of map starts
        // locked (reckoners position root task assemblies; children ride along).
        // The viz sidecar, applied afterwards, overrides this.
        locked: parent !== MAP,
      }),
    )
    loadedNames.push(name)
  }
  return { ns, namespaces, objects, loadedNames }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * Set a numeric value, but only if it actually changed — untouched scalars keep
 * their exact original text. New/changed values are written as floats.
 */
function setNum(map: YAMLMap, key: string, value: number): void {
  const v = round6(value)
  const cur = map.get(key, true)
  if (cur instanceof Scalar && typeof cur.value === 'number' && Math.abs(cur.value - v) < 5e-7)
    return
  map.set(key, floatScalar(v))
}

function floatScalar(v: number): Scalar {
  const s = new Scalar(v)
  if (Number.isInteger(v)) s.minFractionDigits = 1
  return s
}

function setIfChanged(map: YAMLMap, key: string, value: string | boolean): void {
  if (map.get(key) !== value) map.set(key, value)
}

function deleteIfPresent(map: YAMLMap, key: string): void {
  if (map.has(key)) map.delete(key)
}

function ensureMap(doc: Document, parent: YAMLMap, key: string): YAMLMap {
  const cur = parent.get(key)
  if (isMap(cur)) return cur
  const m = doc.createNode({}) as YAMLMap
  parent.set(key, m)
  return m
}

/** Minimal document for "save as" without a loaded file. */
export function emptyConfigText(ns = '/talos/riptide_mapping2'): string {
  return `${ns}:\n  ros__parameters:\n    init_data: {}\n    buffer_size: 60\n`
}

/**
 * Apply the model to the original config text and return the new text.
 * `loadedNames` = object names the model owned when the text was loaded (or
 * last saved); names present in init_data but absent from `objects` AND listed
 * there are user deletions. Everything else (deprecated objects, other
 * namespaces, unknown keys) is preserved untouched.
 *
 * Strategy: first try byte-range splices into the original text (AST source
 * ranges), which keeps every untouched byte identical — a no-op save returns
 * the input verbatim. The result is verified semantically against a full
 * AST-level rewrite; on any mismatch or unsupported structure the AST result
 * (comment-preserving, but with cosmetic normalization) is used instead.
 */
export function saveConfig(
  text: string,
  ns: string,
  objects: PropObj[],
  loadedNames: string[],
): string {
  const astOut = saveConfigAst(text, ns, objects, loadedNames)
  try {
    const spliced = spliceSave(text, ns, objects, loadedNames)
    if (spliced !== null && semanticEqual(parse(spliced), parse(astOut))) return spliced
  } catch {
    /* fall back to the AST rewrite */
  }
  return astOut
}

function saveConfigAst(
  text: string,
  ns: string,
  objects: PropObj[],
  loadedNames: string[],
): string {
  const doc = parseDocument(text)
  if (!isMap(doc.contents)) throw new Error('config root is not a mapping')
  const root = doc.contents as YAMLMap
  const nsMap = ensureMap(doc, root, ns)
  const rp = ensureMap(doc, nsMap, 'ros__parameters')
  const init = ensureMap(doc, rp, 'init_data')
  // an empty init_data may have been parsed/created as a flow map ({}) — new
  // entries must be block style to look like the rest of the file
  if (init.items.length === 0 && objects.length > 0) init.flow = false

  const currentNames = new Set(objects.map((p) => p.name))
  for (const p of objects) {
    let entry = init.get(p.name)
    if (!isMap(entry)) {
      entry = doc.createNode({}) as YAMLMap
      ;(entry as YAMLMap).flow = false
      init.set(p.name, entry)
    }
    const e = entry as YAMLMap
    setIfChanged(e, 'parent', p.parent === MAP ? MAP : `${p.parent}_frame`)
    if (p.cls != null && p.cls !== '') setIfChanged(e, 'class', p.cls)
    else deleteIfPresent(e, 'class')
    if (p.lockOrientation) setIfChanged(e, 'lock_orientation_to_config', true)
    else deleteIfPresent(e, 'lock_orientation_to_config')
    if (p.pointYawAtParent) setIfChanged(e, 'point_yaw_at_parent', true)
    else deleteIfPresent(e, 'point_yaw_at_parent')
    const cov = ensureMap(doc, e, 'covar')
    const cv = { ...defaultCovar(), ...p.covar }
    setNum(cov, 'x', cv.x)
    setNum(cov, 'y', cv.y)
    setNum(cov, 'z', cv.z)
    setNum(cov, 'yaw', cv.yaw)
    const pose = ensureMap(doc, e, 'pose')
    setNum(pose, 'x', p.x)
    setNum(pose, 'y', p.y)
    setNum(pose, 'z', p.z)
    setNum(pose, 'yaw', p.yaw)
  }

  // deletions: only names the tool loaded and the user then removed
  for (const name of loadedNames) {
    if (!currentNames.has(name) && !DEPRECATED_OBJECTS.has(name) && init.has(name))
      init.delete(name)
  }

  if (!rp.has('buffer_size')) rp.set('buffer_size', 60)
  return doc.toString({ lineWidth: 0 })
}

// --------------------------- byte-splice save path ---------------------------

interface Splice {
  start: number
  end: number
  text: string
}

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/
const PLAIN_VAL = /^[A-Za-z0-9_.-]+$/

const lineStartAt = (text: string, idx: number) => text.lastIndexOf('\n', idx - 1) + 1
const lineEndAfter = (text: string, idx: number) => {
  const e = text.indexOf('\n', idx)
  return e === -1 ? text.length : e + 1
}

function formatFloat(v: number): string {
  let s = String(round6(v))
  if (!/[.eE]/.test(s)) s += '.0'
  return s
}

function getPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((it) => (it.key as Scalar)?.value === key) as Pair | undefined
}

/** Splice that removes the pair's full line(s), including trailing comments. */
function deletePairSplice(text: string, pair: Pair): Splice {
  const keyStart = (pair.key as Scalar).range![0]
  const node = (pair.value ?? pair.key) as Scalar
  const end = Math.max(node.range![2], (pair.key as Scalar).range![2])
  return { start: lineStartAt(text, keyStart), end: lineEndAfter(text, end - 1), text: '' }
}

function entryText(p: PropObj, indent: string): string | null {
  if (!PLAIN_KEY.test(p.name)) return null
  if (p.cls && !PLAIN_VAL.test(p.cls)) return null
  const f = indent + '  '
  const n = f + '  '
  const cv = { ...defaultCovar(), ...p.covar }
  return (
    `${indent}${p.name}:\n` +
    `${f}parent: ${p.parent === MAP ? MAP : `${p.parent}_frame`}\n` +
    (p.cls ? `${f}class: ${p.cls}\n` : '') +
    (p.lockOrientation ? `${f}lock_orientation_to_config: true\n` : '') +
    (p.pointYawAtParent ? `${f}point_yaw_at_parent: true\n` : '') +
    `${f}covar:\n` +
    `${n}x: ${formatFloat(cv.x)}\n${n}y: ${formatFloat(cv.y)}\n${n}z: ${formatFloat(cv.z)}\n${n}yaw: ${formatFloat(cv.yaw)}\n` +
    `${f}pose:\n` +
    `${n}x: ${formatFloat(p.x)}\n${n}y: ${formatFloat(p.y)}\n${n}z: ${formatFloat(p.z)}\n${n}yaw: ${formatFloat(p.yaw)}\n`
  )
}

function spliceSave(
  text: string,
  ns: string,
  objects: PropObj[],
  loadedNames: string[],
): string | null {
  const doc = parseDocument(text)
  if (!isMap(doc.contents)) return null
  const rp = doc.getIn([ns, 'ros__parameters'])
  if (!isMap(rp) || !rp.has('buffer_size')) return null
  const init = rp.get('init_data')
  if (!isMap(init) || init.flow || init.items.length === 0) return null

  const splices: Splice[] = []
  const entryPairs = init.items as Pair[]
  const firstKey = entryPairs[0].key as Scalar
  const entryIndent = text.slice(lineStartAt(text, firstKey.range![0]), firstKey.range![0])
  if (!/^ *$/.test(entryIndent)) return null
  const fieldIndent = entryIndent + '  '

  const newEntries: string[] = []
  for (const p of objects) {
    const pair = getPair(init, p.name)
    if (!pair) {
      const et = entryText(p, entryIndent)
      if (et === null) return null
      newEntries.push(et)
      continue
    }
    const e = pair.value
    if (!isMap(e)) return null

    const parentStr = p.parent === MAP ? MAP : `${p.parent}_frame`
    if (parentStr !== MAP && !PLAIN_VAL.test(parentStr)) return null
    const parentPair = getPair(e, 'parent')
    if (!parentPair || !isScalar(parentPair.value) || !parentPair.value.range) return null
    if (parentPair.value.value !== parentStr)
      splices.push({ start: parentPair.value.range[0], end: parentPair.value.range[1], text: parentStr })

    // class + flags; new keys are inserted right after the parent line
    const insertAt = lineEndAfter(text, parentPair.value.range[1])
    const inserts: string[] = []
    const clsPair = getPair(e, 'class')
    if (p.cls != null && p.cls !== '') {
      if (!PLAIN_VAL.test(p.cls)) return null
      if (clsPair) {
        if (!isScalar(clsPair.value) || !clsPair.value.range) return null
        if (String(clsPair.value.value) !== p.cls)
          splices.push({ start: clsPair.value.range[0], end: clsPair.value.range[1], text: p.cls })
      } else inserts.push(`${fieldIndent}class: ${p.cls}\n`)
    } else if (clsPair) splices.push(deletePairSplice(text, clsPair))

    for (const [key, val] of [
      ['lock_orientation_to_config', p.lockOrientation],
      ['point_yaw_at_parent', p.pointYawAtParent],
    ] as const) {
      const fp = getPair(e, key)
      if (val) {
        if (fp) {
          if (!isScalar(fp.value) || !fp.value.range) return null
          if (fp.value.value !== true)
            splices.push({ start: fp.value.range[0], end: fp.value.range[1], text: 'true' })
        } else inserts.push(`${fieldIndent}${key}: true\n`)
      } else if (fp) splices.push(deletePairSplice(text, fp))
    }
    if (inserts.length) splices.push({ start: insertAt, end: insertAt, text: inserts.join('') })

    const cv = { ...defaultCovar(), ...p.covar }
    for (const [mapKey, vals] of [
      ['covar', cv],
      ['pose', { x: p.x, y: p.y, z: p.z, yaw: p.yaw }],
    ] as const) {
      const mp = getPair(e, mapKey)
      if (!mp || !isMap(mp.value)) return null
      for (const k of ['x', 'y', 'z', 'yaw'] as const) {
        const vp = getPair(mp.value as YAMLMap, k)
        if (!vp || !isScalar(vp.value) || typeof vp.value.value !== 'number' || !vp.value.range)
          return null
        const nv = round6(vals[k])
        if (Math.abs(vp.value.value - nv) < 5e-7) continue
        splices.push({ start: vp.value.range[0], end: vp.value.range[1], text: formatFloat(nv) })
      }
    }
  }

  const currentNames = new Set(objects.map((p) => p.name))
  for (const name of loadedNames) {
    if (currentNames.has(name) || DEPRECATED_OBJECTS.has(name)) continue
    const pair = getPair(init, name)
    if (pair) splices.push(deletePairSplice(text, pair))
  }

  if (newEntries.length) {
    const lastPair = entryPairs[entryPairs.length - 1]
    const endNode = (lastPair.value ?? lastPair.key) as Scalar
    const at = lineEndAfter(text, endNode.range![2] - 1)
    splices.push({ start: at, end: at, text: newEntries.join('') })
  }

  return applySplices(text, splices)
}

function applySplices(text: string, splices: Splice[]): string | null {
  const sorted = splices.slice().sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return null
  let out = text
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    out = out.slice(0, s.start) + s.text + out.slice(s.end)
  }
  return out
}

/** Deep equality, order-insensitive for object keys (key positions may differ). */
function semanticEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => semanticEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((k) => semanticEqual((a as any)[k], (b as any)[k]))
  }
  return false
}
