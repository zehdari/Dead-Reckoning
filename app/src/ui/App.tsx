import { useEffect, useState } from 'react'
import { isDesktop } from '../api'
import { PoolCanvas } from '../canvas/PoolCanvas'
import { sceneHandle } from '../canvas/scene'
import { mapToWorld } from '../core/math'
import { useStore } from '../state/store'
import { Inspector } from './Inspector'
import { ObjectsPanel, PoseColsToggle } from './ObjectsPanel'
import { StatusBar } from './StatusBar'
import { Toolbar } from './Toolbar'
import { confirmDelete } from './confirm'

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    {dir === 'left' ? <path d="M14.5 5.5 8 12l6.5 6.5" /> : <path d="M9.5 5.5 16 12l-6.5 6.5" />}
  </svg>
)

function usePanelWidth(key: string, initial: number, min: number): [number, (w: number) => void] {
  const clamp = (w: number) => Math.min(Math.max(w, min), 620)
  const [w, setW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem(key) ?? '', 10)
      return Number.isFinite(v) ? clamp(v) : clamp(initial)
    } catch {
      return clamp(initial)
    }
  })
  return [
    w,
    (nw: number) => {
      const c = clamp(nw)
      setW(c)
      try {
        localStorage.setItem(key, String(c))
      } catch {
        /* private mode */
      }
    },
  ]
}

/** Docked side panel with a collapse button and a drag-resize edge. */
function DockPanel(props: {
  side: 'left' | 'right'
  title: string
  hotkey: string
  width: number
  onWidth: (w: number) => void
  onCollapse: () => void
  /** extra buttons in the panel head, before the collapse chevron */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const { side, title, hotkey, width, onWidth, onCollapse, actions, children } = props
  const [active, setActive] = useState(false)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    setActive(true)
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent) =>
      onWidth(side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX))
    const up = () => {
      setActive(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <aside className={`panel ${side}`} style={{ width }}>
      <div className="panel-head">
        <span>{title}</span>
        <span className="head-tools">
          {actions}
          <button onClick={onCollapse} title={`Hide ${title} (${hotkey})`}>
            <Chevron dir={side} />
          </button>
        </span>
      </div>
      {children}
      <div className={`resize-handle${active ? ' active' : ''}`} onPointerDown={startResize} />
    </aside>
  )
}

function Rail(props: { side: 'left' | 'right'; title: string; hotkey: string; onOpen: () => void }) {
  return (
    <div className={`rail ${props.side}`}>
      <button onClick={props.onOpen} title={`Show ${props.title} (${props.hotkey})`}>
        <Chevron dir={props.side === 'left' ? 'right' : 'left'} />
      </button>
      <span className="rail-label">{props.title}</span>
    </div>
  )
}

export function App() {
  const theme = useStore((s) => s.theme)
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const selected = useStore((s) => s.selected)
  const [leftW, setLeftW] = usePanelWidth('dr.leftW', 360, 340)
  const [rightW, setRightW] = usePanelWidth('dr.rightW', 360, 360)

  useEffect(() => {
    void useStore.getState().bootstrap()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // desktop: the window X bypasses beforeunload, so guard the close event
  useEffect(() => {
    if (!isDesktop) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void (async () => {
      const [{ getCurrentWindow }, { ask }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/plugin-dialog'),
      ])
      const win = getCurrentWindow()
      // Always preventDefault synchronously, then decide and close explicitly.
      // Awaiting inside the handler without this can race Tauri's close
      // decision, and on WebKitGTK a hung native dialog would otherwise trap
      // the window open forever.
      const un = await win.onCloseRequested(async (e) => {
        if (!useStore.getState().dirty) return // clean → let it close
        e.preventDefault()
        const leave = await ask('You have unsaved changes. Quit anyway?', {
          title: 'Dead Reckoning',
          kind: 'warning',
        })
        if (leave) await win.destroy()
      })
      // Escape hatch: Ctrl/Cmd+Q force-closes unconditionally, so a
      // misbehaving dialog can never leave the window unclosable.
      const onQuit = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'q' || e.key === 'Q')) {
          e.preventDefault()
          void win.destroy()
        }
      }
      window.addEventListener('keydown', onQuit, true)
      const un2 = () => {
        un()
        window.removeEventListener('keydown', onQuit, true)
      }
      if (disposed) un2()
      else unlisten = un2
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      const s = useStore.getState()
      const sel = s.selected
      const key = e.key
      if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y')) {
        e.preventDefault()
        if (key === 'y' || key === 'Y' || e.shiftKey) s.redo()
        else s.undo()
        return
      }
      // plain single-key shortcuts only — don't shadow browser chords (Ctrl+F…).
      // preventDefault on the ones we handle so Firefox's quick-find /
      // find-as-you-type can't steal the keystroke.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (key === '[') {
        e.preventDefault()
        s.setLeftOpen(!s.leftOpen)
        return
      }
      if (key === ']') {
        e.preventDefault()
        s.setRightOpen(!s.rightOpen)
        return
      }
      if (key === 'f' || key === 'F') {
        e.preventDefault()
        sceneHandle.current?.fit()
        return
      }
      if (key === 'Escape') {
        if (s.placeMode) s.setPlaceMode(null)
        else s.select(null)
        return
      }
      if (!sel || !s.objects[sel]) return
      const p = s.objects[sel]
      if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault()
        confirmDelete(sel)
        return
      }
      if (key === 'l' || key === 'L') {
        e.preventDefault()
        s.patchObject(sel, { locked: !p.locked })
        return
      }
      if (key === 'h' || key === 'H') {
        e.preventDefault()
        s.patchObject(sel, { hidden: !p.hidden })
        return
      }
      const step = e.shiftKey ? 0.1 : 0.01
      const rot = e.shiftKey ? 15 : 1
      if (p.locked) return
      switch (key) {
        case 'ArrowLeft':
          e.preventDefault()
          s.nudgeWorld(sel, -step, 0)
          break
        case 'ArrowRight':
          e.preventDefault()
          s.nudgeWorld(sel, step, 0)
          break
        case 'ArrowUp':
          e.preventDefault()
          s.nudgeWorld(sel, 0, step)
          break
        case 'ArrowDown':
          e.preventDefault()
          s.nudgeWorld(sel, 0, -step)
          break
        case 'q':
        case 'Q':
        case 'e':
        case 'E': {
          e.preventDefault()
          const mp = s.mapPoses[sel]
          if (!mp) break
          const [, , wyaw] = mapToWorld(mp[0], mp[1], mp[3], s.tag)
          s.setWorldYaw(sel, wyaw + (key === 'q' || key === 'Q' ? rot : -rot))
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const st = () => useStore.getState()
  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        {leftOpen ? (
          <DockPanel
            side="left"
            title="Objects"
            hotkey="["
            width={leftW}
            onWidth={setLeftW}
            onCollapse={() => st().setLeftOpen(false)}
            actions={<PoseColsToggle />}
          >
            <ObjectsPanel />
          </DockPanel>
        ) : (
          <Rail side="left" title="Objects" hotkey="[" onOpen={() => st().setLeftOpen(true)} />
        )}
        <div className="canvas-wrap">
          <PoolCanvas />
        </div>
        {rightOpen ? (
          <DockPanel
            side="right"
            title={selected ?? 'Scene'}
            hotkey="]"
            width={rightW}
            onWidth={setRightW}
            onCollapse={() => st().setRightOpen(false)}
          >
            <Inspector />
          </DockPanel>
        ) : (
          <Rail side="right" title={selected ?? 'Scene'} hotkey="]" onOpen={() => st().setRightOpen(true)} />
        )}
      </div>
      <StatusBar />
    </div>
  )
}
