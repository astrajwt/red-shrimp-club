// Red Shrimp Lab — Chrono (Scheduler) Page
// Friendly UI for cron jobs: preset frequencies, target selection (DM vs channel)

import { useEffect, useState } from 'react'
import { cronApi, agentsApi, channelsApi, type CronJob, type Agent, type Channel } from '../lib/api'

// ── Frequency presets ─────────────────────────────────────────────────────────
const PRESETS: { label: string; expr: string }[] = [
  { label: '每30分钟',    expr: '*/30 * * * *' },
  { label: '每小时',      expr: '0 * * * *'    },
  { label: '每2小时',     expr: '0 */2 * * *'  },
  { label: '每天 9:00',   expr: '0 9 * * *'    },
  { label: '每天 21:00',  expr: '0 21 * * *'   },
  { label: '周一 9:00',   expr: '0 9 * * 1'    },
  { label: '工作日 9:00', expr: '0 9 * * 1-5'  },
]

function describeCron(expr: string): string {
  const preset = PRESETS.find(p => p.expr === expr)
  if (preset) return preset.label
  const parts = expr.split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, , , dow] = parts
  const dowNames: Record<string, string> = { '0': '周日', '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六', '1-5': '工作日' }
  if (min.startsWith('*/')) return `每 ${min.slice(2)} 分钟`
  if (hour.startsWith('*/')) return `每 ${hour.slice(2)} 小时`
  if (hour !== '*' && min !== '*') {
    const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dow === '*') return `每天 ${timeStr}`
    return `${dowNames[dow] ?? `周${dow}`} ${timeStr}`
  }
  return expr
}

export default function ChronoPage() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState('0 9 * * *')
  const [customExpr, setCustomExpr] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [target, setTarget] = useState<'dm' | string>('dm') // 'dm' or channelId
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const reload = () =>
    cronApi.list().then(({ jobs: j }) => setJobs(j)).catch(() => {})

  useEffect(() => {
    reload()
    agentsApi.list().then(list => {
      setAgents(list)
      if (list.length > 0 && !agentId) {
        const donovan = list.find(a => a.name === 'Donovan')
        setAgentId(donovan?.id ?? list[0].id)
      }
    }).catch(() => {})
    channelsApi.list().then(list => {
      setChannels(list.filter(c => c.type === 'channel'))
    }).catch(() => {})
  }, [])

  const cronExpr = useCustom ? customExpr : selectedPreset

  const handleCreate = async () => {
    if (!agentId || !cronExpr || !prompt.trim()) return
    setCreating(true)
    setCreateErr(null)
    try {
      await cronApi.create({
        agentId,
        cronExpr,
        prompt: prompt.trim(),
        channelId: target === 'dm' ? undefined : target,
      })
      setPrompt('')
      setShowNew(false)
      reload()
    } catch (e: any) {
      setCreateErr(e.message ?? 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const toggleJob = async (job: CronJob) => {
    setToggling(job.id)
    try {
      await cronApi.update(job.id, { enabled: !job.enabled })
      reload()
    } catch { /* ignore */ } finally {
      setToggling(null)
    }
  }

  const deleteJob = async (id: string) => {
    setDeleting(id)
    try {
      await cronApi.delete(id)
      reload()
    } catch { /* ignore */ } finally {
      setDeleting(null)
    }
  }

  const btnCls = (active: boolean) =>
    `border-[2px] px-3 py-1.5 text-[12px] transition-colors ${
      active
        ? 'border-[#6bc5e8] bg-[#0e1520] text-[#6bc5e8]'
        : 'border-[#2a2228] bg-[#0e0c10] text-[#6a6068] hover:border-[#4a4048]'
    }`

  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] px-3 py-3 md:px-6 md:py-5"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      <div className="max-w-[700px] mx-auto">
        {/* Header */}
        <div className="mb-5 md:mb-6 flex items-end justify-between">
          <div>
            <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">scheduler</div>
            <div className="text-[24px] md:text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-2">chrono</div>
          </div>
          <button
            onClick={() => setShowNew(v => !v)}
            className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] px-4 py-2 text-[11px] uppercase hover:bg-[#243548]"
          >
            {showNew ? '✕ 取消' : '+ 新任务'}
          </button>
        </div>

        {/* New job form */}
        {showNew && (
          <div className="border-[3px] border-black bg-[#141018] p-4 mb-5 space-y-4" style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.85)' }}>
            {/* Step 1: Select agent */}
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-2">1. 选择 agent</div>
              <div className="flex flex-wrap gap-2">
                {agents.map(a => (
                  <button
                    key={a.id}
                    onClick={() => setAgentId(a.id)}
                    className={`border-[2px] px-3 py-1.5 text-[12px] transition-colors ${
                      agentId === a.id
                        ? 'border-[#c0392b] bg-[#2b1414] text-[#e7dfd3]'
                        : 'border-[#2a2228] bg-[#0e0c10] text-[#6a6068] hover:border-[#4a4048]'
                    }`}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: Target — DM or channel */}
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-2">2. 发送到</div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setTarget('dm')} className={btnCls(target === 'dm')}>
                  私聊 (DM)
                </button>
                {channels.map(ch => (
                  <button key={ch.id} onClick={() => setTarget(ch.id)} className={btnCls(target === ch.id)}>
                    #{ch.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 3: Frequency */}
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-2">3. 执行频率</div>
              <div className="flex flex-wrap gap-2 mb-2">
                {PRESETS.map(p => (
                  <button
                    key={p.expr}
                    onClick={() => { setSelectedPreset(p.expr); setUseCustom(false) }}
                    className={btnCls(!useCustom && selectedPreset === p.expr)}
                  >
                    {p.label}
                  </button>
                ))}
                <button onClick={() => setUseCustom(true)} className={btnCls(useCustom)}>
                  自定义...
                </button>
              </div>
              {useCustom && (
                <input
                  value={customExpr}
                  onChange={e => setCustomExpr(e.target.value)}
                  placeholder="cron 表达式，如: */30 * * * *"
                  className="w-full border-[2px] border-[#2a2228] bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none placeholder-[#4a4048] font-mono focus:border-[#6bc5e8]"
                />
              )}
            </div>

            {/* Step 4: Prompt */}
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-2">4. 任务指令</div>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="告诉 agent 要做什么..."
                rows={3}
                className="w-full border-[2px] border-[#2a2228] bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none placeholder-[#4a4048] resize-none focus:border-[#6bc5e8]"
              />
            </div>

            {createErr && (
              <div className="border-[2px] border-[#c0392b] px-3 py-1.5 text-[11px] text-[#e04050]">✕ {createErr}</div>
            )}

            <button
              onClick={handleCreate}
              disabled={creating || !agentId || !cronExpr || !prompt.trim()}
              className="w-full border-[3px] border-black bg-[#c0392b] text-black px-5 py-2.5 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
            >
              {creating ? '创建中...' : '创建定时任务'}
            </button>
          </div>
        )}

        {/* Jobs list */}
        {jobs.length === 0 ? (
          <div className="text-[12px] text-[#4a4048] text-center py-10 border-[2px] border-dashed border-[#2a2228]">
            还没有定时任务
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map(job => (
              <div
                key={job.id}
                className={`border-[3px] border-black bg-[#141018] flex items-stretch ${!job.enabled ? 'opacity-50' : ''}`}
              >
                {/* Toggle */}
                <button
                  onClick={() => toggleJob(job)}
                  disabled={toggling === job.id}
                  className="border-r-[3px] border-black px-3 py-3 md:px-4 hover:bg-[#1e1a20] disabled:opacity-40 shrink-0 self-stretch flex items-center"
                  title={job.enabled ? '暂停' : '启用'}
                >
                  <span className={`text-[14px] ${job.enabled ? 'text-[#3abfa0]' : 'text-[#3a3535]'}`}>
                    {toggling === job.id ? '…' : job.enabled ? '●' : '○'}
                  </span>
                </button>

                {/* Content */}
                <div className="flex-1 min-w-0 px-3 py-3 md:px-4">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-[#6bc5e8] bg-[#0e1520] border border-[#1e3d55] px-2 py-0.5">
                      {describeCron(job.cron_expr)}
                    </span>
                    <span className="text-[12px] text-[#c0392b]">{job.agent_name}</span>
                    <span className="text-[10px] text-[#4a4048] border border-[#2a2228] px-1.5 py-0.5">
                      {job.channel_name ? `#${job.channel_name}` : 'DM'}
                    </span>
                  </div>
                  <div className="text-[13px] text-[#c8bdb8] leading-5 line-clamp-2">{job.prompt}</div>
                  <div className="text-[10px] text-[#4a4048] mt-1">
                    {new Date(job.created_at).toLocaleString('zh-CN')}
                  </div>
                </div>

                {/* Delete */}
                <button
                  onClick={() => deleteJob(job.id)}
                  disabled={deleting === job.id}
                  className="border-l-[3px] border-black px-2.5 py-3 md:px-3 text-[#4a4048] hover:text-[#c0392b] hover:bg-[#3a1520] disabled:opacity-40 transition-colors shrink-0 self-stretch flex items-center"
                  title="删除"
                >
                  {deleting === job.id ? '…' : '✕'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
