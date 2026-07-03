import { memo } from 'react'
import { sceneHandle } from '../canvas/scene'
import { MAP } from '../core/math'
import { useStore } from '../state/store'
import { EyeIcon, LockIcon } from './common'

/**
 * Objects tree: hierarchy + lock/hide toggles + relative-pose columns.
 * Hidden/locked objects stay fully selectable and editable here (selection is
 * never tied to canvas visibility).
 */
export function ObjectsPanel() {
  const order = useStore((s) => s.order)
  const objects = useStore((s) => s.objects)
  const showPose = useStore((s) => s.showPoseCols)

  const roots = order.filter((n) => {
    const p = objects[n]
    return p.parent === MAP || !objects[p.parent]
  })
  const rows: { name: string; depth: number }[] = []
  const push = (name: string, depth: number) => {
    rows.push({ name, depth })
    for (const n of order) if (objects[n].parent === name) push(n, depth + 1)
  }
  roots.forEach((n) => push(n, 0))

  return (
    <div className={`objects-panel${showPose ? ' pose-cols' : ''}`}>
      <div className="objects-head">
        <span className="col-name">Object ({order.length})</span>
        <span className="col-flag" title="locked = immovable & click-through on canvas">
          <LockIcon on />
        </span>
        <span className="col-flag" title="hidden from canvas (still editable here)">
          <EyeIcon off={false} />
        </span>
        {showPose && (
          <>
            <span className="col-num">x</span>
            <span className="col-num">y</span>
            <span className="col-num">z</span>
            <span className="col-num">yaw°</span>
          </>
        )}
      </div>
      <div className="objects-rows">
        {rows.map(({ name, depth }) => (
          <Row key={name} name={name} depth={depth} />
        ))}
        {!rows.length && <div className="empty">No objects — load a config or press “+ Add”.</div>}
      </div>
    </div>
  )
}

/** Panel-head toggle for the pose columns (rendered by App in the dock header). */
export function PoseColsToggle() {
  const on = useStore((s) => s.showPoseCols)
  return (
    <button
      className={on ? 'on' : ''}
      title={on ? 'Hide the x / y / z / yaw columns' : 'Show the x / y / z / yaw columns'}
      onClick={() => useStore.getState().setShowPoseCols(!on)}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <path d="M9.5 4v16M15.5 4v16" />
      </svg>
    </button>
  )
}

const Row = memo(function Row({ name, depth }: { name: string; depth: number }) {
  const p = useStore((s) => s.objects[name])
  const selected = useStore((s) => s.selected === name)
  const showPose = useStore((s) => s.showPoseCols)
  if (!p) return null
  const st = () => useStore.getState()
  return (
    <div
      className={`obj-row${selected ? ' selected' : ''}${p.hidden ? ' is-hidden' : ''}`}
      onClick={() => st().select(name)}
      onDoubleClick={() => {
        st().select(name)
        sceneHandle.current?.centerOn(name)
      }}
    >
      <span className="col-name" style={{ paddingLeft: 6 + depth * 14 }}>
        <span className="dot" style={{ background: p.color }} />
        <span className="nm" title={`${name} (frame: ${name}_frame)`}>{name}</span>
      </span>
      <FlagBtn
        on={p.locked}
        className="col-flag lock"
        title={p.locked ? 'Unlock (make draggable)' : 'Lock (immovable + click-through)'}
        onToggle={() => st().patchObject(name, { locked: !p.locked })}
      >
        <LockIcon on={p.locked} />
      </FlagBtn>
      <FlagBtn
        on={p.hidden}
        className="col-flag hide"
        title={p.hidden ? 'Show on canvas' : 'Hide from canvas'}
        onToggle={() => st().patchObject(name, { hidden: !p.hidden })}
      >
        <EyeIcon off={p.hidden} />
      </FlagBtn>
      {showPose && (
        <>
          <Num v={p.x} d={2} />
          <Num v={p.y} d={2} />
          <Num v={p.z} d={2} />
          <Num v={p.yaw} d={1} />
        </>
      )}
    </div>
  )
})

function FlagBtn(props: {
  on: boolean
  className: string
  title: string
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`${props.className}${props.on ? ' on' : ''}`}
      title={props.title}
      onClick={(e) => {
        e.stopPropagation()
        props.onToggle()
      }}
    >
      {props.children}
    </button>
  )
}

function Num({ v, d }: { v: number; d: number }) {
  return <span className="col-num">{v.toFixed(d)}</span>
}
