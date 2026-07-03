import { useEffect, useRef } from 'react'
import { PoolScene, sceneHandle } from './scene'

export function PoolCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new PoolScene()
    sceneHandle.current = scene
    let alive = true
    scene.init(host).catch((e) => {
      if (alive) console.error('canvas init failed', e)
    })
    return () => {
      alive = false
      if (sceneHandle.current === scene) sceneHandle.current = null
      scene.destroy()
    }
  }, [])

  return <div ref={hostRef} className="canvas-host" />
}
