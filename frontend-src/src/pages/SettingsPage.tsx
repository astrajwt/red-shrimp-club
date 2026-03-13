// Red Shrimp Lab — Settings Page
// Cron Jobs · Danger Zone

import { useEffect, useState } from 'react'
import { cronApi, agentsApi, type CronJob, type Agent } from '../lib/api'

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode
}) {
  return (
    <div
      className="border-[3px] border-black bg-[#191619] mb-5"
      style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.85)' }}
    >
      <div className="border-b-[3px] border-black px-5 py-3 bg-[#1e1a20]">
        <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-0.5">{subtitle ?? 'config'}</div>
        <div className="text-[20px] leading-none">{title}</div>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

function Field({
  label, value, onChange, type = 'text', placeholder, hint, mono = false,
}: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; hint?: string; mono?: boolean
}) {
  return (
    <div className="mb-4">
      <div className="text-[11px] text-[#6bc5e8] uppercase tracking-[0.08em] mb-1">{label}</div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none placeholder-[#4a4048] focus:border-[#c0392b]"
        style={mono ? { fontFamily: 'monospace' } : undefined}
      />
      {hint && <div className="text-[11px] text-[#4a4048] mt-1">{hint}</div>}
    </div>
  )
}

// ─── Cron Jobs Section ────────────────────────────────────────────────────────

function CronSection() {
  const [jobs, setJobs]       = useState<CronJob[]>([])
  const [agents, setAgents]   = useState<Agent[]>([])
  const [showNew, setShowNew] = useState(false)
  const [form, setForm]       = useState({
    agentId: '', cronExpr: '0 9 * * *', prompt: '', channelId: '', modelOverride: '',
  })
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const reload = () =>
    cronApi.list().then(({ jobs: j }) => setJobs(j)).catch(() => {})

  useEffect(() => {
    reload()
    agentsApi.list().then(setAgents).catch(() => {})
  }, [])

  const handleCreate = async () => {
    if (!form.agentId || !form.cronExpr || !form.prompt.trim()) return
    setCreating(true)
    setCreateErr(null)
    try {
      await cronApi.create({
        agentId:       form.agentId,
        cronExpr:      form.cronExpr,
        prompt:        form.prompt.trim(),
        channelId:     form.channelId || undefined,
        modelOverride: form.modelOverride || undefined,
      })
      setForm({ agentId: form.agentId, cronExpr: '0 9 * * *', prompt: '', channelId: '', modelOverride: '' })
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

  return (
    <Section title="cron jobs" subtitle="scheduler">
      {/* New job form */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-[12px] text-[#4a4048]">{jobs.length} job{jobs.length !== 1 ? 's' : ''} scheduled</div>
        <button
          onClick={() => setShowNew(v => !v)}
          className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] px-4 py-1.5 text-[11px] uppercase hover:bg-[#243548]"
        >
          {showNew ? '✕ cancel' : '+ new job'}
        </button>
      </div>

      {showNew && (
        <div
          className="border-[3px] border-black bg-[#141018] p-4 mb-4 space-y-3"
          style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.85)' }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">shrimp *</div>
              <select
                value={form.agentId}
                onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none"
              >
                <option value="">— select shrimp —</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">
                cron expr *
                <span className="ml-2 text-[10px] text-[#3a3535] normal-case">min hour day mon dow</span>
              </div>
              <input
                value={form.cronExpr}
                onChange={e => setForm(f => ({ ...f, cronExpr: e.target.value }))}
                placeholder="0 9 * * *"
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none font-mono"
              />
              <div className="text-[10px] text-[#4a4048] mt-0.5">
                <CronPreset label="9 AM daily"   expr="0 9 * * *"    onSet={e => setForm(f => ({ ...f, cronExpr: e }))} />
                <CronPreset label="hourly"        expr="0 * * * *"    onSet={e => setForm(f => ({ ...f, cronExpr: e }))} />
                <CronPreset label="Mon 9 AM"      expr="0 9 * * 1"   onSet={e => setForm(f => ({ ...f, cronExpr: e }))} />
                <CronPreset label="every 30 min"  expr="*/30 * * * *" onSet={e => setForm(f => ({ ...f, cronExpr: e }))} />
              </div>
            </div>
          </div>

          <div>
            <div className="text-[11px] text-[#4a4048] uppercase mb-1">prompt *</div>
            <textarea
              value={form.prompt}
              onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
              placeholder="What should the shrimp do when this fires?"
              rows={3}
              className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none placeholder-[#4a4048] resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">model override <span className="text-[#3a3535] normal-case">(optional)</span></div>
              <input
                value={form.modelOverride}
                onChange={e => setForm(f => ({ ...f, modelOverride: e.target.value }))}
                placeholder="claude-sonnet-4-6"
                className="w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none placeholder-[#4a4048]"
              />
            </div>
          </div>

          {createErr && (
            <div className="border-[2px] border-[#c0392b] px-3 py-1.5 text-[11px] text-[#e04050]">✕ {createErr}</div>
          )}

          <button
            onClick={handleCreate}
            disabled={creating || !form.agentId || !form.cronExpr || !form.prompt.trim()}
            className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
          >
            {creating ? '...' : 'schedule →'}
          </button>
        </div>
      )}

      {/* Jobs list */}
      {jobs.length === 0 ? (
        <div className="text-[12px] text-[#4a4048] text-center py-6 border-[2px] border-dashed border-[#2a2228]">
          no cron jobs scheduled
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <div
              key={job.id}
              className="border-[3px] border-black bg-[#141018] flex items-start gap-0"
            >
              {/* Enable toggle */}
              <button
                onClick={() => toggleJob(job)}
                disabled={toggling === job.id}
                className="border-r-[3px] border-black px-4 py-3 text-[13px] hover:bg-[#1e1a20] disabled:opacity-40 shrink-0 self-stretch flex items-center"
                title={job.enabled ? 'disable' : 'enable'}
              >
                <span style={{ color: job.enabled ? '#3abfa0' : '#3a3535' }}>
                  {toggling === job.id ? '…' : job.enabled ? '●' : '○'}
                </span>
              </button>

              {/* Content */}
              <div className="flex-1 min-w-0 px-4 py-3">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-[12px] font-mono text-[#6bc5e8] bg-[#0e1520] border border-[#1e3d55] px-2 py-0.5">
                    {job.cron_expr}
                  </span>
                  <span className="text-[12px] text-[#c0392b]">{job.agent_name}</span>
                  {job.model_override && (
                    <span className="text-[10px] text-[#4a4048] border border-[#2a2228] px-1.5 py-0.5">
                      {job.model_override}
                    </span>
                  )}
                  {!job.enabled && (
                    <span className="text-[10px] text-[#6a3535] uppercase">disabled</span>
                  )}
                </div>
                <div className="text-[13px] text-[#c8bdb8] leading-5 line-clamp-2">
                  {job.prompt}
                </div>
                <div className="text-[10px] text-[#4a4048] mt-1">
                  created {new Date(job.created_at).toLocaleString('zh-CN')}
                </div>
              </div>

              {/* Delete */}
              <button
                onClick={() => deleteJob(job.id)}
                disabled={deleting === job.id}
                className="border-l-[3px] border-black px-3 py-3 text-[#4a4048] hover:text-[#c0392b] hover:bg-[#3a1520] disabled:opacity-40 transition-colors shrink-0 self-stretch flex items-center"
                title="delete"
              >
                {deleting === job.id ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function CronPreset({ label, expr, onSet }: { label: string; expr: string; onSet: (e: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSet(expr)}
      className="mr-2 text-[10px] text-[#4a4048] hover:text-[#6bc5e8] underline"
    >
      {label}
    </button>
  )
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] px-6 py-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      <div className="max-w-[900px] mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">configuration</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-2">settings</div>
        </div>

        <CronSection />
      </div>
    </div>
  )
}
