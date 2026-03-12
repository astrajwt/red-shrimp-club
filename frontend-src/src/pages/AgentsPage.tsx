// Red Shrimp Lab — Agents Management Page (connected to backend)

import { useEffect, useRef, useState } from 'react'
import { agentsApi, type Agent, type AgentLog, type ModelRegistry } from '../lib/api'
import { socketClient } from '../lib/socket'

type AgentStatus = Agent['status']

const statusColor = (s: AgentStatus) => {
  if (s === 'running' || s === 'online') return { dot: '#3abfa0', text: '#3abfa0', label: 'running', pulse: true }
  if (s === 'idle')    return { dot: '#6bc5e8', text: '#6bc5e8', label: 'idle',    pulse: false }
  if (s === 'offline') return { dot: '#c0392b', text: '#c0392b', label: 'offline', pulse: false }
  return                      { dot: '#e04050', text: '#e04050', label: 'error',   pulse: true  }
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [models, setModels] = useState<ModelRegistry | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [logsAgent, setLogsAgent] = useState<Agent | null>(null)
  const [logsData, setLogsData] = useState<AgentLog[]>([])
  const logsBottomRef = useRef<HTMLDivElement>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', modelId: 'claude-sonnet-4-6', workspacePath: '', description: '', role: 'general', runtime: 'claude' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [detail, setDetail] = useState<Agent | null>(null)
  const [detailLogs, setDetailLogs] = useState<AgentLog[]>([])
  const detailLogsBottomRef = useRef<HTMLDivElement>(null)

  const reload = () => agentsApi.list().then(a => setAgents(a)).catch(() => {})

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

  const handleCreate = async () => {
    if (!createForm.name.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      await agentsApi.create({
        name: createForm.name.trim(),
        modelId: createForm.modelId,
        role: createForm.role,
        runtime: createForm.runtime,
        workspacePath: createForm.workspacePath.trim() || undefined,
        description: createForm.description.trim() || undefined,
      })
      setShowCreate(false)
      setCreateForm({ name: '', modelId: 'claude-sonnet-4-6', workspacePath: '', description: '', role: 'general', runtime: 'claude' })
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
    setDetail(agent)
    setDetailLogs([])
    try {
      const { logs } = await agentsApi.logs(agent.id, 200)
      setDetailLogs(logs)
      setTimeout(() => detailLogsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch { /* ignore */ }
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
      if (agent.status === 'running') {
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

  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-5"
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
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">shrimps</div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#e04050]"
          style={{ transform: 'rotate(0.2deg)' }}
        >
          + new shrimp
        </button>
      </div>

      {/* Create agent modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="w-[480px] border-[3px] border-black bg-[#141018]"
            style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}
          >
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20] flex items-center justify-between">
              <div className="text-[13px] uppercase text-[#c0392b]">new shrimp</div>
              <button onClick={() => setShowCreate(false)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">name *</div>
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
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">model</div>
                <select
                  value={createForm.modelId}
                  onChange={e => setCreateForm(f => ({ ...f, modelId: e.target.value }))}
                  className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
                >
                  {models ? (
                    <>
                      {models.anthropic.map(m => <option key={m.id} value={m.id}>Anthropic — {m.label}</option>)}
                      {models.moonshot.map(m => <option key={m.id} value={m.id}>Moonshot — {m.label}</option>)}
                      {models.openai.map(m => <option key={m.id} value={m.id}>OpenAI — {m.label}</option>)}
                    </>
                  ) : (
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  )}
                </select>
              </div>
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">workspace path <span className="text-[#3a3535]">(auto-generated if empty)</span></div>
                <input
                  value={createForm.workspacePath}
                  onChange={e => setCreateForm(f => ({ ...f, workspacePath: e.target.value }))}
                  placeholder={`~/JwtVault/agents/${createForm.name.trim().toLowerCase().replace(/\s+/g, '-') || '<name>'}`}
                  className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#3a3535]"
                />
                {!createForm.workspacePath && (
                  <div className="text-[11px] text-[#3abfa0] mt-1">
                    ✓ MEMORY.md · CLAUDE.md · HEARTBEAT.md will be created automatically
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
                          const defaultModel = rt === 'codex' ? 'o4-mini' : rt === 'kimi' ? 'kimi-k2-5' : 'claude-sonnet-4-6'
                          setCreateForm(f => ({ ...f, runtime: rt, modelId: defaultModel }))
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
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">role</div>
                <select
                  value={createForm.role}
                  onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}
                  className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none"
                >
                  <option value="general">general — 通用助手</option>
                  <option value="developer">developer — 开发工程师</option>
                  <option value="tester">tester — 测试工程师</option>
                  <option value="pm">pm — 产品经理</option>
                  <option value="ops">ops — 运维工程师</option>
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
              <div className="mx-5 mb-3 px-3 py-2 border-[2px] border-[#c0392b] text-[#c0392b] text-[11px]">
                ✗ {createError}
              </div>
            )}
            <div className="border-t-[3px] border-black grid grid-cols-2">
              <button
                onClick={() => { setShowCreate(false); setCreateError(null) }}
                className="border-r-[3px] border-black py-3 text-[12px] uppercase text-[#4a4048] hover:bg-[#1e1a20] hover:text-[#e7dfd3]"
              >
                cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !createForm.name.trim()}
                className="py-3 text-[12px] uppercase bg-[#c0392b] text-black hover:bg-[#e04050] disabled:opacity-40"
              >
                {creating ? '...' : 'spawn'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logs modal */}
      {logsAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="w-[700px] max-h-[80vh] flex flex-col border-[3px] border-black bg-[#141018]"
            style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}
          >
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20] flex items-center justify-between shrink-0">
              <div>
                <div className="text-[13px] uppercase text-[#6bc5e8]">{logsAgent.name}</div>
                <div className="text-[11px] text-[#4a4048]">{logsData.length} log entries</div>
              </div>
              <button onClick={() => setLogsAgent(null)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
            </div>
            <div className="overflow-auto flex-1 font-mono">
              {logsData.length === 0 ? (
                <div className="text-[12px] text-[#4a4048] text-center py-8">no logs yet</div>
              ) : logsData.map((log, i) => {
                const time = new Date(log.created_at).toLocaleTimeString('zh-CN', { hour12: false })
                const lvlColor = log.level === 'ERROR' ? '#ff4444' : log.level === 'WARN' ? '#d4a017' : '#9a8888'
                return (
                  <div key={log.id} className="border-b border-[#1a1620] flex gap-0 text-[12px]"
                    style={{ background: i % 2 === 0 ? '#141018' : '#100e13' }}>
                    <div className="px-3 py-1 text-[#4a4048] w-[72px] shrink-0 border-r border-[#1a1620]">{time}</div>
                    <div className="px-2 py-1 w-[60px] shrink-0 border-r border-[#1a1620]" style={{ color: lvlColor }}>{log.level}</div>
                    <div className="px-3 py-1 text-[#c8bdb8] flex-1 break-words">{log.content}</div>
                  </div>
                )
              })}
              <div ref={logsBottomRef} />
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="w-[360px] border-[3px] border-black bg-[#141018]"
            style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}
          >
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#3a1520]">
              <div className="text-[13px] uppercase text-[#c0392b]">confirm delete</div>
            </div>
            <div className="px-5 py-5">
              <div className="text-[14px] text-[#e7dfd3] mb-2">
                确定要让 <span className="text-[#c0392b]">{deleteConfirm.name}</span> 离开俱乐部吗？
              </div>
              <div className="text-[11px] text-[#4a4048]">此操作不可恢复。日志和运行记录将一并删除。</div>
            </div>
            <div className="border-t-[3px] border-black grid grid-cols-2">
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
          </div>
        </div>
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
              className="w-12 h-12 border-[3px] border-black flex items-center justify-center text-[20px]"
              style={{ background: '#3a1520', color: '#c0392b' }}
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
                onClick={() => handleResetContext(detail)}
                disabled={busy === detail.id}
                className="border-[2px] border-black px-4 py-1.5 text-[12px] text-[#d4a017] uppercase hover:bg-[#2a2520] hover:text-[#f0c040] disabled:opacity-40"
                title="清空 context，摘要写入 MEMORY.md"
              >
                {busy === detail.id ? '...' : 'reset ctx'}
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
                <MetaRow label="model"     value={detail.model_id} />
                <MetaRow label="provider"  value={detail.model_provider ?? 'anthropic'} />
                <MetaRow label="runtime"   value={detail.runtime} />
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

              {/* Token usage */}
              <div className="border-[3px] border-black bg-[#191619] p-4">
                <div className="text-[11px] text-[#4a4048] uppercase mb-2">context usage</div>
                {(() => {
                  const used = detail.tokens_used_today ?? 0
                  const limit = 200000
                  const pct = Math.min(100, Math.round((used / limit) * 100))
                  return (
                    <>
                      <div className="flex justify-between text-[12px] mb-1">
                        <span className="text-[#9a8888]">{used.toLocaleString()} / {limit.toLocaleString()}</span>
                        <span style={{ color: pct > 80 ? '#c0392b' : '#6bc5e8' }}>{pct}%</span>
                      </div>
                      <div className="border-[2px] border-black bg-[#120f13] h-4">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${pct}%`,
                            background: pct > 80 ? '#c0392b' : pct > 50 ? '#6bc5e8' : '#3abfa0',
                          }}
                        />
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>

            {/* Right: live logs */}
            <div className="flex-1 flex flex-col bg-[#0e0c10]">
              <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20] flex items-center justify-between shrink-0">
                <div className="text-[13px] uppercase text-[#6bc5e8]">live logs</div>
                <div className="text-[11px] text-[#4a4048]">{detailLogs.length} entries</div>
              </div>
              <div className="flex-1 overflow-auto font-mono">
                {detailLogs.length === 0 ? (
                  <div className="text-[12px] text-[#4a4048] text-center py-8">no logs yet — start the shrimp to see activity</div>
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
          // Use today's token usage from the agent row — tokens_used_today
          const used  = agent.tokens_used_today ?? 0
          const limit = 200000
          const pct   = Math.min(100, Math.round((used / limit) * 100))
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
                    className="w-10 h-10 border-[3px] border-black flex items-center justify-center text-[16px]"
                    style={{ background: '#3a1520', color: '#c0392b' }}
                  >
                    {agent.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[16px]">{agent.name}</div>
                    <div className="text-[11px] text-[#6bc5e8] uppercase">{agent.runtime}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
                <MetaRow label="workspace" value={agent.workspace_path ?? '—'} small />
                <MetaRow label="last seen" value={lastSeen} />

                {/* Token meter */}
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#4a4048] uppercase">context usage</span>
                    <span style={{ color: pct > 80 ? '#c0392b' : '#6bc5e8' }}>{pct}%</span>
                  </div>
                  <div className="border-[2px] border-black bg-[#120f13] h-3">
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: pct > 80 ? '#c0392b' : pct > 50 ? '#6bc5e8' : '#3abfa0',
                        boxShadow: pct > 80 ? '0 0 6px rgba(192,57,43,0.5)' : 'none',
                      }}
                    />
                  </div>
                </div>
              </div>

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
                  onClick={() => handleResetContext(agent)}
                  disabled={busy === agent.id}
                  className="border-r-[3px] border-black py-2 text-[11px] text-[#d4a017] uppercase hover:bg-[#2a2520] hover:text-[#f0c040] disabled:opacity-40 transition-colors"
                  title="清空 context，摘要写入 MEMORY.md"
                >
                  {busy === agent.id ? '...' : 'reset'}
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
            no shrimps — create one to get started
          </div>
        )}
      </div>

      {/* Model registry */}
      <div
        className="mt-5 border-[3px] border-black bg-[#141118]"
        style={{
          boxShadow: '4px 5px 0 rgba(0,0,0,0.9), 0 0 16px rgba(50,120,220,0.10)',
          transform: 'rotate(-0.1deg)',
        }}
      >
        <div className="border-b-[3px] border-black bg-[#1e1a20] px-5 py-3">
          <div className="text-[11px] text-[#3abfa0] uppercase tracking-widest">model registry</div>
          <div className="text-[18px] mt-1">available providers</div>
        </div>
        <div className="grid grid-cols-3 divide-x-[3px] divide-black">
          {models ? (
            [
              { key: 'anthropic', name: 'Anthropic Claude', color: '#c0392b', items: models.anthropic },
              { key: 'moonshot',  name: 'Moonshot Kimi',    color: '#6bc5e8', items: models.moonshot  },
              { key: 'openai',    name: 'OpenAI',           color: '#3abfa0', items: models.openai    },
            ].map(p => (
              <div key={p.key} className="px-5 py-4">
                <div className="text-[13px] mb-2" style={{ color: p.color }}>{p.name}</div>
                {p.items.map(m => (
                  <div key={m.id} className="text-[12px] text-[#6a5858] leading-6 pl-2 border-l-[2px] border-[#2a2228]">
                    {m.label}
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div className="col-span-3 px-5 py-4 text-[12px] text-[#4a4048]">loading models...</div>
          )}
        </div>
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
