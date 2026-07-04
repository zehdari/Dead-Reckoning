/**
 * GPU pool canvas (PixiJS / WebGL).
 *
 * Retained scene graph: every object is a Container whose transform is updated
 * on drag — no CPU re-rasterization anywhere in the hot path, so drags are
 * O(1) in scene size and distance (SPEC §2). The world container carries a
 * y-flip so all scene math stays in pool world coordinates (Y-up, meters).
 * Labels are DOM elements (crisp at any zoom, constant on-screen size).
 */
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Texture,
  loadTextures,
} from 'pixi.js'
import {
  MAP,
  POOL_LENGTH_M,
  POOL_WIDTH_M,
  Tag,
  centeredPositions,
  mapToWorld,
  tagCandidates,
  tagPhi,
} from '../core/math'
import { LocalRect, PropObj, hitTest, localRect, worldBBox } from '../core/model'
import { hasTexture, texUrlFor, topdownUrl } from '../core/mesh'
import { State, Theme, labeledNames, useStore } from '../state/store'

// In the packaged Tauri app the frontend is served from a custom protocol
// (tauri://localhost in the Linux WebKitGTK webview). PixiJS v8 loads textures
// with fetch() — in a Web Worker by default, on the main thread via
// fetch + createImageBitmap — and fetch of the custom protocol fails silently
// there, so every sprite falls back to a plain rectangle. Disabling both makes
// Pixi load through `new Image()`, the same document loader path that already
// resolves /assets/* successfully in `tauri dev` and the build.
if (loadTextures.config) {
  loadTextures.config.preferWorkers = false
  loadTextures.config.preferCreateImageBitmap = false
}

interface Palette {
  deck: number
  wall: number
  water: number
  waterEdge: number
  lane: number
  laneAlpha: number
  grid: number
  gridAlpha: number
  accent: number
  tagBody: number
  tagInner: number
  axisX: number
  axisY: number
  origin: number
  handleDot: number
}

const PALETTES: Record<Theme, Palette> = {
  light: {
    deck: 0xe7ebf0,
    wall: 0x8fa3b5,
    water: 0xcfe2ee,
    waterEdge: 0xb8d4e6,
    lane: 0x2c4a66,
    laneAlpha: 0.55,
    grid: 0xffffff,
    gridAlpha: 0.7,
    accent: 0x2f6df6,
    tagBody: 0x14181f,
    tagInner: 0xffffff,
    axisX: 0xe5484d,
    axisY: 0x30a46c,
    origin: 0x111111,
    handleDot: 0xffffff,
  },
  dark: {
    deck: 0x0e1218,
    wall: 0x28323e,
    water: 0x122a38,
    waterEdge: 0x1d4257,
    lane: 0x86b6d2,
    laneAlpha: 0.5,
    grid: 0x35485a,
    gridAlpha: 0.9,
    accent: 0x5c93ff,
    tagBody: 0xe8edf3,
    tagInner: 0x0e1218,
    axisX: 0xff6b6f,
    axisY: 0x54d090,
    origin: 0xe8edf3,
    handleDot: 0x0e1218,
  },
}

const POOL_CLAMP = 2.0 // how far outside the pool an object may be dragged, m

function shade(hex: string, f: number): number {
  const n = parseInt(hex.replace('#', ''), 16)
  const ch = (sh: number) => Math.max(0, Math.min(255, Math.round(((n >> sh) & 0xff) * f)))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function hexNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || 0x888888
}

/** Dashed rectangle outline (pixi has no dashed strokes). */
function dashedRect(g: Graphics, r: LocalRect, dash: number, width: number, color: number): void {
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1)
    const n = Math.max(1, Math.floor(len / (dash * 2)))
    const ux = (x2 - x1) / len
    const uy = (y2 - y1) / len
    for (let i = 0; i < n; i++) {
      const s = (i * len) / n
      const e = Math.min(s + dash, len)
      g.moveTo(x1 + ux * s, y1 + uy * s).lineTo(x1 + ux * e, y1 + uy * e)
    }
  }
  seg(r.x, r.y, r.x + r.w, r.y)
  seg(r.x + r.w, r.y, r.x + r.w, r.y + r.h)
  seg(r.x + r.w, r.y + r.h, r.x, r.y + r.h)
  seg(r.x, r.y + r.h, r.x, r.y)
  g.stroke({ width, color, cap: 'round' })
}

interface PropView {
  root: Container
  content: Container
  frame: Graphics
  gizmo: Graphics
  obj: PropObj // last-rendered object (visual diffing)
  wx: number
  wy: number
  wyaw: number
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'drag'; name: string; offX: number; offY: number }
  | { kind: 'rotate'; name: string }
  | { kind: 'origin-drag'; offX: number; offY: number }
  | { kind: 'origin-rotate' }

export class PoolScene {
  private app = new Application()
  private world = new Container()
  private staticLayer = new Graphics()
  private gridLayer = new Graphics()
  private laneLayer = new Graphics()
  private poolFrameG = new Graphics()
  private candLayer = new Graphics()
  private tagLayer = new Container()
  private originContent = new Container()
  private tagG = new Graphics()
  private propsLayer = new Container()
  private views = new Map<string, PropView>()
  private labelHost!: HTMLDivElement
  private labels = new Map<string, HTMLDivElement>()
  private textures = new Map<string, Texture | 'loading'>()

  private pal: Palette = PALETTES.light
  private k = 20 // px per meter
  private tx = 0
  private ty = 0
  private mode: Mode = { kind: 'idle' }
  private didFit = false
  private labelsDirty = true
  private unsub: (() => void) | null = null
  private last: Partial<State> = {}
  private host!: HTMLElement
  private ready = false
  private cursorRaf = 0
  private resizeObs: ResizeObserver | null = null

  async init(host: HTMLElement): Promise<void> {
    this.host = host
    this.pal = PALETTES[useStore.getState().theme]
    await this.app.init({
      background: this.pal.deck,
      resizeTo: host,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    })
    if (!this.host.isConnected) {
      this.app.destroy(true)
      return
    }
    host.appendChild(this.app.canvas)
    this.labelHost = document.createElement('div')
    this.labelHost.className = 'canvas-labels'
    host.appendChild(this.labelHost)

    this.propsLayer.sortableChildren = true
    this.tagLayer.addChild(this.originContent, this.tagG)
    this.world.addChild(
      this.staticLayer,
      this.gridLayer,
      this.laneLayer,
      this.poolFrameG,
      this.candLayer,
      this.tagLayer,
      this.propsLayer,
    )
    this.app.stage.addChild(this.world)

    // resizeTo only reacts to window resizes — collapsing/resizing a side
    // panel changes the host without one, so watch the host itself
    this.resizeObs = new ResizeObserver(() => {
      this.app.resize()
      this.labelsDirty = true
    })
    this.resizeObs.observe(host)

    this.bindPointer()
    this.app.ticker.add(() => this.tick())
    this.ready = true

    this.unsub = useStore.subscribe((s) => this.sync(s))
    this.sync(useStore.getState(), true)
  }

  destroy(): void {
    this.unsub?.()
    this.resizeObs?.disconnect()
    cancelAnimationFrame(this.cursorRaf)
    if (this.ready) this.app.destroy(true)
    this.labelHost?.remove()
  }

  // ------------------------------- camera -------------------------------

  private applyCamera(): void {
    this.world.position.set(this.tx, this.ty)
    this.world.scale.set(this.k, -this.k)
    this.labelsDirty = true
  }

  private viewSize(): { w: number; h: number } {
    // CSS pixels — the stage coordinate space and all pointer math (getBoundingClientRect)
    // live here. Reading the renderer's device pixels would double-count DPR on retina.
    const r = this.app.canvas.getBoundingClientRect()
    return { w: r.width, h: r.height }
  }

  worldFromClient(clientX: number, clientY: number): { wx: number; wy: number } {
    const r = this.app.canvas.getBoundingClientRect()
    const sx = clientX - r.left
    const sy = clientY - r.top
    return { wx: (sx - this.tx) / this.k, wy: (this.ty - sy) / this.k }
  }

  /** World -> browser client coordinates (labels, tests). */
  clientFromWorld(wx: number, wy: number): { cx: number; cy: number } {
    const r = this.app.canvas.getBoundingClientRect()
    return { cx: r.left + this.tx + this.k * wx, cy: r.top + this.ty - this.k * wy }
  }

  get fps(): number {
    return this.app.ticker.FPS
  }

  get scalePxPerM(): number {
    return this.k
  }

  private limitRect(s: State): { x: number; y: number; w: number; h: number } {
    const m = 3
    let minX = -m
    let minY = -m
    let maxX = POOL_LENGTH_M + m
    let maxY = POOL_WIDTH_M + m
    for (const name of s.order) {
      const v = this.views.get(name)
      const p = s.objects[name]
      if (!v || !p || p.hidden) continue
      const bb = worldBBox(p, v.wx, v.wy, v.wyaw)
      minX = Math.min(minX, bb.minX)
      minY = Math.min(minY, bb.minY)
      maxX = Math.max(maxX, bb.maxX)
      maxY = Math.max(maxY, bb.maxY)
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  private minScale(): number {
    const { w, h } = this.viewSize()
    const r = this.limitRect(useStore.getState())
    if (r.w <= 0 || r.h <= 0 || w <= 0 || h <= 0) return 1e-6
    return Math.min(w / r.w, h / r.h)
  }

  fit(): void {
    const { w, h } = this.viewSize()
    if (w <= 0 || h <= 0) return
    const m = 2
    const rw = POOL_LENGTH_M + 2 * m
    const rh = POOL_WIDTH_M + 2 * m
    this.k = Math.min(w / rw, h / rh)
    this.tx = w / 2 - this.k * (POOL_LENGTH_M / 2)
    this.ty = h / 2 + this.k * (POOL_WIDTH_M / 2)
    this.applyCamera()
    this.redrawZoomDependent()
  }

  centerOn(name: string): void {
    const v = this.views.get(name)
    if (!v) return
    const { w, h } = this.viewSize()
    this.k = Math.max(this.k, 60)
    this.tx = w / 2 - this.k * v.wx
    this.ty = h / 2 + this.k * v.wy
    this.applyCamera()
    this.redrawZoomDependent()
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const wx = (sx - this.tx) / this.k
    const wy = (this.ty - sy) / this.k
    let nk = this.k * factor
    if (factor < 1) nk = Math.max(nk, this.minScale())
    if (nk === this.k) return
    this.k = nk
    this.tx = sx - this.k * wx
    this.ty = sy + this.k * wy
    this.applyCamera()
    this.redrawZoomDependent()
  }

  private redrawZoomDependent(): void {
    const s = useStore.getState()
    this.drawGizmo(s)
    this.drawPoolFrame()
    this.drawTag(s.tag) // origin rotate handle length adapts to zoom
    if (s.placeMode === 'apriltag') this.drawCandidates(s)
  }

  // ------------------------------- pointer -------------------------------

  private bindPointer(): void {
    const el = this.app.canvas
    el.style.touchAction = 'none'
    el.addEventListener('pointerdown', (e) => this.onDown(e))
    el.addEventListener('pointermove', (e) => this.onMove(e))
    el.addEventListener('pointerup', (e) => this.onUp(e))
    el.addEventListener('pointercancel', (e) => this.onUp(e))
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = el.getBoundingClientRect()
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
      },
      { passive: false },
    )
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('dblclick', (e) => {
      const { wx, wy } = this.worldFromClient(e.clientX, e.clientY)
      const hit = this.pick(useStore.getState(), wx, wy)
      if (hit) this.centerOn(hit)
    })
  }

  private pick(s: State, wx: number, wy: number): string | null {
    let best: string | null = null
    let bestZ = -1
    for (const name of s.order) {
      const p = s.objects[name]
      const v = this.views.get(name)
      if (!p || !v || p.locked || !v.root.visible) continue
      if (hitTest(p, v.wx, v.wy, v.wyaw, wx, wy) && v.root.zIndex > bestZ) {
        best = name
        bestZ = v.root.zIndex
      }
    }
    return best
  }

  private handleCenter(p: PropObj): { x: number; y: number; r: number } {
    const r = localRect(p)
    const gap = Math.max(0.45, 18 / this.k)
    return { x: r.x + r.w + gap, y: 0, r: Math.max(0.2, 8 / this.k) }
  }

  private onRotateHandle(s: State, wx: number, wy: number): boolean {
    if (!s.selected) return false
    const p = s.objects[s.selected]
    const v = this.views.get(s.selected)
    if (!p || !v || p.locked || !v.root.visible) return false
    const h = this.handleCenter(p)
    const [lx, ly] = this.toLocal(wx - v.wx, wy - v.wy, v.wyaw)
    return Math.hypot(lx - h.x, ly - h.y) <= h.r * 1.8
  }

  private toLocal(dx: number, dy: number, yawDeg: number): [number, number] {
    const a = (-yawDeg * Math.PI) / 180
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)]
  }

  /** Origin (robot mode) grab geometry in the origin's local frame. */
  private originLocal(s: State, wx: number, wy: number): { lx: number; ly: number } {
    const [lx, ly] = this.toLocal(wx - s.tag.x, wy - s.tag.y, tagPhi(s.tag))
    return { lx, ly }
  }

  private originHandleDist(): number {
    return Math.max(1.6, 46 / this.k)
  }

  private onDown(e: PointerEvent): void {
    const s = useStore.getState()
    const { wx, wy } = this.worldFromClient(e.clientX, e.clientY)
    this.app.canvas.setPointerCapture(e.pointerId)

    if (e.button === 0 && s.placeMode) {
      if (s.placeMode === 'robot') s.placeOriginFree(wx, wy)
      else s.placeTagAtWorld(wx, wy)
      return
    }
    if (e.button === 1 || e.button === 2) {
      this.mode = { kind: 'pan', lastX: e.clientX, lastY: e.clientY }
      this.setCursor('grabbing')
      return
    }
    if (e.button !== 0) return

    if (this.onRotateHandle(s, wx, wy)) {
      s.beginGesture()
      this.mode = { kind: 'rotate', name: s.selected! }
      return
    }
    const hit = this.pick(s, wx, wy)
    if (hit) {
      const v = this.views.get(hit)!
      s.select(hit)
      s.beginGesture()
      this.mode = { kind: 'drag', name: hit, offX: wx - v.wx, offY: wy - v.wy }
      this.setCursor('grabbing')
      return
    }
    // robot-frame origin is directly draggable / rotatable in open water
    if (s.tag.mode === 'robot') {
      const { lx, ly } = this.originLocal(s, wx, wy)
      const hd = this.originHandleDist()
      const hr = Math.max(0.22, 9 / this.k)
      if (Math.hypot(lx - hd, ly) <= hr * 1.8) {
        s.beginGesture()
        this.mode = { kind: 'origin-rotate' }
        this.updatePoolFrameVisibility(s)
        return
      }
      if (Math.hypot(lx, ly) <= Math.max(0.55, 16 / this.k)) {
        s.beginGesture()
        this.mode = { kind: 'origin-drag', offX: wx - s.tag.x, offY: wy - s.tag.y }
        this.updatePoolFrameVisibility(s)
        this.setCursor('grabbing')
        return
      }
    }
    // empty background (or a locked prop): deselect, then pan with the drag
    s.select(null)
    this.mode = { kind: 'pan', lastX: e.clientX, lastY: e.clientY }
    this.setCursor('grabbing')
  }

  private onMove(e: PointerEvent): void {
    const s = useStore.getState()
    const { wx, wy } = this.worldFromClient(e.clientX, e.clientY)
    this.reportCursor(wx, wy)

    switch (this.mode.kind) {
      case 'pan':
        this.tx += e.clientX - this.mode.lastX
        this.ty += e.clientY - this.mode.lastY
        this.mode.lastX = e.clientX
        this.mode.lastY = e.clientY
        this.applyCamera()
        return
      case 'drag': {
        const nx = Math.min(Math.max(wx - this.mode.offX, -POOL_CLAMP), POOL_LENGTH_M + POOL_CLAMP)
        const ny = Math.min(Math.max(wy - this.mode.offY, -POOL_CLAMP), POOL_WIDTH_M + POOL_CLAMP)
        s.setWorldXY(this.mode.name, nx, ny)
        return
      }
      case 'rotate': {
        const v = this.views.get(this.mode.name)
        if (v) s.setWorldYaw(this.mode.name, (Math.atan2(wy - v.wy, wx - v.wx) * 180) / Math.PI)
        return
      }
      case 'origin-drag':
        s.setOriginPos(wx - this.mode.offX, wy - this.mode.offY)
        return
      case 'origin-rotate':
        s.setOriginYawWorld((Math.atan2(wy - s.tag.y, wx - s.tag.x) * 180) / Math.PI)
        return
    }
    // idle hover cursor
    if (s.placeMode) this.setCursor('crosshair')
    else if (this.onRotateHandle(s, wx, wy)) this.setCursor('alias')
    else if (this.pick(s, wx, wy)) this.setCursor('grab')
    else if (s.tag.mode === 'robot' && this.overOrigin(s, wx, wy)) this.setCursor('grab')
    else this.setCursor('default')
  }

  private overOrigin(s: State, wx: number, wy: number): boolean {
    const { lx, ly } = this.originLocal(s, wx, wy)
    const hd = this.originHandleDist()
    return (
      Math.hypot(lx, ly) <= Math.max(0.55, 16 / this.k) ||
      Math.hypot(lx - hd, ly) <= Math.max(0.22, 9 / this.k) * 1.8
    )
  }

  private onUp(e: PointerEvent): void {
    if (this.mode.kind !== 'idle') {
      if (this.mode.kind !== 'pan') useStore.getState().endGesture()
      this.mode = { kind: 'idle' }
      this.updatePoolFrameVisibility(useStore.getState())
      this.setCursor(useStore.getState().placeMode ? 'crosshair' : 'default')
    }
    try {
      this.app.canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  private setCursor(c: string): void {
    if (this.app.canvas.style.cursor !== c) this.app.canvas.style.cursor = c
  }

  private reportCursor(wx: number, wy: number): void {
    cancelAnimationFrame(this.cursorRaf)
    this.cursorRaf = requestAnimationFrame(() => useStore.setState({ cursor: { wx, wy } }))
  }

  // ------------------------------- store sync -------------------------------

  private sync(s: State, force = false): void {
    if (!this.ready) return
    const l = this.last
    const themeChanged = force || s.theme !== l.theme
    const objectsChanged = force || s.objects !== l.objects || s.order !== l.order
    const posesChanged = force || s.mapPoses !== l.mapPoses
    const tagChanged = force || s.tag !== l.tag
    const linesChanged = force || s.lines !== l.lines
    const selChanged = force || s.selected !== l.selected
    const placeChanged = force || s.placeMode !== l.placeMode
    const labelChanged = force || s.labelMode !== l.labelMode
    // Ignore no-op notifications (e.g. cursor-only setState during a mouse move) so
    // labels and layers don't churn every frame.
    if (
      !(themeChanged || objectsChanged || posesChanged || tagChanged || linesChanged ||
        selChanged || placeChanged || labelChanged)
    )
      return
    this.last = {
      objects: s.objects,
      order: s.order,
      mapPoses: s.mapPoses,
      tag: s.tag,
      lines: s.lines,
      selected: s.selected,
      placeMode: s.placeMode,
      labelMode: s.labelMode,
      theme: s.theme,
    }

    if (themeChanged) {
      this.pal = PALETTES[s.theme]
      this.app.renderer.background.color = this.pal.deck
    }
    if (themeChanged || force) {
      this.drawStatic()
      this.drawPoolFrame()
    }
    if (themeChanged || linesChanged) {
      this.drawLanes(s)
      this.drawGrid(s)
    }
    if (themeChanged || tagChanged) this.drawTag(s.tag)
    if (objectsChanged) this.reconcileViews(s)
    if (themeChanged) for (const [name, v] of this.views) this.applyVisual(v, s.objects[name])
    if (objectsChanged || posesChanged || tagChanged || linesChanged) this.updateTransforms(s)
    if (objectsChanged) this.resortZ(s)
    if (themeChanged || selChanged || objectsChanged || posesChanged || linesChanged)
      this.drawGizmo(s)
    if (placeChanged || linesChanged || themeChanged) {
      this.candLayer.visible = s.placeMode === 'apriltag'
      if (s.placeMode === 'apriltag') this.drawCandidates(s)
      this.updatePoolFrameVisibility(s)
      this.setCursor(s.placeMode ? 'crosshair' : 'default')
    }
    this.labelsDirty = true
  }

  private tick(): void {
    if (!this.didFit) {
      const { w, h } = this.viewSize()
      if (w > 10 && h > 10) {
        this.didFit = true
        this.fit()
      }
    }
    if (this.labelsDirty) {
      this.labelsDirty = false
      this.updateLabels(useStore.getState())
    }
  }

  // ------------------------------- static drawing -------------------------------

  private drawStatic(): void {
    const g = this.staticLayer
    g.clear()
    g.rect(-0.3, -0.3, POOL_LENGTH_M + 0.6, POOL_WIDTH_M + 0.6).fill(this.pal.wall)
    g.rect(0, 0, POOL_LENGTH_M, POOL_WIDTH_M).fill(this.pal.water)
    g.rect(0.06, 0.06, POOL_LENGTH_M - 0.12, POOL_WIDTH_M - 0.12).stroke({
      width: 0.12,
      color: this.pal.waterEdge,
    })
  }

  private drawLanes(s: State): void {
    const g = this.laneLayer
    g.clear()
    const ln = s.lines
    // T ends are built from non-overlapping rects (bar + inset stem) so the
    // translucent fill doesn't double-blend where they meet
    if (ln.shortShow) {
      const t = ln.shortThickness
      const L = Math.min(ln.shortLength, POOL_WIDTH_M)
      const y0 = (POOL_WIDTH_M - L) / 2
      for (const x of centeredPositions(POOL_LENGTH_M, ln.shortCount, ln.shortSpacing)) {
        if (ln.teeShow) {
          const b = Math.max(ln.shortTeeLength, t)
          g.rect(x - b / 2, y0, b, t)
          g.rect(x - b / 2, y0 + L - t, b, t)
          g.rect(x - t / 2, y0 + t, t, Math.max(L - 2 * t, 0))
        } else g.rect(x - t / 2, y0, t, L)
      }
    }
    if (ln.longShow) {
      const t = ln.longThickness
      const L = Math.min(ln.longLength, POOL_LENGTH_M)
      const x0 = (POOL_LENGTH_M - L) / 2
      // the across lines cut through the along lines: drop a window around each
      // crossing so the cut ends sit an air gap away from the across stripe
      const shortL = Math.min(ln.shortLength, POOL_WIDTH_M)
      const sy0 = (POOL_WIDTH_M - shortL) / 2
      const cutHalf = ln.shortThickness / 2 + Math.max(ln.crossGap, 0)
      const xs = ln.shortShow
        ? centeredPositions(POOL_LENGTH_M, ln.shortCount, ln.shortSpacing)
        : []
      for (const y of centeredPositions(POOL_WIDTH_M, ln.longCount, ln.longSpacing)) {
        let s0 = x0
        let s1 = x0 + L
        if (ln.teeShow) {
          const b = Math.max(ln.longTeeLength, t)
          g.rect(x0, y - b / 2, t, b)
          g.rect(x0 + L - t, y - b / 2, t, b)
          s0 += t
          s1 -= t
        }
        const cuts = y + t / 2 > sy0 && y - t / 2 < sy0 + shortL ? xs : []
        let segs: Array<[number, number]> = s1 > s0 ? [[s0, s1]] : []
        for (const x of cuts) {
          const lo = x - cutHalf
          const hi = x + cutHalf
          const next: Array<[number, number]> = []
          for (const [a, b] of segs) {
            if (lo > a) next.push([a, Math.min(lo, b)])
            if (hi < b) next.push([Math.max(hi, a), b])
          }
          segs = next
        }
        for (const [a, b] of segs) g.rect(a, y - t / 2, b - a, t)
      }
    }
    g.fill({ color: this.pal.lane, alpha: this.pal.laneAlpha })
  }

  private drawGrid(s: State): void {
    const g = this.gridLayer
    g.clear()
    if (!s.lines.showGrid) return
    for (let x = 5; x < POOL_LENGTH_M; x += 5) g.moveTo(x, 0).lineTo(x, POOL_WIDTH_M)
    for (let y = 5; y < POOL_WIDTH_M; y += 5) g.moveTo(0, y).lineTo(POOL_LENGTH_M, y)
    g.stroke({ width: 0.03, color: this.pal.grid, alpha: this.pal.gridAlpha })
  }

  private poolFrameActive(s: State): boolean {
    return (
      s.placeMode !== null ||
      this.mode.kind === 'origin-drag' ||
      this.mode.kind === 'origin-rotate'
    )
  }

  private updatePoolFrameVisibility(s: State): void {
    const active = this.poolFrameActive(s)
    this.poolFrameG.visible = active
    this.labelsDirty = true
  }

  private drawPoolFrame(): void {
    const g = this.poolFrameG
    g.clear()
    const r = Math.max(0.16, 6 / this.k)
    const axis = Math.max(1.25, 42 / this.k)
    const lw = Math.max(0.035, 2 / this.k)
    g.circle(0, 0, r).fill({ color: this.pal.handleDot }).stroke({ width: lw, color: this.pal.origin })
    g.moveTo(0, 0).lineTo(axis, 0).stroke({ width: lw, color: this.pal.axisX })
    g.poly([axis, -0.12, axis, 0.12, axis + 0.24, 0]).fill(this.pal.axisX)
    g.moveTo(0, 0).lineTo(0, axis).stroke({ width: lw, color: this.pal.axisY })
    g.poly([-0.12, axis, 0.12, axis, 0, axis + 0.24]).fill(this.pal.axisY)
    g.visible = this.poolFrameActive(useStore.getState())
  }

  private drawTag(tag: Tag): void {
    const g = this.tagG
    g.clear()
    this.originContent.removeChildren().forEach((c) => c.destroy())

    if (tag.mode === 'robot') {
      // robot-frame origin: talos footprint marker
      const tex = this.getTexture(topdownUrl('talos'))
      const entry = useStore.getState().manifest['talos']
      if (tex && entry) {
        const [x0, x1, y0, y1] = entry.bbox
        const sp = new Sprite(tex)
        sp.position.set(x0, y1)
        sp.scale.set((x1 - x0) / tex.width, -((y1 - y0) / tex.height))
        this.originContent.addChild(sp)
      }
      g.circle(0, 0, Math.max(0.14, 6 / this.k)).stroke({ width: 0.04, color: this.pal.accent })
    } else {
      // AprilTag body on the wall
      g.rect(-0.28, -0.28, 0.56, 0.56).fill(this.pal.tagBody)
      g.rect(-0.17, -0.17, 0.34, 0.34).stroke({ width: 0.06, color: this.pal.tagInner })
    }
    // shared axes: +X into the pool / +Y left
    g.moveTo(0, 0).lineTo(1.7, 0).stroke({ width: 0.08, color: this.pal.axisX })
    g.poly([1.7, -0.14, 1.7, 0.14, 2.0, 0]).fill(this.pal.axisX)
    g.moveTo(0, 0).lineTo(0, 1.1).stroke({ width: 0.08, color: this.pal.axisY })
    g.poly([-0.14, 1.1, 0.14, 1.1, 0, 1.4]).fill(this.pal.axisY)

    if (tag.mode === 'robot') {
      const hd = this.originHandleDist()
      const hr = Math.max(0.14, 7 / this.k)
      g.moveTo(2.0, 0).lineTo(hd, 0).stroke({ width: 0.03, color: this.pal.accent, alpha: 0.7 })
      g.circle(hd, 0, hr).fill({ color: this.pal.accent })
      g.circle(hd, 0, hr * 0.45).fill({ color: this.pal.handleDot })
    }

    this.tagLayer.position.set(tag.x, tag.y)
    this.tagLayer.rotation = (tagPhi(tag) * Math.PI) / 180
  }

  private drawCandidates(s: State): void {
    const g = this.candLayer
    g.clear()
    const ln = s.lines
    const r = Math.max(0.22, 9 / this.k)
    for (const c of tagCandidates(
      ln.shortShow,
      ln.shortCount,
      ln.shortSpacing,
      ln.longShow,
      ln.longCount,
      ln.longSpacing,
    )) {
      g.circle(c.x, c.y, r).fill({ color: this.pal.accent, alpha: 0.35 })
      g.circle(c.x, c.y, r * 0.4).fill({ color: this.pal.accent })
    }
  }

  // ------------------------------- prop views -------------------------------

  private reconcileViews(s: State): void {
    for (const [name, v] of this.views) {
      if (!s.objects[name]) {
        v.root.destroy({ children: true })
        this.views.delete(name)
        this.labels.get(name)?.remove()
        this.labels.delete(name)
      }
    }
    for (const name of s.order) {
      const p = s.objects[name]
      let v = this.views.get(name)
      if (!v) {
        const root = new Container()
        const content = new Container()
        const frame = new Graphics()
        const gizmo = new Graphics()
        root.addChild(content, frame, gizmo)
        this.propsLayer.addChild(root)
        v = { root, content, frame, gizmo, obj: p, wx: 0, wy: 0, wyaw: 0 }
        this.views.set(name, v)
        this.applyVisual(v, p)
      } else if (v.obj !== p) {
        const prev = v.obj
        v.obj = p
        if (
          prev.mesh !== p.mesh ||
          prev.color !== p.color ||
          prev.cls !== p.cls ||
          prev.bbox !== p.bbox ||
          prev.length !== p.length ||
          prev.width !== p.width ||
          prev.locked !== p.locked ||
          prev.hidden !== p.hidden ||
          prev.imageRot !== p.imageRot
        )
          this.applyVisual(v, p)
      }
    }
  }

  /** Load + cache a texture by URL; re-applies dependent views when it arrives. */
  private getTexture(url: string): Texture | null {
    const cur = this.textures.get(url)
    if (cur instanceof Texture) return cur
    if (cur === 'loading') return null
    this.textures.set(url, 'loading')
    Assets.load<Texture>(url)
      .then((tex) => {
        this.textures.set(url, tex)
        const s = useStore.getState()
        for (const [name, v] of this.views) {
          const p = s.objects[name]
          if (p) this.applyVisual(v, p)
        }
        this.drawTag(s.tag) // origin talos sprite may have been waiting
      })
      .catch((e) => {
        this.textures.delete(url)
        useStore.getState().say(`tex ${url}: ${e?.message ?? e}`, 'error')
      })
    return null
  }

  private spriteUrl(p: PropObj): string | null {
    if (!p.mesh) return null
    const entry = useStore.getState().manifest[p.mesh]
    if (hasTexture(entry)) return texUrlFor(entry, p.cls)
    return topdownUrl(p.mesh)
  }

  private applyVisual(v: PropView, p: PropObj): void {
    if (!p) return
    v.content.removeChildren().forEach((c) => c.destroy())
    v.content.rotation = ((p.imageRot ?? 0) * Math.PI) / 180
    v.frame.clear()
    const r = localRect(p)
    const colN = hexNum(p.color)
    const url = this.spriteUrl(p)
    const texture = url ? this.getTexture(url) : null

    if (texture && p.bbox) {
      const [x0, x1, y0, y1] = p.bbox
      const sp = new Sprite(texture)
      sp.position.set(x0, y1)
      sp.scale.set((x1 - x0) / texture.width, -((y1 - y0) / texture.height))
      sp.alpha = p.locked ? 0.9 : 1
      v.content.addChild(sp)
    } else {
      const g = new Graphics()
      const rad = Math.min(0.08, r.w / 4, r.h / 4)
      g.roundRect(r.x, r.y, r.w, r.h, rad).fill({ color: colN, alpha: p.locked ? 0.32 : 0.55 })
      g.roundRect(r.x, r.y, r.w, r.h, rad).stroke({ width: 0.03, color: shade(p.color, 0.62) })
      v.content.addChild(g)
    }
    // heading marker at the pose point (model origin may be off-center)
    const sMark = Math.max(0.06, Math.min(0.18, 0.25 * Math.min(r.w, r.h)))
    v.frame.poly([0, -sMark, 0, sMark, 2 * sMark, 0]).fill({ color: this.pal.origin, alpha: 0.8 })
    v.root.alpha = p.locked ? 0.82 : 1
    this.labelsDirty = true
  }

  private updateTransforms(s: State): void {
    for (const name of s.order) {
      const v = this.views.get(name)
      const p = s.objects[name]
      if (!v || !p) continue
      const mp = s.mapPoses[name] ?? [0, 0, 0, 0]
      const [wx, wy, wyaw] = mapToWorld(mp[0], mp[1], mp[3], s.tag)
      v.wx = wx
      v.wy = wy
      v.wyaw = wyaw
      v.root.position.set(wx, wy)
      v.root.rotation = (wyaw * Math.PI) / 180
      v.root.visible = !p.hidden && (p.parent === MAP || s.lines.showChildren)
    }
  }

  private resortZ(s: State): void {
    // children always render above their parents (tree depth first); among
    // peers, locked props sit below interactive ones and larger footprints
    // below smaller (so e.g. the locked table never hides the props on it)
    const depth = (n: string): number => {
      let d = 0
      let p = s.objects[n]
      while (p && p.parent !== MAP && s.objects[p.parent] && d < 32) {
        d++
        p = s.objects[p.parent]
      }
      return d
    }
    const depths = new Map(s.order.map((n) => [n, depth(n)]))
    const names = s.order.slice().sort((a, b) => {
      const da = depths.get(a)! - depths.get(b)!
      if (da !== 0) return da
      const pa = s.objects[a]
      const pb = s.objects[b]
      if (pa.locked !== pb.locked) return pa.locked ? -1 : 1
      const ra = localRect(pa)
      const rb = localRect(pb)
      return rb.w * rb.h - ra.w * ra.h
    })
    names.forEach((n, i) => {
      const v = this.views.get(n)
      if (v) v.root.zIndex = i + 1
    })
  }

  private drawGizmo(s: State): void {
    for (const [name, v] of this.views) if (name !== s.selected) v.gizmo.clear()
    if (!s.selected) return
    const v = this.views.get(s.selected)
    const p = s.objects[s.selected]
    if (!v || !p) return
    const g = v.gizmo
    g.clear()
    const r = localRect(p)
    const pad = Math.max(0.08, 4 / this.k)
    const rr: LocalRect = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }
    const lw = Math.max(0.02, 1.6 / this.k)
    dashedRect(g, rr, Math.max(0.15, 7 / this.k), lw, this.pal.accent)
    if (!p.locked) {
      const h = this.handleCenter(p)
      g.moveTo(rr.x + rr.w, 0).lineTo(h.x, 0).stroke({ width: lw, color: this.pal.accent, alpha: 0.8 })
      g.circle(h.x, h.y, h.r).fill({ color: this.pal.accent })
      g.circle(h.x, h.y, h.r * 0.45).fill({ color: this.pal.handleDot })
    }
  }

  // ------------------------------- labels -------------------------------

  private updateLabels(s: State): void {
    if (!this.labelHost) return
    const wanted = new Set(labeledNames(s))
    for (const [name, el] of this.labels) {
      if (!wanted.has(name) && name !== '__origin__') {
        el.remove()
        this.labels.delete(name)
      }
    }
    const { w, h } = this.viewSize()
    const place = (key: string, text: string, wx: number, wy: number, cls: string, visible: boolean) => {
      let el = this.labels.get(key)
      if (!el) {
        el = document.createElement('div')
        this.labelHost.appendChild(el)
        this.labels.set(key, el)
      }
      el.className = `canvas-label ${cls}`
      if (el.textContent !== text) el.textContent = text
      const sx = this.tx + this.k * wx
      const sy = this.ty - this.k * wy
      const on = visible && sx > -80 && sx < w + 80 && sy > -40 && sy < h + 40
      el.style.display = on ? 'block' : 'none'
      if (on)
        el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, 9px)`
    }
    for (const name of wanted) {
      const v = this.views.get(name)
      const p = s.objects[name]
      if (!v || !p) continue
      place(name, name, v.wx, v.wy, name === s.selected ? 'sel' : '', v.root.visible)
    }
    place('__origin__', s.tag.mode === 'robot' ? 'map · robot' : 'map · tag', s.tag.x, s.tag.y, 'tag', true)
    place('__pool_frame__', 'pool frame', 0, 0, 'pool', this.poolFrameActive(s))
  }
}

/** Imperative access for toolbar/list actions (fit, center-on). */
export const sceneHandle: { current: PoolScene | null } = { current: null }
