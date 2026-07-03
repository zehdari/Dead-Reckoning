import { useEffect, useRef, useState } from 'react'

/**
 * Number input that keeps focus while typing and commits on Enter/blur.
 * Native spinners are hidden (they render poorly, especially in Firefox);
 * custom chevron steppers step by `step` and support press-and-hold.
 */
export function NumberField(props: {
  value: number
  onCommit: (v: number) => void
  step?: number
  decimals?: number
  disabled?: boolean
  suffix?: string
  width?: number
  title?: string
}) {
  const { value, onCommit, step = 0.01, decimals = 3, disabled, suffix, width, title } = props
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? fmt(value, decimals)
  // latest state for the hold-repeat timers (their closures would go stale)
  const live = useRef({ value, text, step, onCommit })
  live.current = { value, text, step, onCommit }
  const timers = useRef<{ t: number; i: number }>({ t: 0, i: 0 })

  function fmt(v: number, d: number): string {
    const s = v.toFixed(d)
    return s === '-0' + (d ? '.' + '0'.repeat(d) : '') ? (0).toFixed(d) : s
  }
  function commit(raw: string): void {
    const v = parseFloat(raw)
    if (Number.isFinite(v) && v !== value) onCommit(v)
    setText(null)
  }
  function stepBy(dir: 1 | -1): void {
    const L = live.current
    const typed = parseFloat(L.text ?? '')
    const base = Number.isFinite(typed) ? typed : L.value
    const v = +(base + dir * L.step).toFixed(6)
    setText(null)
    if (v !== L.value) L.onCommit(v)
  }
  function stopHold(): void {
    window.clearTimeout(timers.current.t)
    window.clearInterval(timers.current.i)
  }
  function startHold(e: React.PointerEvent, dir: 1 | -1): void {
    e.preventDefault() // keep focus (and any typed text) in the input
    if (e.button !== 0) return
    stepBy(dir)
    stopHold()
    timers.current.t = window.setTimeout(() => {
      timers.current.i = window.setInterval(() => stepBy(dir), 80)
    }, 400)
  }
  useEffect(() => stopHold, [])

  return (
    <span className="numfield" title={title}>
      <span className="numwrap">
        <input
          type="number"
          step={step}
          disabled={disabled}
          value={shown}
          style={width ? { width } : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setText(null)
            e.stopPropagation()
          }}
        />
        {!disabled && (
          <span className="steppers">
            {([1, -1] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                tabIndex={-1}
                aria-label={dir === 1 ? 'increment' : 'decrement'}
                onPointerDown={(e) => startHold(e, dir)}
                onPointerUp={stopHold}
                onPointerLeave={stopHold}
              >
                <svg width="7" height="5" viewBox="0 0 8 5">
                  <path
                    d={dir === 1 ? 'M0.5 4.5 4 1 7.5 4.5' : 'M0.5 0.5 4 4 7.5 0.5'}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ))}
          </span>
        )}
      </span>
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  )
}

/** Text input that commits on Enter/blur (used for rename / class). */
export function TextField(props: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      type="text"
      className="textfield"
      placeholder={props.placeholder}
      disabled={props.disabled}
      value={text ?? props.value}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        if (text !== null && e.target.value !== props.value) props.onCommit(e.target.value)
        setText(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(null)
        e.stopPropagation()
      }}
    />
  )
}

/** Modal path prompt for load/save/export. */
export function PathDialog(props: {
  title: string
  action: string
  initial: string
  onSubmit: (path: string) => void
  onClose: () => void
}) {
  const [path, setPath] = useState(props.initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal">
        <h3>{props.title}</h3>
        <input
          ref={ref}
          type="text"
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim()) props.onSubmit(path.trim())
            if (e.key === 'Escape') props.onClose()
          }}
        />
        <div className="modal-actions">
          <button onClick={props.onClose}>Cancel</button>
          <button className="accent" disabled={!path.trim()} onClick={() => props.onSubmit(path.trim())}>
            {props.action}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Card(props: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="card">
      {(props.title || props.right) && (
        <header>
          <span>{props.title}</span>
          {props.right}
        </header>
      )}
      {props.children}
    </section>
  )
}

export const LockIcon = ({ on }: { on: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="10" rx="2" fill={on ? 'currentColor' : 'none'} />
    {on ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.8-1.3" />}
  </svg>
)

export const EyeIcon = ({ off }: { off: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    {off && <line x1="4" y1="20" x2="20" y2="4" />}
  </svg>
)
