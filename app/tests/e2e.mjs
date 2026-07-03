/**
 * End-to-end verification against the running dev server (http://localhost:5173).
 * Drives the real canvas with pointer events and checks the acceptance criteria
 * from SPEC §11. Run:  node tests/e2e.mjs
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'

const CHROME = process.env.CHROME || '/usr/bin/chromium-browser'
const URL = 'http://127.0.0.1:5173/'

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}`)
  if (!cond) failures++
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const closeAng = (a, b, tol = 1e-6) => Math.abs(((a - b) % 360 + 540) % 360 - 180) <= tol

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => {
  console.log('  ✗ PAGE ERROR', e.message)
  failures++
})
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(
  () => window.__store && window.__store.getState().order.length > 0 && window.__scene?.current,
  { timeout: 30000 },
)
await new Promise((r) => setTimeout(r, 800)) // initial fit + textures

const st = () => page.evaluate(() => {
  const s = window.__store.getState()
  return {
    order: s.order,
    objects: s.objects,
    mapPoses: s.mapPoses,
    tag: s.tag,
    selected: s.selected,
    configPath: s.configPath,
    dirty: s.dirty,
  }
})
const clientOf = (wx, wy) =>
  page.evaluate((x, y) => window.__scene.current.clientFromWorld(x, y), wx, wy)
const worldOf = (name) =>
  page.evaluate((n) => {
    const s = window.__store.getState()
    const mp = s.mapPoses[n]
    const t = s.tag
    const phi = ((t.basePhi + t.yawOffset) * Math.PI) / 180
    return {
      wx: t.x + mp[0] * Math.cos(phi) - mp[1] * Math.sin(phi),
      wy: t.y + mp[0] * Math.sin(phi) + mp[1] * Math.cos(phi),
      wyaw: mp[3] + t.basePhi + t.yawOffset,
    }
  }, name)

// ---------------------------------------------------------------- load
console.log('load & hierarchy')
{
  const s = await st()
  ok(s.order.length === 35, `35 talos objects loaded (got ${s.order.length})`)
  ok(!s.order.includes('prequal_gate') && !s.order.includes('prequal_pole'), 'prequal ignored')
  ok(s.objects.gate_rescue.parent === 'gate', 'gate_rescue under gate')
  ok(s.objects.magnet1.parent === 'bin_cad_geometry', 'magnet1 under bin_cad_geometry')
  ok(s.objects.gate_rescue.locked && !s.objects.gate.locked, 'non-map children default locked')
  // gate_rescue map pose == compose(gate, rel)
  const g = s.objects.gate
  const r = s.objects.gate_rescue
  const a = (g.yaw * Math.PI) / 180
  const ex = g.x + r.x * Math.cos(a) - r.y * Math.sin(a)
  const ey = g.y + r.x * Math.sin(a) + r.y * Math.cos(a)
  ok(
    close(s.mapPoses.gate_rescue[0], ex) && close(s.mapPoses.gate_rescue[1], ey) &&
      close(s.mapPoses.gate_rescue[2], g.z + r.z),
    'gate_rescue map pose == compose(gate_map, rel)',
  )
  ok(s.objects.gate.mesh === 'gate' && s.objects.pill.mesh === 'table_pill', 'meshes auto-resolved')
}

// normalize the origin: a user sidecar next to the real config may have moved the
// tag (e.g. onto the S wall), which would break the geometry assumptions below
await page.evaluate(() => {
  const st = window.__store.getState()
  st.setOriginMode('apriltag')
  st.setPlaceMode('apriltag')
  st.placeTagAtWorld(0.2, 11.4)
  window.__store.setState({ past: [], future: [], dirty: false })
})

// ---------------------------------------------------------------- drag
console.log('drag gate across the pool (children rigid)')
{
  let s = await st()
  const relBefore = { ...s.objects.gate_rescue }
  const gw = await worldOf('gate')
  const from = await clientOf(gw.wx, gw.wy + 1.5) // on the gate footprint, off-origin
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  const to = await clientOf(40, 5)
  const t0 = Date.now()
  const STEPS = 120
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(
      from.cx + ((to.cx - from.cx) * i) / STEPS,
      from.cy + ((to.cy - from.cy) * i) / STEPS,
    )
  }
  const dragMs = Date.now() - t0
  await page.mouse.up()
  s = await st()
  ok(s.selected === 'gate', 'drag selected the gate')
  const gw2 = await worldOf('gate')
  ok(close(gw2.wx, 40, 0.05) && close(gw2.wy, 5 - 1.5, 0.05), `gate landed at drop point (${gw2.wx.toFixed(2)}, ${gw2.wy.toFixed(2)})`)
  const relAfter = s.objects.gate_rescue
  ok(
    relAfter.x === relBefore.x && relAfter.y === relBefore.y && relAfter.yaw === relBefore.yaw,
    'children relative poses unchanged during drag',
  )
  const a = (s.objects.gate.yaw * Math.PI) / 180
  const ex = s.objects.gate.x + relAfter.x * Math.cos(a) - relAfter.y * Math.sin(a)
  ok(close(s.mapPoses.gate_rescue[0], ex), 'children map poses follow rigidly')
  const fps = await page.evaluate(() => window.__scene.current.fps)
  console.log(`  · ${STEPS} drag moves in ${dragMs} ms (${((STEPS * 1000) / dragMs).toFixed(0)} moves/s), ticker ${fps.toFixed(0)} fps (software GL)`)
  ok(s.dirty, 'drag marks document dirty')
}

// ---------------------------------------------------------------- rotate handle
console.log('rotate via handle')
{
  await page.evaluate(() => window.__scene.current.centerOn('gate'))
  await new Promise((r) => setTimeout(r, 150))
  const gw = await worldOf('gate')
  // handle sits on local +X at bbox right + gap (k >= 60 → gap = 0.45 m); gate yaw ≈ 0
  const k = await page.evaluate(() => window.__scene.current.scalePxPerM)
  const gap = Math.max(0.45, 18 / k)
  const h = await clientOf(gw.wx + 0.038 + gap, gw.wy)
  await page.mouse.move(h.cx, h.cy)
  await page.mouse.down()
  const up = await clientOf(gw.wx, gw.wy + 3) // pointer straight "up" in world → yaw 90
  for (let i = 1; i <= 20; i++)
    await page.mouse.move(h.cx + ((up.cx - h.cx) * i) / 20, h.cy + ((up.cy - h.cy) * i) / 20)
  await page.mouse.up()
  const s = await st()
  ok(close(s.objects.gate.yaw, 90, 1.5), `gate yaw ≈ 90° after handle drag (got ${s.objects.gate.yaw.toFixed(1)})`)
  ok(s.objects.gate_rescue.yaw === 180, 'child relative yaw untouched by parent rotation')
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.setRelPose('gate', { x: 2, y: 0, yaw: 0 })
  })
}

// ---------------------------------------------------------------- lock = click-through
console.log('lock & click-through (table case)')
{
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.patchObject('table', { locked: true })
    s.patchObject('pill', { locked: false })
    s.select(null)
  })
  await page.evaluate(() => window.__scene.current.centerOn('table'))
  await new Promise((r) => setTimeout(r, 150))
  const pw = await worldOf('pill')
  const pc = await clientOf(pw.wx, pw.wy)
  await page.mouse.click(pc.cx, pc.cy)
  let s = await st()
  ok(s.selected === 'pill', `click over locked table selects the small prop on top (got ${s.selected})`)
  // click a table point away from any child → nothing (locked = click-through)
  const tw = await worldOf('table')
  const tc = await clientOf(tw.wx + 0.9, tw.wy + 0.9)
  await page.mouse.click(tc.cx, tc.cy)
  s = await st()
  ok(s.selected === null, 'clicking the locked table itself passes through (deselects)')
  // still selectable from the list
  await page.evaluate(() => window.__store.getState().select('table'))
  s = await st()
  ok(s.selected === 'table', 'locked object still selectable programmatically (list)')
}

// ---------------------------------------------------------------- hide
console.log('hide')
{
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.patchObject('bin', { hidden: true })
    s.select(null)
  })
  const bw = await worldOf('bin')
  const bc = await clientOf(bw.wx, bw.wy)
  await page.mouse.click(bc.cx, bc.cy)
  const s = await st()
  ok(s.selected !== 'bin', 'hidden object is not clickable on canvas')
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.select('bin')
    s.setRelPose('bin', { x: 1.25 })
  })
  const s2 = await st()
  ok(s2.objects.bin.x === 1.25, 'hidden object still editable via list/inspector')
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.setRelPose('bin', { x: 1.0 })
    s.patchObject('bin', { hidden: false })
    s.select(null)
  })
}

// ---------------------------------------------------------------- reparent preserves world pose
console.log('reparent')
{
  const before = await worldOf('torpedo')
  await page.evaluate(() => window.__store.getState().reparentObject('torpedo', 'gate'))
  let s = await st()
  const after = await worldOf('torpedo')
  ok(s.objects.torpedo.parent === 'gate', 'torpedo reparented under gate_frame')
  ok(close(before.wx, after.wx, 1e-6) && close(before.wy, after.wy, 1e-6), 'pool position unchanged by reparent')
  await page.evaluate(() => window.__store.getState().reparentObject('torpedo', 'map'))
  s = await st()
  const back = await worldOf('torpedo')
  ok(close(before.wx, back.wx, 1e-6), 'reparent back to map also preserves pose')
  const cycle = await page.evaluate(() => {
    const s = window.__store.getState()
    s.reparentObject('gate', 'gate_rescue') // must be refused
    return window.__store.getState().objects.gate.parent
  })
  ok(cycle === 'map', 'cycle-creating reparent refused')
}

// ---------------------------------------------------------------- tag placement
console.log('AprilTag placement')
{
  await page.evaluate(() => window.__scene.current.fit())
  await new Promise((r) => setTimeout(r, 100))
  const before = await worldOf('gate')
  // place on the south wall: click near a lane/wall intersection
  await page.evaluate(() => window.__store.getState().setPlaceMode('apriltag'))
  const target = await clientOf(25.1, 0.3) // near south wall center lane line
  await page.mouse.click(target.cx, target.cy)
  const s = await st()
  ok(s.tag.wall === 'S' && close(s.tag.basePhi, 90), `tag snapped to S wall (x=${s.tag.x.toFixed(2)})`)
  ok(Math.abs(s.tag.x - 25.1) < 1.5 && s.tag.y === 0, 'snapped to nearest lane/wall intersection')
  const after = await worldOf('gate')
  ok(!close(before.wx, after.wx, 0.01) || !close(before.wy, after.wy, 0.01), 'objects follow the tag (config poses are authoritative)')
  // map +X now points into the pool from the south wall (world +Y)
  const probe = await page.evaluate(() => {
    const s = window.__store.getState()
    const t = s.tag
    const phi = ((t.basePhi + t.yawOffset) * Math.PI) / 180
    // world point 4 m into the pool from the tag
    const wx = t.x
    const wy = t.y + 4
    const dx = wx - t.x
    const dy = wy - t.y
    return { mx: dx * Math.cos(phi) + dy * Math.sin(phi), my: -dx * Math.sin(phi) + dy * Math.cos(phi) }
  })
  ok(close(probe.mx, 4, 1e-9) && close(probe.my, 0, 1e-9), '+X points into the pool after snap')
  // restore west-wall default for the save test
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.setPlaceMode('apriltag')
    st.placeTagAtWorld(0.2, 11.4)
  })
}

// ---------------------------------------------------------------- robot-frame origin
console.log('robot-frame origin mode')
{
  const before = await worldOf('gate')
  await page.evaluate(() => window.__store.getState().setOriginMode('robot'))
  await page.evaluate(() => window.__store.getState().placeOriginFree(25, 11))
  let s = await st()
  ok(s.tag.mode === 'robot', 'switched to robot-frame origin')
  ok(close(s.tag.x, 25) && close(s.tag.y, 11), 'origin placed freely off the wall (no snap)')
  const after = await worldOf('gate')
  ok(!close(before.wx, after.wx, 0.01), 'objects follow the robot-frame origin')
  // drag the origin marker on the canvas
  await page.evaluate(() => window.__scene.current.fit())
  await new Promise((r) => setTimeout(r, 100))
  const from = await clientOf(25, 11)
  const to = await clientOf(30, 8)
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  for (let i = 1; i <= 20; i++)
    await page.mouse.move(from.cx + ((to.cx - from.cx) * i) / 20, from.cy + ((to.cy - from.cy) * i) / 20)
  await page.mouse.up()
  s = await st()
  ok(close(s.tag.x, 30, 0.2) && close(s.tag.y, 8, 0.2), `origin marker is draggable (at ${s.tag.x.toFixed(1)}, ${s.tag.y.toFixed(1)})`)
  // restore apriltag mode + west wall for the save test
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.setOriginMode('apriltag')
    st.setPlaceMode('apriltag')
    st.placeTagAtWorld(0.2, 11.4)
  })
}

// ---------------------------------------------------------------- swap + textures
console.log('swap poses / classes + textured sprites')
{
  let s = await st()
  const before = { rescue: { ...s.objects.gate_rescue }, repair: { ...s.objects.gate_repair } }
  await page.evaluate(() => window.__store.getState().swapPose('gate_rescue', 'gate_repair'))
  s = await st()
  ok(
    s.objects.gate_rescue.y === before.repair.y && s.objects.gate_repair.y === before.rescue.y,
    'swapPose exchanges the two gate sides',
  )
  await page.evaluate(() => window.__store.getState().swapPose('gate_rescue', 'gate_repair')) // restore

  s = await st()
  const v1 = s.objects.bin_vinyl1.cls
  const v2 = s.objects.bin_vinyl2.cls
  await page.evaluate(() => window.__store.getState().swapClass('bin_vinyl1', 'bin_vinyl2'))
  s = await st()
  ok(s.objects.bin_vinyl1.cls === v2 && s.objects.bin_vinyl2.cls === v1, 'swapClass exchanges fire/blood')
  await page.evaluate(() => window.__store.getState().swapClass('bin_vinyl1', 'bin_vinyl2')) // restore

  const manifest = await page.evaluate(() => window.__store.getState().manifest)
  ok(manifest.bin_vinyl?.texByClass?.fire?.includes('fire'), 'vinyl fire/blood textures in manifest')
  ok(!!manifest.table_pill?.tex, 'pill has a top-down texture sprite')
  ok(
    s.objects.pill.mesh === 'table_pill' &&
      Math.abs(s.objects.pill.bbox[0]) === Math.abs(s.objects.pill.bbox[2]),
    'textured object gets a square footprint',
  )
}

// ---------------------------------------------------------------- undo/redo
console.log('undo/redo')
{
  let s = await st()
  const x0 = s.objects.bin.x
  await page.evaluate(() => window.__store.getState().setRelPose('bin', { x: 7.77 }))
  await page.evaluate(() => window.__store.getState().undo())
  s = await st()
  ok(s.objects.bin.x === x0, `undo restores the previous pose (${s.objects.bin.x})`)
  await page.evaluate(() => window.__store.getState().redo())
  s = await st()
  ok(s.objects.bin.x === 7.77, 'redo re-applies it')
  await page.evaluate(() => window.__store.getState().undo())

  // a tag move is one undo step and restores objects' map poses with it
  const tagBefore = (await st()).tag
  await page.evaluate(() => window.__store.getState().rotateTag(90))
  await page.evaluate(() => window.__store.getState().undo())
  s = await st()
  ok(close(s.tag.yawOffset, tagBefore.yawOffset), 'tag rotation is undoable')

  // a full canvas drag collapses into a single undo step
  await page.evaluate(() => window.__scene.current.fit())
  await new Promise((r) => setTimeout(r, 100))
  const gw = await worldOf('gate')
  const depth0 = await page.evaluate(() => window.__store.getState().past.length)
  const from = await clientOf(gw.wx, gw.wy + 1.5)
  const to = await clientOf(gw.wx + 5, gw.wy + 1.5)
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  for (let i = 1; i <= 25; i++)
    await page.mouse.move(from.cx + ((to.cx - from.cx) * i) / 25, from.cy)
  await page.mouse.up()
  const depth1 = await page.evaluate(() => window.__store.getState().past.length)
  ok(depth1 === depth0 + 1, `drag gesture = one undo step (${depth0} -> ${depth1})`)
  await page.evaluate(() => window.__store.getState().undo())
  const gw2 = await worldOf('gate')
  ok(close(gw2.wx, gw.wx, 0.01) && close(gw2.wy, gw.wy, 0.01), 'undo restores the pre-drag position')
}

// ---------------------------------------------------------------- pin objects to pool
console.log('pin to pool')
{
  const before = await worldOf('gate')
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.setPoolLock(true)
    s.rotateTag(90)
  })
  const after = await worldOf('gate')
  ok(
    close(before.wx, after.wx, 1e-6) && close(before.wy, after.wy, 1e-6) && closeAng(before.wyaw, after.wyaw, 1e-6),
    'pinned: objects keep their pool pose when the origin rotates',
  )
  const s = await st()
  ok(!close(s.objects.gate.x, 2.0, 1e-6) || !close(s.tag.yawOffset, 0, 1e-6), 'map-relative poses were re-expressed')
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.undo() // restores tag + object poses in one step
    s.setPoolLock(false)
  })
  const restored = await worldOf('gate')
  ok(close(restored.wx, before.wx, 1e-6), 'undo reverts the pinned origin move')
}

// ---------------------------------------------------------------- theme
console.log('dark mode')
{
  await page.evaluate(() => window.__store.getState().setTheme('dark'))
  const attr = await page.evaluate(() => document.documentElement.dataset.theme)
  ok(attr === 'dark', 'dark theme applied to root element')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ok(bg === 'rgb(14, 18, 24)', `body background switched to dark (${bg})`)
  await page.evaluate(() => window.__store.getState().setTheme('light'))
}

// ---------------------------------------------------------------- zoom-out limit
console.log('camera limits')
{
  await page.evaluate(() => window.__scene.current.fit())
  const canvas = await page.$('.canvas-host canvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40; i++) await page.mouse.wheel({ deltaY: 400 })
  await new Promise((r) => setTimeout(r, 200))
  const a = await clientOf(0, 0)
  const b = await clientOf(50, 0)
  const poolPx = b.cx - a.cx
  ok(poolPx > box.width * 0.5, `zoom-out clamps at pool+objects fit (pool spans ${poolPx.toFixed(0)}px of ${box.width.toFixed(0)}px)`)
  for (let i = 0; i < 10; i++) await page.mouse.wheel({ deltaY: -400 })
  const c = await clientOf(0, 0)
  const d = await clientOf(50, 0)
  ok(d.cx - c.cx > poolPx, 'zoom-in works about the cursor')
}

// ---------------------------------------------------------------- save
console.log('save round-trip through the UI store')
{
  await page.evaluate(() => window.__store.getState().setRelPose('gate', { x: 2.75 }))
  await page.evaluate(() => window.__store.getState().saveToPath('/tmp/dr_e2e/config.yaml'))
  await new Promise((r) => setTimeout(r, 400))
  const saved = readFileSync('/tmp/dr_e2e/config.yaml', 'utf-8')
  const orig = readFileSync(
    '/home/ubuntu/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml',
    'utf-8',
  )
  ok(saved.includes('x: 2.75'), 'edited pose written')
  ok(saved.includes('# BOTH-ROBOTS SETTTINGS') && saved.includes('#NO TOUCH'), 'comments preserved')
  ok(saved.includes('prequal_gate:') && saved.includes('/liltank/riptide_mapping2:'), 'deprecated sections preserved')
  const changed = orig.split('\n').filter((l) => !saved.includes(l))
  ok(changed.length <= 2, `minimal diff vs original (${changed.length} source lines changed)`)
  const sidecar = JSON.parse(readFileSync('/tmp/dr_e2e/config.yaml.dr_viz.json', 'utf-8'))
  ok(sidecar.apriltag && sidecar.props.gate, 'viz sidecar written (tag + props)')
  ok(sidecar.props.table.locked === true, 'sidecar carries lock state')
  const s = await st()
  ok(!s.dirty, 'save clears dirty flag')
}

await browser.close()
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E CHECKS PASSED')
process.exit(failures ? 1 : 0)
