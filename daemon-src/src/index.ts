// redshrimp-daemon — 红虾俱乐部 Machine Daemon
// Connects to the Red Shrimp Lab backend via WebSocket.
// Spawns and manages AI agent CLI processes (Claude Code, Codex, Kimi).

import WebSocket from 'ws'
import { spawn, ChildProcess, execSync } from 'child_process'
import { mkdir, writeFile, access } from 'fs/promises'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.0'

// ── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
let serverUrl = ''
let apiKey = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--server-url' && args[i + 1]) serverUrl = args[++i]
  if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i]
  if (args[i] === '--version' || args[i] === '-v') {
    console.log(`redshrimp-daemon v${VERSION}`)
    process.exit(0)
  }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`redshrimp-daemon v${VERSION}`)
    console.log('Usage: redshrimp-daemon --server-url <url> --api-key <key>')
    process.exit(0)
  }
}

if (!serverUrl || !apiKey) {
  console.error('Usage: redshrimp-daemon --server-url <url> --api-key <key>')
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
}

interface AgentConfig {
  name: string
  displayName?: string
  description?: string
  model: string
  runtime: string
  serverUrl: string
  authToken?: string
  sessionId?: string
}

const agents = new Map<string, AgentProc>()
const chatBridgePath = resolve(__dirname, 'chat-bridge.js')
const workspaceBase = resolve(os.homedir(), '.redshrimp', 'agents')

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

function buildAgentPrompt(name: string): string {
  return `You are ${name}. Read CLAUDE.md and MEMORY.md for your role and context.\nYour job: stay online silently and respond only when someone talks to you.\nLoop (repeat forever):\n1. Call mcp__chat__receive_message with block=true\n2. For each message received: if it's directed at you, @mentions you, or is a DM — reply using the reply_to field from the message (e.g. reply_to.dm_to or reply_to.channel)\n3. Go back to step 1\nIMPORTANT: Do NOT send any unprompted messages. Do NOT announce you are online. Do NOT send status updates. Only speak when a message requires your response.\nExit only when your context window is nearly full — write important notes to MEMORY.md first, then exit cleanly.`
}

function buildCommand(agentId: string, config: AgentConfig): string[] {
  const mcpConfig = buildMcpConfig(agentId, config)
  const prompt = buildAgentPrompt(config.displayName || config.name)
  const runtime = config.runtime || 'claude'

  switch (runtime) {
    case 'claude': {
      const args: string[] = [
        'claude',
        '--dangerously-skip-permissions',
        '--model', config.model || 'claude-sonnet-4-6',
        '--mcp-config', mcpConfig,
      ]
      if (config.sessionId) {
        args.push('--resume', config.sessionId)
      } else {
        args.push('-p', prompt)
      }
      return args
    }
    case 'codex':
      return [
        'codex', 'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m', config.model || 'o4-mini',
        prompt,
      ]
    case 'kimi':
      return [
        'kimi',
        '--skip-permissions',
        '--model', config.model || 'kimi-k2-5',
        '--mcp-config', mcpConfig,
        '-p', prompt,
      ]
    default:
      throw new Error(`Unknown runtime: ${runtime}`)
  }
}

async function startAgent(agentId: string, config: AgentConfig) {
  // Stop existing if any
  const existing = agents.get(agentId)
  if (existing?.proc) {
    log(`Agent ${config.name} already running, stopping first`)
    existing.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 1000))
  }

  const workDir = resolve(workspaceBase, agentId)
  await mkdir(workDir, { recursive: true })

  // Create MEMORY.md if not exists
  try {
    await access(resolve(workDir, 'MEMORY.md'))
  } catch {
    await writeFile(resolve(workDir, 'MEMORY.md'), `# ${config.displayName || config.name}\n\n## Role\n${config.description || 'AI Agent'}\n\n## Active Context\n- Just started\n`)
  }

  const cmd = buildCommand(agentId, config)
  log(`Starting ${config.name} (${config.runtime}): ${cmd[0]}`)

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  // Clean Claude Code env vars to prevent conflicts
  delete env['CLAUDECODE']
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key]
  }
  env['FORCE_COLOR'] = '0'

  const proc = spawn(cmd[0], cmd.slice(1), {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workDir,
  })

  const ap: AgentProc = { id: agentId, config, proc, sessionId: config.sessionId || null, status: 'active' }
  agents.set(agentId, ap)

  sendToServer({ type: 'agent:status', agentId, status: 'active' })

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
              entries.push({ kind: 'thinking', text: (block.thinking || '').slice(0, 500) })
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
    if (code === 0 || code === null) {
      // Clean exit — agent chose to stop (context window full, or completed task)
      // Resume with last session if available, otherwise restart fresh
      log(`Agent ${config.name} exited cleanly, resuming in 3s...`)
      ap.status = 'sleeping'
      sendToServer({ type: 'agent:status', agentId, status: 'sleeping' })
      setTimeout(() => {
        if (ap.status === 'sleeping' && !ap.proc) {
          startAgent(agentId, ap.sessionId ? { ...ap.config, sessionId: ap.sessionId } : ap.config)
            .catch(err => log(`Agent ${ap.config.name} resume failed: ${err.message}`))
        }
      }, 3_000)
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
  if (!ap?.proc || !ap.proc.stdin?.writable) {
    // Agent sleeping — wake it up with resume
    if (ap?.sessionId && ap.status === 'sleeping') {
      log(`Waking sleeping agent ${ap.config.name}`)
      startAgent(agentId, { ...ap.config, sessionId: ap.sessionId })
    }
    return
  }
  // Send notification via stdin (Claude Code stream-json format)
  const notification = `\n[System notification: You have 1 new message waiting. Call receive_message to read it when you're ready.]\n`
  try {
    ap.proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: notification }] },
    }) + '\n')
  } catch {
    // stdin may be closed
  }
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
