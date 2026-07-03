import { createRoot } from 'react-dom/client'
import { sceneHandle } from './canvas/scene'
import { useStore } from './state/store'
import { App } from './ui/App'
import './styles.css'

// No StrictMode: the Pixi canvas owns real GPU resources and must init exactly once.
createRoot(document.getElementById('root')!).render(<App />)

if (import.meta.env.DEV) {
  // dev/e2e hooks
  ;(window as any).__store = useStore
  ;(window as any).__scene = sceneHandle
}
