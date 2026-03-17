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
let serverUrl =
  process.env.REDSHRIMP_SERVER_URL?.trim()
  || process.env.SERVER_URL?.trim()
  || `http://127.0.0.1:${process.env.PORT ?? 3001}`
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
  "Send a message to a channel or DM. To reply, reuse the channel value from the received message (e.g. channel='#all' or channel='DM:@richard'). To start a NEW DM, use dm_to with the person's name.",
  {
    channel: z.string().optional().describe("Where to send. Reuse the identifier from received messages: '#channel-name' for channels, 'DM:@peer-name' for DMs."),
    dm_to: z.string().optional().describe("Person's name to start a NEW DM with (e.g. 'richard'). Only for starting a new DM — to reply in an existing DM, use channel instead."),
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
  'Receive new messages. Use block=true to wait for new messages. Returns messages formatted as [#channel-name] or [DM:@peer-name] followed by the sender and content.',
  {
    block: z.boolean().default(true).describe('Whether to block (wait) for new messages'),
    timeout_ms: z.number().default(45000).describe('How long to wait in ms when blocking'),
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
  'List all channels in this server, including which ones you have joined, plus all agents and humans.',
  {},
  async () => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/server`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      let text = '## Server\n\n### Channels\n'
      text += "Use `#channel-name` with send_message to post in a channel. `joined` means you currently belong to that channel.\n"
      if (data.channels?.length > 0) {
        for (const t of data.channels) {
          const status = t.joined ? 'joined' : 'not joined'
          text += t.description ? `  - #${t.name} [${status}] — ${t.description}\n` : `  - #${t.name} [${status}]\n`
        }
      } else { text += '  (none)\n' }
      text += '\n### Agents\nOther AI agents in this server.\n'
      if (data.agents?.length > 0) { for (const a of data.agents) text += `  - @${a.name} (${a.status})\n` }
      else { text += '  (none)\n' }
      text += '\n### Humans\n'
      text += 'To start a new DM: send_message(dm_to="<name>"). To reply in an existing DM: reuse channel from the received message.\n'
      if (data.humans?.length > 0) { for (const u of data.humans) text += `  - @${u.name}\n` }
      else { text += '  (none)\n' }
      return { content: [{ type: 'text' as const, text }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'read_history',
  "Read message history for a channel or DM. Use #channel-name for channels or DM:@name for DMs.",
  {
    channel: z.string().describe("The channel to read history from — e.g. '#all', '#general', 'DM:@richard'"),
    limit: z.number().default(50).describe('Max number of messages to return (default 50, max 100)'),
    before: z.number().optional().describe('Return messages before this seq number (for backward pagination).'),
    after: z.number().optional().describe('Return messages after this seq number (for catching up on unread).'),
  },
  async ({ channel, limit, before, after }) => {
    try {
      const params = new URLSearchParams()
      params.set('channel', channel)
      params.set('limit', String(Math.min(limit, 100)))
      if (before) params.set('before', String(before))
      if (after) params.set('after', String(after))
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/history?${params}`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.messages || data.messages.length === 0) return { content: [{ type: 'text' as const, text: 'No messages in this channel.' }] }
      const formatted = data.messages.map((m: any) => {
        const prefix = m.senderType === 'agent' ? '(agent) ' : ''
        const time = m.createdAt ? ` (${toLocalTime(m.createdAt)})` : ''
        return `[seq:${m.seq}]${time} ${prefix}@${m.senderName}: ${m.content}`
      }).join('\n')
      let footer = ''
      if (data.historyLimited) {
        footer = `\n\n--- ${data.historyLimitMessage || 'Message history is limited on this plan.'} ---`
      } else if (data.has_more && data.messages.length > 0) {
        if (after) {
          const maxSeq = data.messages[data.messages.length - 1].seq
          footer = `\n\n--- ${data.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`
        } else {
          const minSeq = data.messages[0].seq
          footer = `\n\n--- ${data.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`
        }
      }
      let header = `## Message History for ${channel} (${data.messages.length} messages)`
      if (data.last_read_seq > 0 && !after && !before) {
        header += `\nYour last read position: seq ${data.last_read_seq}. Use read_history(channel="${channel}", after=${data.last_read_seq}) to see only unread messages.`
      }
      return { content: [{ type: 'text' as const, text: `${header}\n\n${formatted}${footer}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'get_human_messages',
  'Get all messages sent by human users on a given date (UTC+8), across all channels in this server. Useful for Akara daily report.',
  { date: z.string().optional().describe('Date in YYYY-MM-DD format (UTC+8). Defaults to today if omitted.') },
  async ({ date }) => {
    try {
      const params = new URLSearchParams()
      if (date) params.set('date', date)
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/human-messages?${params}`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.messages || data.messages.length === 0) return { content: [{ type: 'text' as const, text: `No human messages found for ${data.date}.` }] }
      const formatted = data.messages.map((m: any) => {
        const ch = m.channelType === 'dm' ? `DM:@${m.channelName}` : `#${m.channelName}`
        const time = m.createdAt ? ` (${toLocalTime(m.createdAt)})` : ''
        return `[${ch}]${time} @${m.senderName}: ${m.content}`
      }).join('\n')
      return { content: [{ type: 'text' as const, text: `## Human messages on ${data.date} (${data.messages.length} total)\n\n${formatted}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'create_todo_bundle',
  'Create a todo root in memory/todos/<todo>/index.md, create the parent task plus subtasks, and link the root markdown to that todo.',
  {
    channel: z.string().describe("Target channel, e.g. '#all'"),
    title: z.string().describe('Parent todo title'),
    summary: z.string().optional().describe('Summary of the todo'),
    owner_agent_id: z.string().optional().describe('Primary owner agent id or name/mention. Defaults to the calling agent if omitted.'),
    clean_level: z.string().optional().describe('Current user-agreed memory cleanliness standard'),
    subtasks: z.array(z.object({
      title: z.string().describe('Subtask title'),
      assignee_agent_id: z.string().optional().describe('Assignee agent id or name/mention'),
    })).default([]).describe('Subtasks to create under the todo'),
  },
  async ({ channel, title, summary, owner_agent_id, clean_level, subtasks }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/todo-intake`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, title, summary, owner_agent_id, clean_level, subtasks }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const subtasksLine = data.bundle.subtaskNumbers.length > 0
        ? data.bundle.subtaskNumbers.map((n: number) => `#t${n}`).join(', ')
        : 'none'
      return { content: [{ type: 'text' as const, text: `Todo bundle created in ${channel}\n\nParent: #t${data.bundle.parentTaskNumber}\nSubtasks: ${subtasksLine}\nRoot memory: ${data.bundle.docPath}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'append_todo_note',
  'Append a derived markdown note to the current todo. Use this for plans, summaries, reading notes, or review notes.',
  {
    task_id: z.string().optional().describe('The parent todo task id. Optional if the agent currently has exactly one active task.'),
    title: z.string().describe('Markdown note title'),
    content: z.string().describe('Markdown note content'),
  },
  async ({ task_id, title, content }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/memory-note`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ task_id, title, content }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: `Todo note linked to #t${data.task.number}: ${data.note.docPath}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'list_tasks',
  "List tasks on a channel's task board. Returns tasks with their number (#t1, #t2...), title, status, and assignee.",
  {
    channel: z.string().describe("The channel whose task board to view — e.g. '#engineering', '#proj-slock'"),
    status: z.enum(['all', 'todo', 'in_progress', 'in_review', 'done']).default('all').describe('Filter by status (default: all)'),
    mine: z.boolean().optional().describe('If true, only return tasks assigned to you.'),
  },
  async ({ channel, status, mine }) => {
    try {
      const params = new URLSearchParams()
      params.set('channel', channel)
      if (status !== 'all') params.set('status', status)
      if (mine) params.set('mine', 'true')
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks?${params}`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.tasks || data.tasks.length === 0) return { content: [{ type: 'text' as const, text: `No${status !== 'all' ? ` ${status}` : ''} tasks in ${channel}.` }] }
      const formatted = data.tasks.map((t: any) => {
        const assignee = t.claimedByName ? ` → @${t.claimedByName}` : ''
        const creator = t.createdByName ? ` (by @${t.createdByName})` : ''
        const locked = t.status === 'pending_discussion' ? ' 🔒' : ''
        return `#t${t.taskNumber} [${t.status}${locked}] "${t.title}"${assignee}${creator}`
      }).join('\n')
      return { content: [{ type: 'text' as const, text: `## Task Board for ${channel} (${data.tasks.length} tasks)\n\n${formatted}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'list_all_tasks',
  'List ALL tasks across the entire server (all channels). Use this for weekly reports, ops overview, or when you need a full picture of task status.',
  {
    status: z.enum(['all', 'todo', 'in_progress', 'in_review', 'done']).default('all').describe('Filter by status (default: all)'),
  },
  async ({ status }) => {
    try {
      const params = new URLSearchParams()
      if (status !== 'all') params.set('status', status)
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/server?${params}`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.tasks || data.tasks.length === 0) return { content: [{ type: 'text' as const, text: 'No tasks found.' }] }
      const byChannel: Record<string, any[]> = {}
      for (const t of data.tasks) {
        if (!byChannel[t.channelName]) byChannel[t.channelName] = []
        byChannel[t.channelName].push(t)
      }
      const lines: string[] = []
      for (const [ch, tasks] of Object.entries(byChannel)) {
        lines.push(`### #${ch}`)
        for (const t of tasks) {
          const assignee = t.claimedByName ? ` → @${t.claimedByName}` : ''
          const locked = t.status === 'pending_discussion' ? ' 🔒' : ''
          lines.push(`  #t${t.taskNumber} [${t.status}${locked}] "${t.title}"${assignee}`)
        }
      }
      return { content: [{ type: 'text' as const, text: `## All Tasks (${data.tasks.length} total)\n\n${lines.join('\n')}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'mark_task_discussed',
  'Unlock a task that is waiting for discussion (pending_discussion → todo). Only coordinator (Donovan) can call this. Call after the team has discussed the task and you are ready to dispatch it for execution.',
  {
    channel: z.string().describe("The channel containing the task — e.g. '#all'"),
    task_number: z.number().describe('The task number to unlock (e.g. 5)'),
  },
  async ({ channel, task_number }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/mark-discussed`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_number }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: data.message ?? `#t${task_number} discussion complete — task is now unlocked and assignee can begin work.` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'read_agent_memory',
  "Read another agent's MEMORY.md. Only available to the coordinator (Donovan). Use this to understand what a specific agent is currently working on before dispatching tasks.",
  { agent_name: z.string().describe("The name of the agent whose MEMORY.md to read (e.g. 'Brandeis', 'Akara')") },
  async ({ agent_name }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/agent-memory/${encodeURIComponent(agent_name)}`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      return { content: [{ type: 'text' as const, text: `## @${data.agentName} MEMORY.md\n\n${data.content}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'get_team_status',
  'Get the current status of all agents in this server: role, running/sleeping/offline, open task count, and current project. Use this before dispatching tasks to understand who is available.',
  {},
  async () => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/team-status`, { method: 'GET', headers: commonHeaders })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (!data.team || data.team.length === 0) return { content: [{ type: 'text' as const, text: 'No agents found.' }] }
      const lines = ['## Team Status', '']
      for (const a of data.team) {
        const statusLabel = a.status === 'running' ? 'running' : a.status === 'idle' ? 'sleeping' : a.status
        const tasks = a.assignedTaskCount > 0 ? ` — ${a.assignedTaskCount} open task${a.assignedTaskCount !== 1 ? 's' : ''}` : ' — 0 open tasks'
        const project = a.currentProject ? `, project: ${a.currentProject}` : ''
        lines.push(`@${a.name.padEnd(12)} [${(a.role ?? 'general').padEnd(12)}] ${statusLabel}${tasks}${project}`)
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'create_tasks',
  'Create one or more tasks on a channel\'s task board. Tasks are assigned immediately when created. New tasks start in pending_discussion state and must be unlocked by coordinator via mark_task_discussed before assignee can begin.',
  {
    channel: z.string().describe("The channel to create tasks in — e.g. '#engineering'"),
    tasks: z.array(z.object({
      title: z.string().describe('Task title'),
      assignee_agent_id: z.string().optional().describe('Explicit assignee agent id, plain name, or @mention. Defaults to the calling agent if omitted.'),
    })).describe('Array of tasks to create'),
  },
  async ({ channel, tasks }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, tasks }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const created = data.tasks
        .map((t: any) => `#t${t.taskNumber} "${t.title}"${t.assigneeName ? ` → @${t.assigneeName}` : ''} [pending_discussion 🔒]`)
        .join('\n')
      return { content: [{ type: 'text' as const, text: `Created ${data.tasks.length} task(s) in ${channel}:\n${created}\n\nCall mark_task_discussed when team discussion is complete.` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'create_task_room',
  'Create or reopen a task-specific group channel and invite the relevant members.',
  {
    channel: z.string().describe("The parent task-board channel that owns the task — e.g. '#all'"),
    task_number: z.number().describe('The task number to create a room for (e.g. 138)'),
    participant_agent_ids: z.array(z.string()).optional().describe('Optional extra agent ids, plain names, or @mentions to invite into the room.'),
  },
  async ({ channel, task_number, participant_agent_ids }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/task-room`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_number, participant_agent_ids }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const invitedAgents = data.invitedAgents?.length ? `Agents: ${data.invitedAgents.map((name: string) => `@${name}`).join(', ')}` : 'Agents: none'
      const invitedHumans = `Humans inherited from ${channel}: ${data.invitedHumans ?? 0}`
      return { content: [{ type: 'text' as const, text: `${data.created ? 'Created' : 'Reopened'} task room #${data.channel.name} for #t${task_number}.\n${invitedAgents}\n${invitedHumans}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'claim_tasks',
  'Disabled in explicit-assignment mode. Tasks must be assigned by coordinator.',
  {
    channel: z.string(),
    task_numbers: z.array(z.number()),
  },
  async () => {
    return { content: [{ type: 'text' as const, text: 'Error: Tasks must be explicitly assigned by coordinator. claim_tasks is disabled.' }] }
  },
)

server.tool(
  'unclaim_task',
  'Disabled in explicit-assignment mode.',
  { channel: z.string(), task_number: z.number() },
  async () => {
    return { content: [{ type: 'text' as const, text: 'Error: Tasks must be explicitly assigned by coordinator. unclaim_task is disabled.' }] }
  },
)

server.tool(
  'update_task_status',
  'Update task progress status for a task already assigned to you. Valid transitions: todo→in_progress, in_progress→in_review, in_progress→done, in_review→in_progress, in_review→done. Note: pending_discussion tasks are locked until coordinator calls mark_task_discussed.',
  {
    channel: z.string().describe("The channel — e.g. '#engineering'"),
    task_number: z.number().describe('The task number to update (e.g. 3)'),
    status: z.enum(['todo', 'in_progress', 'in_review', 'done']).describe('The new status'),
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

server.tool(
  'link_task_doc',
  'Link a vault document to an existing task. The doc_path should be relative to vault root (e.g. "05_notes/bugfix/bugfix-2026-03-14-fix.md"). Status can be "writing" (agent is still working on it) or "unread" (ready for review).',
  {
    channel: z.string(),
    task_number: z.number(),
    doc_path: z.string(),
    doc_name: z.string().optional(),
    status: z.enum(['writing', 'unread']).optional(),
  },
  async ({ channel, task_number, doc_path, doc_name, status }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/link-doc`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ channel, task_number, doc_path, doc_name, status }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      if (data.already_linked) return { content: [{ type: 'text' as const, text: `Doc already linked to #t${task_number}` }] }
      return { content: [{ type: 'text' as const, text: `Linked "${doc_path}" to #t${task_number}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'create_sticky_note',
  'Create a sticky note on the homepage bulletin board. Also writes a flash note to vault 05_notes/flash/.',
  {
    title: z.string().describe('Short title for the sticky note'),
    content: z.string().optional().describe('Detailed content of the note'),
    color: z.enum(['#f0b35e', '#6bc5e8', '#7ecfa8', '#c0392b']).optional().describe('Sticky note color'),
  },
  async ({ title, content, color }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/bulletins`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ category: 'sticky', title, content: content ?? null, metadata: { color: color ?? '#f0b35e', size: 'medium' } }),
      })
      const data = await res.json() as any
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] }
      const vaultPath = data.bulletin?.linked_file ? ` → ${data.bulletin.linked_file}` : ''
      return { content: [{ type: 'text' as const, text: `Sticky note created: "${title}"${vaultPath}` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

server.tool(
  'vault_commit',
  'Commit your vault file changes to git. Call this after writing or updating documents in the vault.',
  { message: z.string().optional().describe('Short commit message describing what changed') },
  async ({ message }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/vault-commit`, {
        method: 'POST', headers: commonHeaders,
        body: JSON.stringify({ message: message ?? undefined }),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${(data as any).error ?? res.status}` }] }
      return { content: [{ type: 'text' as const, text: 'Vault commit scheduled.' }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] }
    }
  },
)

// ── Graceful shutdown on pipe break ───────────────────────────────
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
})
process.stdin.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0)
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// ── Start MCP server ──────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
