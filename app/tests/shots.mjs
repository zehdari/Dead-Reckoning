/** Screenshot helper: overview (light+dark), textured table detail, robot origin. */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium-browser',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
})
const page = await browser.newPage()
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__store?.getState().order.length > 0 && window.__scene?.current)
await new Promise((r) => setTimeout(r, 1500))
const out = process.env.OUT || `${process.env.HOME}/dr-verify`

await page.evaluate(() => window.__store.getState().setTheme('light'))
await new Promise((r) => setTimeout(r, 300))
await page.screenshot({ path: `${out}/shot-overview.png` })

await page.evaluate(() => {
  const s = window.__store.getState()
  s.select('table')
  window.__scene.current.centerOn('table')
})
await new Promise((r) => setTimeout(r, 600))
await page.screenshot({ path: `${out}/shot-table.png` })

await page.evaluate(() => window.__store.getState().setTheme('dark'))
await new Promise((r) => setTimeout(r, 400))
await page.screenshot({ path: `${out}/shot-table-dark.png` })

await page.evaluate(() => {
  const s = window.__store.getState()
  s.select(null)
  s.setOriginMode('robot')
  s.placeOriginFree(20, 12)
  window.__scene.current.fit()
})
await new Promise((r) => setTimeout(r, 600))
await page.screenshot({ path: `${out}/shot-robot-dark.png` })

await browser.close()
console.log('shots written to', out)
