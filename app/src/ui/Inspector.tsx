import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MAP, mapToWorld } from '../core/math'
import { siblingsOf, useStore, validParents } from '../state/store'
import { Card, EyeIcon, LockIcon, NumberField, TextField } from './common'
import { confirmDelete } from './confirm'

export function Inspector() {
  const selected = useStore((s) => s.selected)
  return <div className="inspector">{selected ? <ObjectInspector name={selected} /> : <SceneInspector />}</div>
}

// ------------------------------ selected object ------------------------------

function ObjectInspector({ name }: { name: string }) {
  const p = useStore((s) => s.objects[name])
  const mapPose = useStore((s) => s.mapPoses[name])
  const tag = useStore((s) => s.tag)
  const parents = useStore(useShallow((s) => validParents(s, name)))
  const manifest = useStore((s) => s.manifest)
  if (!p || !mapPose) return null
  const st = () => useStore.getState()
  const [wx, wy, wyaw] = mapToWorld(mapPose[0], mapPose[1], mapPose[3], tag)

  return (
    <>
      <Card>
        <div className="obj-header">
          <label className="swatch" title="marker color">
            <input type="color" value={p.color} onChange={(e) => st().patchObject(name, { color: e.target.value })} />
            <span style={{ background: p.color }} />
          </label>
          <TextField value={name} onCommit={(v) => st().renameObject(name, v)} />
          <button
            className={`icon-btn${p.locked ? ' on' : ''}`}
            title={p.locked ? 'Unlock' : 'Lock (immovable + click-through)'}
            onClick={() => st().patchObject(name, { locked: !p.locked })}
          >
            <LockIcon on={p.locked} />
          </button>
          <button
            className={`icon-btn${p.hidden ? ' on' : ''}`}
            title={p.hidden ? 'Show on canvas' : 'Hide from canvas'}
            onClick={() => st().patchObject(name, { hidden: !p.hidden })}
          >
            <EyeIcon off={p.hidden} />
          </button>
        </div>
        <div className="muted mono">owns frame {name}_frame</div>
      </Card>

      <Card title={`Pose relative to ${p.parent === MAP ? 'map' : `${p.parent}_frame`}`}>
        <div className="form-row">
          <label>parent</label>
          <select value={p.parent} onChange={(e) => st().reparentObject(name, e.target.value)} title="Re-parenting keeps the object's pool position">
            {parents.map((n) => (
              <option key={n} value={n}>
                {n === MAP ? 'map' : `${n}_frame`}
              </option>
            ))}
          </select>
        </div>
        <div className="pose-grid">
          <label>x</label>
          <NumberField value={p.x} onCommit={(v) => st().setRelPose(name, { x: v })} suffix="m" />
          <label>y</label>
          <NumberField value={p.y} onCommit={(v) => st().setRelPose(name, { y: v })} suffix="m" />
          <label>z</label>
          <NumberField value={p.z} onCommit={(v) => st().setRelPose(name, { z: v })} suffix="m" />
          <label>yaw</label>
          <NumberField value={p.yaw} decimals={2} step={1} onCommit={(v) => st().setRelPose(name, { yaw: v })} suffix="°" />
        </div>
        <div className="readout mono">
          map&nbsp; ({mapPose[0].toFixed(2)}, {mapPose[1].toFixed(2)}, {mapPose[2].toFixed(2)}) yaw {mapPose[3].toFixed(1)}°
          <br />
          pool ({wx.toFixed(2)}, {wy.toFixed(2)}) yaw {wyaw.toFixed(1)}°
        </div>
      </Card>

      <Card title="Config flags">
        <label className="check">
          <input
            type="checkbox"
            checked={p.lockOrientation}
            onChange={(e) => st().patchObject(name, { lockOrientation: e.target.checked })}
          />
          lock_orientation_to_config
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={p.pointYawAtParent}
            onChange={(e) => st().patchObject(name, { pointYawAtParent: e.target.checked })}
          />
          point_yaw_at_parent
        </label>
        <div className="form-row">
          <label>class</label>
          <TextField value={p.cls ?? ''} placeholder="(none)" onCommit={(v) => st().patchObject(name, { cls: v.trim() || null })} />
        </div>
      </Card>

      <Card title="Covariance">
        <div className="pose-grid">
          {(['x', 'y', 'z', 'yaw'] as const).map((k) => (
            <CovField key={k} name={name} k={k} v={p.covar[k]} />
          ))}
        </div>
      </Card>

      <Card title="Appearance">
        <div className="form-row">
          <label>mesh</label>
          <select
            value={p.mesh ?? ''}
            onChange={(e) => st().assignMesh(name, e.target.value || null)}
            title="Top-down sprite rendered from riptide_meshes model.dae"
          >
            <option value="">(none — colored footprint)</option>
            {Object.keys(manifest).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        {p.mesh ? (
          <div className="form-row">
            <label>sprite rot</label>
            <NumberField value={p.imageRot} decimals={1} step={90} suffix="°" onCommit={(v) => st().patchObject(name, { imageRot: v })} />
          </div>
        ) : (
          <div className="pose-grid">
            <label>length</label>
            <NumberField value={p.length} step={0.05} onCommit={(v) => st().setFootprint(name, v, p.width)} suffix="m" />
            <label>width</label>
            <NumberField value={p.width} step={0.05} onCommit={(v) => st().setFootprint(name, p.length, v)} suffix="m" />
          </div>
        )}
      </Card>

      <SwapCard name={name} />

      <div className="btn-row">
        <button onClick={() => st().addObject(name)} title="Add a child object under this frame">
          + Child
        </button>
        <button onClick={() => st().duplicateObject(name)}>Duplicate</button>
        <button className="danger" onClick={() => confirmDelete(name)}>
          Delete
        </button>
      </div>
    </>
  )
}

/** Swap this object's pose (and, for classed props, its class) with a sibling —
 *  e.g. the two gate sides, or the table items among themselves. */
function SwapCard({ name }: { name: string }) {
  const p = useStore((s) => s.objects[name])
  const siblings = useStore(useShallow((s) => siblingsOf(s, name)))
  const [target, setTarget] = useState('')
  useEffect(() => setTarget(''), [name])
  const other = target && siblings.includes(target) ? target : (siblings[0] ?? '')
  const otherProp = useStore((s) => s.objects[other])
  const st = () => useStore.getState()
  if (!p || siblings.length === 0) return null
  const canSwapClass = p.cls != null && otherProp?.cls != null

  return (
    <Card title="Swap with sibling">
      <div className="form-row">
        <label>sibling</label>
        <select value={other} onChange={(e) => setTarget(e.target.value)}>
          {siblings.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="btn-row">
        <button onClick={() => st().swapPose(name, other)} title="Exchange pool positions (world-preserving)">
          Swap pose
        </button>
        <button
          disabled={!canSwapClass}
          onClick={() => st().swapClass(name, other)}
          title={canSwapClass ? 'Exchange class (e.g. fire ↔ blood)' : 'both objects need a class'}
        >
          Swap class
        </button>
      </div>
    </Card>
  )
}

function CovField({ name, k, v }: { name: string; k: 'x' | 'y' | 'z' | 'yaw'; v: number }) {
  const st = () => useStore.getState()
  return (
    <>
      <label>{k}</label>
      <NumberField
        value={v}
        step={0.1}
        onCommit={(nv) => {
          const p = st().objects[name]
          if (p) st().patchObject(name, { covar: { ...p.covar, [k]: nv } })
        }}
      />
    </>
  )
}

// ------------------------------ nothing selected ------------------------------

function SceneInspector() {
  const tag = useStore((s) => s.tag)
  const lines = useStore((s) => s.lines)
  const placeMode = useStore((s) => s.placeMode)
  const labelMode = useStore((s) => s.labelMode)
  const theme = useStore((s) => s.theme)
  const st = () => useStore.getState()
  const robot = tag.mode === 'robot'
  const phi = (((tag.basePhi + tag.yawOffset) % 360) + 360) % 360
  const placing = placeMode !== null

  return (
    <>
      <Card title="Map origin">
        <div className="readout mono">
          {robot ? 'robot frame' : `${tag.wall} wall (AprilTag)`} · pool ({tag.x.toFixed(2)}, {tag.y.toFixed(2)})
          <br />
          +X heading {phi.toFixed(1)}° {robot ? '' : '(into the pool)'}
        </div>
        <div className="pose-grid">
          <label>x</label>
          <NumberField
            value={tag.x}
            step={0.01}
            suffix="m"
            title="Origin pool X"
            onCommit={(v) => st().setOriginPos(v, tag.y)}
          />
          <label>y</label>
          <NumberField
            value={tag.y}
            step={0.01}
            suffix="m"
            title="Origin pool Y"
            onCommit={(v) => st().setOriginPos(tag.x, v)}
          />
        </div>
        <div className="btn-row">
          <button
            className={placing ? 'accent' : ''}
            onClick={() => st().setPlaceMode(placing ? null : tag.mode)}
          >
            {placing ? 'Click the canvas…' : robot ? 'Place origin' : 'Place on wall'}
          </button>
          {robot && (
            <>
              <button onClick={() => st().rotateTag(90)}>⟲ 90°</button>
              <button onClick={() => st().rotateTag(-90)}>⟳ 90°</button>
            </>
          )}
        </div>
        {robot && (
          <div className="form-row">
            <label>heading</label>
            <NumberField value={tag.yawOffset} decimals={1} step={0.5} suffix="°" onCommit={(v) => st().setTagOffset(v)} />
          </div>
        )}
        <div className="muted">
          {robot
            ? 'The map origin is set in the robot frame (placed freely off the wall, shown with the talos footprint). Drag the marker or its handle on the canvas. World↔map math is unchanged.'
            : 'The map frame is the AprilTag frame (REP-103): +X into the pool, +Y left, +Z up. Snaps to bottom-line / wall intersections. Switch Tag / Robot in the toolbar.'}
        </div>
      </Card>

      <Card title="Display">
        <div className="form-row">
          <label>labels</label>
          <div className="seg">
            {(['roots', 'all', 'none'] as const).map((m) => (
              <button key={m} className={labelMode === m ? 'on' : ''} onClick={() => st().setLabelMode(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="form-row">
          <label>theme</label>
          <div className="seg">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => st().setTheme('light')}>
              light
            </button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => st().setTheme('dark')}>
              dark
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={lines.showGrid} onChange={(e) => st().setLines({ showGrid: e.target.checked })} />
          5 m grid overlay
        </label>
        <label className="check">
          <input type="checkbox" checked={lines.showChildren} onChange={(e) => st().setLines({ showChildren: e.target.checked })} />
          show child objects on canvas
        </label>
        <details className="adv">
          <summary>Bottom lines (tag snap points)</summary>
          <div className="lines-grid">
            <span />
            <span className="muted">count</span>
            <span className="muted">spacing</span>
            <span className="muted">thickness</span>
            <label className="check">
              <input type="checkbox" checked={lines.shortShow} onChange={(e) => st().setLines({ shortShow: e.target.checked })} />
              across (∥ short side)
            </label>
            <NumberField value={lines.shortCount} decimals={0} step={1} width={52} onCommit={(v) => st().setLines({ shortCount: Math.max(0, Math.round(v)) })} />
            <NumberField value={lines.shortSpacing} decimals={4} step={0.01} width={80} suffix="m" onCommit={(v) => st().setLines({ shortSpacing: Math.max(0.1, v) })} />
            <NumberField value={lines.shortThickness} decimals={3} step={0.01} width={64} suffix="m" title="Stripe thickness of the across lines" onCommit={(v) => st().setLines({ shortThickness: Math.max(0.02, v) })} />
            <label className="check">
              <input type="checkbox" checked={lines.longShow} onChange={(e) => st().setLines({ longShow: e.target.checked })} />
              along (∥ long side)
            </label>
            <NumberField value={lines.longCount} decimals={0} step={1} width={52} onCommit={(v) => st().setLines({ longCount: Math.max(0, Math.round(v)) })} />
            <NumberField value={lines.longSpacing} decimals={4} step={0.01} width={80} suffix="m" onCommit={(v) => st().setLines({ longSpacing: Math.max(0.1, v) })} />
            <NumberField value={lines.longThickness} decimals={3} step={0.01} width={64} suffix="m" title="Stripe thickness of the along lines" onCommit={(v) => st().setLines({ longThickness: Math.max(0.02, v) })} />
            <label className="check" title="T crossbars at line ends, same thickness as the line">
              <input type="checkbox" checked={lines.teeShow} onChange={(e) => st().setLines({ teeShow: e.target.checked })} />
              T ends
            </label>
            <span className="muted">length</span>
            <span className="muted">T length</span>
            <span />
            <span>across</span>
            <NumberField value={lines.shortLength} decimals={3} step={0.1} width={80} suffix="m" title="Run length of the across lines (centered on the pool width)" onCommit={(v) => st().setLines({ shortLength: Math.max(0.2, v) })} />
            <NumberField value={lines.shortTeeLength} decimals={3} step={0.05} width={64} suffix="m" disabled={!lines.teeShow} title="Length of the T crossbar at each across-line end" onCommit={(v) => st().setLines({ shortTeeLength: Math.max(0.05, v) })} />
            <span />
            <span>along</span>
            <NumberField value={lines.longLength} decimals={3} step={0.1} width={80} suffix="m" title="Run length of the along lines (centered on the pool length)" onCommit={(v) => st().setLines({ longLength: Math.max(0.2, v) })} />
            <NumberField value={lines.longTeeLength} decimals={3} step={0.05} width={64} suffix="m" disabled={!lines.teeShow} title="Length of the T crossbar at each along-line end" onCommit={(v) => st().setLines({ longTeeLength: Math.max(0.05, v) })} />
            <span />
            <span>cut gap</span>
            <NumberField value={lines.crossGap} decimals={3} step={0.05} width={80} suffix="m" title="Air gap between the cut ends of the along lines and the crossing across lines" onCommit={(v) => st().setLines({ crossGap: Math.max(0, v) })} />
            <span />
            <span />
          </div>
        </details>
      </Card>

      <Card title="Controls">
        <div className="muted help">
          <b>drag</b> object to move · <b>blue handle</b> rotates
          <br />
          <b>drag background</b> / middle-drag: pan · <b>wheel</b>: zoom
          <br />
          <b>double-click</b>: zoom to object · <b>F</b>: fit pool
          <br />
          <b>arrows</b>: nudge 1 cm (⇧ 10 cm) · <b>Q/E</b>: rotate 1° (⇧ 15°)
          <br />
          <b>Ctrl+Z</b>: undo · <b>Ctrl+⇧Z</b>: redo
          <br />
          <b>L</b>: lock · <b>H</b>: hide · <b>Del</b>: delete · <b>Esc</b>: deselect
          <br />
          <b>[</b> hides the Objects panel · <b>]</b> hides the Inspector
          <br />
          Children start locked after a config load — unlock via the list to fine-tune them.
        </div>
      </Card>
    </>
  )
}
