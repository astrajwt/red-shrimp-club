// Red Shrimp Lab — Machines Page (connect nodes, manage agents per machine)

import { useEffect, useState } from 'react'
import { machinesApi, agentsApi, type Machine, type Agent, type ModelRegistry } from '../lib/api'

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([])
  const [machineAgents, setMachineAgents] = useState<Record<string, Agent[]>>({})
  const [connectResult, setConnectResult] = useState<{ connect_command: string; api_key: string } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [createAgentMachineId, setCreateAgentMachineId] = useState<string | null>(null)
  const [createAgentName, setCreateAgentName] = useState('')
  const [createAgentRuntime, setCreateAgentRuntime] = useState<string>('claude')
  const [createAgentModel, setCreateAgentModel] = useState<string>('claude-sonnet-4-6')
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [models, setModels] = useState<ModelRegistry | null>(null)

  const reload = async () => {
    try {
      const list = await machinesApi.list()
      setMachines(list)
      // Load agents per machine
      const agentMap: Record<string, Agent[]> = {}
      await Promise.all(list.map(async (m) => {
        try { agentMap[m.id] = await machinesApi.agents(m.id) } catch { agentMap[m.id] = [] }
      }))
      setMachineAgents(agentMap)
    } catch {
      // Backend may not have machines table yet — show empty state
      setMachines([])
    }
  }

  useEffect(() => {
    reload()
    agentsApi.models().then(setModels).catch(() => {})
  }, [])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      const result = await machinesApi.create()
      setConnectResult({ connect_command: result.connect_command, api_key: result.api_key })
      await reload()
    } catch (err: any) {
      console.error('Failed to create machine:', err.message)
    } finally {
      setConnecting(false)
    }
  }

  const handleRename = async (id: string) => {
    if (!renameValue.trim()) return
    try {
      await machinesApi.rename(id, renameValue.trim())
      setRenamingId(null)
      await reload()
    } catch (err: any) {
      console.error('Rename failed:', err.message)
    }
  }

  const handleCreateAgent = async () => {
    if (!createAgentMachineId || !createAgentName.trim()) return
    setCreatingAgent(true)
    try {
      await agentsApi.create({
        name: createAgentName.trim(),
        modelId: createAgentModel,
        runtime: createAgentRuntime,
        machineId: createAgentMachineId,
      })
      setCreateAgentMachineId(null)
      setCreateAgentName('')
      setCreateAgentRuntime('claude')
      setCreateAgentModel('claude-sonnet-4-6')
      await reload()
    } catch (err: any) {
      console.error('Create agent failed:', err.message)
    } finally {
      setCreatingAgent(false)
    }
  }

  const [reconnectResult, setReconnectResult] = useState<{ machineId: string; api_key: string; connect_command: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const handleReconnect = async (id: string) => {
    try {
      const result = await machinesApi.reconnect(id)
      setReconnectResult({ machineId: id, ...result })
      await reload()
    } catch (err: any) {
      console.error('Reconnect failed:', err.message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await machinesApi.delete(id)
      setDeleteConfirm(null)
      await reload()
    } catch (err: any) {
      console.error('Failed to delete machine:', err.message)
    }
  }

  return (
    <div
      className="h-full bg-[#0e0c10] text-[#e7dfd3] overflow-auto p-5"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">infrastructure</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">machines</div>
        </div>
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#e04050] disabled:opacity-50"
          style={{ transform: 'rotate(0.2deg)' }}
        >
          {connecting ? '...' : '+ connect machine'}
        </button>
      </div>

      {/* Connect command result */}
      {connectResult && (
        <div
          className="mb-5 border-[3px] border-black bg-[#141018]"
          style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 16px rgba(50,120,220,0.10)' }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#0f1a18] flex items-center justify-between">
            <div className="text-[13px] uppercase text-[#3abfa0]">run this on your machine</div>
            <button onClick={() => setConnectResult(null)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
          </div>
          <div className="px-4 py-3">
            <div
              className="border-[3px] border-black bg-[#0e0c10] text-[#3abfa0] px-4 py-3 text-[12px] font-mono cursor-pointer hover:bg-[#161218] break-all"
              onClick={() => navigator.clipboard.writeText(connectResult.connect_command)}
              title="Click to copy"
            >
              {connectResult.connect_command}
            </div>
            <div className="text-[11px] text-[#c0392b] mt-2">Save this API key — it will only be shown once.</div>
            <div className="text-[11px] text-[#4a4048] mt-1">The machine name will be set automatically when the daemon connects.</div>
          </div>
        </div>
      )}

      {/* Machine cards */}
      {machines.map((machine, i) => {
        const agents = machineAgents[machine.id] ?? []
        const isOnline = machine.status === 'online'

        return (
          <div
            key={machine.id}
            className="mb-5 border-[3px] border-black bg-[#191619]"
            style={{
              transform: `rotate(${i % 2 === 0 ? '-0.15deg' : '0.15deg'})`,
              boxShadow:
                '4px 5px 0 rgba(0,0,0,0.9), ' +
                '0 8px 24px rgba(50,120,220,0.14), ' +
                '0 4px 12px rgba(30,180,120,0.08)',
            }}
          >
            {/* Machine header */}
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 border-[3px] border-black flex items-center justify-center text-[14px]"
                  style={{ background: isOnline ? '#0f1a18' : '#1e1a20', color: isOnline ? '#3abfa0' : '#4a4048' }}
                >
                  ⬡
                </div>
                <div>
                  {renamingId === machine.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRename(machine.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="border-[2px] border-[#3abfa0] bg-[#0e0c10] text-[#e7dfd3] px-2 py-0.5 text-[14px] outline-none w-36"
                      />
                      <button onClick={() => handleRename(machine.id)} className="text-[#3abfa0] text-[11px] hover:text-[#4ed0b0]">ok</button>
                      <button onClick={() => setRenamingId(null)} className="text-[#4a4048] text-[11px]">✕</button>
                    </div>
                  ) : (
                    <div
                      className="text-[16px] cursor-pointer hover:text-[#3abfa0] group flex items-center gap-1"
                      onClick={() => { setRenamingId(machine.id); setRenameValue(machine.name) }}
                      title="Click to rename"
                    >
                      {machine.hostname ?? machine.name}
                      <span className="text-[10px] text-[#4a4048] opacity-0 group-hover:opacity-100">✎</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 border border-black"
                      style={{
                        background: isOnline ? '#3abfa0' : '#4a4048',
                        animation: isOnline ? 'pulse 1.2s ease-in-out infinite' : 'none',
                      }}
                    />
                    <span className="text-[11px] uppercase" style={{ color: isOnline ? '#3abfa0' : '#4a4048' }}>
                      {machine.status}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleReconnect(machine.id)}
                  className="border-[3px] border-black bg-[#3abfa0] text-black px-4 py-1 text-[12px] uppercase hover:bg-[#4ed0b0]"
                >
                  reconnect
                </button>
                <button
                  onClick={() => setDeleteConfirm(machine.id)}
                  className="border-[3px] border-black bg-[#1e1a20] text-[#4a4048] px-3 py-1 text-[12px] uppercase hover:bg-[#2a2228] hover:text-[#c0392b]"
                >
                  remove
                </button>
              </div>
            </div>

            {/* Machine meta */}
            <div className="px-5 py-3 grid grid-cols-4 gap-4 border-b-[3px] border-black bg-[#120f13]">
              <MetaItem label="hostname" value={machine.hostname ?? '—'} />
              <MetaItem label="os" value={machine.os ?? '—'} />
              <MetaItem label="version" value={machine.daemon_version ?? '—'} />
              <MetaItem label="shrimp" value={String(machine.agent_count)} />
            </div>

            {/* Agents on this machine */}
            <div className="px-5 py-3">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[11px] text-[#4a4048] uppercase">
                  shrimps on this machine ({agents.length})
                </div>
                <button
                  onClick={() => { setCreateAgentMachineId(machine.id); setCreateAgentName('') }}
                  className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-3 py-1 uppercase hover:bg-[#243548]"
                >
                  + new shrimp
                </button>
              </div>

              {agents.length === 0 ? (
                <div className="text-[12px] text-[#4a4048] text-center py-4 border-[2px] border-dashed border-[#2a2228]">
                  no shrimps on machine
                </div>
              ) : (
                <div className="space-y-2">
                  {agents.map(agent => {
                    const isRunning = agent.status === 'running'
                    return (
                      <div key={agent.id} className="flex items-center gap-3 border-[2px] border-black bg-[#1e1a20] px-3 py-2">
                        <span
                          className="w-3 h-3 border border-black shrink-0"
                          style={{
                            background: isRunning ? '#3abfa0' : '#3a3535',
                            animation: isRunning ? 'pulse 1.2s ease-in-out infinite' : 'none',
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-[13px]">{agent.name}</span>
                          <span className="text-[11px] text-[#6bc5e8] ml-2">{agent.model_id}</span>
                        </div>
                        <span className="text-[10px] uppercase px-1.5 py-0.5 border border-black" style={{
                          background: agent.runtime === 'codex' ? '#1a2010' : agent.runtime === 'kimi' ? '#1a1535' : '#0f1a18',
                          color:      agent.runtime === 'codex' ? '#7ecf50' : agent.runtime === 'kimi' ? '#a07ef0' : '#3abfa0',
                        }}>
                          {agent.runtime ?? 'claude'}
                        </span>
                        <span className="text-[11px] uppercase" style={{ color: isRunning ? '#3abfa0' : '#4a4048' }}>
                          {agent.status}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Create agent on machine modal */}
      {createAgentMachineId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="w-[400px] border-[3px] border-black bg-[#141018]"
            style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}
          >
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20] flex items-center justify-between">
              <div className="text-[13px] uppercase text-[#6bc5e8]">new shrimp on machine</div>
              <button onClick={() => setCreateAgentMachineId(null)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">shrimp name *</div>
                <input
                  autoFocus
                  value={createAgentName}
                  onChange={e => setCreateAgentName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateAgent()}
                  placeholder="e.g. my-agent"
                  className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#4a4048]"
                />
              </div>
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">runtime</div>
                <div className="grid grid-cols-3 gap-2">
                  {(['claude', 'codex', 'kimi'] as const).map(rt => (
                    <button
                      key={rt}
                      onClick={() => {
                        setCreateAgentRuntime(rt)
                        if (rt === 'codex') setCreateAgentModel('o4-mini')
                        else if (rt === 'kimi') setCreateAgentModel('kimi-k2-5')
                        else setCreateAgentModel('claude-sonnet-4-6')
                      }}
                      className="border-[3px] border-black py-2 text-[12px] uppercase transition-colors"
                      style={{
                        background: createAgentRuntime === rt
                          ? (rt === 'codex' ? '#1a2010' : rt === 'kimi' ? '#1a1535' : '#0f1a18')
                          : '#1e1a20',
                        color: createAgentRuntime === rt
                          ? (rt === 'codex' ? '#7ecf50' : rt === 'kimi' ? '#a07ef0' : '#3abfa0')
                          : '#4a4048',
                        borderColor: createAgentRuntime === rt ? 'black' : 'black',
                        outline: createAgentRuntime === rt ? '2px solid currentColor' : 'none',
                        outlineOffset: '-4px',
                      }}
                    >
                      {rt === 'claude' ? 'claude code' : rt === 'codex' ? 'codex cli' : 'kimi cli'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#4a4048] uppercase mb-1">model</div>
                <input
                  value={createAgentModel}
                  onChange={e => setCreateAgentModel(e.target.value)}
                  placeholder="model id"
                  className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[13px] outline-none placeholder:text-[#4a4048]"
                />
              </div>
            </div>
            <div className="border-t-[3px] border-black grid grid-cols-2">
              <button
                onClick={() => setCreateAgentMachineId(null)}
                className="border-r-[3px] border-black py-3 text-[12px] uppercase text-[#4a4048] hover:bg-[#1e1a20]"
              >cancel</button>
              <button
                onClick={handleCreateAgent}
                disabled={creatingAgent || !createAgentName.trim()}
                className="py-3 text-[12px] uppercase bg-[#3abfa0] text-black hover:bg-[#4ed0b0] disabled:opacity-40"
              >{creatingAgent ? '...' : 'create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Reconnect result */}
      {reconnectResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[520px] border-[3px] border-black bg-[#141018]" style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}>
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#0f1a18] flex items-center justify-between">
              <div className="text-[13px] uppercase text-[#3abfa0]">connection command</div>
              <button onClick={() => setReconnectResult(null)} className="text-[#4a4048] hover:text-[#e7dfd3] text-[18px] leading-none">×</button>
            </div>
            <div className="px-5 py-4">
              <div className="text-[12px] text-[#9a8888] mb-2">Run this command on the machine:</div>
              <div
                className="border-[3px] border-black bg-[#0e0c10] text-[#3abfa0] px-4 py-3 text-[12px] font-mono cursor-pointer hover:bg-[#161218] break-all"
                onClick={() => navigator.clipboard.writeText(reconnectResult.connect_command)}
                title="Click to copy"
              >
                {reconnectResult.connect_command}
              </div>
              <div className="text-[11px] text-[#4a4048] mt-2">在目标机器上运行此命令即可连接。</div>
            </div>
            <div className="border-t-[3px] border-black">
              <button
                onClick={() => setReconnectResult(null)}
                className="w-full py-3 text-[12px] uppercase text-[#3abfa0] hover:bg-[#0f1a18]"
              >
                done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[360px] border-[3px] border-black bg-[#141018]" style={{ boxShadow: '6px 7px 0 rgba(0,0,0,0.95)' }}>
            <div className="border-b-[3px] border-black px-5 py-3 bg-[#3a1520]">
              <div className="text-[13px] uppercase text-[#c0392b]">remove machine</div>
            </div>
            <div className="px-5 py-5">
              <div className="text-[14px] text-[#e7dfd3] mb-2">确定要移除这台机器吗？</div>
              <div className="text-[11px] text-[#4a4048]">关联的 Shrimp 不会被删除，但会失去机器绑定。</div>
            </div>
            <div className="border-t-[3px] border-black grid grid-cols-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="border-r-[3px] border-black py-3 text-[12px] uppercase text-[#4a4048] hover:bg-[#1e1a20]"
              >cancel</button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="py-3 text-[12px] uppercase text-[#c0392b] hover:bg-[#3a1520]"
              >remove</button>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {machines.length === 0 && (
        <div className="text-center py-16">
          <div className="text-[48px] mb-3 opacity-20">⬡</div>
          <div className="text-[14px] text-[#4a4048] mb-2">no machines connected</div>
          <div className="text-[12px] text-[#3a3535]">click "+ connect machine" to add your first node</div>
        </div>
      )}
    </div>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-[#4a4048] uppercase mb-1">{label}</div>
      <div className="text-[13px] text-[#c8bdb8] truncate">{value}</div>
    </div>
  )
}
