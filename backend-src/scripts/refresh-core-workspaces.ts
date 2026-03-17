import 'dotenv/config'
import { query } from '../src/db/client.js'
import { refreshAgentWorkspace } from '../src/daemon/workspace-init.js'
import { resolveAgentWorkspacePath } from '../src/services/agent-workspace.js'
import { resolveServerUrl } from '../src/server-url.js'

const DEFAULT_TEAM_CONTEXT = '红虾俱乐部 (Red Shrimp Lab) — multi-agent collaboration system. Team includes human users and AI agents communicating via mcp__chat tools.'

async function main() {
  const rows = await query<{
    id: string
    name: string
    description: string | null
    role: string
    model_id: string
    workspace_path: string | null
  }>(
    `SELECT id, name, description, role, model_id, workspace_path
     FROM agents
     WHERE role IN ('coordinator', 'tech-lead', 'ops')
     ORDER BY CASE role
       WHEN 'coordinator' THEN 0
       WHEN 'tech-lead' THEN 1
       WHEN 'ops' THEN 2
       ELSE 9
     END, name`
  )

  const serverUrl = resolveServerUrl()

  for (const agent of rows) {
    const workspacePath = agent.workspace_path?.trim() || resolveAgentWorkspacePath(agent.name)
    await refreshAgentWorkspace(workspacePath, {
      agentId: agent.id,
      agentName: agent.name,
      description: agent.description,
      role: agent.role as any,
      modelId: agent.model_id,
      serverUrl,
      channelName: '#all',
      teamContext: DEFAULT_TEAM_CONTEXT,
    })
    await query('UPDATE agents SET workspace_path = $2 WHERE id = $1', [agent.id, workspacePath])
    console.log(`refreshed ${agent.role} ${agent.name} -> ${workspacePath}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
