// Red Shrimp Lab — Agents Management Page (connected to backend)

import { useEffect, useRef, useState } from 'react'
import {
  agentsApi, machinesApi, obsidianApi,
  type Agent, type AgentAuthoredDoc, type AgentLog, type AgentMemory, type AgentTodo, type AgentTodoDoc, type Machine, type ModelRegistry,
} from '../lib/api'
import {
  agentModelsForRuntime, defaultAgentModelForRuntime, syncAgentModelForRuntime,
  type AgentRuntime,
} from '../lib/agent-runtime'
import { rollAgentName } from '../lib/agent-name-roll'
import { DialogShell } from '../components/Dialog'
import { socketClient } from '../lib/socket'
import DocumentViewer from './DocumentViewer'

type AgentStatus = Agent['status']
type MemorySectionKey = 'memory' | 'knowledge' | 'notes'

const statusColor = (s: AgentStatus) => {
  if (s === 'running' || s === 'online') return { dot: '#3abfa0', text: '#3abfa0', label: 'running', pulse: true }
  if (s === 'starting')                  return { dot: '#f0b35e', text: '#f0b35e', label: 'starting', pulse: true }
  if (s === 'idle' || s === 'sleeping')  return { dot: '#6bc5e8', text: '#6bc5e8', label: s === 'sleeping' ? 'sleeping' : 'idle', pulse: false }
  if (s === 'offline')                   return { dot: '#c0392b', text: '#c0392b', label: 'offline', pulse: false }
  return                                        { dot: '#e04050', text: '#e04050', label: 'error',   pulse: true  }
}

function SidebarNavButton({
  active, onClick, children, accent = 'default',
}: {
  active: boolean
  onClick: () => void
  children: string
  accent?: 'default' | 'refresh'
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left border-[2px] border-black px-3 py-2 text-[11px] uppercase"
      style={{
        background: active ? '#1a2535' : '#141018',
        color: active ? '#6bc5e8' : accent === 'refresh' ? '#6bc5e8' : '#4a4048',
      }}
    >
      {children}
    </button>
  )
}

function SidebarFileButton({
  active,
  onClick,
  label,
  path,
}: {
  active: boolean
  onClick: () => void
  label: string
  path: string
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left border-[2px] border-black px-3 py-2"
      style={{
        background: active ? '#1a2535' : '#120f13',
        color: active ? '#e7dfd3' : '#9a8888',
      }}
    >
      <div className="text-[11px] uppercase">{label}</div>
      <div className="text-[10px] text-[#4a4048] mt-1 truncate">{path}</div>
    </button>
  )
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [models, setModels] = useState<ModelRegistry | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reconnectingAll, setReconnectingAll] = useState(false)
  const [reconnectAllResult, setReconnectAllResult] = useState<{
    ok: boolean
    count: number
    results: Array<{ agentId: string; name: string; ok: boolean; message?: string; error?: string }>
  } | null>(null)
  const [logsAgent, setLogsAgent] = useState<Agent | null>(null)
  const [logsData, setLogsData] = useState<AgentLog[]>([])
  const logsBottomRef = useRef<HTMLDivElement>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    modelId: defaultAgentModelForRuntime('codex'),
    workspacePath: '',
    description: '',
    role: 'general',
    runtime: 'codex' as AgentRuntime,
    reasoningEffort: 'medium' as string,
    machineId: '' as string,
    parentAgentId: '' as string, // empty = auto (defaults to Donovan on backend)
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [detail, setDetail] = useState<Agent | null>(null)
  const [agentNoteDraft, setAgentNoteDraft] = useState('')
  const [savingAgentNote, setSavingAgentNote] = useState(false)
  const [detailLogs, setDetailLogs] = useState<AgentLog[]>([])
  const detailLogsBottomRef = useRef<HTMLDivElement>(null)
  const [detailTab, setDetailTab] = useState<'memory' | 'docs' | 'todos' | 'logs'>('memory')
  const [detailMemory, setDetailMemory] = useState<AgentMemory | null>(null)
  const [detailMemorySection, setDetailMemorySection] = useState<MemorySectionKey>('memory')
  const [detailAuthoredDocs, setDetailAuthoredDocs] = useState<AgentAuthoredDoc[]>([])
  const [detailAuthoredDocsLoading, setDetailAuthoredDocsLoading] = useState(false)
  const [selectedAuthoredDocPath, setSelectedAuthoredDocPath] = useState<string | null>(null)
  const [detailTodos, setDetailTodos] = useState<AgentTodo[]>([])
  const [detailMemoryLoading, setDetailMemoryLoading] = useState(false)
  const [detailTodosLoading, setDetailTodosLoading] = useState(false)
  const [todoPreviewPath, setTodoPreviewPath] = useState<string | null>(null)
  const [todoPreviewContent, setTodoPreviewContent] = useState('')
  const [todoPreviewLoading, setTodoPreviewLoading] = useState(false)
  const [todoPreviewError, setTodoPreviewError] = useState<string | null>(null)

  // Per-agent streaming state: agentId → last N log lines
  const [streamingAgents, setStreamingAgents] = useState<Record<string, string[]>>({})

  // Subscribe to agent streaming events for all agents
  useEffect(() => {
    const unsub = [
      socketClient.on('agent:started', (e: any) => {
        setStreamingAgents(prev => ({ ...prev, [e.agentId]: [] }))
      }),
      socketClient.on('agent:log', (e: any) => {
        setStreamingAgents(prev => {
          const lines = prev[e.agentId] ?? []
          const next = [...lines, e.content]
          return { ...prev, [e.agentId]: next.length > 8 ? next.slice(-8) : next }
        })
      }),
      socketClient.on('agent:stopped', (e: any) => {
        setStreamingAgents(prev => {
          const { [e.agentId]: _, ...rest } = prev
          return rest
        })
      }),
      socketClient.on('agent:crashed', (e: any) => {
        setStreamingAgents(prev => {
          const { [e.agentId]: _, ...rest } = prev
          return rest
        })
      }),
    ]
    return () => unsub.forEach(fn => fn())
  }, [])

  const runtimeModelOptions = agentModelsForRuntime(models, createForm.runtime)

  const reload = async () => {
    await Promise.all([
      agentsApi.list().then(a => setAgents(a)).catch(() => {}),
      machinesApi.list().then(setMachines).catch(() => setMachines([])),
    ])
  }

  const loadTodoPreview = async (docPath: string | null) => {
    setTodoPreviewPath(docPath)
    setTodoPreviewContent('')
    setTodoPreviewError(null)

    if (!docPath) return

    setTodoPreviewLoading(true)
    try {
      const file = await obsidianApi.file(docPath)
      setTodoPreviewContent(file.content)
    } catch (err: any) {
      setTodoPreviewError(err.message ?? 'Failed to load todo note')
    } finally {
      setTodoPreviewLoading(false)
    }
  }

  const loadDetailContext = async (agentId: string, preferredDocPath?: string | null) => {
    setDetailMemoryLoading(true)
    setDetailAuthoredDocsLoading(true)
    setDetailTodosLoading(true)
    try {
      const [memory, { docs: authoredDocs }, { todos }] = await Promise.all([
        agentsApi.memory(agentId),
        agentsApi.authoredDocs(agentId),
        agentsApi.todos(agentId),
      ])

      setDetailMemory(memory)
      setDetailAuthoredDocs(authoredDocs)
      setSelectedAuthoredDocPath(currentPath => {
        if (currentPath && authoredDocs.some(doc => doc.path === currentPath)) return currentPath
        return authoredDocs[0]?.path ?? null
      })
      setDetailTodos(todos)

      const defaultDocPath =
        preferredDocPath && todos.some(todo => todo.docs.some(doc => doc.doc_path === preferredDocPath))
          ? preferredDocPath
          : todos.find(todo => todo.docs.length > 0)?.docs[0]?.doc_path ?? null

      await loadTodoPreview(defaultDocPath)
    } catch {
      setDetailMemory(null)
      setDetailAuthoredDocs([])
      setSelectedAuthoredDocPath(null)
      setDetailTodos([])
      await loadTodoPreview(null)
    } finally {
      setDetailMemoryLoading(false)
      setDetailAuthoredDocsLoading(false)
      setDetailTodosLoading(false)
    }
  }

  const loadDetailData = async (agentId: string, seedAgent?: Agent) => {
    if (seedAgent) setDetail(seedAgent)
    setAgentNoteDraft(seedAgent?.note ?? '')
    setDetailLogs([])
    setDetailMemory(null)
    setDetailMemorySection('memory')
    setDetailAuthoredDocs([])
    setSelectedAuthoredDocPath(null)
    setDetailTodos([])
    setTodoPreviewPath(null)
    setTodoPreviewContent('')
    setTodoPreviewError(null)

    try {
      const [agent, { logs }] = await Promise.all([
        agentsApi.get(agentId),
        agentsApi.logs(agentId, 200),
      ])
      setDetail(agent)
      setAgentNoteDraft(agent.note ?? '')
      setDetailLogs(logs)
      setTimeout(() => detailLogsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch { /* ignore */ }

    await loadDetailContext(agentId)
  }

  useEffect(() => {
    reload()
    agentsApi.models().then(setModels).catch(() => {})

    // Live status updates via WebSocket
    const unsubs = [
      socketClient.on('agent:started',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'running' } : ag))),
      socketClient.on('agent:stopped',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'idle'    } : ag))),
      socketClient.on('agent:crashed',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'error'   } : ag))),
      socketClient.on('agent:offline',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'offline' } : ag))),
    ]
    return () => { for (const u of unsubs) u() }
  }, [])

  useEffect(() => {
    if (!models) return
    setCreateForm(form => ({
      ...form,
      modelId: syncAgentModelForRuntime(models, form.runtime, form.modelId),
    }))
  }, [models])

  const existingAgentNames = agents.map(agent => agent.name)

  const rollCreateName = () => {
    setCreateForm(form => ({ ...form, name: rollAgentName(existingAgentNames) }))
    setCreateError(null)
  }

  const openCreateModal = () => {
    setCreateError(null)
    setCreateForm(form => ({
      ...form,
      name: form.name.trim() || rollAgentName(existingAgentNames),
      machineId: form.machineId || (machines.length === 1 ? machines[0].id : ''),
    }))
    setShowCreate(true)
  }

  const handleCreate = async () => {
    if (!createForm.name.trim()) return
    if (!createForm.machineId) {
      setCreateError(machines.length === 0
        ? 'No machine available. Create or reconnect a machine first.'
        : 'Machine is required. Pick exactly one machine for this agent.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await agentsApi.create({
        name: createForm.name.trim(),
        modelId: createForm.modelId,
        role: createForm.role,
        runtime: createForm.runtime,
        reasoningEffort: createForm.reasoningEffort || undefined,
        machineId: createForm.machineId || undefined,
        workspacePath: createForm.workspacePath.trim() || undefined,
        description: createForm.description.trim() || undefined,
        parentAgentId: createForm.parentAgentId || undefined,
      })
      setShowCreate(false)
      setCreateForm({
        name: '',
        modelId: defaultAgentModelForRuntime('codex'),
        workspacePath: '',
        description: '',
        role: 'general',
        runtime: 'codex',
        reasoningEffort: 'medium',
        machineId: '',
        parentAgentId: '',
      })
      await reload()
    } catch (err: any) {
      setCreateError(err.message ?? 'Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  const openLogs = async (agent: Agent) => {
    setLogsAgent(agent)
    setLogsData([])
    try {
      const { logs } = await agentsApi.logs(agent.id, 100)
      setLogsData(logs)
      setTimeout(() => logsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch { /* ignore */ }
  }

  const openDetail = async (agent: Agent) => {
    setDetailTab('memory')
    setDetailMemorySection('memory')
    await loadDetailData(agent.id, agent)
  }

  // Live log updates for detail view
  useEffect(() => {
    if (!detail) return
    return socketClient.on('agent:log', (data: any) => {
      if (data.agentId === detail.id) {
        setDetailLogs(prev => [...prev, data])
        setTimeout(() => detailLogsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
      }
    })
  }, [detail])

  const handleDelete = async () => {
    if (!deleteConfirm) return
    setDeleting(true)
    try {
      await agentsApi.delete(deleteConfirm.id)
      setDeleteConfirm(null)
      await reload()
    } catch (err: any) {
      console.error(err.message)
    } finally {
      setDeleting(false)
    }
  }

  const handleResetContext = async (agent: Agent) => {
    setBusy(agent.id)
    try {
      await agentsApi.resetContext(agent.id)
      await reload()
    } catch (err: any) {
      console.error(err.message)
    } finally {
      setBusy(null)
    }
  }

  const toggleAgent = async (agent: Agent) => {
    setBusy(agent.id)
    try {
      if (agent.status === 'running' || agent.status === 'online') {
        await agentsApi.stop(agent.id)
      } else {
        await agentsApi.start(agent.id)
      }
      await reload()
    } catch (err: any) {
      console.error(err.message)
    } finally {
      setBusy(null)
    }
  }

  const handleSaveAgentNote = async () => {
    if (!detail || savingAgentNote) return
    setSavingAgentNote(true)
    try {
      const trimmed = agentNoteDraft.trim()
      const { agent } = await agentsApi.updateNote(detail.id, trimmed)
      setDetail(current => current ? { ...current, note: agent.note ?? null } : current)
      setAgents(current => current.map(item => item.id === detail.id ? { ...item, note: agent.note ?? null } : item))
      setAgentNoteDraft(agent.note ?? '')
    } catch (err: any) {
      console.error(err.message)
    } finally {
      setSavingAgentNote(false)
    }
  }

  const handleReconnectAll = async () => {
    setReconnectingAll(true)
    try {
      const result = await agentsApi.reconnectAll()
      setReconnectAllResult(result)
      await reload()
      if (detail) {
        await loadDetailData(detail.id)
      }
    } catch (err: any) {
      setReconnectAllResult({
        ok: false,
        count: 0,
        results: [{ agentId: 'all', name: 'all agents', ok: false, error: err.message ?? 'Reconnect failed' }],
      })
    } finally {
      setReconnectingAll(false)
    }
  }

  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] p-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">management</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">agents</div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleReconnectAll}
            disabled={reconnectingAll || agents.length === 0}
            className="border-[3px] border-black bg-[#3abfa0] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#4ed0b0] disabled:opacity-40"
            style={{ transform: 'rotate(-0.15deg)' }}
          >
            {reconnectingAll ? 'reconnecting...' : 'reconnect all agents'}
          </button>
          <button
            onClick={openCreateModal}
            className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#e04050]"
            style={{ transform: 'rotate(0.2deg)' }}
          >
            + new agent
          </button>
        </div>
      </div>

      {reconnectAllResult && (
        <div
          className="mb-5 border-[3px] border-black bg-[#141018]"
          style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 16px rgba(50,120,220,0.10)' }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20] flex items-center justify-between">
            <div className="text-[13px] uppercase" style={{ color: reconnectAllResult.ok ? '#3abfa0' : '#c0392b' }}>
              reconnect all agents
            </div>
            <button onClick={() => setReconnectAllResult(null)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
          </div>
          <div className="px-4 py-3">
            <div className="text-[12px] text-[#c8bdb8] mb-3">
              {reconnectAllResult.results.filter(result => result.ok).length}/{reconnectAllResult.count} agents restarted
            </div>
            <div className="space-y-2 max-h-48 overflow-auto">
              {reconnectAllResult.results.map(result => (
                <div key={result.agentId} className="border-[2px] border-black bg-[#120f13] px-3 py-2 text-[11px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[#e7dfd3]">{result.name}</span>
                    <span style={{ color: result.ok ? '#3abfa0' : '#c0392b' }}>
                      {result.ok ? 'ok' : 'error'}
                    </span>
                  </div>
                  <div className="text-[#4a4048] mt-1 break-words">{result.message ?? result.error ?? 'done'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Create agent modal */}
      {showCreate && (
        <DialogShell
          title="new agent"
          tone="brand"
          widthClassName="max-w-[480px]"
          onClose={() => setShowCreate(false)}
          footer={(
            <div className="grid grid-cols-2">
              <button
                onClick={() => { setShowCreate(false); setCreateError(null) }}
                className="border-r-[3px] border-black py-3 text-[12px] uppercase text-[#4a4048] hover:bg-[#1e1a20] hover:text-[#e7dfd3]"
              >
                cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !createForm.name.trim() || !createForm.machineId}
                className="py-3 text-[12px] uppercase bg-[#c0392b] text-black hover:bg-[#e04050] disabled:opacity-40"
              >
                {creating ? '...' : 'spawn'}
              </button>
            </div>
          )}
        >
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="text-[11px] text-[#4a4048] uppercase">name *</div>
                <button
                  type="button"
                  onClick={rollCreateName}
                  className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] px-2 py-0.5 text-[10px] uppercase hover:bg-[#243548]"
                >
                  roll
                </button>
              </div>
              <input
                autoFocus
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="e.g. Donovan, Akara..."
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#4a4048]"
              />
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">machine *</div>
              <select
                value={createForm.machineId}
                onChange={e => {
                  const nextMachineId = e.target.value
                  setCreateForm(f => ({ ...f, machineId: nextMachineId }))
                  if (nextMachineId) setCreateError(null)
                }}
                className="rsl-control rsl-select w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
              >
                <option value="" disabled>{machines.length === 0 ? 'no machine available' : 'select machine'}</option>
                {machines.map(machine => (
                  <option key={machine.id} value={machine.id}>
                    {(machine.hostname ?? machine.name)} · {machine.status}
                    {machine.runtimes?.length ? ` · ${machine.runtimes.join('/')}` : ''}
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-[#3a3535] mt-1">
                every agent is bound to exactly one machine; creation now requires an explicit machine choice
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">model</div>
              <select
                value={createForm.modelId}
                onChange={e => setCreateForm(f => ({ ...f, modelId: e.target.value }))}
                className="rsl-control rsl-select w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
              >
                {runtimeModelOptions.length > 0 ? (
                  runtimeModelOptions.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))
                ) : (
                  <option value={defaultAgentModelForRuntime(createForm.runtime)}>
                    {defaultAgentModelForRuntime(createForm.runtime)}
                  </option>
                )}
              </select>
              <div className="text-[11px] text-[#3a3535] mt-1">
                model options follow the selected runtime
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">workspace path <span className="text-[#3a3535]">(auto-generated if empty)</span></div>
              <input
                value={createForm.workspacePath}
                onChange={e => setCreateForm(f => ({ ...f, workspacePath: e.target.value }))}
                placeholder={`<vault>/00_hub/agents/${createForm.name.trim() || '<name>'}`}
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#3a3535]"
              />
              {!createForm.workspacePath && (
                <div className="text-[11px] text-[#3abfa0] mt-1">
                  ✓ MEMORY.md · KNOWLEDGE.md · notes/README.md · GUIDE.md · HEARTBEAT.md will be created automatically
                </div>
              )}
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">runtime</div>
              <div className="grid grid-cols-3 gap-2">
                {(['claude', 'codex', 'kimi'] as const).map(rt => {
                  const active = createForm.runtime === rt
                  const accentColor = rt === 'codex' ? '#7ecf50' : rt === 'kimi' ? '#a07ef0' : '#3abfa0'
                  const bgColor = rt === 'codex' ? '#1a2010' : rt === 'kimi' ? '#1a1535' : '#0f1a18'
                  return (
                    <button
                      key={rt}
                      type="button"
                      onClick={() => {
                        setCreateForm(f => ({
                          ...f,
                          runtime: rt,
                          modelId: syncAgentModelForRuntime(models, rt, f.modelId),
                        }))
                      }}
                      className="border-[3px] border-black py-2 text-[11px] uppercase transition-colors"
                      style={{
                        background: active ? bgColor : '#1e1a20',
                        color: active ? accentColor : '#4a4048',
                        outline: active ? `2px solid ${accentColor}` : 'none',
                        outlineOffset: '-4px',
                      }}
                    >
                      {rt === 'claude' ? 'claude code' : rt === 'codex' ? 'codex cli' : 'kimi cli'}
                    </button>
                  )
                })}
              </div>
            </div>
            {createForm.runtime === 'codex' && (
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">reasoning effort</div>
              <div className="grid grid-cols-4 gap-2">
                {(['low', 'medium', 'high', 'extra_high'] as const).map(level => {
                  const active = createForm.reasoningEffort === level
                  const labels: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', extra_high: 'extra high' }
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setCreateForm(f => ({ ...f, reasoningEffort: level }))}
                      className="border-[3px] border-black py-1.5 text-[10px] uppercase transition-colors"
                      style={{
                        background: active ? '#1a2535' : '#1e1a20',
                        color: active ? '#6bc5e8' : '#4a4048',
                        outline: active ? '2px solid #6bc5e8' : 'none',
                        outlineOffset: '-4px',
                      }}
                    >
                      {labels[level]}
                    </button>
                  )
                })}
              </div>
            </div>
            )}
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">role</div>
              <select
                value={createForm.role}
                onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}
                className="rsl-control rsl-select w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
              >
                <optgroup label="Core">
                  <option value="coordinator">coordinator — 协调员</option>
                  <option value="ops">ops — 运维观察员</option>
                </optgroup>
                <optgroup label="Investigation (→ Coordinator)">
                  <option value="investigator">investigator — 调查员</option>
                </optgroup>
                <optgroup label="Observability (→ Coordinator)">
                  <option value="observer">observer — 指标观测</option>
                </optgroup>
                <optgroup label="Engineering (→ Tech Lead)">
                  <option value="developer">developer — 开发工程师</option>
                  <option value="profiler">profiler — 性能分析</option>
                </optgroup>
                <optgroup label="Experiment (→ Tech Lead)">
                  <option value="exp-kernel">exp-kernel — 算子实验</option>
                  <option value="exp-training">exp-training — 训练实验</option>
                  <option value="exp-inference">exp-inference — 推理实验</option>
                </optgroup>
                <optgroup label="Other">
                  <option value="general">general — 通用</option>
                </optgroup>
              </select>
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">reports to <span className="text-[#3a3535]">(默认汇报给 donovan)</span></div>
              <select
                value={createForm.parentAgentId}
                onChange={e => setCreateForm(f => ({ ...f, parentAgentId: e.target.value }))}
                className="rsl-control rsl-select w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
              >
                <option value="">auto (donovan)</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.role ? ` — ${a.role}` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">description <span className="text-[#3a3535]">(optional)</span></div>
              <input
                value={createForm.description}
                onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
                placeholder="这位酒保负责什么？"
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#4a4048]"
              />
            </div>
          </div>
          {createError && (
            <div className="mt-4 px-3 py-2 border-[2px] border-[#c0392b] text-[#c0392b] text-[11px]">
              ✗ {createError}
            </div>
          )}
        </DialogShell>
      )}

      {/* Logs modal */}
      {logsAgent && (
        <DialogShell
          title={logsAgent.name}
          subtitle={`${logsData.length} log entries`}
          tone="info"
          widthClassName="max-w-[700px]"
          panelClassName="max-h-[80vh] flex flex-col"
          bodyClassName="overflow-auto flex-1 font-mono"
          onClose={() => setLogsAgent(null)}
        >
          {logsData.length === 0 ? (
            <div className="text-[12px] text-[#4a4048] text-center py-8">no logs yet</div>
          ) : logsData.map((log, i) => {
            const time = new Date(log.created_at).toLocaleTimeString('zh-CN', { hour12: false })
            const lvlColor = log.level === 'ERROR' ? '#ff4444' : log.level === 'WARN' ? '#d4a017' : '#9a8888'
            return (
              <div
                key={log.id}
                className="border-b border-[#1a1620] flex gap-0 text-[12px]"
                style={{ background: i % 2 === 0 ? '#141018' : '#100e13' }}
              >
                <div className="px-3 py-1 text-[#4a4048] w-[72px] shrink-0 border-r border-[#1a1620]">{time}</div>
                <div className="px-2 py-1 w-[60px] shrink-0 border-r border-[#1a1620]" style={{ color: lvlColor }}>{log.level}</div>
                <div className="px-3 py-1 text-[#c8bdb8] flex-1 break-words">{log.content}</div>
              </div>
            )
          })}
          <div ref={logsBottomRef} />
        </DialogShell>
      )}

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <DialogShell
          title="confirm delete"
          tone="danger"
          widthClassName="max-w-[360px]"
          bodyClassName="px-5 py-5"
          onClose={() => setDeleteConfirm(null)}
          footer={(
            <div className="grid grid-cols-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="border-r-[3px] border-black py-3 text-[12px] uppercase text-[#4a4048] hover:bg-[#1e1a20]"
              >
                cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="py-3 text-[12px] uppercase text-[#c0392b] hover:bg-[#3a1520] disabled:opacity-40"
              >
                {deleting ? '...' : 'delete'}
              </button>
            </div>
          )}
        >
          <div className="text-[14px] text-[#e7dfd3] mb-2">
            确定要让 <span className="text-[#c0392b]">{deleteConfirm.name}</span> 离开俱乐部吗？
          </div>
          <div className="text-[11px] text-[#4a4048]">此操作不可恢复。日志和运行记录将一并删除。</div>
        </DialogShell>
      )}

      {/* ── Shrimp Detail View ──────────────────────────────────────── */}
      {detail && (
        <div className="fixed inset-0 z-50 bg-[#0e0c10] overflow-auto"
          style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}>
          {/* Detail header */}
          <div className="border-b-[3px] border-black bg-[#141118] px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
            <button
              onClick={() => setDetail(null)}
              className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px]"
            >
              ← back
            </button>
            <div
              className={`w-12 h-12 border-[3px] border-black flex items-center justify-center text-[20px]
                ${detail.status === 'running' || detail.status === 'online' ? 'agent-running-blink' : ''}`}
              style={{
                background: '#3a1520',
                color: '#c0392b',
                boxShadow: detail.status === 'running' || detail.status === 'online'
                  ? '0 0 10px rgba(58, 191, 160, 0.5)' : 'none',
              }}
            >
              {detail.name[0]?.toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="text-[22px]">{detail.name}</div>
              <div className="text-[12px] text-[#6bc5e8] uppercase">{detail.role ?? 'general'} · {detail.model_id}</div>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 border border-black"
                style={{
                  background: statusColor(detail.status).dot,
                  animation: statusColor(detail.status).pulse ? 'pulse 1.2s ease-in-out infinite' : 'none',
                }}
              />
              <span className="text-[13px] uppercase" style={{ color: statusColor(detail.status).text }}>
                {statusColor(detail.status).label}
              </span>
              <button
                onClick={() => toggleAgent(detail)}
                disabled={busy === detail.id}
                className="border-[2px] border-black px-4 py-1.5 text-[12px] uppercase hover:bg-[#2a2535] disabled:opacity-40"
                style={{ color: detail.status === 'running' ? '#c0392b' : '#3abfa0' }}
              >
                {busy === detail.id ? '...' : detail.status === 'running' ? 'stop' : 'start'}
              </button>
              <button
                onClick={() => { setDetail(null); setDeleteConfirm(detail) }}
                className="border-[2px] border-black px-4 py-1.5 text-[12px] text-[#6a3535] uppercase hover:bg-[#3a1520] hover:text-[#c0392b]"
              >
                delete
              </button>
            </div>
          </div>

          {/* Detail body — two columns */}
          <div className="flex h-[calc(100vh-76px)]">
            {/* Left: info */}
            <div className="w-[360px] border-r-[3px] border-black bg-[#141118] p-5 space-y-4 overflow-auto">
              <div className="border-[3px] border-black bg-[#191619] p-4 space-y-3">
                <div className="text-[11px] text-[#4a4048] uppercase mb-2">info</div>
                <MetaRow label="name"      value={detail.name} />
                <MetaRow label="role"      value={detail.role ?? 'general'} />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#4a4048] w-[72px] shrink-0 uppercase">model</span>
                  <select
                    value={detail.model_id}
                    onChange={async (e) => {
                      const newModel = e.target.value
                      try {
                        await agentsApi.updateModel(detail.id, newModel)
                        setDetail(d => d ? { ...d, model_id: newModel } : d)
                        reload()
                      } catch (err: any) { console.error(err.message) }
                    }}
                    className="rsl-control rsl-select flex-1 border-[2px] border-black bg-[#0e0c10] text-[#e7dfd3] px-2 py-0.5 text-[12px] outline-none"
                  >
                    {agentModelsForRuntime(models, detail.runtime as any).map(m => (
                      <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
                    ))}
                  </select>
                </div>
                <MetaRow label="runtime"   value={detail.runtime} />
                <MetaRow label="project"   value={detail.current_project_name ?? '—'} />
                <MetaRow label="workspace" value={detail.workspace_path ?? '—'} small />
                <MetaRow label="created"   value={new Date(detail.created_at).toLocaleString('zh-CN')} />
                <MetaRow label="heartbeat" value={detail.last_heartbeat_at
                  ? new Date(detail.last_heartbeat_at).toLocaleString('zh-CN')
                  : 'never'} />
              </div>

              {detail.description && (
                <div className="border-[3px] border-black bg-[#191619] p-4">
                  <div className="text-[11px] text-[#4a4048] uppercase mb-2">description</div>
                  <div className="text-[13px] text-[#c8bdb8] leading-5">{detail.description}</div>
                </div>
              )}

              <div className="border-[3px] border-black bg-[#191619] p-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="text-[11px] text-[#4a4048] uppercase">agent note</div>
                  <button
                    onClick={handleSaveAgentNote}
                    disabled={savingAgentNote || agentNoteDraft.trim() === (detail.note ?? '').trim()}
                    className="border-[2px] border-black px-2 py-1 text-[10px] uppercase text-[#6bc5e8] hover:bg-[#1a2535] disabled:opacity-40"
                  >
                    {savingAgentNote ? 'saving...' : 'save'}
                  </button>
                </div>
                <textarea
                  value={agentNoteDraft}
                  onChange={e => setAgentNoteDraft(e.target.value)}
                  placeholder="add a private note for this agent..."
                  className="w-full min-h-[112px] resize-y border-[3px] border-black bg-[#0e0c10] text-[#c8bdb8] px-3 py-2 text-[12px] leading-6 outline-none placeholder:text-[#4a4048]"
                />
              </div>

            </div>

            {/* Right: file-style sidebar + content */}
            <div className="flex-1 flex bg-[#0e0c10] min-w-0">
              <div className="w-[248px] shrink-0 border-r-[3px] border-black bg-[#141018] flex flex-col">
                <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] shrink-0">
                  <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest mb-0.5">workspace</div>
                  <div className="text-[16px] leading-none">files</div>
                </div>
                <div className="flex-1 overflow-auto px-2 py-3">
                  <div className="space-y-1">
                    <SidebarNavButton active={detailTab === 'memory'} onClick={() => setDetailTab('memory')}>memory</SidebarNavButton>
                    <SidebarNavButton active={detailTab === 'docs'} onClick={() => setDetailTab('docs')}>docs</SidebarNavButton>
                    <SidebarNavButton active={detailTab === 'todos'} onClick={() => setDetailTab('todos')}>todos</SidebarNavButton>
                    <SidebarNavButton active={detailTab === 'logs'} onClick={() => setDetailTab('logs')}>logs</SidebarNavButton>
                    <SidebarNavButton active={false} onClick={() => loadDetailData(detail.id, detail)} accent="refresh">refresh</SidebarNavButton>
                  </div>

                  <div className="mt-4 border-t border-[#221d24] pt-3">
                    <div className="px-2 pb-2 text-[10px] text-[#4a4048] uppercase">memory</div>
                    <div className="space-y-1">
                      <SidebarFileButton
                        active={detailTab === 'memory' && detailMemorySection === 'memory'}
                        onClick={() => { setDetailTab('memory'); setDetailMemorySection('memory') }}
                        label="memory"
                        path={detailMemory?.memory?.path ?? 'MEMORY.md'}
                      />
                      <SidebarFileButton
                        active={detailTab === 'memory' && detailMemorySection === 'knowledge'}
                        onClick={() => { setDetailTab('memory'); setDetailMemorySection('knowledge') }}
                        label="knowledge"
                        path={detailMemory?.knowledge?.path ?? 'KNOWLEDGE.md'}
                      />
                      <SidebarFileButton
                        active={detailTab === 'memory' && detailMemorySection === 'notes'}
                        onClick={() => { setDetailTab('memory'); setDetailMemorySection('notes') }}
                        label="notes"
                        path={detailMemory?.notesIndex?.path ?? 'notes/README.md'}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-w-0 flex flex-col">
                {detailTab === 'memory' && (
                  <div className="flex-1 overflow-auto p-5">
                    <div className="h-full border-[3px] border-black bg-[#141018] flex flex-col">
                      <div className="border-b-[3px] border-black px-4 py-3 bg-[#191619] flex items-center justify-between shrink-0 gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] uppercase text-[#6bc5e8]">{detailMemorySection}</div>
                          <div className="text-[11px] text-[#4a4048] mt-2 break-all">
                            {getAgentMemorySection(detailMemory, detailMemorySection)?.path ?? (detail.workspace_path ?? 'workspace unknown')}
                          </div>
                        </div>
                        <div className="text-[11px] text-[#4a4048] text-right shrink-0">
                          {getAgentMemorySection(detailMemory, detailMemorySection)?.updatedAt
                            ? new Date(getAgentMemorySection(detailMemory, detailMemorySection)!.updatedAt!).toLocaleString('zh-CN')
                            : 'not written yet'}
                        </div>
                      </div>
                      <div className="flex-1 overflow-auto">
                        {detailMemoryLoading ? (
                          <div className="text-[12px] text-[#4a4048] text-center py-8">loading memory...</div>
                        ) : getAgentMemorySection(detailMemory, detailMemorySection)?.content ? (
                          <pre className="px-4 py-4 text-[12px] leading-6 text-[#c8bdb8] whitespace-pre-wrap break-words">
                            {getAgentMemorySection(detailMemory, detailMemorySection)?.content}
                          </pre>
                        ) : (
                          <div className="text-[12px] text-[#4a4048] text-center py-8">
                            {detailMemorySection === 'memory'
                              ? 'no MEMORY.md content yet'
                              : detailMemorySection === 'knowledge'
                                ? 'no KNOWLEDGE.md content yet'
                                : 'no notes index yet'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {detailTab === 'docs' && (
                  <div className="flex-1 overflow-hidden grid" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
                    <div className="border-r-[3px] border-black bg-[#141018] overflow-auto p-4 space-y-3">
                      {detailAuthoredDocsLoading ? (
                        <div className="text-[12px] text-[#4a4048] text-center py-8">loading docs...</div>
                      ) : detailAuthoredDocs.length === 0 ? (
                        <div className="text-[12px] text-[#4a4048] text-center py-8">no authored docs found</div>
                      ) : detailAuthoredDocs.map((doc) => {
                        const active = doc.path === selectedAuthoredDocPath
                        return (
                          <button
                            key={doc.path}
                            onClick={() => setSelectedAuthoredDocPath(doc.path)}
                            className="w-full text-left border-[3px] border-black bg-[#191619] hover:bg-[#1a2535]"
                            style={{ boxShadow: active ? '4px 5px 0 rgba(0,0,0,0.9)' : '3px 4px 0 rgba(0,0,0,0.72)', background: active ? '#1a2535' : '#191619' }}
                          >
                            <div className="border-b-[3px] border-black px-3 py-2 bg-[#1e1a20]">
                              <div className="text-[10px] text-[#4a4048] uppercase">
                                {doc.type ?? 'doc'}{doc.date ? ` · ${doc.date}` : ''}
                              </div>
                              <div className="text-[13px] mt-1 leading-5">{doc.title}</div>
                            </div>
                            <div className="px-3 py-2 space-y-2">
                              <div className="text-[11px] text-[#6bc5e8] truncate">{doc.path}</div>
                              {doc.author.length > 0 && (
                                <div className="text-[11px] text-[#9a8888] truncate">author: {doc.author.join(', ')}</div>
                              )}
                              {doc.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {doc.tags.slice(0, 4).map(tag => (
                                    <span key={tag} className="border border-black bg-[#120f13] px-1.5 py-0.5 text-[10px] text-[#6bc5e8]">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>

                    <div className="overflow-auto bg-[#0e0c10]">
                      {selectedAuthoredDocPath ? (
                        <DocumentViewer
                          filePath={selectedAuthoredDocPath}
                          embedded
                          onNavigate={setSelectedAuthoredDocPath}
                        />
                      ) : (
                        <div className="h-full flex items-center justify-center text-[12px] text-[#4a4048]">
                          select an authored doc from the left
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {detailTab === 'todos' && (
                <div className="flex-1 overflow-hidden grid" style={{ gridTemplateColumns: '360px minmax(0, 1fr)' }}>
                  <div className="border-r-[3px] border-black bg-[#141018] overflow-auto p-4 space-y-3">
                    {detailTodosLoading ? (
                      <div className="text-[12px] text-[#4a4048] text-center py-8">loading todos...</div>
                    ) : detailTodos.length === 0 ? (
                      <div className="text-[12px] text-[#4a4048] text-center py-8">no assigned todos</div>
                    ) : detailTodos.map((todo) => {
                      const hasActiveDoc = todo.docs.some(doc => doc.doc_path === todoPreviewPath)
                      return (
                        <div
                          key={todo.id}
                          className="border-[3px] border-black bg-[#191619]"
                          style={{ boxShadow: hasActiveDoc ? '4px 5px 0 rgba(0,0,0,0.9)' : '3px 4px 0 rgba(0,0,0,0.72)' }}
                        >
                          <div className="border-b-[3px] border-black px-3 py-2 bg-[#1e1a20]">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] text-[#4a4048] uppercase">#{todo.number} · #{todo.channel_name}</div>
                              <TodoStatusPill status={todo.status} />
                            </div>
                            <div className="text-[13px] mt-1 leading-5">{todo.title}</div>
                          </div>
                          <div className="px-3 py-2 text-[11px] text-[#6a6068] border-b-[3px] border-black">
                            {todo.docs.length} linked doc{todo.docs.length === 1 ? '' : 's'}
                          </div>
                          <div className="px-3 py-2 space-y-2">
                            {todo.docs.length === 0 ? (
                              <div className="text-[11px] text-[#4a4048]">no linked todo docs</div>
                            ) : todo.docs.map((doc) => {
                              const active = doc.doc_path === todoPreviewPath
                              return (
                                <button
                                  key={doc.id}
                                  onClick={() => loadTodoPreview(doc.doc_path)}
                                  className="w-full text-left border-[2px] border-black px-2 py-2 hover:bg-[#243548]"
                                  style={{ background: active ? '#1a2535' : '#120f13' }}
                                >
                                  <div className="flex items-center gap-2">
                                    <TodoDocDot status={doc.status} />
                                    <span className="text-[11px] text-[#e7dfd3] truncate">{doc.doc_name}</span>
                                  </div>
                                  <div className="text-[10px] text-[#4a4048] mt-1 truncate">{doc.doc_path}</div>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="overflow-auto p-5">
                    <div className="h-full border-[3px] border-black bg-[#141018] flex flex-col">
                      <div className="border-b-[3px] border-black px-4 py-3 bg-[#191619] shrink-0">
                        <div className="text-[13px] uppercase text-[#6bc5e8]">todo preview</div>
                        <div className="text-[11px] text-[#4a4048]">{todoPreviewPath ?? 'select a linked todo doc'}</div>
                      </div>
                      <div className="flex-1 overflow-auto">
                        {todoPreviewLoading ? (
                          <div className="text-[12px] text-[#4a4048] text-center py-8">loading doc...</div>
                        ) : todoPreviewError ? (
                          <div className="text-[12px] text-[#c0392b] text-center py-8">{todoPreviewError}</div>
                        ) : todoPreviewContent ? (
                          <pre className="px-4 py-4 text-[12px] leading-6 text-[#c8bdb8] whitespace-pre-wrap break-words">{todoPreviewContent}</pre>
                        ) : (
                          <div className="text-[12px] text-[#4a4048] text-center py-8">pick a todo note from the left</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {detailTab === 'logs' && (
                  <div className="flex-1 overflow-auto font-mono">
                    {detailLogs.length === 0 ? (
                      <div className="text-[12px] text-[#4a4048] text-center py-8">no logs yet — start the agent to see activity</div>
                    ) : detailLogs.map((log, i) => {
                      const time = new Date(log.created_at).toLocaleTimeString('zh-CN', { hour12: false })
                      const lvlColor = log.level === 'ERROR' ? '#ff4444' : log.level === 'WARN' ? '#d4a017' : '#9a8888'
                      return (
                        <div key={log.id ?? i} className="border-b border-[#1a1620] flex gap-0 text-[12px]"
                          style={{ background: i % 2 === 0 ? '#0e0c10' : '#100e13' }}>
                          <div className="px-3 py-1 text-[#4a4048] w-[72px] shrink-0 border-r border-[#1a1620]">{time}</div>
                          <div className="px-2 py-1 w-[60px] shrink-0 border-r border-[#1a1620]" style={{ color: lvlColor }}>{log.level}</div>
                          <div className="px-3 py-1 text-[#c8bdb8] flex-1 break-words whitespace-pre-wrap">{log.content}</div>
                        </div>
                      )
                    })}
                    <div ref={detailLogsBottomRef} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hierarchy tree */}
      {agents.length > 0 && (
        <div
          className="mb-5 border-[3px] border-black bg-[#141018]"
          style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.9)' }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20] flex items-center gap-3">
            <span className="text-[11px] text-[#4a4048] uppercase tracking-wider">汇报树</span>
            <span className="text-[11px] text-[#3a3535]">reporting hierarchy</span>
          </div>
          <div className="px-3 py-2">
            <AgentTree agents={agents} depth={0} parentId={null}
              onToggle={toggleAgent} onLogs={openLogs} busy={busy} />
          </div>
        </div>
      )}

      {/* Agent cards */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))' }}>
        {agents.map((agent, i) => {
          const sc = statusColor(agent.status)
          const lastSeen = agent.last_heartbeat_at
            ? new Date(agent.last_heartbeat_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : 'never'

          return (
            <div
              key={agent.id}
              className="border-[3px] border-black bg-[#191619] cursor-pointer hover:border-[#4a4048] transition-colors"
              onClick={() => openDetail(agent)}
              style={{
                transform: `rotate(${i % 2 === 0 ? '-0.2deg' : '0.2deg'})`,
                boxShadow:
                  '4px 5px 0 rgba(0,0,0,0.9), ' +
                  '0 8px 24px rgba(50,120,220,0.14), ' +
                  '0 4px 12px rgba(30,180,120,0.08)',
              }}
            >
              {/* Card header */}
              <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 border-[3px] border-black flex items-center justify-center text-[16px]
                      ${agent.status === 'running' || agent.status === 'online' ? 'agent-running-blink' : ''}`}
                    style={{
                      background: '#3a1520',
                      color: '#c0392b',
                      boxShadow: agent.status === 'running' || agent.status === 'online'
                        ? '0 0 8px rgba(58, 191, 160, 0.5)' : 'none',
                    }}
                  >
                    {agent.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[16px]">{agent.name}</div>
                    <div className="text-[11px] text-[#6bc5e8] uppercase">
                      {(agent.role ?? 'general')} · {agent.runtime}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(agent.status === 'running' || agent.status === 'online') && (
                    <button
                      onClick={e => { e.stopPropagation(); toggleAgent(agent) }}
                      disabled={busy === agent.id}
                      className="border-[2px] border-black bg-[#3a1520] px-2 py-1 text-[10px] text-[#c0392b]
                                 uppercase hover:bg-[#5a1520] hover:text-[#ff4050] disabled:opacity-40 transition-colors"
                      title="stop agent"
                    >
                      ■ stop
                    </button>
                  )}
                  <span
                    className="w-3 h-3 border border-black"
                    style={{
                      background: sc.dot,
                      animation: sc.pulse ? 'pulse 1.2s ease-in-out infinite' : 'none',
                    }}
                  />
                  <span className="text-[12px] uppercase" style={{ color: sc.text }}>{sc.label}</span>
                </div>
              </div>

              {/* System prompt preview */}
              <div className="px-4 py-2 text-[13px] text-[#9a8888] border-b-[3px] border-black bg-[#120f13] truncate">
                {agent.system_prompt?.slice(0, 80) ?? 'no system prompt'}
              </div>

              {/* Meta */}
              <div className="px-4 py-3 space-y-2">
                <MetaRow label="model"     value={agent.model_id} />
                <MetaRow label="project"   value={agent.current_project_name ?? '—'} />
                <MetaRow label="workspace" value={agent.workspace_path ?? '—'} small />
                <MetaRow label="last seen" value={lastSeen} />

                <div className="border-[2px] border-black bg-[#120f13] px-3 py-2">
                  <div className="text-[10px] text-[#4a4048] uppercase mb-1">note</div>
                  <div className="text-[12px] text-[#c8bdb8] leading-5 whitespace-pre-wrap break-words max-h-[4.5rem] overflow-hidden">
                    {agent.note?.trim() || 'no note yet'}
                  </div>
                </div>

              </div>

              {/* Streaming indicator */}
              {streamingAgents[agent.id] !== undefined && (
                <div className="border-t-[3px] border-black px-3 py-2 bg-[#161d24]" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 bg-[#3abfa0] animate-pulse" />
                    <span className="text-[10px] text-[#6bc5e8] uppercase tracking-wider">responding</span>
                    <span className="text-[10px] text-[#4a4048] ml-auto">
                      {streamingAgents[agent.id].length > 0 ? `${streamingAgents[agent.id].length} lines` : ''}
                    </span>
                  </div>
                  {streamingAgents[agent.id].length > 0 && (
                    <pre className="text-[11px] text-[#8d8a85] whitespace-pre-wrap break-words max-h-[60px] overflow-hidden leading-4">
                      {streamingAgents[agent.id].slice(-3).join('\n')}
                    </pre>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="border-t-[3px] border-black grid grid-cols-4" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => toggleAgent(agent)}
                  disabled={busy === agent.id}
                  className="border-r-[3px] border-black py-2 text-[11px] uppercase hover:bg-[#2a2535] hover:text-[#c0392b] disabled:opacity-40 transition-colors"
                  style={{ color: agent.status === 'running' ? '#c0392b' : '#3abfa0' }}
                >
                  {busy === agent.id ? '...' : agent.status === 'running' ? 'stop' : 'start'}
                </button>
                <button
                  onClick={() => openLogs(agent)}
                  className="border-r-[3px] border-black py-2 text-[11px] text-[#9a8888] uppercase hover:bg-[#2a2535] hover:text-[#6bc5e8] transition-colors"
                >
                  logs
                </button>
                <button
                  onClick={() => setDeleteConfirm(agent)}
                  className="py-2 text-[11px] text-[#6a3535] uppercase hover:bg-[#3a1520] hover:text-[#c0392b] transition-colors"
                >
                  delete
                </button>
              </div>
            </div>
          )
        })}

        {agents.length === 0 && (
          <div className="text-[14px] text-[#4a4048] col-span-full pt-8 text-center">
            no agents — create one to get started
          </div>
        )}
      </div>
    </div>
  )
}

function MetaRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="text-[11px] text-[#4a4048] uppercase w-[80px] shrink-0">{label}</span>
      <span className={`${small ? 'text-[11px]' : 'text-[13px]'} text-[#c8bdb8] truncate`}>{value}</span>
    </div>
  )
}

function TodoStatusPill({ status }: { status: AgentTodo['status'] }) {
  const states: Record<AgentTodo['status'], { bg: string; text: string; label: string }> = {
    open:        { bg: '#2a2622', text: '#9a8888', label: 'unassigned' },
    claimed:     { bg: '#2a1a35', text: '#b08cd9', label: 'assigned' },
    in_progress: { bg: '#1a2535', text: '#6bc5e8', label: 'in progress' },
    reviewing:   { bg: '#352515', text: '#f0b35e', label: 'in review' },
    completed:   { bg: '#1e2e26', text: '#7ecfa8', label: 'done' },
  }
  const palette = states[status]
  return (
    <span
      className="border-[2px] border-black px-2 py-0.5 text-[10px] uppercase"
      style={{ background: palette.bg, color: palette.text }}
    >
      {palette.label}
    </span>
  )
}

function TodoDocDot({ status }: { status: AgentTodoDoc['status'] }) {
  if (status === 'writing') {
    return (
      <span
        className="w-2 h-2 border border-black shrink-0"
        style={{ background: '#D4A017', animation: 'pulse 1.2s ease-in-out infinite' }}
      />
    )
  }
  if (status === 'unread') {
    return <span className="w-2 h-2 border border-black bg-[#4A90D9] shrink-0" />
  }
  return <span className="w-2 h-2 border border-black bg-[#2a2622] shrink-0" />
}

function getAgentMemorySection(memory: AgentMemory | null, section: MemorySectionKey) {
  if (!memory) return null
  if (section === 'knowledge') return memory.knowledge ?? null
  if (section === 'notes') return memory.notesIndex ?? null
  return memory.memory ?? { path: memory.path, content: memory.content, updatedAt: memory.updatedAt }
}

// ── Agent hierarchy tree ──────────────────────────────────────────────────────

interface AgentTreeProps {
  agents: Agent[]
  depth: number
  parentId: string | null
  onToggle: (a: Agent) => void
  onLogs: (a: Agent) => void
  busy: string | null
}

function AgentTree({ agents, depth, parentId, onToggle, onLogs, busy }: AgentTreeProps) {
  const children = agents.filter(a => (a.parent_agent_id ?? null) === parentId)
  if (children.length === 0) return null

  return (
    <div>
      {children.map(agent => {
        const sc = statusColor(agent.status)
        const hasChildren = agents.some(a => a.parent_agent_id === agent.id)
        return (
          <div key={agent.id}>
            <div
              className="flex items-center gap-2 py-1 border-b border-[#1a1620] hover:bg-[#1e1a20] group"
              style={{ paddingLeft: depth * 20 + 8 }}
            >
              {/* Tree connector */}
              {depth > 0 && (
                <span className="text-[10px] text-[#2a2228] shrink-0">└</span>
              )}
              {/* Status dot */}
              <span
                className="w-2 h-2 shrink-0 border border-black"
                style={{
                  background: sc.dot,
                  animation: sc.pulse ? 'pulse 1.2s ease-in-out infinite' : 'none',
                }}
              />
              {/* Name + role */}
              <span className="text-[13px] flex-1 min-w-0">
                {agent.name}
                {agent.role && (
                  <span className="ml-2 text-[10px] text-[#4a4048] uppercase">{agent.role}</span>
                )}
                {hasChildren && (
                  <span className="ml-2 text-[10px] text-[#3a3535]">
                    [{agents.filter(a => a.parent_agent_id === agent.id).length} sub]
                  </span>
                )}
              </span>
              {/* Status label */}
              <span className="text-[10px] uppercase shrink-0" style={{ color: sc.text }}>
                {sc.label}
              </span>
              {/* Quick actions (visible on hover) */}
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={() => onToggle(agent)}
                  disabled={busy === agent.id}
                  className="text-[10px] px-2 py-0.5 border border-[#2a2228] hover:border-[#c0392b] hover:text-[#c0392b] uppercase transition-colors disabled:opacity-40"
                  style={{ color: agent.status === 'running' ? '#c0392b' : '#3abfa0' }}
                >
                  {busy === agent.id ? '...' : agent.status === 'running' ? 'stop' : 'start'}
                </button>
                <button
                  onClick={() => onLogs(agent)}
                  className="text-[10px] px-2 py-0.5 border border-[#2a2228] hover:border-[#6bc5e8] hover:text-[#6bc5e8] text-[#4a4048] uppercase transition-colors"
                >
                  logs
                </button>
              </div>
            </div>
            {/* Recurse into children */}
            <AgentTree
              agents={agents}
              depth={depth + 1}
              parentId={agent.id}
              onToggle={onToggle}
              onLogs={onLogs}
              busy={busy}
            />
          </div>
        )
      })}
    </div>
  )
}
