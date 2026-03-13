/**
 * @file AgentsPage.tsx — AI Agent 管理页面
 * @description Agent 的全生命周期管理界面，包含：
 *   1. Agent 卡片网格 — 显示状态、模型、workspace、token 用量、system prompt 预览
 *   2. 启动/停止控制 — toggleAgent() 切换 agent 进程状态
 *   3. 实时状态更新 — 通过 WebSocket 监听 agent:started/stopped/crashed/offline 事件
 *   4. 模型注册表 — 展示所有可用的 LLM 提供商和模型
 *
 * 状态管理：组件内 useState，WebSocket 事件驱动局部更新（不重新请求列表）
 */

import { useEffect, useState } from 'react'
import { agentsApi, type Agent, type ModelRegistry } from '../lib/api'
import { socketClient } from '../lib/socket'

type AgentStatus = Agent['status']

/**
 * 根据 agent 状态返回颜色配置
 * @param s - agent 状态
 * @returns { dot: 圆点颜色, text: 文字颜色, label: 状态文本, pulse: 是否显示脉冲动画 }
 */
const statusColor = (s: AgentStatus) => {
  if (s === 'running') return { dot: '#c0392b', text: '#e04050', label: 'running', pulse: true }
  if (s === 'idle')    return { dot: '#6bc5e8', text: '#6bc5e8', label: 'idle',    pulse: false }
  if (s === 'offline') return { dot: '#3a3535', text: '#6a5858', label: 'offline', pulse: false }
  return                      { dot: '#c0392b', text: '#c0392b', label: 'error',   pulse: true  }
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])            // Agent 列表
  const [models, setModels] = useState<ModelRegistry | null>(null)  // 可用模型注册表
  const [busy, setBusy] = useState<string | null>(null)        // 当前正在操作的 agent ID（防止重复点击）

  /** 从后端重新加载 agent 列表 */
  const reload = () => agentsApi.list().then(({ agents: a }) => setAgents(a))

  useEffect(() => {
    reload()
    agentsApi.models().then(setModels).catch(() => {})

    // 通过 WebSocket 实时监听 agent 状态变更，直接更新本地状态（避免轮询）
    const unsubs = [
      socketClient.on('agent:started',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'running' } : ag))),
      socketClient.on('agent:stopped',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'idle'    } : ag))),
      socketClient.on('agent:crashed',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'error'   } : ag))),
      socketClient.on('agent:offline',  ({ agentId }) => setAgents(a => a.map(ag => ag.id === agentId ? { ...ag, status: 'offline' } : ag))),
    ]
    return () => { for (const u of unsubs) u() }  // 清理所有 WebSocket 监听
  }, [])

  /**
   * 切换 agent 运行状态
   * running → 停止; 其他状态 → 启动
   * @param agent - 要操作的 agent 对象
   */
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
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">agents</div>
        </div>
        <button
          className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#e04050]"
          style={{ transform: 'rotate(0.2deg)' }}
        >
          + spawn agent
        </button>
      </div>

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
              className="border-[3px] border-black bg-[#191619]"
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
              <div className="border-t-[3px] border-black grid grid-cols-3">
                <button
                  onClick={() => toggleAgent(agent)}
                  disabled={busy === agent.id}
                  className="border-r-[3px] border-black py-2 text-[11px] uppercase hover:bg-[#2a2535] hover:text-[#c0392b] disabled:opacity-40 transition-colors"
                  style={{ color: agent.status === 'running' ? '#c0392b' : '#3abfa0' }}
                >
                  {busy === agent.id ? '...' : agent.status === 'running' ? 'stop' : 'start'}
                </button>
                <button className="border-r-[3px] border-black py-2 text-[11px] text-[#9a8888] uppercase hover:bg-[#2a2535] hover:text-[#6bc5e8] transition-colors">
                  view logs
                </button>
                <button className="py-2 text-[11px] text-[#9a8888] uppercase hover:bg-[#2a2535] hover:text-[#6bc5e8] transition-colors">
                  configure
                </button>
              </div>
            </div>
          )
        })}

        {agents.length === 0 && (
          <div className="text-[14px] text-[#4a4048] col-span-full pt-8 text-center">
            no agents — spawn one to get started
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

/**
 * MetaRow — Agent 卡片中的元数据行
 * @param label - 标签文本（如 model / workspace / last seen）
 * @param value - 值文本
 * @param small - 是否使用更小的字号（用于路径等长文本）
 */
function MetaRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="text-[11px] text-[#4a4048] uppercase w-[80px] shrink-0">{label}</span>
      <span className={`${small ? 'text-[11px]' : 'text-[13px]'} text-[#c8bdb8] truncate`}>{value}</span>
    </div>
  )
}
