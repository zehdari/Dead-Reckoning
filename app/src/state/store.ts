/**
 * Single zustand store: canonical scene model + UI state. The Pixi canvas
 * subscribes imperatively (no React re-render on the drag hot path); panels
 * subscribe via selectors.
 */
import { create } from 'zustand'
import {
  MAP,
  OriginMode,
  POOL_LENGTH_M,
  POOL_WIDTH_M,
  Pose4,
  Tag,
  mapToWorld,
  nearestCandidate,
  normDeg,
  tagCandidates,
  worldToMap,
} from '../core/math'
import {
  Objects,
  PropObj,
  computeMapPoses,
  childrenOf,
  descendants,
  makeProp,
  relativeUnder,
  uniqueName,
} from '../core/model'
import { DEPRECATED_OBJECTS, emptyConfigText, loadConfig, saveConfig } from '../core/config'
import { LinesConfig, applySidecar, buildSidecar, defaultLines } from '../core/sidecar'
import { TopdownManifest, meshFootprint, resolveMeshDir } from '../core/mesh'
import * as api from '../api'

export interface Session {
  text: string
  ns: string
  loadedNames: string[]
}

export interface StatusMsg {
  text: string
  kind: 'info' | 'error'
  at: number
}

export type Theme = 'light' | 'dark'
export type LabelMode = 'roots' | 'all' | 'none'
/** what "Place origin" mode is waiting to place (null = not placing) */
export type PlaceMode = 'apriltag' | 'robot' | null

/** One undo step: everything the user can mutate that isn't pure UI chrome. */
interface Snapshot {
  objects: Objects
  order: string[]
  tag: Tag
  lines: LinesConfig
  selected: string | null
}

export interface State {
  objects: Objects
  order: string[]
  mapPoses: Record<string, Pose4>
  tag: Tag
  /** the inactive origin mode's last pose — Tag and Robot each keep their own */
  savedTags: Partial<Record<OriginMode, Tag>>
  lines: LinesConfig
  selected: string | null
  /** legacy: true while placing (kept for the canvas); mirrors placeMode != null */
  tagMode: boolean
  placeMode: PlaceMode
  configPath: string | null
  session: Session | null
  dirty: boolean
  status: StatusMsg
  home: string | null
  manifest: TopdownManifest
  cursor: { wx: number; wy: number } | null
  // UI (persisted to localStorage, not the sidecar)
  theme: Theme
  labelMode: LabelMode
  leftOpen: boolean
  rightOpen: boolean
  /** show the x/y/z/yaw columns in the Objects panel */
  showPoseCols: boolean
  /** pin objects to the pool: moving/rotating the tag/origin re-expresses map
   *  poses so nothing follows the frame (off = current/default behavior) */
  poolLock: boolean

  // undo/redo
  past: Snapshot[]
  future: Snapshot[]
  undo: () => void
  redo: () => void
  /** canvas drag gestures: one undo step per gesture, not per pointermove */
  beginGesture: () => void
  endGesture: () => void

  // selection & modes
  select: (name: string | null) => void
  setTagMode: (on: boolean) => void
  setPlaceMode: (mode: PlaceMode) => void
  setPoolLock: (on: boolean) => void

  // UI
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setLabelMode: (m: LabelMode) => void
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
  setShowPoseCols: (on: boolean) => void

  // origin (AprilTag or robot frame)
  placeTagAtWorld: (wx: number, wy: number) => boolean
  placeOriginFree: (wx: number, wy: number) => void
  setOriginPos: (wx: number, wy: number) => void
  setOriginMode: (mode: OriginMode) => void
  rotateTag: (deltaDeg: number) => void
  setTagOffset: (deg: number) => void
  setOriginYawWorld: (wyawDeg: number) => void

  // objects (swaps, e.g. table items among themselves or the two gate sides)
  swapPose: (a: string, b: string) => void
  swapClass: (a: string, b: string) => void

  // lines / view options
  setLines: (patch: Partial<LinesConfig>) => void

  // objects
  addObject: (parent?: string) => string
  duplicateObject: (name: string) => string | null
  deleteObject: (name: string) => void
  renameObject: (name: string, next: string) => boolean
  reparentObject: (name: string, parent: string) => void
  patchObject: (name: string, patch: Partial<PropObj>) => void
  setRelPose: (name: string, patch: Partial<Pick<PropObj, 'x' | 'y' | 'z' | 'yaw'>>) => void
  setWorldXY: (name: string, wx: number, wy: number) => void
  setWorldYaw: (name: string, wyawDeg: number) => void
  nudgeWorld: (name: string, dx: number, dy: number) => void
  setFootprint: (name: string, length: number, width: number) => void
  assignMesh: (name: string, mesh: string | null) => void
  autoAssignMeshes: () => number

  // io
  bootstrap: () => Promise<void>
  loadFromPath: (path: string) => Promise<void>
  saveToPath: (path: string) => Promise<void>
  say: (text: string, kind?: 'info' | 'error') => void
}

function defaultTag(): Tag {
  return { x: 0, y: POOL_WIDTH_M / 2, basePhi: 0, wall: 'W', yawOffset: 0, mode: 'apriltag' }
}

const LS = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(`dr.${key}`) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`dr.${key}`, value)
    } catch {
      /* private mode / SSR */
    }
  },
}

function initialTheme(): Theme {
  const saved = LS.get('theme', '')
  if (saved === 'light' || saved === 'dark') return saved
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function placeholderObjects(tag: Tag): { objects: Objects; order: string[] } {
  const cx = POOL_LENGTH_M / 2
  const cy = POOL_WIDTH_M / 2
  const spots: [string, number, number, Partial<PropObj>][] = [
    ['gate', cx - 13, cy, { length: 0.3, width: 3.0 }],
    ['buoy', cx - 6, cy + 1.5, { length: 0.4, width: 0.4 }],
    ['bin', cx + 2, cy - 3, { length: 1.2, width: 0.9 }],
    ['torpedo', cx + 10, cy + 2, { length: 1.0, width: 1.0 }],
  ]
  const objects: Objects = {}
  const order: string[] = []
  for (const [name, wx, wy, extra] of spots) {
    const [mx, my, myaw] = worldToMap(wx, wy, 0, tag)
    objects[name] = makeProp(name, { x: mx, y: my, yaw: myaw, ...extra })
    order.push(name)
  }
  return { objects, order }
}

export const useStore = create<State>()((set, get) => {
  /** apply an objects/order change + recompute derived map poses + mark dirty */
  const commit = (
    objects: Objects,
    order: string[],
    extra: Partial<State> = {},
    dirty = true,
  ): void => {
    set({ objects, order, mapPoses: computeMapPoses(objects, order), ...(dirty && { dirty: true }), ...extra })
  }

  // ------------------------------ undo history ------------------------------
  const HISTORY_MAX = 100
  let gestureActive = false
  /** pre-gesture state, pushed lazily on the gesture's first real mutation */
  let pendingGesture: Snapshot | null = null
  let lastKey: string | null = null
  let lastAt = 0
  /** state refs as of the last load/save — undoing back to them clears dirty */
  let baseline: Omit<Snapshot, 'selected'> | null = null

  const snapshot = (s: State): Snapshot => ({
    objects: s.objects,
    order: s.order,
    tag: s.tag,
    lines: s.lines,
    selected: s.selected,
  })

  /**
   * Push the current state onto the undo stack. Call at the top of every
   * mutating action (after its early-outs). `key` coalesces bursts of the same
   * edit (spinner clicks, arrow-key repeats, color-picker drags) into one step;
   * during a canvas gesture only the beginGesture push counts.
   */
  const record = (key?: string): void => {
    if (gestureActive) {
      if (pendingGesture) {
        set({ past: [...get().past, pendingGesture].slice(-HISTORY_MAX), future: [] })
        pendingGesture = null
      }
      return
    }
    const now = Date.now()
    if (key && key === lastKey && now - lastAt < 800) {
      lastAt = now
      return
    }
    lastKey = key ?? null
    lastAt = now
    const s = get()
    set({ past: [...s.past, snapshot(s)].slice(-HISTORY_MAX), future: [] })
  }

  const atBaseline = (s: State): boolean =>
    !!baseline &&
    baseline.objects === s.objects &&
    baseline.order === s.order &&
    baseline.tag === s.tag &&
    baseline.lines === s.lines

  const markClean = (): void => {
    const s = get()
    baseline = { objects: s.objects, order: s.order, tag: s.tag, lines: s.lines }
  }

  const restore = (snap: Snapshot): Partial<State> => ({
    objects: snap.objects,
    order: snap.order,
    tag: snap.tag,
    lines: snap.lines,
    mapPoses: computeMapPoses(snap.objects, snap.order),
    selected: snap.selected && snap.objects[snap.selected] ? snap.selected : null,
  })

  const withMapPose = (name: string, mapPose: Pose4): void => {
    const s = get()
    const p = s.objects[name]
    if (!p || p.locked) return
    record(`world:${name}`)
    const rel = relativeUnder(p.parent, s.mapPoses, mapPose)
    const objects = {
      ...s.objects,
      [name]: { ...p, x: rel[0], y: rel[1], z: rel[2], yaw: rel[3] },
    }
    commit(objects, s.order)
  }

  /**
   * Change the origin/tag. With poolLock on, every map-root object is
   * re-expressed under the new frame so its pool-world pose is unchanged
   * (children ride on their parents, so roots are enough).
   */
  const applyTag = (tag: Tag, extra: Partial<State> = {}): void => {
    const s = get()
    if (!s.poolLock) {
      set({ tag, dirty: true, ...extra })
      return
    }
    const objects = { ...s.objects }
    for (const n of s.order) {
      const p = objects[n]
      if (p.parent !== MAP && s.objects[p.parent]) continue
      const [wx, wy, wyaw] = mapToWorld(p.x, p.y, p.yaw, s.tag)
      const [nx, ny, nyaw] = worldToMap(wx, wy, wyaw, tag)
      objects[n] = { ...p, x: nx, y: ny, yaw: nyaw }
    }
    commit(objects, s.order, { tag, ...extra })
  }

  return {
    objects: {},
    order: [],
    mapPoses: {},
    tag: defaultTag(),
    savedTags: {},
    lines: defaultLines(),
    selected: null,
    tagMode: false,
    placeMode: null,
    configPath: null,
    session: null,
    dirty: false,
    status: { text: '', kind: 'info', at: 0 },
    home: null,
    manifest: {},
    cursor: null,
    theme: initialTheme(),
    labelMode: (LS.get('labels', 'roots') as LabelMode) || 'roots',
    leftOpen: LS.get('leftOpen', '1') !== '0',
    rightOpen: LS.get('rightOpen', '1') !== '0',
    showPoseCols: LS.get('poseCols', '0') === '1',
    poolLock: LS.get('poolLock', '0') === '1',
    past: [],
    future: [],

    say: (text, kind = 'info') => set({ status: { text, kind, at: Date.now() } }),

    select: (name) => set({ selected: name }),
    setTagMode: (on) => set({ tagMode: on, placeMode: on ? (get().placeMode ?? 'apriltag') : null }),
    setPlaceMode: (mode) => set({ placeMode: mode, tagMode: mode !== null }),
    setPoolLock: (on) => {
      LS.set('poolLock', on ? '1' : '0')
      set({ poolLock: on })
    },

    undo: () => {
      const s = get()
      const snap = s.past[s.past.length - 1]
      if (!snap) return
      lastKey = null
      set({
        past: s.past.slice(0, -1),
        future: [...s.future, snapshot(s)],
        ...restore(snap),
      })
      set({ dirty: !atBaseline(get()) })
    },

    redo: () => {
      const s = get()
      const snap = s.future[s.future.length - 1]
      if (!snap) return
      lastKey = null
      set({
        future: s.future.slice(0, -1),
        past: [...s.past, snapshot(s)],
        ...restore(snap),
      })
      set({ dirty: !atBaseline(get()) })
    },

    beginGesture: () => {
      pendingGesture = snapshot(get())
      gestureActive = true
    },

    endGesture: () => {
      gestureActive = false
      pendingGesture = null
      lastKey = null
    },

    setTheme: (t) => {
      LS.set('theme', t)
      set({ theme: t })
    },
    toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    setLabelMode: (m) => {
      LS.set('labels', m)
      set({ labelMode: m })
    },
    setLeftOpen: (open) => {
      LS.set('leftOpen', open ? '1' : '0')
      set({ leftOpen: open })
    },
    setRightOpen: (open) => {
      LS.set('rightOpen', open ? '1' : '0')
      set({ rightOpen: open })
    },
    setShowPoseCols: (on) => {
      LS.set('poseCols', on ? '1' : '0')
      set({ showPoseCols: on })
    },

    placeTagAtWorld: (wx, wy) => {
      const s = get()
      const cands = tagCandidates(
        s.lines.shortShow,
        s.lines.shortCount,
        s.lines.shortSpacing,
        s.lines.longShow,
        s.lines.longCount,
        s.lines.longSpacing,
      )
      const c = nearestCandidate(cands, wx, wy, 3.0)
      if (!c) {
        get().say('No bottom-line / wall intersection within 3 m of that click.', 'error')
        return false
      }
      record()
      const tag: Tag = {
        x: c.x,
        y: c.y,
        basePhi: c.phi,
        wall: c.wall,
        yawOffset: s.tag.yawOffset,
        mode: 'apriltag',
      }
      applyTag(tag, { tagMode: false, placeMode: null })
      get().say(`AprilTag on ${c.wall} wall at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}), facing into the pool.`)
      return true
    },

    placeOriginFree: (wx, wy) => {
      record()
      const t = get().tag
      applyTag({ ...t, x: wx, y: wy, mode: 'robot' }, { tagMode: false, placeMode: null })
      get().say(`Robot-frame map origin at pool (${wx.toFixed(2)}, ${wy.toFixed(2)}).`)
    },

    setOriginPos: (wx, wy) => {
      record('originPos')
      const t = get().tag
      applyTag({ ...t, x: wx, y: wy })
    },

    setOriginMode: (mode) => {
      const s = get()
      const t = s.tag
      if (t.mode === mode) return
      record()
      // each mode keeps its own origin pose. First robot visit seeds from the
      // tag with the heading folded into a free offset (basePhi 0) so the ±90
      // buttons and yaw field rotate the frame freely.
      const tag: Tag =
        s.savedTags[mode] ??
        (mode === 'robot'
          ? { ...t, mode, basePhi: 0, yawOffset: normDeg(t.basePhi + t.yawOffset) }
          : defaultTag())
      // a mode switch swaps which origin is active — it must never move the
      // scene, so re-express every map root under the restored frame
      // (children ride on their parents) regardless of poolLock
      const objects = { ...s.objects }
      for (const n of s.order) {
        const p = objects[n]
        if (p.parent !== MAP && s.objects[p.parent]) continue
        const [wx, wy, wyaw] = mapToWorld(p.x, p.y, p.yaw, t)
        const [nx, ny, nyaw] = worldToMap(wx, wy, wyaw, tag)
        objects[n] = { ...p, x: nx, y: ny, yaw: nyaw }
      }
      commit(objects, s.order, {
        tag,
        savedTags: { ...s.savedTags, [t.mode]: t },
        tagMode: false,
        placeMode: null,
      })
      get().say(mode === 'robot' ? 'Robot-frame origin mode — place the origin anywhere.' : 'AprilTag mode — origin snaps to wall intersections.')
    },

    rotateTag: (deltaDeg) => {
      record()
      const t = get().tag
      applyTag({ ...t, yawOffset: normDeg(t.yawOffset + deltaDeg) })
    },

    setTagOffset: (deg) => {
      record('tagOffset')
      const t = get().tag
      applyTag({ ...t, yawOffset: normDeg(deg) })
    },

    setOriginYawWorld: (wyawDeg) => {
      record('originYaw')
      const t = get().tag
      applyTag({ ...t, yawOffset: normDeg(wyawDeg - t.basePhi) })
    },

    swapPose: (a, b) => {
      const s = get()
      const pa = s.objects[a]
      const pb = s.objects[b]
      if (!pa || !pb || a === b) return
      if (descendants(s.objects, s.order, a).has(b) || descendants(s.objects, s.order, b).has(a)) {
        get().say('Cannot swap an object with its own ancestor/descendant.', 'error')
        return
      }
      record()
      // exchange MAP poses, each re-expressed under its own parent — identical to a
      // plain relative-pose swap for siblings, and world-preserving across parents
      const ra = relativeUnder(pa.parent, s.mapPoses, s.mapPoses[b])
      const rb = relativeUnder(pb.parent, s.mapPoses, s.mapPoses[a])
      const objects = {
        ...s.objects,
        [a]: { ...pa, x: ra[0], y: ra[1], z: ra[2], yaw: ra[3] },
        [b]: { ...pb, x: rb[0], y: rb[1], z: rb[2], yaw: rb[3] },
      }
      commit(objects, s.order)
      get().say(`Swapped poses: ${a} ↔ ${b}.`)
    },

    swapClass: (a, b) => {
      const s = get()
      const pa = s.objects[a]
      const pb = s.objects[b]
      if (!pa || !pb || a === b) return
      record()
      commit(
        { ...s.objects, [a]: { ...pa, cls: pb.cls }, [b]: { ...pb, cls: pa.cls } },
        s.order,
      )
      get().say(`Swapped classes: ${a} ↔ ${b} (${pb.cls ?? '—'} / ${pa.cls ?? '—'}).`)
    },

    setLines: (patch) => {
      record(`lines:${Object.keys(patch).join()}`)
      set({ lines: { ...get().lines, ...patch }, dirty: true })
    },

    addObject: (parent) => {
      record()
      const s = get()
      const name = uniqueName(s.objects, 'prop')
      const [mx, my, myaw] = worldToMap(POOL_LENGTH_M / 2, POOL_WIDTH_M / 2, 0, s.tag)
      let pose: Pose4 = [mx, my, 0, myaw]
      let par = MAP
      if (parent && s.objects[parent]) {
        par = parent
        const pm = s.mapPoses[parent]
        pose = relativeUnder(parent, s.mapPoses, [pm[0] + 0.5, pm[1] + 0.5, pm[2], pm[3]])
      }
      const p = makeProp(name, { parent: par, x: pose[0], y: pose[1], z: pose[2], yaw: pose[3] })
      commit({ ...s.objects, [name]: p }, [...s.order, name], { selected: name })
      return name
    },

    duplicateObject: (name) => {
      const s = get()
      const src = s.objects[name]
      if (!src) return null
      record()
      const copy = uniqueName(s.objects, `${name}_copy`)
      const p: PropObj = {
        ...src,
        name: copy,
        x: src.x + 0.5,
        y: src.y + 0.5,
        covar: { ...src.covar },
        bbox: src.bbox ? [...src.bbox] : null,
      }
      commit({ ...s.objects, [copy]: p }, [...s.order, copy], { selected: copy })
      return copy
    },

    deleteObject: (name) => {
      const s = get()
      if (!s.objects[name]) return
      record()
      const objects: Objects = {}
      // children are re-parented to map (keeping their world pose) so they are not orphaned
      for (const n of s.order) {
        if (n === name) continue
        let p = s.objects[n]
        if (p.parent === name) {
          const mp = s.mapPoses[n]
          p = { ...p, parent: MAP, x: mp[0], y: mp[1], z: mp[2], yaw: mp[3] }
        }
        objects[n] = p
      }
      commit(objects, s.order.filter((n) => n !== name), {
        selected: s.selected === name ? null : s.selected,
      })
    },

    renameObject: (name, next) => {
      const s = get()
      next = next.trim()
      if (!next || next === name) return false
      if (s.objects[next]) {
        get().say(`'${next}' already exists.`, 'error')
        return false
      }
      if (DEPRECATED_OBJECTS.has(next)) {
        get().say(`'${next}' is a deprecated reserved name.`, 'error')
        return false
      }
      record()
      const objects: Objects = {}
      for (const n of s.order) {
        const p = s.objects[n]
        if (n === name) objects[next] = { ...p, name: next }
        else if (p.parent === name) objects[n] = { ...p, parent: next }
        else objects[n] = p
      }
      commit(objects, s.order.map((n) => (n === name ? next : n)), {
        selected: s.selected === name ? next : s.selected,
      })
      return true
    },

    reparentObject: (name, parent) => {
      const s = get()
      const p = s.objects[name]
      if (!p || p.parent === parent) return
      if (parent !== MAP && (parent === name || descendants(s.objects, s.order, name).has(parent))) {
        get().say('Cannot parent an object to itself or its own descendant.', 'error')
        return
      }
      if (parent !== MAP && !s.objects[parent]) return
      record()
      // keep the object where it is in the pool: recompute relative pose under the new parent
      const rel = relativeUnder(parent, s.mapPoses, s.mapPoses[name])
      const objects = {
        ...s.objects,
        [name]: { ...p, parent, x: rel[0], y: rel[1], z: rel[2], yaw: rel[3] },
      }
      commit(objects, s.order)
    },

    patchObject: (name, patch) => {
      const s = get()
      const p = s.objects[name]
      if (!p) return
      record(`patch:${name}:${Object.keys(patch).join()}`)
      commit({ ...s.objects, [name]: { ...p, ...patch, name } }, s.order)
    },

    setRelPose: (name, patch) => {
      const s = get()
      const p = s.objects[name]
      if (!p) return
      record(`rel:${name}:${Object.keys(patch).join()}`)
      commit({ ...s.objects, [name]: { ...p, ...patch } }, s.order)
    },

    setWorldXY: (name, wx, wy) => {
      const s = get()
      const mp = s.mapPoses[name]
      if (!mp) return
      const [mx, my] = worldToMap(wx, wy, 0, s.tag)
      withMapPose(name, [mx, my, mp[2], mp[3]])
    },

    setWorldYaw: (name, wyawDeg) => {
      const s = get()
      const mp = s.mapPoses[name]
      if (!mp) return
      const [, , myaw] = worldToMap(0, 0, wyawDeg, s.tag)
      withMapPose(name, [mp[0], mp[1], mp[2], myaw])
    },

    nudgeWorld: (name, dx, dy) => {
      const s = get()
      const mp = s.mapPoses[name]
      if (!mp) return
      const [wx, wy] = mapToWorld(mp[0], mp[1], mp[3], s.tag)
      get().setWorldXY(name, wx + dx, wy + dy)
    },

    setFootprint: (name, length, width) => {
      // a manual size change overrides a mesh's asymmetric footprint
      get().patchObject(name, { length, width, bbox: null, mesh: null })
    },

    assignMesh: (name, mesh) => {
      const s = get()
      const p = s.objects[name]
      if (!p) return
      if (!mesh) {
        get().patchObject(name, { mesh: null, bbox: null, imageRot: 0 })
        return
      }
      const entry = s.manifest[mesh]
      if (!entry) return
      get().patchObject(name, { mesh, imageRot: 0, ...meshFootprint(entry) })
    },

    autoAssignMeshes: () => {
      const s = get()
      const dirs = Object.keys(s.manifest)
      let n = 0
      const objects = { ...s.objects }
      for (const name of s.order) {
        const p = objects[name]
        if (p.mesh) continue
        const dir = resolveMeshDir(name, dirs)
        if (!dir) continue
        objects[name] = { ...p, mesh: dir, ...meshFootprint(s.manifest[dir]) }
        n++
      }
      if (n) {
        record()
        commit(objects, s.order)
      }
      return n
    },

    bootstrap: async () => {
      try {
        const manifest = (await fetch('/topdown/manifest.json').then((r) =>
          r.ok ? r.json() : {},
        )) as TopdownManifest
        set({ manifest })
      } catch {
        set({ manifest: {} })
      }
      let env: api.Env | null = null
      try {
        env = await api.env()
        set({ home: env.home })
      } catch {
        /* server API unavailable (static build) — keep going */
      }
      if (env?.defaultConfigExists) {
        await get().loadFromPath(env.defaultConfigPath)
      } else {
        const tag = get().tag
        const { objects, order } = placeholderObjects(tag)
        commit(objects, order, {}, false)
        get().autoAssignMeshes()
        set({ dirty: false, past: [], future: [] })
        markClean()
        get().say('No config found — starting with placeholder objects.')
      }
    },

    loadFromPath: async (path) => {
      try {
        const text = await api.readFile(path)
        const { ns, objects: list, loadedNames } = loadConfig(text)
        const objects: Objects = {}
        const order: string[] = []
        for (const p of list) {
          objects[p.name] = p
          order.push(p.name)
        }
        let tag = defaultTag()
        let lines = defaultLines()
        let finalObjects = objects
        try {
          const vizJson = await api.readViz(path)
          if (vizJson) {
            const applied = applySidecar(vizJson, objects, get().manifest)
            finalObjects = applied.objects
            if (applied.tag) tag = applied.tag
            lines = { ...lines, ...applied.lines }
          }
        } catch {
          /* no viz state — fine */
        }
        commit(finalObjects, order, {
          tag,
          savedTags: {},
          lines,
          configPath: path,
          session: { text, ns, loadedNames },
          selected: null,
        }, false)
        get().autoAssignMeshes()
        set({ dirty: false, past: [], future: [] })
        markClean()
        get().say(`Loaded ${order.length} objects from ${ns} (${path.split('/').pop()}).`)
      } catch (e) {
        get().say(`Load failed: ${e instanceof Error ? e.message : e}`, 'error')
        throw e
      }
    },

    saveToPath: async (path) => {
      const s = get()
      try {
        const base = s.session ?? { text: emptyConfigText(), ns: '/talos/riptide_mapping2', loadedNames: [] }
        const objects = s.order.map((n) => s.objects[n])
        const text = saveConfig(base.text, base.ns, objects, base.loadedNames)
        await api.writeFile(path, text)
        set({
          configPath: path,
          session: { text, ns: base.ns, loadedNames: s.order.slice() },
          dirty: false,
        })
        markClean()
        try {
          await api.writeViz(path, buildSidecar(s.objects, s.order, s.tag, s.lines, s.home))
        } catch {
          /* viz state is best-effort; never block a config save on it */
        }
        get().say(`Saved ${s.order.length} objects to ${path.split('/').pop()}.`)
      } catch (e) {
        get().say(`Save failed: ${e instanceof Error ? e.message : e}`, 'error')
        throw e
      }
    },
  }
})

/** Objects eligible as a parent for `name` (no self / descendants / cycles). */
export function validParents(s: State, name: string): string[] {
  const banned = new Set([name, ...descendants(s.objects, s.order, name)])
  return [MAP, ...s.order.filter((n) => !banned.has(n))]
}

/** Names to label on the canvas, per the label mode; selection is always labeled. */
export function labeledNames(s: State): string[] {
  let out: string[]
  if (s.labelMode === 'all') out = s.order.slice()
  else if (s.labelMode === 'roots') out = s.order.filter((n) => s.objects[n].parent === MAP)
  else out = []
  if (s.selected && s.objects[s.selected] && !out.includes(s.selected)) out.push(s.selected)
  return out
}

/** Objects that share `name`'s parent (excluding itself) — swap targets. */
export function siblingsOf(s: State, name: string): string[] {
  const p = s.objects[name]
  if (!p) return []
  return s.order.filter((n) => n !== name && s.objects[n].parent === p.parent)
}

export { childrenOf }
