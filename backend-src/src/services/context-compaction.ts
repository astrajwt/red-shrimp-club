// Context compaction — summarize an agent's current context into MEMORY.md
// Used by:
//   1. POST /api/agents/:id/reset-context  (manual button)
//   2. Scheduler triggerHandoff()           (auto on token exhaustion)

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { query } from '../db/client.js'
import { llmClient } from '../daemon/llm-client.js'

interface CompactResult {
  ok: boolean
  tokensUsed: number
}

/**
 * Compact an agent's context: read MEMORY.md + recent logs, ask LLM to
 * produce a condensed summary, write it back, and log the event.
 */
export async function compactAgentContext(
  agentId: string,
  agentName: string,
  workspacePath: string,
  modelId: string,
): Promise<CompactResult> {
  const memoryPath = join(workspacePath, 'MEMORY.md')

  // Read existing MEMORY.md
  let currentMemory = ''
  try { currentMemory = await readFile(memoryPath, 'utf-8') } catch { /* no file yet */ }

  // Read recent logs for context
  const logs = await query(
    `SELECT level, content FROM agent_logs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 80`,
    [agentId]
  )
  const logText = (logs as any[]).reverse()
    .map((l: any) => `[${l.level}] ${l.content}`)
    .join('\n')

  // Ask LLM to write a condensed MEMORY.md
  const resp = await llmClient.complete({
    model: modelId,
    prompt: `You are compacting the memory of AI shrimp "${agentName}".

Current MEMORY.md:
\`\`\`
${currentMemory || '(empty)'}
\`\`\`

Recent activity logs (newest at bottom):
\`\`\`
${logText || '(none)'}
\`\`\`

Write an updated MEMORY.md that:
1. Preserves the Identity section exactly
2. Summarizes key findings, decisions, and completed work from the logs
3. Notes any in-progress tasks or important state
4. Stays under 150 lines

Output only the raw Markdown content for MEMORY.md, nothing else.`,
  })

  // Write compacted memory
  await writeFile(memoryPath, resp.text, 'utf-8')

  // Log the compaction event
  await query(
    `INSERT INTO agent_logs (agent_id, level, content) VALUES ($1, 'info', $2)`,
    [agentId, `[compact] Context summarized (${resp.tokensUsed} tokens used). MEMORY.md updated.`]
  )

  return { ok: true, tokensUsed: resp.tokensUsed }
}
