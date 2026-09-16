/**
 * Pool registry — every venue the tool can lay out. Selecting a pool sets the
 * world dimensions, the default bottom-line layout (which also defines the
 * AprilTag snap points), and the default tag placement. The chosen pool id is
 * persisted in the viz sidecar, so ids must stay stable once released.
 *
 * To add a venue, append an entry here — everything else (canvas, snapping,
 * inspector picker, sidecar round-trip) picks it up automatically.
 */
import {
  DEFAULT_NINE_FT_M,
  ExtraLine,
  LineRun,
  M_PER_FT,
  POOL_DEPTH_M,
  POOL_LENGTH_M,
  POOL_WIDTH_M,
} from './math'

export interface PoolDef {
  id: string
  /** short name shown in the picker */
  label: string
  /** venue detail (city / campus) */
  venue: string
  /** world +X extent, m */
  lengthM: number
  /** world +Y extent, m */
  widthM: number
  depthM: number
  /** default bottom-line layout (spacing along length / width) */
  lines: {
    shortCount: number
    shortSpacing: number
    /** first short-line center from the x=0 wall, m; absent = centered */
    shortAnchor?: number
    /** per-line run overrides along Y; null/missing entry = family default */
    shortRuns?: (LineRun | null)[]
    /** T crossbars on the short family (default true) */
    shortTee?: boolean
    longCount: number
    longSpacing: number
    /** first long-line center from the y=0 wall, m; absent = centered */
    longAnchor?: number
    /** per-line run overrides along X; null/missing entry = family default */
    longRuns?: (LineRun | null)[]
    /** T crossbars on the long family (default true) */
    longTee?: boolean
    /** short-line stems cut windows out of long lines (default true) */
    crossCut?: boolean
    /** free-form one-off lines outside the two uniform families */
    extras?: ExtraLine[]
  }
}

export const POOLS: PoolDef[] = [
  {
    id: 'woollett',
    label: 'Woollett Aquatics Center',
    venue: 'Irvine, CA — RoboSub',
    lengthM: POOL_LENGTH_M,
    widthM: POOL_WIDTH_M,
    depthM: POOL_DEPTH_M,
    lines: {
      shortCount: 17,
      shortSpacing: DEFAULT_NINE_FT_M,
      longCount: 8,
      longSpacing: DEFAULT_NINE_FT_M,
    },
  },
  {
    id: 'rpac-divewell',
    label: 'RPAC Dive Well',
    venue: 'Ohio State University',
    // depth is a PLACEHOLDER (it varies across the pool) — l/w are measured
    lengthM: 25.0,
    widthM: 17.0,
    depthM: 17.0 * M_PER_FT,
    lines: {
      // 4 cross lines: first center 14 ft from the x=0 short wall, 12.5 ft apart;
      // runs seeded at the centered family default, tuned per line on site
      shortCount: 4,
      shortSpacing: 12.5 * M_PER_FT,
      shortAnchor: 14.0 * M_PER_FT,
      shortRuns: [
        { start: 2.0, length: 7.31 },
        { start: 2.7, length: 7.31 },
        { start: 3.4, length: 7.31 },
        { start: 1.7, length: 7.31 },
      ],
      shortTee: false,
      // 6 lap lanes along the length: centered at 3 m puts centers 1 m off each wall
      longCount: 7,
      longSpacing: 2.5,
      longTee: true,
      // the cross lines lie over the lap lines — no cut windows
      crossCut: false,
      // 2 more lap-parallel lines with odd placement and no T's — positions
      // are PLACEHOLDERS, tune in the Inspector ("extra lines") on site
      // extras: [
      //   { dir: 'along', pos: 2.5, start: 2.0, length: 9.0, tee: false },
      //   { dir: 'along', pos: 14.5, start: 2.0, length: 9.0, tee: false },
      // ],
    },
  },
]

export const DEFAULT_POOL = POOLS[0]

/** Resolve a persisted pool id; unknown/missing ids fall back to the default. */
export function poolById(id: string | null | undefined): PoolDef {
  return POOLS.find((p) => p.id === id) ?? DEFAULT_POOL
}
