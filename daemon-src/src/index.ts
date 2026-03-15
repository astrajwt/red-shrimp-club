// redshrimp-daemon — 红虾俱乐部 Machine Daemon
// Connects to the Red Shrimp Lab backend via WebSocket.
// Spawns and manages AI agent CLI processes (Claude Code, Codex, Kimi).

import WebSocket from 'ws'
import { spawn, ChildProcess, execSync } from 'child_process'
import { mkdir, writeFile, access } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.0'
const REPO_ROOT = resolve(__dirname, '../..')
const DEFAULT_MEMORY_TEMPLATE_PATH = resolve(REPO_ROOT, 'config', 'MEMORY.template.md')
const FALLBACK_MEMORY_TEMPLATE = `# {{agentName}}

## Role
{{roleSeed}}

## Key Knowledge
{{keyKnowledge}}

## Active Context
- {{activeContext}}
`

// ── Load .env file (lightweight, no dotenv dependency) ──────────────
function loadEnvFile() {
  const candidates = [
    resolve(__dirname, '../.env'),           // daemon-src/.env
    resolve(__dirname, '../../.env'),         // project root .env
  ]
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (!process.env[key]) process.env[key] = val  // CLI env takes priority
    }
    break  // only load first found
  }
}
loadEnvFile()

// ── CLI args + env fallback ─────────────────────────────────────────
const args = process.argv.slice(2)
let serverUrl = process.env.REDSHRIMP_SERVER_URL ?? process.env.SERVER_URL ?? ''
let apiKey = process.env.REDSHRIMP_API_KEY ?? process.env.API_KEY ?? ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--server-url' && args[i + 1]) serverUrl = args[++i]
  if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i]
  if (args[i] === '--version' || args[i] === '-v') {
    console.log(`redshrimp-daemon v${VERSION}`)
    process.exit(0)
  }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`redshrimp-daemon v${VERSION}`)
    console.log('Usage: redshrimp-daemon [--server-url <url>] [--api-key <key>]')
    console.log('')
    console.log('Config priority: CLI args > env vars > .env file')
    console.log('  Env vars: REDSHRIMP_SERVER_URL, REDSHRIMP_API_KEY')
    process.exit(0)
  }
}

if (!serverUrl || !apiKey) {
  console.error('Error: server-url and api-key are required.')
  console.error('')
  console.error('Set them via any of:')
  console.error('  1. CLI args:  redshrimp-daemon --server-url <url> --api-key <key>')
  console.error('  2. Env vars:  REDSHRIMP_SERVER_URL=... REDSHRIMP_API_KEY=...')
  console.error('  3. .env file: create daemon-src/.env with the vars above')
  process.exit(1)
}

// ── Runtime detection ───────────────────────────────────────────────
function detectRuntimes(): string[] {
  const runtimes: string[] = []
  for (const bin of ['claude', 'codex', 'kimi']) {
    try {
      execSync(`which ${bin}`, { stdio: 'ignore' })
      runtimes.push(bin)
    } catch { /* not found */ }
  }
  return runtimes
}

// ── Agent process management ────────────────────────────────────────
interface AgentProc {
  id: string
  config: AgentConfig
  proc: ChildProcess | null
  sessionId: string | null
  status: 'active' | 'sleeping' | 'inactive'
  pendingNotificationCount: number
  notificationTimer: ReturnType<typeof setTimeout> | null
  lastDeliveredMessage: DeliveredMessage | null
}

interface AgentConfig {
  name: string
  displayName?: string
  description?: string
  model: string
  runtime: string
  reasoningEffort?: string
  serverUrl: string
  authToken?: string
  sessionId?: string
}

interface DeliveredMessage {
  channel_name: string
  channel_type: string
  sender_name: string
  sender_type: string
  content: string
  timestamp: string
}

const agents = new Map<string, AgentProc>()
const chatBridgePath = resolve(__dirname, 'chat-bridge.js')
const workspaceBase = resolve(os.homedir(), '.redshrimp', 'agents')
const NOTIFICATION_BATCH_MS = 3000
const WAKE_NOTIFICATION_DELAY_MS = 1500
const DEFAULT_KIMI_CLI_MODEL = 'kimi-code/kimi-for-coding'
const LEGACY_KIMI_MODEL = 'kimi-k2-5'

interface InitialMemoryTemplateInput {
  agentName: string
  description?: string
  serverUrl?: string
  activeContext?: string
}

function resolveMemoryTemplatePath(): string {
  const customPath = process.env.MEMORY_TEMPLATE_PATH?.trim()
  if (customPath) return resolve(customPath)
  return DEFAULT_MEMORY_TEMPLATE_PATH
}

function loadMemoryTemplate(): string {
  const templatePath = resolveMemoryTemplatePath()
  if (!existsSync(templatePath)) return FALLBACK_MEMORY_TEMPLATE
  try {
    return readFileSync(templatePath, 'utf-8')
  } catch {
    return FALLBACK_MEMORY_TEMPLATE
  }
}

function renderMemoryTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '')
}

function buildMcpConfig(agentId: string, config: AgentConfig): string {
  return JSON.stringify({
    mcpServers: {
      chat: {
        command: 'node',
        args: [
          chatBridgePath,
          '--agent-id', agentId,
          '--server-url', config.serverUrl || serverUrl,
          '--auth-token', config.authToken || apiKey,
        ],
      },
    },
  })
}

function buildChatBridgeArgs(agentId: string, config: AgentConfig): string[] {
  return [
    'node',
    chatBridgePath,
    '--agent-id', agentId,
    '--server-url', config.serverUrl || serverUrl,
    '--auth-token', config.authToken || apiKey,
  ]
}

function buildInitialMemoryIndex(input: InitialMemoryTemplateInput): string {
  return renderMemoryTemplate(loadMemoryTemplate(), {
    agentName: input.agentName,
    roleSeed: input.description?.trim() || 'No role defined yet.',
    keyKnowledge: [
      input.serverUrl?.trim() ? `- Backend: \`${input.serverUrl.trim()}\`.` : '',
      '- Read `KNOWLEDGE.md` and `notes/` for workspace context when available.',
      '- Update this file when role, preferences, or active context change.',
    ].filter(Boolean).join('\n'),
    activeContext: input.activeContext?.trim() || 'First startup.',
    serverUrl: input.serverUrl?.trim() || '',
    channelName: '',
    teamContext: '',
  })
}

function buildBootstrapPrompt(name: string): string {
  return `You are "${name}", an AI agent in Red Shrimp.

Read \`MEMORY.md\` in your cwd first. It is your editable memory index and the main source of truth for your role, preferences, and active context.

Communication rules:
- Use MCP chat tools only for communication.
- Do NOT use shell commands to send or receive messages.
- Do NOT output plain text outside tool calls.
- Do NOT announce yourself or send unprompted status updates.
- Write important long-term state back to \`MEMORY.md\`.

Available MCP chat tools:
- \`mcp__chat__receive_message\`
- \`mcp__chat__send_message\`
- \`mcp__chat__list_server\`
- \`mcp__chat__read_history\`
- \`mcp__chat__list_tasks\`
- \`mcp__chat__create_tasks\`
- \`mcp__chat__claim_tasks\`
- \`mcp__chat__unclaim_task\`
- \`mcp__chat__update_task_status\`

Task rules:
- Tasks are explicitly assigned. Do not rely on claim/unclaim as a normal workflow.
- Only update the status of tasks already assigned to you.
- When creating a task, assign it directly to the right agent up front instead of leaving it open.
- \`create_tasks\` accepts the assignee as an agent id, plain name, or @mention; if omitted, the task is assigned to you.

Working loop:
1. Read \`MEMORY.md\`.
2. Call \`mcp__chat__receive_message(block=true)\` to listen for work.
3. Reply or take action as needed using chat/task tools.
4. After each step, call \`mcp__chat__receive_message(block=true)\` again.

Your process may exit between turns. Make \`receive_message(block=true)\` your last action when you finish the current step.`
}

function buildResumePrompt(unreadCount: number): string {
  if (unreadCount > 0) {
    return `You may have unread messages from while you were away. Call \`mcp__chat__receive_message(block=true)\` to read them, respond as appropriate, and then keep listening.`
  }
  return `No new work is guaranteed. Read \`MEMORY.md\` if needed, then call \`mcp__chat__receive_message(block=true)\` to keep listening.`
}

function buildLaunchPrompt(config: AgentConfig, unreadCount: number): string {
  if (config.sessionId) return buildResumePrompt(unreadCount)
  return buildBootstrapPrompt(config.displayName || config.name)
}

function usesStreamingJsonInput(runtime: string): boolean {
  return runtime === 'claude'
}

function supportsStdinNotification(runtime: string): boolean {
  return runtime === 'claude'
}

function buildStdinMessage(runtime: string, text: string): string {
  if (runtime === 'kimi') {
    return JSON.stringify({ role: 'user', content: text })
  }

  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function normalizeKimiCliModel(model?: string): string | undefined {
  if (!model?.trim()) return undefined
  if (model === LEGACY_KIMI_MODEL) return DEFAULT_KIMI_CLI_MODEL
  return model
}

function writeAgentInput(ap: AgentProc, text: string): boolean {
  if (!ap.proc?.stdin?.writable) return false

  try {
    ap.proc.stdin.write(`${buildStdinMessage(ap.config.runtime || 'claude', text)}\n`)
    return true
  } catch {
    return false
  }
}

function buildCommand(agentId: string, config: AgentConfig, prompt: string): string[] {
  const mcpConfig = buildMcpConfig(agentId, config)
  const runtime = config.runtime || 'claude'

  switch (runtime) {
    case 'claude': {
      const args: string[] = [
        'claude',
        '--allow-dangerously-skip-permissions',
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--mcp-config', mcpConfig,
        '--model', config.model || 'sonnet',
      ]
      if (config.sessionId) {
        args.push('--resume', config.sessionId)
      }
      return args
    }
    case 'codex': {
      // Codex uses -c flags for inline MCP config (matches slock driver)
      const bridgeArgs = buildChatBridgeArgs(agentId, config)
      const bridgeCommand = bridgeArgs[0]  // 'node'
      const bridgeRest = bridgeArgs.slice(1)
      const codexArgs = [
        'codex', 'exec',
        ...(config.sessionId ? ['resume', config.sessionId] : []),
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        '-c', `mcp_servers.chat.command=${JSON.stringify(bridgeCommand)}`,
        '-c', `mcp_servers.chat.args=${JSON.stringify(bridgeRest)}`,
        '-c', 'mcp_servers.chat.startup_timeout_sec=30',
        '-c', 'mcp_servers.chat.tool_timeout_sec=120',
        '-c', 'mcp_servers.chat.enabled=true',
        '-c', 'mcp_servers.chat.required=true',
      ]
      if (config.model) {
        codexArgs.push('-m', config.model)
      } else {
        codexArgs.push('-m', 'gpt-5.4')
      }
      if (config.reasoningEffort) {
        codexArgs.push('-c', `model_reasoning_effort=${config.reasoningEffort}`)
      } else {
        codexArgs.push('-c', 'model_reasoning_effort="medium"')
      }
      codexArgs.push(prompt)
      return codexArgs
    }
    case 'kimi': {
      const kimiModel = normalizeKimiCliModel(config.model)
      const kimiArgs = [
        'kimi',
        '--print',
        '--output-format', 'stream-json',
        '--mcp-config', mcpConfig,
      ]
      if (kimiModel) {
        kimiArgs.push('--model', kimiModel)
      }
      if (config.sessionId) {
        kimiArgs.push('--session', config.sessionId)
      }
      kimiArgs.push('-p', prompt)
      return kimiArgs
    }
    default:
      throw new Error(`Unknown runtime: ${runtime}`)
  }
}

async function startAgent(agentId: string, config: AgentConfig) {
  // Skip if agent already has an active process
  const existing = agents.get(agentId)
  if (existing?.proc && existing.status === 'active') {
    log(`Agent ${config.name} already active (pid ${existing.proc.pid}), skipping duplicate start`)
    return
  }
  // Stop zombie process if exists (proc exists but not active)
  if (existing?.proc) {
    log(`Agent ${config.name} has stale process, stopping first`)
    existing.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 1000))
  }

  const workDir = resolve(workspaceBase, agentId)
  await mkdir(workDir, { recursive: true })

  // Create MEMORY.md if not exists
  try {
    await access(resolve(workDir, 'MEMORY.md'))
  } catch {
    await writeFile(resolve(workDir, 'MEMORY.md'), buildInitialMemoryIndex({
      agentName: config.displayName || config.name,
      description: config.description,
      serverUrl: config.serverUrl || serverUrl,
      activeContext: 'First startup.',
    }))
  }

  // Codex requires a git repo (like slock driver)
  const runtime = config.runtime || 'claude'
  if (runtime === 'codex') {
    const gitDir = resolve(workDir, '.git')
    if (!existsSync(gitDir)) {
      try {
        execSync('git init', { cwd: workDir, stdio: 'pipe' })
        execSync('git add -A && git commit --allow-empty -m "init"', {
          cwd: workDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'redshrimp',
            GIT_AUTHOR_EMAIL: 'redshrimp@local',
            GIT_COMMITTER_NAME: 'redshrimp',
            GIT_COMMITTER_EMAIL: 'redshrimp@local',
          },
        })
      } catch {
        // Best effort
      }
    }
  }

  const launchPrompt = buildLaunchPrompt(config, existing?.pendingNotificationCount ?? 0)
  const cmd = buildCommand(agentId, config, launchPrompt)
  log(`Starting ${config.name} (${config.runtime}): ${cmd[0]}`)

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  // Clean Claude Code env vars to prevent conflicts
  delete env['CLAUDECODE']
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key]
  }
  // Remove empty API keys — they override CLI's own auth and cause "Invalid API key"
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
                    'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'MOONSHOT_API_KEY']) {
    if (!env[k] || !env[k].trim()) delete env[k]
  }
  env['FORCE_COLOR'] = '0'
  if (runtime === 'codex') env['NO_COLOR'] = '1'

  const proc = spawn(cmd[0], cmd.slice(1), {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workDir,
  })

  const ap: AgentProc = {
    id: agentId,
    config,
    proc,
    sessionId: config.sessionId || null,
    status: 'active',
    pendingNotificationCount: existing?.pendingNotificationCount ?? 0,
    notificationTimer: null,
    lastDeliveredMessage: existing?.lastDeliveredMessage ?? null,
  }
  agents.set(agentId, ap)

  sendToServer({ type: 'agent:status', agentId, status: 'active' })

  if (usesStreamingJsonInput(runtime)) {
    setTimeout(() => {
      writeAgentInput(ap, launchPrompt)
    }, 150)
  }

  if (ap.pendingNotificationCount > 0) {
    scheduleNotification(agentId, WAKE_NOTIFICATION_DELAY_MS)
  }

  // Parse stdout for trajectory events
  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    const entries: Array<Record<string, unknown>> = []
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          ap.sessionId = event.session_id
          sendToServer({ type: 'agent:session', agentId, sessionId: event.session_id })
        }
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'thinking') {
              entries.push({ kind: 'thinking', text: (block.thinking || '').slice(0, 4000) })
            } else if (block.type === 'text') {
              entries.push({ kind: 'text', text: (block.text || '').slice(0, 2000) })
            } else if (block.type === 'tool_use') {
              entries.push({ kind: 'tool_start', toolName: block.name, toolInput: JSON.stringify(block.input || {}).slice(0, 500) })
            }
          }
        }
        if (event.type === 'result' && event.session_id) {
          ap.sessionId = event.session_id
          sendToServer({ type: 'agent:session', agentId, sessionId: event.session_id })
          entries.push({ kind: 'turn_end', sessionId: event.session_id })
        }
        if (event.role === 'assistant') {
          const text = typeof event.content === 'string'
            ? event.content
            : Array.isArray(event.content)
              ? event.content
                  .map((block: any) => typeof block === 'string' ? block : (block?.text || block?.content || ''))
                  .filter(Boolean)
                  .join('\n')
              : ''
          if (text) entries.push({ kind: 'text', text: text.slice(0, 2000) })
        }
        if (event.session_id && typeof event.session_id === 'string') {
          ap.sessionId = event.session_id
          sendToServer({ type: 'agent:session', agentId, sessionId: event.session_id })
        }
      } catch {
        // Not JSON, treat as plain log
        entries.push({ kind: 'text', text: line.slice(0, 2000) })
      }
    }
    if (entries.length > 0) {
      sendToServer({ type: 'agent:trajectory', agentId, entries })
    }
  })

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim()
    if (text) {
      sendToServer({ type: 'agent:trajectory', agentId, entries: [{ kind: 'text', text: `[stderr] ${text.slice(0, 2000)}` }] })
    }
  })

  proc.on('error', (err) => {
    log(`Agent ${config.name} spawn error: ${err.message}`)
    ap.status = 'inactive'
    ap.proc = null
    sendToServer({ type: 'agent:status', agentId, status: 'inactive' })
  })

  proc.on('exit', (code) => {
    ap.proc = null
    clearNotificationTimer(ap)
    if (code === 0 || code === null) {
      // Clean exit — keep the session and wait for a future message to wake
      // the agent back up, like slock's sleeping/resume lifecycle.
      log(`Agent ${config.name} exited cleanly, entering sleeping state`)
      ap.status = 'sleeping'
      sendToServer({ type: 'agent:status', agentId, status: 'sleeping' })
    } else if (code === 143 || code === 137) {
      // Killed by SIGTERM/SIGKILL — intentional stop, don't restart
      log(`Agent ${config.name} stopped (signal)`)
      ap.status = 'inactive'
      sendToServer({ type: 'agent:status', agentId, status: 'inactive' })
    } else {
      // Unexpected crash — restart with backoff
      log(`Agent ${config.name} crashed (code ${code}), restarting in 5s...`)
      ap.status = 'inactive'
      sendToServer({ type: 'agent:status', agentId, status: 'inactive' })
      setTimeout(() => {
        if (!ap.proc) {
          startAgent(agentId, ap.config)
            .catch(err => log(`Agent ${ap.config.name} restart failed: ${err.message}`))
        }
      }, 5_000)
    }
  })
}

async function stopAgent(agentId: string) {
  const ap = agents.get(agentId)
  if (!ap?.proc) return
  log(`Stopping agent ${ap.config.name}`)
  clearNotificationTimer(ap)
  ap.proc.kill('SIGTERM')
  setTimeout(() => ap.proc?.kill('SIGKILL'), 5000)
}

async function sleepAgent(agentId: string) {
  const ap = agents.get(agentId)
  if (!ap?.proc) return
  log(`Sleeping agent ${ap.config.name}`)
  ap.proc.kill('SIGTERM')
  ap.status = 'sleeping'
  sendToServer({ type: 'agent:status', agentId, status: 'sleeping' })
}

function deliverMessage(agentId: string, message: unknown) {
  const ap = agents.get(agentId)
  if (!ap) return

  ap.pendingNotificationCount++
  ap.lastDeliveredMessage = message as DeliveredMessage

  if (!ap.proc || !ap.proc.stdin?.writable) {
    if (ap.status === 'sleeping') {
      log(`Waking sleeping agent ${ap.config.name}`)
      startAgent(agentId, ap.sessionId ? { ...ap.config, sessionId: ap.sessionId } : ap.config)
        .catch(err => log(`Agent ${ap.config.name} wake failed: ${err.message}`))
    }
    return
  }

  if (!supportsStdinNotification(ap.config.runtime || 'claude')) return

  scheduleNotification(agentId)
}

function clearNotificationTimer(ap: AgentProc) {
  if (ap.notificationTimer) {
    clearTimeout(ap.notificationTimer)
    ap.notificationTimer = null
  }
}

function formatMessagePreview(message: DeliveredMessage | null): string {
  if (!message) return ''
  const channel = message.channel_type === 'dm' ? `DM:@${message.sender_name}` : `#${message.channel_name}`
  const content = (message.content || '').replace(/\s+/g, ' ').trim()
  const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content
  return `Latest: [${channel}] @${message.sender_name}: ${preview}`
}

function flushNotification(agentId: string) {
  const ap = agents.get(agentId)
  if (!ap || ap.pendingNotificationCount <= 0) return
  if (!ap.proc || !ap.proc.stdin?.writable) return

  const count = ap.pendingNotificationCount
  const preview = formatMessagePreview(ap.lastDeliveredMessage)
  const detail = preview ? ` ${preview}` : ''
  const notification =
    `\n[System notification: You have ${count} new message(s) waiting. ` +
    `Call receive_message to read them when you're ready.${detail}]\n`

  ap.pendingNotificationCount = 0
  ap.lastDeliveredMessage = null
  clearNotificationTimer(ap)

  try {
    writeAgentInput(ap, notification)
  } catch {
    // stdin may be closed; unread messages remain in backend storage.
  }
}

function scheduleNotification(agentId: string, delayMs = NOTIFICATION_BATCH_MS) {
  const ap = agents.get(agentId)
  if (!ap || ap.notificationTimer) return

  ap.notificationTimer = setTimeout(() => {
    flushNotification(agentId)
  }, delayMs)
}

// ── WebSocket connection ────────────────────────────────────────────
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
let shouldConnect = true

function sendToServer(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function connect() {
  if (!shouldConnect) return
  const wsUrl = serverUrl.replace(/^http/, 'ws') + `/daemon/connect?key=${apiKey}`
  log(`Connecting to ${serverUrl}...`)

  ws = new WebSocket(wsUrl)

  ws.on('open', () => {
    log('Connected to server')
    reconnectDelay = 1000

    // Send ready handshake
    const runtimes = detectRuntimes()
    log(`Detected runtimes: ${runtimes.join(', ') || 'none'}`)

    const runningAgentIds = [...agents.entries()]
      .filter(([, ap]) => ap.status === 'active')
      .map(([id]) => id)

    sendToServer({
      type: 'ready',
      capabilities: ['agent:start', 'agent:stop', 'agent:deliver', 'workspace:files'],
      runtimes,
      runningAgents: runningAgentIds,
      hostname: os.hostname(),
      os: `${os.platform()} ${os.arch()}`,
      daemonVersion: VERSION,
    })
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      handleMessage(msg)
    } catch (err: any) {
      log(`Invalid message from server: ${err.message}`)
    }
  })

  ws.on('close', () => {
    log('Disconnected from server')
    log('Lost connection — agents continue running locally')
    scheduleReconnect()
  })

  ws.on('error', (err: Error) => {
    log(`WebSocket error: ${err.message}`)
  })
}

function scheduleReconnect() {
  if (!shouldConnect || reconnectTimer) return
  log(`Reconnecting in ${reconnectDelay}ms...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function handleMessage(msg: any) {
  switch (msg.type) {
    case 'agent:start':
      log(`Starting agent ${msg.agentId} (model: ${msg.config?.model}, runtime: ${msg.config?.runtime || 'claude'})`)
      startAgent(msg.agentId, msg.config).catch(err => {
        log(`Failed to start agent: ${err.message}`)
        sendToServer({ type: 'agent:status', agentId: msg.agentId, status: 'inactive' })
      })
      break

    case 'agent:stop':
      log(`Stopping agent ${msg.agentId}`)
      stopAgent(msg.agentId)
      break

    case 'agent:sleep':
      sleepAgent(msg.agentId)
      break

    case 'agent:deliver':
      deliverMessage(msg.agentId, msg.message)
      sendToServer({ type: 'agent:deliver:ack', agentId: msg.agentId, seq: msg.seq })
      break

    case 'ping':
      sendToServer({ type: 'pong' })
      break

    default:
      log(`Unknown message type: ${msg.type}`)
  }
}

// ── Logging ─────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`[Daemon] ${msg}`)
}

// ── Graceful shutdown ───────────────────────────────────────────────
function shutdown() {
  log('Shutting down...')
  shouldConnect = false
  if (reconnectTimer) clearTimeout(reconnectTimer)

  // Stop all agents gracefully
  for (const [id, ap] of agents) {
    if (ap.proc) {
      log(`Stopping agent ${ap.config.name}`)
      ap.proc.kill('SIGTERM')
    }
  }

  if (ws) ws.close()
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Start ───────────────────────────────────────────────────────────
console.log(`[Red Shrimp Daemon] v${VERSION} starting...`)
connect()
