import { useSyncExternalStore } from 'react'

export interface ServiceStatus {
  reachable: boolean
  message: string | null
  checkedAt: number | null
}

let state: ServiceStatus = {
  reachable: true,
  message: null,
  checkedAt: null,
}

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setState(next: ServiceStatus) {
  if (
    state.reachable === next.reachable &&
    state.message === next.message &&
    state.checkedAt === next.checkedAt
  ) return
  state = next
  emit()
}

export function markServiceReachable() {
  if (state.reachable && state.message === null) return
  setState({
    reachable: true,
    message: null,
    checkedAt: Date.now(),
  })
}

export function markServiceUnreachable(message: string) {
  setState({
    reachable: false,
    message,
    checkedAt: Date.now(),
  })
}

export function describeServiceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return 'Backend unavailable. Check whether the API server and database are running.'
  }
  return message || 'Backend unavailable.'
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return state
}

export function useServiceStatus() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
