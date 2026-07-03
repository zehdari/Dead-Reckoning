/**
 * Config object name -> mesh directory resolver (same rules as the reference
 * implementation), against the set of available pre-rendered top-down sprites.
 */

/** cases plain/suffix matching can't resolve */
export const MESH_ALIASES: Record<string, string> = {
  slalom_parent: 'slalom',
  magnet1: 'bin_magnet',
  magnet2: 'bin_magnet',
  magnet_target1: 'bin_magnet',
  magnet_target2: 'bin_magnet',
}

export interface MeshEntry {
  bbox: [number, number, number, number]
  /** clean task-graphic sprite (relative to /topdown/), when the graphic reads top-down */
  tex?: string
  /** per-class variants, e.g. bin_vinyl fire/blood */
  texByClass?: Record<string, string>
  /** half-side of the square footprint to render a texture sprite on (meters) */
  texSquare?: number
}

export interface TopdownManifest {
  [dir: string]: MeshEntry
}

/** Resolve the texture sprite URL for a mesh (+ optional class), or null. */
export function texUrlFor(entry: MeshEntry | undefined, cls: string | null): string | null {
  if (!entry) return null
  if (entry.texByClass) {
    const key = (cls ?? '').toLowerCase()
    const f = entry.texByClass[key]
    return f ? `/topdown/${f}` : null
  }
  return entry.tex ? `/topdown/${entry.tex}` : null
}

/** True if this mesh has any top-down texture available. */
export function hasTexture(entry: MeshEntry | undefined): boolean {
  return !!entry && (!!entry.tex || !!entry.texByClass)
}

/**
 * Priority order: alias table / exact / strip trailing digits
 * (bin_vinyl1 -> bin_vinyl) / unique `_<name>` suffix (pill -> table_pill).
 */
export function resolveMeshDir(name: string, dirs: string[]): string | null {
  const set = new Set(dirs)
  const alias = MESH_ALIASES[name]
  if (alias && set.has(alias)) return alias
  if (set.has(name)) return name
  const stripped = name.replace(/[0-9]+$/, '')
  if (set.has(stripped)) return stripped
  const suffix = dirs.filter((d) => d.endsWith('_' + name))
  if (suffix.length === 1) return suffix[0]
  return null
}

export function topdownUrl(mesh: string): string {
  return `/topdown/${mesh}.png`
}
