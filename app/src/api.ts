/**
 * File access for the two runtimes the app can run in:
 *  - Tauri desktop app: Rust commands from src-tauri (native dialogs; viz
 *    state lives in the platform app-data dir).
 *  - Browser + Vite dev/preview server: the localhost HTTP API
 *    (server/fsApi.ts); viz state in a sidecar file next to the config.
 * The Tauri modules are imported lazily so the browser bundle and the node
 * test environment never load them.
 */

export interface Env {
  home: string
  defaultConfigPath: string
  defaultConfigExists: boolean
}

/** True when running inside the Tauri shell (desktop app). */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

async function check<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export async function env(): Promise<Env> {
  if (isDesktop) return invoke<Env>('env_info')
  return check<Env>(await fetch('/api/env'))
}

export async function readFile(path: string): Promise<string> {
  if (isDesktop) return invoke<string>('read_file', { path })
  const data = await check<{ content: string }>(
    await fetch(`/api/read?path=${encodeURIComponent(path)}`),
  )
  return data.content
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isDesktop) return invoke('write_file', { path, content })
  await check(
    await fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  )
}

// ---------------------------------------------------------------- viz state

/** App-data file name for a config's viz state: readable basename plus an
 *  FNV-1a hash of the full path (two configs both named config.yaml must not
 *  collide). Must satisfy the key rules in src-tauri/src/lib.rs. */
function vizKey(configPath: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < configPath.length; i++) {
    h ^= configPath.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const base = (configPath.split(/[\\/]/).pop() ?? 'config').replace(/[^A-Za-z0-9_-]+/g, '_')
  return `viz-${base}-${(h >>> 0).toString(16)}.json`
}

const legacySidecar = (configPath: string) => `${configPath}.dr_viz.json`

/** Read a config's viz state (footprints/colors/hidden, tag, lines), or null.
 *  The desktop app reads its app-data copy first, then falls back to a legacy
 *  `.dr_viz.json` sidecar next to the config. */
export async function readViz(configPath: string): Promise<string | null> {
  if (isDesktop) {
    const s = await invoke<string | null>('read_app_state', { key: vizKey(configPath) })
    if (s != null) return s
  }
  try {
    return await readFile(legacySidecar(configPath))
  } catch {
    return null
  }
}

/** Write a config's viz state: app-data dir on desktop (nothing is written
 *  next to the external config), sidecar file in the browser. */
export async function writeViz(configPath: string, json: string): Promise<void> {
  if (isDesktop) return invoke('write_app_state', { key: vizKey(configPath), content: json })
  return writeFile(legacySidecar(configPath), json)
}

// ------------------------------------------------------------ native dialogs

const YAML_FILTERS = [{ name: 'YAML config', extensions: ['yaml', 'yml'] }]

/** Native open dialog; null when cancelled. Desktop only — browser callers
 *  show the in-app PathDialog instead. */
export async function pickLoadPath(defaultPath?: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const sel = await open({
    title: 'Load mapping config',
    defaultPath,
    multiple: false,
    directory: false,
    filters: YAML_FILTERS,
  })
  return typeof sel === 'string' ? sel : null
}

/** Native save dialog; null when cancelled. Desktop only. */
export async function pickSavePath(defaultPath?: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  return save({ title: 'Save mapping config as', defaultPath, filters: YAML_FILTERS })
}
