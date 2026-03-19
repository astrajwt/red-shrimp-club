import { useSyncExternalStore } from 'react'

function getMediaQueryList() {
  if (typeof window === 'undefined') return null
  if (typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(max-width: 767px)')
}

function subscribe(cb: () => void) {
  const mql = getMediaQueryList()
  mql?.addEventListener('change', cb)
  return () => mql?.removeEventListener('change', cb)
}

function getSnapshot() {
  const mql = getMediaQueryList()
  return mql?.matches ?? false
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
