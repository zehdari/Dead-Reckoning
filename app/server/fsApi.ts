/**
 * Local file-system API for the dev/preview server.
 *
 * The editor runs in a browser but must read/write real files (the riptide_mapping
 * config, its viz sidecar, CSV exports). This tiny middleware exposes them on
 * localhost only; paths are restricted to the user's home directory and /tmp.
 */
import type { Plugin, Connect } from 'vite'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG_PATH =
  '/home/ubuntu/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml'

function allowed(p: string): boolean {
  const r = path.resolve(p)
  return r.startsWith(os.homedir() + path.sep) || r.startsWith('/tmp/')
}

function send(res: any, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(data))
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

function handler(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()
    try {
      if (url.pathname === '/api/env' && req.method === 'GET') {
        return send(res, 200, {
          home: os.homedir(),
          defaultConfigPath: DEFAULT_CONFIG_PATH,
          defaultConfigExists: existsSync(DEFAULT_CONFIG_PATH),
        })
      }
      if (url.pathname === '/api/read' && req.method === 'GET') {
        const p = url.searchParams.get('path') ?? ''
        if (!allowed(p)) return send(res, 403, { error: 'path not allowed' })
        if (!existsSync(p)) return send(res, 404, { error: 'not found' })
        const content = await fs.readFile(p, 'utf-8')
        return send(res, 200, { content })
      }
      if (url.pathname === '/api/write' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { path: string; content: string }
        if (!allowed(body.path)) return send(res, 403, { error: 'path not allowed' })
        await fs.mkdir(path.dirname(path.resolve(body.path)), { recursive: true })
        await fs.writeFile(body.path, body.content, 'utf-8')
        return send(res, 200, { ok: true })
      }
      return send(res, 404, { error: 'unknown endpoint' })
    } catch (e) {
      return send(res, 500, { error: String(e) })
    }
  }
}

export function fsApiPlugin(): Plugin {
  return {
    name: 'dead-reckoning-fs-api',
    configureServer(server) {
      server.middlewares.use(handler())
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler())
    },
  }
}
