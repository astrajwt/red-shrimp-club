// Red Shrimp Lab — Activity / Agent Logs Page (connected to backend)

import { useEffect, useRef, useState } from 'react'
import { agentsApi, type Agent, type AgentLog } from '../lib/api'
import { socketClient, type AgentLogEvent, type AgentStatusEvent } from '../lib/socket'

const levelStyle = (level: string) => {
  if (level === 'ACTION') return { bg: '#3a1520', text: '#e04050', border: '#c0392b' }
  if (level === 'FILE')   return { bg: '#0f1a18', text: '#3abfa0', border: '#1e3d30' }
  if (level === 'SPAWN')  return { bg: '#1a2535', text: '#6bc5e8', border: '#1e3d55' }
  if (level === 'WARN')   return { bg: '#2a2010', text: '#d4a017', border: '#4a3010' }
  if (level === 'ERROR')  return { bg: '#3a1010', text: '#ff4444', border: '#6a1010' }
  return                         { bg: '#1e1a20', text: '#9a8888', border: '#2a2228' }
}

const agentColors = ['#c0392b', '#6bc5e8', '#3abfa0', '#d4a017', '#a08cd8']

interface LogRow {
  id: string
  time: string
  agentId: string
  agentName: string
  level: string
  content: string
  runId?: string
  isLive?: boolean
}

export default function ActivityPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null)
  const [agentColors_, setAgentColors_] = useState<Record<string, string>>({})
  const bottomRef = useRef<HTMLDivElement>(null)

  // Assign consistent colors per agent
  const getColor = (agentId: string) => agentColors_[agentId] ?? '#9a8888'

  // Load agents + recent logs
  useEffect(() => {
    agentsApi.list().then((a) => {
      setAgents(a)
      const colorMap: Record<string, string> = {}
      a.forEach((ag, i) => { colorMap[ag.id] = agentColors[i % agentColors.length] })
      setAgentColors_(colorMap)

      // Load last 100 logs for each agent
      Promise.all(a.map(ag =>
        agentsApi.logs(ag.id, 50).then(({ logs: ls }) =>
          ls.map(l => toRow(l, ag.name))
        )
      )).then(all => {
        const flat = all.flat().sort((a, b) =>
          new Date(a.time).getTime() - new Date(b.time).getTime()
        )
        setLogs(flat.slice(-200))
      })
    })
  }, [])

  // Live log stream via WebSocket
  useEffect(() => {
    const unsub = socketClient.on('agent:log', (evt: AgentLogEvent) => {
      const agentName = agents.find(a => a.id === evt.agentId)?.name ?? evt.agentId.slice(0, 8)
      const row: LogRow = {
        id: `live-${Date.now()}-${Math.random()}`,
        time: evt.timestamp,
        agentId: evt.agentId,
        agentName,
        level: evt.level,
        content: evt.content,
        runId: evt.runId,
        isLive: true,
      }
      setLogs(prev => [...prev.slice(-499), row])
    })
    return unsub
  }, [agents])

  // Auto-scroll to bottom on new live logs
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const displayed = filterAgentId
    ? logs.filter(l => l.agentId === filterAgentId)
    : logs

  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 15% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 85% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">real-time</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">activity log</div>
        </div>
        {/* Agent filter */}
        <div className="flex gap-2">
          <button
            onClick={() => setFilterAgentId(null)}
            className={`border-[3px] border-black px-3 py-1 text-[12px] uppercase
              ${!filterAgentId ? 'bg-[#c0392b] text-black' : 'bg-[#1e1a20] text-[#9a8888] hover:bg-[#2a2228]'}`}
          >
            All
          </button>
          {agents.map(a => (
            <button
              key={a.id}
              onClick={() => setFilterAgentId(a.id === filterAgentId ? null : a.id)}
              className={`border-[3px] border-black px-3 py-1 text-[12px] uppercase
                ${filterAgentId === a.id ? 'bg-[#1a2535] text-[#6bc5e8]' : 'bg-[#1e1a20] text-[#9a8888] hover:bg-[#2a2228]'}`}
            >
              {a.name}
            </button>
          ))}
        </div>
      </div>

      {/* Two columns: log stream + agent tree */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 320px' }}>

        {/* ── Log stream ── */}
        <div
          className="border-[3px] border-black bg-[#141018]"
          style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 16px rgba(50,120,220,0.10)' }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20] flex items-center gap-3">
            <span className="text-[13px] uppercase text-[#4a4048]">log stream</span>
            <span className="w-2 h-2 bg-[#c0392b] border border-black" style={{ animation: 'pulse 1s ease-in-out infinite' }} />
            <span className="text-[11px] text-[#c0392b]">live</span>
            <span className="ml-auto text-[11px] text-[#4a4048]">{displayed.length} entries</span>
          </div>

          <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
            {displayed.map((log, i) => {
              const s = levelStyle(log.level)
              const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })
              return (
                <div
                  key={log.id}
                  className="border-b-[2px] border-[#1a1620] flex gap-0"
                  style={{ background: i % 2 === 0 ? '#141018' : '#100e13' }}
                >
                  {/* Time */}
                  <div className="px-3 py-2 text-[11px] text-[#4a4048] w-[80px] shrink-0 border-r-[3px] border-black">
                    {time}
                  </div>
                  {/* Agent */}
                  <div className="px-3 py-2 w-[80px] shrink-0 border-r-[3px] border-black">
                    <span className="text-[11px]" style={{ color: getColor(log.agentId) }}>
                      {log.agentName}
                    </span>
                  </div>
                  {/* Level */}
                  <div className="px-2 py-2 w-[72px] shrink-0 border-r-[3px] border-black flex items-start">
                    <span
                      className="text-[10px] uppercase px-1 border-[2px]"
                      style={{ background: s.bg, color: s.text, borderColor: s.border }}
                    >
                      {log.level}
                    </span>
                  </div>
                  {/* Content */}
                  <div className="px-3 py-2 text-[13px] text-[#c8bdb8] flex-1 break-words">
                    {log.content}
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* ── Agent tree ── */}
        <div
          className="border-[3px] border-black bg-[#141018]"
          style={{
            boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 12px rgba(30,180,120,0.08)',
            alignSelf: 'start',
          }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20]">
            <div className="text-[13px] uppercase text-[#4a4048]">shrimp</div>
          </div>
          <div className="px-3 py-3 space-y-2">
            {agents.map(agent => {
              const color = getColor(agent.id)
              const pct = Math.min(100, Math.round(((agent.tokens_used_today ?? 0) / 200000) * 100))
              return (
                <div key={agent.id} className="border-[3px] border-black bg-[#1e1a20]">
                  <div className="flex items-center gap-2 px-3 py-2 bg-[#2a2228]">
                    <span
                      className="w-3 h-3 border border-black shrink-0"
                      style={{
                        background: agent.status === 'running' ? '#3abfa0' : '#3a3535',
                        animation: agent.status === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px]">{agent.name}</div>
                      <div className="text-[10px] text-[#4a4048] uppercase">{agent.runtime} · {agent.status}</div>
                    </div>
                    <div className="text-[10px] text-right">
                      <div style={{ color: pct > 80 ? '#c0392b' : '#6bc5e8' }}>{pct}%</div>
                      <div className="text-[#4a4048]">ctx</div>
                    </div>
                  </div>
                </div>
              )
            })}
            {agents.length === 0 && (
              <div className="text-[12px] text-[#4a4048] text-center py-4">暂无shrimp</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function toRow(log: AgentLog, agentName: string): LogRow {
  return {
    id: log.id,
    time: log.created_at,
    agentId: log.agent_id,
    agentName,
    level: log.level,
    content: log.content,
    runId: log.run_id ?? undefined,
  }
}
