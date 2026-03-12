// redshrimp-daemon chat-bridge — MCP server for agent communication
// Spawned as a subprocess by the AI runtime (Claude Code / Codex / Kimi).
// Provides send_message, receive_message, list_server, etc.
// Talks to the Red Shrimp Lab backend via HTTP (/internal/agent/:id/*).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

function toLocalTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2)
let agentId = ''
let serverUrl = 'http://localhost:3001'
let authToken = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent-id' && args[i + 1]) agentId = args[++i]
  if (args[i] === '--server-url' && args[i + 1]) serverUrl = args[++i]
  if (args[i] === '--auth-token' && args[i + 1]) authToken = args[++i]
}

if (!agentId) {
  console.error('Missing --agent-id')
  process.exit(1)
}

const commonHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
if (authToken) commonHeaders['Authorization'] = `Bearer ${authToken}`

// ── MCP Server ────────────────────────────────────────────────────
const server = new McpServer({ name: 'chat', version: '1.0.0' })

server.tool(
  'send_message',
  'Send a message to a channel or DM. To reply, reuse the channel value from the received message (e.g. channel=\'#all\' or channel=\'DM:@richard\'). To start a NEW DM, use dm_to with the person\'s name.',
  {
    channel: z.string().optional().describe("Where to send. '#channel-name' for channels, 'DM:@peer-name' for DMs."),
    dm_to: z.string().optional().describe("Person's name to start a NEW DM with."),
    content: z.string().describe('The message content'),
  },
  async ({ channel, dm_to, content }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/send`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, dm_to, content }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: `Message sent to ${channel || `new DM with ${dm_to}`}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'receive_message',
  'Receive new messages. Use block=true to wait for new messages.',
  {
    block: z.boolean().default(true).describe('Whether to block (wait) for new messages'),
    timeout_ms: z.number().default(59000).describe('How long to wait in ms when blocking'),
  },
  async ({ block, timeout_ms }) => {
    try {
      const params = new URLSearchParams()
      if (block) params.set('block', 'true')
      params.set('timeout', String(timeout_ms))
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/receive?${params}`, {
        method: 'GET', headers: commonHeaders,
      })
      const data = await res.json() as any
      if (!data.messages || data.messages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No new messages.' }] }
      }
      const formatted = data.messages.map((m: any) => {
        const ch = m.channel_type === 'dm' ? `DM:@${m.channel_name}` : `#${m.channel_name}`
        const prefix = m.sender_type === 'agent' ? '(agent) ' : ''
        const time = m.timestamp ? ` (${toLocalTime(m.timestamp)})` : ''
        return `[${ch}]${time} ${prefix}@${m.sender_name}: ${m.content}`
      }).join('\n')
      return { content: [{ type: 'text' as const, text: formatted }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'list_server',
  'List all channels, agents, and humans in this server.',
  {},
  async () => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/server`, {
        method: 'GET', headers: commonHeaders,
      })
      const data = await res.json() as any
      let text = '## Server\n\n### Channels\n'
      for (const t of data.channels ?? []) {
        const status = t.joined ? 'joined' : 'not joined'
        text += t.description ? `  - #${t.name} [${status}] — ${t.description}\n` : `  - #${t.name} [${status}]\n`
      }
      text += '\n### Agents\n'
      for (const a of data.agents ?? []) text += `  - @${a.name} (${a.status})\n`
      text += '\n### Humans\n'
      for (const u of data.humans ?? []) text += `  - @${u.name}\n`
      return { content: [{ type: 'text' as const, text }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'read_history',
  'Read message history for a channel or DM.',
  {
    channel: z.string().describe("e.g. '#all', 'DM:@richard'"),
    limit: z.number().default(50),
    before: z.number().optional(),
    after: z.number().optional(),
  },
  async ({ channel, limit, before, after }) => {
    try {
      const params = new URLSearchParams({ channel, limit: String(Math.min(limit, 100)) })
      if (before) params.set('before', String(before))
      if (after) params.set('after', String(after))
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/history?${params}`, {
        method: 'GET', headers: commonHeaders,
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.messages?.length) return { content: [{ type: 'text' as const, text: 'No messages.' }] }
      const formatted = data.messages.map((m: any) => {
        const prefix = m.senderType === 'agent' ? '(agent) ' : ''
        const time = m.createdAt ? ` (${toLocalTime(m.createdAt)})` : ''
        return `[seq:${m.seq}]${time} ${prefix}@${m.senderName}: ${m.content}`
      }).join('\n')
      let footer = ''
      if (data.has_more && data.messages.length > 0) {
        const edge = after ? data.messages[data.messages.length - 1].seq : data.messages[0].seq
        footer = `\n\n--- Use ${after ? 'after' : 'before'}=${edge} for more. ---`
      }
      return { content: [{ type: 'text' as const, text: `## History for ${channel}\n\n${formatted}${footer}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'list_tasks',
  "List tasks on a channel's task board.",
  {
    channel: z.string(),
    status: z.enum(['all', 'todo', 'in_progress', 'in_review', 'done']).default('all'),
  },
  async ({ channel, status }) => {
    try {
      const params = new URLSearchParams({ channel })
      if (status !== 'all') params.set('status', status)
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks?${params}`, {
        method: 'GET', headers: commonHeaders,
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.tasks?.length) return { content: [{ type: 'text' as const, text: `No tasks in ${channel}.` }] }
      const formatted = data.tasks.map((t: any) => {
        const assignee = t.claimedByName ? ` → @${t.claimedByName}` : ''
        return `#t${t.taskNumber} [${t.status}] "${t.title}"${assignee}`
      }).join('\n')
      return { content: [{ type: 'text' as const, text: `## Tasks for ${channel}\n\n${formatted}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'create_tasks',
  'Create tasks on a channel task board.',
  {
    channel: z.string(),
    tasks: z.array(z.object({ title: z.string() })),
  },
  async ({ channel, tasks }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, tasks }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const created = data.tasks.map((t: any) => `#t${t.taskNumber} "${t.title}"`).join('\n')
      return { content: [{ type: 'text' as const, text: `Created ${data.tasks.length} task(s):\n${created}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'claim_tasks',
  'Claim tasks by number.',
  {
    channel: z.string(),
    task_numbers: z.array(z.number()),
  },
  async ({ channel, task_numbers }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/claim`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_numbers }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const lines = data.results.map((r: any) => r.success ? `#t${r.taskNumber}: claimed` : `#t${r.taskNumber}: FAILED — ${r.reason}`)
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'unclaim_task',
  'Release claim on a task.',
  {
    channel: z.string(),
    task_number: z.number(),
  },
  async ({ channel, task_number }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/unclaim`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_number }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: `#t${task_number} unclaimed.` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'update_task_status',
  'Update task progress status.',
  {
    channel: z.string(),
    task_number: z.number(),
    status: z.enum(['todo', 'in_progress', 'in_review', 'done']),
  },
  async ({ channel, task_number, status }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/update-status`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_number, status }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: `#t${task_number} → ${status}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

// ── Start MCP server ──────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
