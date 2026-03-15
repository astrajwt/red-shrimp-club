// Track recently sent message IDs so the SFX handler can suppress sounds for own messages.
// This avoids relying solely on sender_id comparison which can fail due to type/format issues.

const MAX_SIZE = 50

export const recentlySentIds = new Set<string>()

export function markSent(id: string) {
  recentlySentIds.add(id)
  if (recentlySentIds.size > MAX_SIZE) {
    const first = recentlySentIds.values().next().value
    if (first) recentlySentIds.delete(first)
  }
}
