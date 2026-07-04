import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { sceneHandle } from '../canvas/scene'
import { useStore } from '../state/store'
import { PathDialog } from './common'
import { confirmDelete } from './confirm'

type Dialog = { title: string; action: string; initial: string; run: (p: string) => void } | null

interface MenuItem {
  label: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}

/** Toolbar dropdown: closes on outside click, Escape, or after an item runs. */
function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation() // just close the menu — don't also deselect
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className={open ? 'menu-open' : ''} onClick={() => setOpen((o) => !o)}>
        {label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 9l7 7 7-7" />
        </svg>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              disabled={it.disabled}
              className={it.danger ? 'danger' : ''}
              title={it.title}
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const UndoIcon = ({ flip }: { flip?: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={flip ? { transform: 'scaleX(-1)' } : undefined}
  >
    <path d="M8.5 5 4 9.5 8.5 14" />
    <path d="M4 9.5h10a6 6 0 0 1 0 12h-3" transform="translate(0 -2.5)" />
  </svg>
)

export function Toolbar() {
  const selected = useStore((s) => s.selected)
  const placeMode = useStore((s) => s.placeMode)
  const originMode = useStore((s) => s.tag.mode)
  const poolLock = useStore((s) => s.poolLock)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const configPath = useStore((s) => s.configPath)
  const dirty = useStore((s) => s.dirty)
  const home = useStore((s) => s.home)
  const theme = useStore((s) => s.theme)
  const [dialog, setDialog] = useState<Dialog>(null)

  const st = () => useStore.getState()
  const fallbackDir = configPath ? configPath.replace(/[\\/][^\\/]*$/, '') : (home ?? '')
  const placing = placeMode !== null
  const robot = originMode === 'robot'

  const doSave = () => {
    if (configPath) void st().saveToPath(configPath)
    else saveAs()
  }
  // Ctrl/Cmd+S saves (even while typing in a field — the browser's own
  // "save page" dialog must never appear). Ref so the listener registers once.
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        doSaveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // desktop: native file dialogs; browser: the in-app path prompt
  const doLoad = () => {
    if (api.isDesktop) {
      void api.pickLoadPath(configPath ?? fallbackDir).then((p) => {
        if (p) void st().loadFromPath(p)
      })
      return
    }
    setDialog({
      title: 'Load mapping config',
      action: 'Load',
      initial: configPath ?? `${fallbackDir}/config.yaml`,
      run: (p) => void st().loadFromPath(p),
    })
  }
  const saveAs = () => {
    if (api.isDesktop) {
      void api.pickSavePath(configPath ?? `${fallbackDir}/config.yaml`).then((p) => {
        if (p) void st().saveToPath(p)
      })
      return
    }
    setDialog({
      title: 'Save mapping config as',
      action: 'Save',
      initial: configPath ?? `${fallbackDir}/config.yaml`,
      run: (p) => void st().saveToPath(p),
    })
  }

  return (
    <div className="toolbar">
      <span className="app-title">
        Dead&nbsp;Reckoning <span className="app-sub">RoboSub 2026</span>
      </span>
      <span className="sep" />
      <Menu
        label="File"
        items={[
          { label: 'Load…', onClick: doLoad },
          {
            label: (
              <>
                Save
                {dirty && <span className="dirty-dot" title="unsaved changes" />}
              </>
            ),
            title: 'Save config + viz sidecar',
            onClick: doSave,
          },
          { label: 'Save As…', onClick: saveAs },
        ]}
      />
      <Menu
        label="Object"
        items={[
          { label: '+ Add', title: 'Add a new object at the pool center', onClick: () => st().addObject() },
          { label: 'Duplicate', disabled: !selected, onClick: () => selected && st().duplicateObject(selected) },
          { label: 'Delete', disabled: !selected, danger: true, onClick: () => selected && confirmDelete(selected) },
        ]}
      />
      <span className="sep" />
      <button className="icon-btn" disabled={!canUndo} onClick={() => st().undo()} title="Undo (Ctrl+Z)">
        <UndoIcon />
      </button>
      <button className="icon-btn" disabled={!canRedo} onClick={() => st().redo()} title="Redo (Ctrl+Shift+Z)">
        <UndoIcon flip />
      </button>
      <span className="sep" />
      <div className="seg" title="Where the map origin lives: an AprilTag on a wall, or a free robot-frame pose">
        <button className={!robot ? 'on' : ''} onClick={() => st().setOriginMode('apriltag')}>
          Tag
        </button>
        <button className={robot ? 'on' : ''} onClick={() => st().setOriginMode('robot')}>
          Robot
        </button>
      </div>
      <button
        className={placing ? 'accent' : ''}
        onClick={() => st().setPlaceMode(placing ? null : originMode)}
        title={
          robot
            ? 'Click anywhere in the pool to set the robot-frame map origin'
            : 'Click a bottom-line / wall intersection to place the AprilTag (map origin)'
        }
      >
        {placing ? 'Click the canvas…' : robot ? 'Place origin' : 'Place tag'}
      </button>
      <label
        className="check pin"
        title="Pin objects to the pool: moving or rotating the tag/origin no longer carries the objects with it"
      >
        <input type="checkbox" checked={poolLock} onChange={(e) => st().setPoolLock(e.target.checked)} />
        pin&nbsp;to&nbsp;pool
      </label>
      <span className="sep" />
      <button onClick={() => sceneHandle.current?.fit()} title="Fit pool to view (F)">
        Fit
      </button>
      <button
        className="icon-btn"
        onClick={() => st().toggleTheme()}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6 8.5 8.5 0 1 0 20.4 14.2z" />
          </svg>
        )}
      </button>
      <span className="spacer" />
      <span className="path-chip" title={configPath ?? 'no config loaded'}>
        {dirty && <span className="dirty-dot" title="unsaved changes" />}
        {configPath ? configPath.split(/[\\/]/).slice(-2).join('/') : 'unsaved layout'}
      </span>
      {dialog && (
        <PathDialog
          title={dialog.title}
          action={dialog.action}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSubmit={(p) => {
            setDialog(null)
            dialog.run(p)
          }}
        />
      )}
    </div>
  )
}
