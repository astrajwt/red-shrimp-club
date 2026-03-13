/**
 * @file ActivityPage.tsx — 实时活动日志页面
 * @description Agent 运行日志的实时监控界面，两栏布局：
 *   左侧 — 日志流（时间 | Agent 名称 | 级别标签 | 日志内容）
 *   右侧 — Agent 状态树（名称、运行时、状态、context 用量百分比）
 *
 * 核心功能：
 *   1. 初始加载每个 agent 最近 50 条历史日志，合并排序后显示最新 200 条
 *   2. WebSocket 实时接收 agent:log 事件，追加到日志流（保持最近 500 条）
 *   3. 按 agent 过滤日志
 *   4. 自动滚动到最新日志
 *   5. 不同日志级别有不同的颜色样式（ACTION/FILE/SPAWN/WARN/ERROR）
 *
 * 组件结构：
 *   - ActivityPage — 主组件（头部筛选栏 + 两栏内容）
 *   - toRow() — 将 AgentLog API 数据转为统一的 LogRow 格式
 */

import { useEffect, useRef, useState } from 'react'
import { agentsApi, type Agent, type AgentLog } from '../lib/api'
import { socketClient, type AgentLogEvent, type AgentStatusEvent } from '../lib/socket'

/**
 * 根据日志级别返回颜色配置
 * @param level - 日志级别字符串
 * @returns { bg: 背景色, text: 文字色, border: 边框色 }
 */
const levelStyle = (level: string) => {
  if (level === 'ACTION') return { bg: '#3a1520', text: '#e04050', border: '#c0392b' }
  if (level === 'FILE')   return { bg: '#0f1a18', text: '#3abfa0', border: '#1e3d30' }
  if (level === 'SPAWN')  return { bg: '#1a2535', text: '#6bc5e8', border: '#1e3d55' }
  if (level === 'WARN')   return { bg: '#2a2010', text: '#d4a017', border: '#4a3010' }
  if (level === 'ERROR')  return { bg: '#3a1010', text: '#ff4444', border: '#6a1010' }
  return                         { bg: '#1e1a20', text: '#9a8888', border: '#2a2228' }
}

/** Agent 颜色调色板 — 按索引循环分配，确保同一 agent 颜色一致 */
const agentColors = ['#c0392b', '#6bc5e8', '#3abfa0', '#d4a017', '#a08cd8']

/** 统一的日志行数据结构（兼容 API 历史日志和 WebSocket 实时日志） */
interface LogRow {
  id: string
  time: string        // ISO 时间戳
  agentId: string
  agentName: string   // Agent 显示名称
  level: string       // 日志级别
  content: string     // 日志内容
  runId?: string      // 关联的 run ID
  isLive?: boolean    // 是否为实时推送的日志（区别于历史加载）
}

export default function ActivityPage() {
  const [agents, setAgents] = useState<Agent[]>([])                         // Agent 列表
  const [logs, setLogs] = useState<LogRow[]>([])                            // 日志行列表
  const [filterAgentId, setFilterAgentId] = useState<string | null>(null)   // 当前过滤的 agent ID（null=全部）
  const [agentColors_, setAgentColors_] = useState<Record<string, string>>({})  // agentId → 颜色映射
  const bottomRef = useRef<HTMLDivElement>(null)                            // 日志列表底部锚点

  /** 获取指定 agent 的颜色，未分配时返回灰色 */
  const getColor = (agentId: string) => agentColors_[agentId] ?? '#9a8888'

  // 初始化：加载 agent 列表 → 为每个 agent 分配颜色 → 加载历史日志
  useEffect(() => {
    agentsApi.list().then(({ agents: a }) => {
      setAgents(a)
      // 按顺序分配循环颜色
      const colorMap: Record<string, string> = {}
      a.forEach((ag, i) => { colorMap[ag.id] = agentColors[i % agentColors.length] })
      setAgentColors_(colorMap)

      // 并行加载每个 agent 的最近 50 条日志，合并后按时间排序，保留最新 200 条
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

  // WebSocket 实时日志流：收到 agent:log 事件后追加到日志列表（最多保留 500 条）
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
      setLogs(prev => [...prev.slice(-499), row])  // 滑动窗口保留最新 500 条
    })
    return unsub
  }, [agents])

  // 新日志到来时自动滚动到底部
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
            <div className="text-[13px] uppercase text-[#4a4048]">agent tree</div>
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
                        background: agent.status === 'running' ? color : '#3a3535',
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
              <div className="text-[12px] text-[#4a4048] text-center py-4">no agents</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 将 API 返回的 AgentLog 转为统一的 LogRow 格式
 * @param log - 后端返回的日志条目
 * @param agentName - Agent 显示名称（API 日志中不含 agent 名称，需外部传入）
 * @returns LogRow 格式的日志行
 */
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
