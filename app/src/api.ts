/** Client for the local file-system API (server/fsApi.ts). */

export interface Env {
  home: string
  defaultConfigPath: string
  defaultConfigExists: boolean
}

async function check<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export async function env(): Promise<Env> {
  return check<Env>(await fetch('/api/env'))
}

export async function readFile(path: string): Promise<string> {
  const data = await check<{ content: string }>(
    await fetch(`/api/read?path=${encodeURIComponent(path)}`),
  )
  return data.content
}

export async function writeFile(path: string, content: string): Promise<void> {
  await check(
    await fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  )
}
