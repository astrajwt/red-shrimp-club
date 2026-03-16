import { useSyncExternalStore } from 'react'

const mql = typeof window !== 'undefined'
  ? window.matchMedia('(max-width: 767px)')
  : null

function subscribe(cb: () => void) {
  mql?.addEventListener('change', cb)
  return () => mql?.removeEventListener('change', cb)
}

function getSnapshot() {
  return mql?.matches ?? false
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
