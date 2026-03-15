// Red Shrimp Lab — Vault Browser (formerly DocBrowser)
// Three-panel: left=file tree, center=vault viewer, right=Donovan handoff

import { useEffect, useRef, useState } from 'react'
import { obsidianApi, memoryApi, channelsApi, messagesApi, agentsApi, setupApi, type ObsidianEntry, type MemorySource } from '../lib/api'
import { isImeComposing } from '../lib/ime'
import DocumentViewer from './DocumentViewer'

const LEFT_PANE_DEFAULT_WIDTH = 240
const LEFT_PANE_MIN_WIDTH = 180
const LEFT_PANE_MAX_WIDTH = 520
const RIGHT_PANE_DEFAULT_WIDTH = 320
const RIGHT_PANE_MIN_WIDTH = 240
const RIGHT_PANE_MAX_WIDTH = 560
const CENTER_PANE_MIN_WIDTH = 280
const RESIZER_WIDTH = 10
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function ResizeHandle({
  active,
  onPointerDown,
}: {
  active: boolean
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={`group relative shrink-0 cursor-col-resize bg-[#09070a] transition-colors ${
        active ? 'bg-[#141018]' : 'hover:bg-[#141018]'
      }`}
      style={{ width: RESIZER_WIDTH, touchAction: 'none' }}
      title="drag to resize"
    >
      <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
        active ? 'bg-[#c0392b]' : 'bg-[#2a2228] group-hover:bg-[#6bc5e8]'
      }`} />
    </div>
  )
}

export default function MemoryBrowser({ initialPath }: { initialPath?: string | null }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null)
  const [history, setHistory] = useState<string[]>([])

  const navigateTo = (path: string | null) => {
    if (selectedPath && path !== selectedPath) {
      setHistory(prev => [...prev, selectedPath])
    }
    setSelectedPath(path)
  }

  const goBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    setSelectedPath(prev)
  }

  useEffect(() => {
    if (initialPath) navigateTo(initialPath)
  }, [initialPath])
  const [showImport, setShowImport] = useState(false)
  const [treeKey, setTreeKey] = useState(0) // bump to force tree reload
  const [leftWidth, setLeftWidth] = useState(LEFT_PANE_DEFAULT_WIDTH)
  const [rightWidth, setRightWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH)
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const leftWidthRef = useRef(LEFT_PANE_DEFAULT_WIDTH)
  const rightWidthRef = useRef(RIGHT_PANE_DEFAULT_WIDTH)

  const refreshTree = () => setTreeKey(k => k + 1)

  const clampWidthsToContainer = () => {
    const container = containerRef.current
    if (!container) return

    const totalWidth = container.getBoundingClientRect().width
    const leftMax = Math.max(
      LEFT_PANE_MIN_WIDTH,
      Math.min(LEFT_PANE_MAX_WIDTH, totalWidth - rightWidthRef.current - CENTER_PANE_MIN_WIDTH - RESIZER_WIDTH * 2),
    )
    const nextLeft = clamp(leftWidthRef.current, LEFT_PANE_MIN_WIDTH, leftMax)

    const rightMax = Math.max(
      RIGHT_PANE_MIN_WIDTH,
      Math.min(RIGHT_PANE_MAX_WIDTH, totalWidth - nextLeft - CENTER_PANE_MIN_WIDTH - RESIZER_WIDTH * 2),
    )
    const nextRight = clamp(rightWidthRef.current, RIGHT_PANE_MIN_WIDTH, rightMax)

    leftWidthRef.current = nextLeft
    rightWidthRef.current = nextRight
    setLeftWidth(nextLeft)
    setRightWidth(nextRight)
  }

  useEffect(() => {
    clampWidthsToContainer()
    window.addEventListener('resize', clampWidthsToContainer)
    return () => window.removeEventListener('resize', clampWidthsToContainer)
  }, [])

  useEffect(() => {
    if (!dragging) return

    const onPointerMove = (event: PointerEvent) => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const totalWidth = rect.width

      if (dragging === 'left') {
        const leftMax = Math.max(
          LEFT_PANE_MIN_WIDTH,
          Math.min(LEFT_PANE_MAX_WIDTH, totalWidth - rightWidthRef.current - CENTER_PANE_MIN_WIDTH - RESIZER_WIDTH * 2),
        )
        const nextLeft = clamp(event.clientX - rect.left, LEFT_PANE_MIN_WIDTH, leftMax)
        leftWidthRef.current = nextLeft
        setLeftWidth(nextLeft)
      } else {
        const rightMax = Math.max(
          RIGHT_PANE_MIN_WIDTH,
          Math.min(RIGHT_PANE_MAX_WIDTH, totalWidth - leftWidthRef.current - CENTER_PANE_MIN_WIDTH - RESIZER_WIDTH * 2),
        )
        const nextRight = clamp(rect.right - event.clientX, RIGHT_PANE_MIN_WIDTH, rightMax)
        rightWidthRef.current = nextRight
        setRightWidth(nextRight)
      }
    }

    const onPointerUp = () => setDragging(null)

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])

  return (
    <div
      ref={containerRef}
      className="h-full flex overflow-hidden bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}>

      {/* ── Left: recursive file tree (resizable) ── */}
      <div
        className="shrink-0 flex flex-col bg-[#141018]"
        style={{ width: leftWidth }}
      >
        <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] shrink-0">
          <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest mb-0.5">obsidian vault</div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={goBack}
                disabled={history.length === 0}
                title="back"
                className="text-[14px] leading-none text-[#4a4048] hover:text-[#6bc5e8] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
              >
                ←
              </button>
              <div className="text-[16px] leading-none">vault</div>
            </div>
            <button
              onClick={() => setShowImport(s => !s)}
              title="import vault repo"
              className={`text-[11px] px-1.5 py-0.5 border transition-colors ${
                showImport
                  ? 'border-[#c0392b] text-[#c0392b]'
                  : 'border-[#3a3535] text-[#4a4048] hover:border-[#6bc5e8] hover:text-[#6bc5e8]'
              }`}
            >
              + git
            </button>
          </div>
        </div>
        {showImport && <GitImportPanel onImported={() => { refreshTree(); setShowImport(false) }} />}
        <div className="flex-1 overflow-auto py-1">
          <TreeNode key={treeKey} path="" depth={0} selectedPath={selectedPath} onSelect={navigateTo} />
        </div>
        <MemorySourcesList onSync={refreshTree} />
      </div>
      <ResizeHandle
        active={dragging === 'left'}
        onPointerDown={(event) => {
          event.preventDefault()
          setDragging('left')
        }}
      />

      {/* ── Center: vault viewer (flex-1) ── */}
      <div className="flex-1 min-w-0 overflow-auto">
        {selectedPath ? (
          <DocumentViewer filePath={selectedPath} embedded onNavigate={navigateTo} />
        ) : (
          <div className="h-full flex items-center justify-center text-center">
            <div>
              <div className="text-[48px] mb-3 opacity-10">⊡</div>
              <div className="text-[13px] text-[#4a4048]">select a vault file to view</div>
            </div>
          </div>
        )}
      </div>
      <ResizeHandle
        active={dragging === 'right'}
        onPointerDown={(event) => {
          event.preventDefault()
          setDragging('right')
        }}
      />

      {/* ── Right: Donovan Q&A panel (resizable) ── */}
      <AskPanel filePath={selectedPath} width={rightWidth} />
    </div>
  )
}

// ── Git Import Panel ──────────────────────────────────────────────────────────

function GitImportPanel({ onImported }: { onImported: () => void }) {
  const [name, setName] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [authMethod, setAuthMethod] = useState<'none' | 'ssh'>('ssh')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim() || !gitUrl.trim()) return
    setLoading(true)
    setError(null)
    try {
      await memoryApi.addSource({ name: name.trim(), gitUrl: gitUrl.trim(), branch, authMethod })
      setName('')
      setGitUrl('')
      onImported()
    } catch (err: any) {
      setError(err.message ?? 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-b-[3px] border-black px-3 py-3 bg-[#1a1620] space-y-2">
      <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest">import vault repo</div>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="name (e.g. team-notes)"
        className="w-full bg-[#0e0c10] border border-[#2a2228] text-[#e7dfd3] text-[11px] px-2 py-1 outline-none focus:border-[#6bc5e8] placeholder-[#3a3535]"
        style={{ fontFamily: 'inherit' }}
      />
      <input
        value={gitUrl}
        onChange={e => setGitUrl(e.target.value)}
        placeholder="git@github.com:org/repo.git"
        className="w-full bg-[#0e0c10] border border-[#2a2228] text-[#e7dfd3] text-[11px] px-2 py-1 outline-none focus:border-[#6bc5e8] placeholder-[#3a3535]"
        style={{ fontFamily: 'inherit' }}
      />
      <div className="flex gap-2">
        <input
          value={branch}
          onChange={e => setBranch(e.target.value)}
          placeholder="branch"
          className="flex-1 bg-[#0e0c10] border border-[#2a2228] text-[#e7dfd3] text-[11px] px-2 py-1 outline-none focus:border-[#6bc5e8] placeholder-[#3a3535]"
          style={{ fontFamily: 'inherit' }}
        />
        <select
          value={authMethod}
          onChange={e => setAuthMethod(e.target.value as 'none' | 'ssh')}
          className="rsl-control rsl-select bg-[#0e0c10] border border-[#2a2228] text-[#9a8888] text-[11px] px-1.5 py-1 outline-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <option value="ssh">SSH</option>
          <option value="none">public</option>
        </select>
      </div>
      {error && <div className="text-[10px] text-[#c0392b]">{error}</div>}
      <button
        onClick={submit}
        disabled={loading || !name.trim() || !gitUrl.trim()}
        className="w-full py-1 text-[11px] uppercase tracking-wider bg-[#0e0c10] border border-[#2a2228] text-[#6bc5e8] hover:bg-[#1a2535] hover:border-[#6bc5e8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'cloning...' : 'import'}
      </button>
    </div>
  )
}

// ── Memory Sources List ───────────────────────────────────────────────────────

function MemorySourcesList({ onSync }: { onSync: () => void }) {
  const [sources, setSources] = useState<MemorySource[]>([])
  const [expanded, setExpanded] = useState(false)

  const load = () => {
    memoryApi.listSources().then(({ sources: s }) => setSources(s)).catch(() => {})
  }

  useEffect(() => { load() }, [])

  if (sources.length === 0) return null

  return (
    <div className="border-t-[3px] border-black shrink-0">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2 text-left flex items-center gap-1.5 hover:bg-[#1e1a20] transition-colors"
      >
        <span className="text-[11px] text-[#6bc5e8]">{expanded ? '▾' : '▸'}</span>
        <span className="text-[10px] text-[#4a4048] uppercase tracking-widest">vault repos ({sources.length})</span>
      </button>
      {expanded && sources.map(s => (
        <div key={s.id} className="px-3 py-1.5 border-b border-[#1a1620] text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-[#9a8888] truncate">{s.name}</span>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => { memoryApi.syncSource(s.id).then(() => { load(); onSync() }).catch(() => {}) }}
                title="sync"
                className="text-[9px] text-[#4a4048] hover:text-[#6bc5e8] px-1"
              >
                ↻
              </button>
              <button
                onClick={() => { memoryApi.deleteSource(s.id).then(() => { load(); onSync() }).catch(() => {}) }}
                title="remove"
                className="text-[9px] text-[#4a4048] hover:text-[#c0392b] px-1"
              >
                ×
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[9px] px-1 border ${
              s.status === 'synced' ? 'border-[#3abfa0] text-[#3abfa0]' :
              s.status === 'error' ? 'border-[#c0392b] text-[#c0392b]' :
              s.status === 'cloning' ? 'border-[#6bc5e8] text-[#6bc5e8]' :
              'border-[#4a4048] text-[#4a4048]'
            }`}>{s.status}</span>
            {s.last_synced && (
              <span className="text-[9px] text-[#3a3535]">
                {new Date(s.last_synced).toLocaleDateString()}
              </span>
            )}
          </div>
          {s.status === 'error' && s.last_error && (
            <div className="text-[9px] text-[#c0392b] mt-0.5 truncate" title={s.last_error}>{s.last_error}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Thinking Indicator ────────────────────────────────────────────────────────

const THINKING_PHRASES = [
  'reading context...',
  'scanning vault...',
  'cross-referencing links...',
  'checking agent memory...',
  'analyzing patterns...',
  'synthesizing answer...',
  'formulating response...',
]

function ThinkingIndicator() {
  const [phraseIdx, setPhraseIdx] = useState(0)

  useEffect(() => {
    const phraseTimer = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length)
    }, 900)
    return () => clearInterval(phraseTimer)
  }, [])

  return (
    <div className="bg-[#0e1520] border-[2px] border-[#1e3d55] px-3 py-2 max-w-[240px]">
      <div className="text-[10px] text-[#3a6a8a] uppercase tracking-widest mb-1">processing</div>
      <div className="text-[11px] text-[#4a9ac8] font-mono">
        {'> '}{THINKING_PHRASES[phraseIdx]}
        <span
          className="inline-block w-[7px] h-[11px] bg-[#4a9ac8] ml-0.5 align-middle"
          style={{ animation: 'blink 0.7s step-start infinite' }}
        />
      </div>
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  )
}

// ── Agent Q&A Panel ─────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  text: string
}

interface AgentOption {
  id: string
  name: string
}

function AskPanel({ filePath, width }: { filePath: string | null; width: number }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [handoffState, setHandoffState] = useState<string | null>(null)
  const [ctxPath, setCtxPath] = useState<string | null>(filePath)
  const [ctxLocked, setCtxLocked] = useState(false)
  const [vaultRoot, setVaultRoot] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const selectedAgent = agents.find(a => a.id === selectedAgentId) ?? null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!ctxLocked) setCtxPath(filePath)
  }, [filePath, ctxLocked])

  useEffect(() => {
    agentsApi.list()
      .then(list => {
        const opts = list.map(a => ({ id: a.id, name: a.name }))
        setAgents(opts)
        if (!selectedAgentId && opts.length > 0) {
          // Default to first agent (usually Donovan as coordinator)
          const donovan = opts.find(a => a.name === 'Donovan')
          setSelectedAgentId(donovan?.id ?? opts[0].id)
        }
      })
      .catch(() => setAgents([]))
  }, [])

  useEffect(() => {
    setupApi.getKeys()
      .then(keys => setVaultRoot(keys.obsidian_root ?? ''))
      .catch(() => setVaultRoot(''))
  }, [])

  const resolveAgentId = async () => {
    if (selectedAgentId) return selectedAgentId
    const list = await agentsApi.list()
    const opts = list.map(a => ({ id: a.id, name: a.name }))
    setAgents(opts)
    if (opts.length > 0) {
      setSelectedAgentId(opts[0].id)
      return opts[0].id
    }
    return null
  }

  const handoffToAgent = async (question: string) => {
    const agentId = await resolveAgentId()
    if (!question || !agentId) throw new Error('No agent available')
    const dm = await channelsApi.openDM(agentId)
    let content = question
    const normalizedVaultRoot = vaultRoot.trim().replace(/[\\/]+$/, '')
    const normalizedCtxPath = ctxPath?.replace(/^\/+/, '') ?? null
    const absoluteVaultPath = normalizedVaultRoot && normalizedCtxPath
      ? `${normalizedVaultRoot}/${normalizedCtxPath}`
      : null

    if (normalizedCtxPath) {
      try {
        const file = await obsidianApi.file(normalizedCtxPath)
        const resolvedVaultPath = file.path || normalizedCtxPath
        const resolvedAbsoluteVaultPath = normalizedVaultRoot
          ? `${normalizedVaultRoot}/${resolvedVaultPath}`
          : absoluteVaultPath
        const truncated = file.content.length > 12000
          ? `${file.content.slice(0, 12000)}\n...[truncated]`
          : file.content
        content = [
          '下面是来自共享 vault 的文档上下文。',
          '不要先去你当前 workspace 里查这个路径，也不要因为本地不存在就拒绝处理。',
          '如果下面正文已经足够，请直接基于正文回答或处理。',
          `vault 相对路径：${resolvedVaultPath}`,
          resolvedAbsoluteVaultPath ? `宿主机绝对路径：${resolvedAbsoluteVaultPath}` : null,
          '',
          '文档内容：',
          '```md',
          truncated,
          '```',
          '',
          `用户请求：${question}`,
        ].filter(Boolean).join('\n')
      } catch {
        content = [
          '下面这个路径来自共享 vault，不是你当前 workspace 里的本地相对路径。',
          '不要仅因为 workspace 里没有这个路径就直接拒绝。',
          `vault 相对路径：${normalizedCtxPath}`,
          absoluteVaultPath ? `宿主机绝对路径：${absoluteVaultPath}` : null,
          '如果需要读文件，请优先尝试上面的宿主机绝对路径；如果还是不够，再明确说明缺什么上下文。',
          '',
          `用户请求：${question}`,
        ].filter(Boolean).join('\n')
      }
    }

    await messagesApi.send(dm.id, content)
    const agentName = selectedAgent?.name ?? 'agent'
    return normalizedCtxPath ? `已发给 ${agentName}：${normalizedCtxPath}` : `已发给 ${agentName}`
  }

  const replacePendingAssistantMessage = (text: string) => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      if (last?.role === 'assistant') {
        updated[updated.length - 1] = { ...last, text }
      } else {
        updated.push({ role: 'assistant', text })
      }
      return updated
    })
  }

  const sendAskToAgent = async (question: string, reason?: string) => {
    const agentName = selectedAgent?.name ?? 'agent'
    const status = await handoffToAgent(question)
    setHandoffState(status)
    replacePendingAssistantMessage(
      reason
        ? `已通过通信转发给 ${agentName}（${reason}），请到私聊查看回复。`
        : `已转发给 ${agentName}，请到私聊查看回复。`
    )
  }

  const send = async () => {
    const q = input.trim()
    if (!q || sending) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setSending(true)
    setMessages(prev => [...prev, { role: 'assistant', text: '' }])

    try {
      await sendAskToAgent(q)
    } catch (err: any) {
      replacePendingAssistantMessage(`⚠ ${err?.message ?? 'failed to message agent'}`)
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const clearCtx = () => { setCtxPath(null); setCtxLocked(true) }
  const toggleLock = () => setCtxLocked(l => !l)

  return (
    <div className="shrink-0 flex flex-col bg-[#100e13]" style={{ width }}>
      {/* Header */}
      <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] shrink-0">
        <div className="text-[14px] leading-none">ask agent</div>
        <div className="flex items-center gap-1 mt-1.5 min-w-0">
          <span className="text-[10px] text-[#4a4048] shrink-0">ctx:</span>
          <span className="text-[10px] text-[#6a5a5a] flex-1 truncate min-w-0" title={ctxPath ?? 'none'}>
            {ctxPath ? ctxPath.split('/').pop() : 'none'}
          </span>
          <button
            onClick={toggleLock}
            title={ctxLocked ? 'unlock — follow selected file' : 'lock this context file'}
            className={`text-[9px] border px-1 py-0.5 leading-none shrink-0 transition-colors ${
              ctxLocked
                ? 'border-[#c0392b] text-[#c0392b]'
                : 'border-[#3a3535] text-[#3a3535] hover:border-[#5a4545] hover:text-[#5a4545]'
            }`}
          >
            {ctxLocked ? 'locked' : 'auto'}
          </button>
          {ctxPath && (
            <button
              onClick={clearCtx}
              title="clear context"
              className="text-[12px] text-[#4a4048] hover:text-[#c0392b] px-0.5 shrink-0 leading-none"
            >x</button>
          )}
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[10px] text-[#4a4048] shrink-0">agent:</span>
          <select
            value={selectedAgentId ?? ''}
            onChange={e => { setSelectedAgentId(e.target.value || null); setMessages([]) }}
            className="flex-1 text-[10px] text-[#9a8888] bg-transparent border-none outline-none cursor-pointer truncate"
          >
            {agents.map(a => (
              <option key={a.id} value={a.id} className="bg-[#1e1a20]">{a.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-[11px] text-[#3a3535] leading-relaxed">
            {filePath
              ? `directly message ${selectedAgent?.name ?? 'agent'} about the current vault file, tasks, or team status`
              : `select a vault file, or message ${selectedAgent?.name ?? 'agent'} about tasks and agents`}
          </div>
        )}
        {messages.map((m, i) => {
          return (
            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              {m.role === 'user' ? (
                <span className="inline-block bg-[#2a1a1a] border-[2px] border-[#c0392b] text-[#e7dfd3] text-[12px] px-3 py-2 max-w-[220px] text-left break-words">
                  {m.text}
                </span>
              ) : (
                <span className="inline-block bg-[#1a2535] border-[2px] border-[#1e3d55] text-[#c8bdb8] text-[12px] px-3 py-2 max-w-[240px] text-left break-words whitespace-pre-wrap">
                  {m.text}
                </span>
              )}
            </div>
          )
        })}
        {sending && messages[messages.length - 1]?.text === '' && messages[messages.length - 1]?.role === 'assistant' && (
          <ThinkingIndicator />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t-[3px] border-black px-3 py-3 shrink-0">
        <textarea
          value={input}
          onChange={e => { setInput(e.target.value); if (handoffState) setHandoffState(null) }}
          onKeyDown={onKey}
          placeholder={`message ${selectedAgent?.name ?? 'agent'}...`}
          rows={3}
          className="w-full bg-[#1e1a20] border-[2px] border-[#2a2228] text-[#e7dfd3] text-[12px] px-3 py-2 resize-none outline-none focus:border-[#c0392b] placeholder-[#3a3535]"
          style={{ fontFamily: 'inherit' }}
        />
        {handoffState && (
          <div className={`mt-2 text-[11px] ${handoffState.startsWith('已发给') ? 'text-[#6bc5e8]' : 'text-[#c0392b]'}`}>
            {handoffState}
          </div>
        )}
        <div className="mt-2">
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="w-full py-1.5 text-[12px] uppercase tracking-wider bg-[#1a2535] border-[2px] border-[#1e3d55] text-[#6bc5e8] hover:bg-[#243548] hover:text-[#e7dfd3] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '⟳ sending...' : `ask ${selectedAgent?.name ?? 'agent'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Recursive tree node ───────────────────────────────────────────────────────

interface TreeNodeProps {
  path: string
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}

function TreeNode({ path, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [entries, setEntries] = useState<ObsidianEntry[]>([])
  const [expanded, setExpanded] = useState(depth === 0)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (depth === 0) {
      setLoading(true)
      obsidianApi.tree(path)
        .then(({ items }) => { setEntries(items); setLoaded(true) })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  }, [])

  const toggle = () => {
    if (!loaded && !loading) {
      setLoading(true)
      obsidianApi.tree(path)
        .then(({ items }) => { setEntries(items); setLoaded(true); setExpanded(true) })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false))
    } else {
      setExpanded(e => !e)
    }
  }

  const dirs  = entries.filter(e => e.type === 'directory')
  const files = entries.filter(e => e.type === 'file')

  return (
    <div>
      {loading && depth === 0 && (
        <div className="text-[11px] text-[#4a4048] px-4 pt-4">loading...</div>
      )}
      {(expanded || depth === 0) && (
        <>
          {dirs.map(entry => (
            <DirNode
              key={entry.path}
              entry={entry}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {files.map(entry => (
            <button
              key={entry.path}
              onClick={() => onSelect(entry.path)}
              className={`w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] transition-colors
                ${selectedPath === entry.path
                  ? 'bg-[#2a1a1a] border-l-[3px] border-l-[#c0392b]'
                  : 'hover:bg-[#1e1a20] border-l-[3px] border-l-transparent'}`}
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              <span className="text-[11px] text-[#4a4048] shrink-0">·</span>
              <span className="text-[12px] text-[#9a8888] truncate">{entry.name}</span>
            </button>
          ))}
          {entries.length === 0 && loaded && depth === 0 && (
            <div className="text-[11px] text-[#4a4048] px-4 pt-4">
              vault root not configured
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface DirNodeProps {
  entry: ObsidianEntry
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}

function DirNode({ entry, depth, selectedPath, onSelect }: DirNodeProps) {
  const [entries, setEntries] = useState<ObsidianEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  // Auto-expand when selected path is inside this directory
  useEffect(() => {
    if (selectedPath && selectedPath.startsWith(entry.path + '/') && !expanded && !loading) {
      if (!loaded) {
        setLoading(true)
        obsidianApi.tree(entry.path)
          .then(({ items }) => { setEntries(items); setLoaded(true); setExpanded(true) })
          .catch(() => setExpanded(true))
          .finally(() => setLoading(false))
      } else {
        setExpanded(true)
      }
    }
  }, [selectedPath])

  const toggle = () => {
    if (!loaded && !loading) {
      setLoading(true)
      obsidianApi.tree(entry.path)
        .then(({ items }) => { setEntries(items); setLoaded(true); setExpanded(true) })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false))
    } else {
      setExpanded(e => !e)
    }
  }

  const dirs  = entries.filter(e => e.type === 'directory')
  const files = entries.filter(e => e.type === 'file')

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] hover:bg-[#1e1a20] transition-colors border-l-[3px] border-l-transparent"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <span className="text-[11px] text-[#6bc5e8] shrink-0">
          {loading ? '…' : expanded ? '▾' : '▸'}
        </span>
        <span className="text-[12px] text-[#c8bdb8] truncate">{entry.name}</span>
      </button>
      {expanded && (
        <div>
          {dirs.map(d => (
            <DirNode key={d.path} entry={d} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
          {files.map(f => (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className={`w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] transition-colors
                ${selectedPath === f.path
                  ? 'bg-[#2a1a1a] border-l-[3px] border-l-[#c0392b]'
                  : 'hover:bg-[#1e1a20] border-l-[3px] border-l-transparent'}`}
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              <span className="text-[11px] text-[#4a4048] shrink-0">·</span>
              <span className="text-[12px] text-[#9a8888] truncate">{f.name}</span>
            </button>
          ))}
          {entries.length === 0 && loaded && (
            <div className="text-[11px] text-[#3a3535] py-1" style={{ paddingLeft: (depth + 1) * 12 + 4 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}
