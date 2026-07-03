import { worldToMap } from '../core/math'
import { useStore } from '../state/store'

export function StatusBar() {
  const cursor = useStore((s) => s.cursor)
  const tag = useStore((s) => s.tag)
  const status = useStore((s) => s.status)
  const count = useStore((s) => s.order.length)
  const phi = (((tag.basePhi + tag.yawOffset) % 360) + 360) % 360

  let coords = '—'
  if (cursor) {
    const [mx, my] = worldToMap(cursor.wx, cursor.wy, 0, tag)
    coords = `pool (${cursor.wx.toFixed(2)}, ${cursor.wy.toFixed(2)})   map (${mx.toFixed(2)}, ${my.toFixed(2)})`
  }
  return (
    <div className="statusbar">
      <span className="mono coords">{coords}</span>
      <span className="mono">
        origin: {tag.mode === 'robot' ? 'robot' : `${tag.wall} wall`} ({tag.x.toFixed(2)},{' '}
        {tag.y.toFixed(2)}) φ {phi.toFixed(1)}°
      </span>
      <span className={`msg ${status.kind}`}>{status.text}</span>
      <span className="spacer" />
      <span className="mono">{count} objects</span>
    </div>
  )
}
