// Per-agent thinking buffer
// Accumulates thinking blocks from agent:trajectory events.
// When an agent sends a chat message, the buffer is drained and attached.

const buffer = new Map<string, string[]>()

export function pushThinking(agentId: string, text: string) {
  if (!text) return
  let arr = buffer.get(agentId)
  if (!arr) { arr = []; buffer.set(agentId, arr) }
  arr.push(text)
}

/** Drain and return all buffered thinking for an agent, or null if empty. */
export function drainThinking(agentId: string): string | null {
  const arr = buffer.get(agentId)
  if (!arr || arr.length === 0) return null
  buffer.delete(agentId)
  return arr.join('\n\n')
}
