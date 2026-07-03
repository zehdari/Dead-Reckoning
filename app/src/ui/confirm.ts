import { childrenOf, useStore } from '../state/store'

/** Delete with a confirmation; children are re-parented to map (world pose kept). */
export function confirmDelete(name: string): void {
  const s = useStore.getState()
  const kids = childrenOf(s.objects, s.order, name)
  const msg = kids.length
    ? `Delete '${name}'? Its ${kids.length} direct child${kids.length > 1 ? 'ren' : ''} will be re-parented to map (keeping their pool positions).`
    : `Delete '${name}'?`
  if (window.confirm(msg)) {
    s.deleteObject(name)
    s.say(`Deleted ${name}.`)
  }
}
