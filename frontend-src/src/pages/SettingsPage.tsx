// Red Shrimp Lab — Settings Page
// Cron Jobs · Danger Zone

import { useEffect, useState } from 'react'
import {
  cronApi,
  agentsApi,
  feishuApi,
  skillsApi,
  setupApi,
  obsidianApi,
  type CronJob,
  type Agent,
  type FeishuRelayBinding,
  type SharedSkillRegistryItem,
  type SharedSkillRegistrySnapshot,
  type ObsidianEntry,
} from '../lib/api'

// ─── Section wrapper ──────────────────────────────────────────────────────────

export function Section({ title, subtitle, children }: {
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

export function Field({
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

export function CronSection() {
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
              <div className="text-[11px] text-[#4a4048] uppercase mb-1">agent *</div>
              <select
                value={form.agentId}
                onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
                className="rsl-control rsl-select w-full border-[3px] border-black bg-[#0e0c10] text-[#e7dfd3] px-3 py-2 text-[12px] outline-none"
              >
                <option value="">— select agent —</option>
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
              placeholder="What should the agent do when this fires?"
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

export function RecipeSection({
  standalone = false,
  vaultGitUrl = '',
}: {
  standalone?: boolean
  vaultGitUrl?: string
} = {}) {
  const [registry, setRegistry] = useState<SharedSkillRegistrySnapshot | null>(null)
  const [form, setForm] = useState({
    valuePath: '',
  })
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadRegistry = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await skillsApi.list()
      setRegistry(next)
    } catch (err: any) {
      setError(err.message ?? 'Failed to load shared skills')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadRegistry()
  }, [])

  const handleImport = async () => {
    if (!form.valuePath.trim()) return
    setImporting(true)
    setError(null)
    setMessage(null)
    try {
      const result = await skillsApi.importRepo({
        valuePath: form.valuePath.trim() || undefined,
      })
      setMessage(`synced ${result.skills.length} skill${result.skills.length === 1 ? '' : 's'} from vault`)
      setForm({ valuePath: '' })
      await loadRegistry()
    } catch (err: any) {
      setError(err.message ?? 'Failed to import skill')
    } finally {
      setImporting(false)
    }
  }

  const content = (
    <div className="space-y-5">
      <div className="text-[12px] text-[#4a4048] leading-5">
        Skills stay shared across agents. This page only keeps the current skills visible and one import flow for bringing more in.
      </div>

      <div className="border-[3px] border-black bg-[#141018]">
        <div className="border-b-[3px] border-black px-4 py-2 flex items-center justify-between gap-3">
          <div className="text-[11px] uppercase tracking-widest text-[#6bc5e8]">current skills</div>
          <div className="text-[10px] text-[#4a4048]">
            {loading ? 'loading...' : `${registry?.skills.length ?? 0} installed`} · shared across agents
          </div>
        </div>
        <div className="p-3 space-y-3 min-h-[180px]">
          {loading && <div className="text-[12px] text-[#4a4048]">loading skills...</div>}
          {!loading && registry && registry.skills.length === 0 && (
            <div className="text-[12px] text-[#4a4048]">no shared skills yet. import one below.</div>
          )}
          {registry?.skills.map(skill => (
            <SkillCard key={`${skill.sourceName}:${skill.name}`} skill={skill} />
          ))}
        </div>
      </div>

      <div
        className="border-[3px] border-black bg-[#141018] p-4"
        style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.85)' }}
      >
        <div className="text-[11px] uppercase tracking-widest text-[#6bc5e8] mb-3">import skill</div>
        <div className="border-[2px] border-[#1e3d55] bg-[#0e1520] px-3 py-2 text-[11px] mb-3 text-[#6bc5e8]">
          from local vault (OBSIDIAN_ROOT)
        </div>
        <Field
          label="skill path"
          value={form.valuePath}
          onChange={value => setForm(current => ({ ...current, valuePath: value }))}
          placeholder="skills/my-skill"
          hint="Relative path inside local vault to the skill directory (containing SKILL.md)."
          mono
        />

        {error && (
          <div className="border-[2px] border-[#c0392b] px-3 py-1.5 text-[11px] text-[#e04050] mb-3">{error}</div>
        )}

        {message && (
          <div className="border-[2px] border-[#1e3d55] bg-[#0e1520] px-3 py-1.5 text-[11px] text-[#6bc5e8] mb-3">{message}</div>
        )}

        <button
          onClick={handleImport}
          disabled={importing || !form.valuePath.trim()}
          className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
        >
          {importing ? 'syncing...' : 'import skill'}
        </button>
      </div>
    </div>
  )

  if (standalone) return content

  return (
    <Section title="recipe" subtitle="shared skills">
      {content}
    </Section>
  )
}

function SkillCard({ skill }: { skill: SharedSkillRegistryItem }) {
  return (
    <div className="border-[2px] border-[#2a2228] bg-[#100d12] px-3 py-2">
      <div className="text-[12px] text-[#e7dfd3] mb-1">{skill.name}</div>
      {skill.description && (
        <div className="text-[11px] text-[#c8bdb8] leading-5 mb-2">{skill.description}</div>
      )}
      <div className="flex flex-wrap gap-2 mb-2">
        {skill.runtimes.map(runtime => (
          <span
            key={runtime}
            className="border border-[#1e3d55] bg-[#0e1520] px-2 py-0.5 text-[10px] uppercase text-[#6bc5e8]"
          >
            {runtime}
          </span>
        ))}
      </div>
    </div>
  )
}

export function VaultSection() {
  const [obsidianRoot, setObsidianRoot] = useState('')
  const [vaultGitUrl, setVaultGitUrl] = useState('')
  const [skillPath, setSkillPath] = useState('')
  const [memoryPath, setMemoryPath] = useState('')
  const [vaultDirs, setVaultDirs] = useState<ObsidianEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadingDirs, setLoadingDirs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadDirs = async () => {
    setLoadingDirs(true)
    try {
      const result = await obsidianApi.tree('')
      setVaultDirs(result.items.filter(e => e.type === 'directory'))
    } catch {
      setVaultDirs([])
    } finally {
      setLoadingDirs(false)
    }
  }

  useEffect(() => {
    setupApi.getKeys().then(keys => {
      setObsidianRoot(keys.obsidian_root ?? '')
      setVaultGitUrl(keys.vault_git_url ?? '')
      setSkillPath(keys.skill_path ?? '')
      setMemoryPath(keys.memory_path ?? '')
      setLoading(false)
      if (keys.obsidian_root) void loadDirs()
    }).catch(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await setupApi.saveKeys({
        obsidianRoot: obsidianRoot.trim() || undefined,
        vaultGitUrl: vaultGitUrl.trim() || undefined,
        skillPath: skillPath === '__custom__' ? '' : (skillPath.trim() || undefined),
        memoryPath: memoryPath === '__custom__' ? '' : (memoryPath.trim() || undefined),
      })
      setMessage('vault config saved')
      await loadDirs()
    } catch (e: any) {
      setError(e.message ?? 'Failed to save vault config')
    } finally {
      setSaving(false)
    }
  }

  const handleLoadDirs = async () => {
    if (!obsidianRoot.trim()) return
    setSaving(true)
    setError(null)
    try {
      await setupApi.saveKeys({ obsidianRoot: obsidianRoot.trim() })
      await loadDirs()
    } catch (e: any) {
      setError(e.message ?? 'Failed to load vault dirs')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="vault" subtitle="workspace paths">
      <div className="space-y-4">
        {loading && <div className="text-[12px] text-[#4a4048]">loading...</div>}
        {!loading && (
          <>
            <Field
              label="obsidian root *"
              value={obsidianRoot}
              onChange={setObsidianRoot}
              placeholder="/home/user/JwtVault"
              hint="本地 Obsidian vault 根目录的绝对路径"
              mono
            />
            <Field
              label="vault git url"
              value={vaultGitUrl}
              onChange={setVaultGitUrl}
              placeholder="https://github.com/user/vault.git"
              hint="vault 对应的 git 仓库地址（用于 skill 导入）"
              mono
            />

            <div className="flex items-center gap-3 mb-2">
              <button
                onClick={handleLoadDirs}
                disabled={!obsidianRoot.trim() || saving || loadingDirs}
                className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] px-4 py-1.5 text-[11px] uppercase hover:bg-[#243548] disabled:opacity-40"
              >
                {loadingDirs ? '...' : '加载 vault 目录'}
              </button>
              {vaultDirs.length > 0 && (
                <span className="text-[11px] text-[#3abfa0]">✓ {vaultDirs.length} 个目录</span>
              )}
            </div>

            <div className="mb-4">
              <div className="text-[11px] text-[#6bc5e8] uppercase tracking-[0.08em] mb-1">skill path</div>
              {vaultDirs.length > 0 ? (
                <select
                  value={skillPath}
                  onChange={e => setSkillPath(e.target.value)}
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none"
                >
                  <option value="">— 不设置 —</option>
                  {vaultDirs.map(d => (
                    <option key={d.path} value={d.path}>{d.path}</option>
                  ))}
                  <option value="__custom__">手动输入...</option>
                </select>
              ) : (
                <input
                  value={skillPath}
                  onChange={e => setSkillPath(e.target.value)}
                  placeholder="skills"
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none placeholder-[#4a4048] focus:border-[#c0392b] font-mono"
                />
              )}
              {skillPath === '__custom__' && (
                <input
                  onChange={e => setSkillPath(e.target.value)}
                  value=""
                  placeholder="skills/my-skill"
                  autoFocus
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none placeholder-[#4a4048] focus:border-[#c0392b] font-mono mt-1"
                />
              )}
              <div className="text-[11px] text-[#4a4048] mt-1">vault 内 skill 存放路径</div>
            </div>

            <div className="mb-4">
              <div className="text-[11px] text-[#6bc5e8] uppercase tracking-[0.08em] mb-1">memory path</div>
              {vaultDirs.length > 0 ? (
                <select
                  value={memoryPath}
                  onChange={e => setMemoryPath(e.target.value)}
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none"
                >
                  <option value="">— 不设置 —</option>
                  {vaultDirs.map(d => (
                    <option key={d.path} value={d.path}>{d.path}</option>
                  ))}
                  <option value="__custom__">手动输入...</option>
                </select>
              ) : (
                <input
                  value={memoryPath}
                  onChange={e => setMemoryPath(e.target.value)}
                  placeholder="memory"
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none placeholder-[#4a4048] focus:border-[#c0392b] font-mono"
                />
              )}
              {memoryPath === '__custom__' && (
                <input
                  onChange={e => setMemoryPath(e.target.value)}
                  value=""
                  placeholder="memory"
                  autoFocus
                  className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[13px] px-3 py-2 outline-none placeholder-[#4a4048] focus:border-[#c0392b] font-mono mt-1"
                />
              )}
              <div className="text-[11px] text-[#4a4048] mt-1">vault 内 memory 存放路径</div>
            </div>

            {error && (
              <div className="border-[2px] border-[#c0392b] px-3 py-1.5 text-[11px] text-[#e04050]">✕ {error}</div>
            )}
            {message && (
              <div className="border-[2px] border-[#1e3d55] bg-[#0e1520] px-3 py-1.5 text-[11px] text-[#6bc5e8]">{message}</div>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
            >
              {saving ? 'saving...' : 'save vault config'}
            </button>
          </>
        )}
      </div>
    </Section>
  )
}

function FeishuSection() {
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [webhookBaseUrl, setWebhookBaseUrl] = useState('')
  const [secretSet, setSecretSet] = useState(false)
  const [tokenSet, setTokenSet] = useState(false)
  const [relay, setRelay] = useState<FeishuRelayBinding | null>(null)
  const [webhookPath, setWebhookPath] = useState('/api/feishu/webhook')
  const [configuredWebhookUrl, setConfiguredWebhookUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingRelay, setSavingRelay] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [keys, relayState] = await Promise.all([
        setupApi.getKeys(),
        feishuApi.relay(),
      ])
      setAppId(keys.feishu_app_id ?? relayState.config.appId ?? '')
      setWebhookBaseUrl(keys.feishu_webhook_base_url ?? '')
      setSecretSet(keys.feishu_app_secret || relayState.config.appSecretSet)
      setTokenSet(keys.feishu_verification_token || relayState.config.verificationTokenSet)
      setRelay(relayState.relay)
      setWebhookPath(relayState.webhookPath)
      setConfiguredWebhookUrl(relayState.webhookUrl)
      setError(null)
    } catch (err: any) {
      setError(err.message ?? 'Failed to load Feishu relay settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const saveConfig = async () => {
    const payload: {
      feishuAppId?: string
      feishuAppSecret?: string
      feishuVerificationToken?: string
      feishuWebhookBaseUrl?: string
    } = {}
    if (appId.trim()) payload.feishuAppId = appId.trim()
    if (appSecret.trim()) payload.feishuAppSecret = appSecret.trim()
    if (verificationToken.trim()) payload.feishuVerificationToken = verificationToken.trim()
    if (webhookBaseUrl.trim()) payload.feishuWebhookBaseUrl = webhookBaseUrl.trim()
    if (!payload.feishuAppId && !payload.feishuAppSecret && !payload.feishuVerificationToken && !payload.feishuWebhookBaseUrl) return

    setSavingConfig(true)
    setError(null)
    setMessage(null)
    try {
      await setupApi.saveKeys(payload)
      setAppSecret('')
      setVerificationToken('')
      setMessage('Feishu bot config saved.')
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to save Feishu bot config')
    } finally {
      setSavingConfig(false)
    }
  }

  const saveRelay = async (resetBinding = false, enabled = true) => {
    setSavingRelay(true)
    setError(null)
    setMessage(null)
    try {
      const result = await feishuApi.saveRelay({ enabled, resetBinding })
      setRelay(result.relay)
      setMessage(
        resetBinding
          ? 'Relay reset. Send one Feishu message to bind this chat again.'
          : enabled
            ? `Relay is now bound to ${result.relay.agent_name}.`
            : 'Relay disabled.'
      )
    } catch (err: any) {
      setError(err.message ?? 'Failed to save relay state')
    } finally {
      setSavingRelay(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setError(null)
    setMessage(null)
    try {
      await feishuApi.testRelay()
      setMessage('Test message sent to Feishu.')
    } catch (err: any) {
      setError(err.message ?? 'Failed to send test message')
    } finally {
      setTesting(false)
    }
  }

  const configured = !!appId.trim() && secretSet
  const webhookUrl = configuredWebhookUrl || (typeof window === 'undefined'
    ? webhookPath
    : `${window.location.origin}${webhookPath}`)

  return (
    <Section title="feishu relay" subtitle="akara bridge">
      <div className="space-y-5">
        <div className="text-[12px] text-[#4a4048] leading-5">
          Bind a Feishu bot to Akara so Feishu text messages can be forwarded into your Akara DM, and Akara replies can be pushed back out to the same Feishu chat.
        </div>

        <div className="border-[3px] border-black bg-[#141018] p-4">
          <div className="text-[11px] uppercase tracking-widest text-[#6bc5e8] mb-3">bot config</div>

          <Field
            label="feishu app id"
            value={appId}
            onChange={setAppId}
            placeholder="cli_xxx"
            mono
          />
          <Field
            label="feishu app secret"
            value={appSecret}
            onChange={setAppSecret}
            type="password"
            placeholder={secretSet ? 'already configured; fill to replace' : 'paste app secret'}
            hint={secretSet ? 'A secret is already stored. Leave this blank if you do not want to replace it.' : undefined}
            mono
          />
          <Field
            label="verification token"
            value={verificationToken}
            onChange={setVerificationToken}
            type="password"
            placeholder={tokenSet ? 'already configured; fill to replace' : 'paste verification token'}
            hint={tokenSet ? 'A verification token is already stored. Leave this blank if you do not want to replace it.' : 'Recommended for validating Feishu event callbacks.'}
            mono
          />
          <Field
            label="public webhook base url"
            value={webhookBaseUrl}
            onChange={setWebhookBaseUrl}
            placeholder="https://xxxx.ngrok-free.app"
            hint="Set this to the public HTTPS base that Feishu can reach. The system will append /api/feishu/webhook."
            mono
          />

          <div className="grid grid-cols-3 gap-3 mb-3 text-[11px]">
            <div className={`border px-3 py-2 ${appId.trim() ? 'border-[#1e3d55] bg-[#0e1520] text-[#6bc5e8]' : 'border-[#2a2228] text-[#4a4048]'}`}>
              app id {appId.trim() ? 'ready' : 'missing'}
            </div>
            <div className={`border px-3 py-2 ${secretSet ? 'border-[#1e3d55] bg-[#0e1520] text-[#6bc5e8]' : 'border-[#2a2228] text-[#4a4048]'}`}>
              secret {secretSet ? 'stored' : 'missing'}
            </div>
            <div className={`border px-3 py-2 ${tokenSet ? 'border-[#1e3d55] bg-[#0e1520] text-[#6bc5e8]' : 'border-[#2a2228] text-[#4a4048]'}`}>
              token {tokenSet ? 'stored' : 'optional'}
            </div>
          </div>

          <button
            type="button"
            onClick={saveConfig}
            disabled={savingConfig}
            className="border-[3px] border-black bg-[#c0392b] text-black px-4 py-2 text-[11px] uppercase hover:bg-[#e04050] disabled:opacity-40"
          >
            {savingConfig ? 'saving...' : 'save bot config'}
          </button>
        </div>

        <div className="border-[3px] border-black bg-[#141018] p-4">
          <div className="text-[11px] uppercase tracking-widest text-[#6bc5e8] mb-3">relay binding</div>

          <div className="border-[2px] border-[#1e3d55] bg-[#0e1520] px-3 py-2 text-[11px] text-[#6bc5e8] mb-3 break-all">
            webhook: {webhookUrl}
          </div>

          <div className="text-[12px] text-[#c8bdb8] leading-5 mb-3">
            1. 在 Feishu 应用里订阅 `im.message.receive_v1`
            <br />
            2. 把上面的 webhook 填进去
            <br />
            3. 保存后点下面的 bind to Akara
            <br />
            4. 先从 Feishu 给机器人发一条文字，让系统记住你的 chat/open id
          </div>

          <div className={`border-[2px] px-3 py-2 text-[11px] mb-3 ${
            relay?.enabled
              ? relay.feishu_open_id || relay.feishu_chat_id
                ? 'border-[#1e3d55] bg-[#0e1520] text-[#6bc5e8]'
                : 'border-[#8c6b1f] bg-[#201807] text-[#e8c56b]'
              : 'border-[#2a2228] text-[#4a4048]'
          }`}>
            {!relay && 'relay not enabled yet'}
            {relay?.enabled && !(relay.feishu_open_id || relay.feishu_chat_id) && `relay enabled for ${relay.agent_name}, waiting for first Feishu text to bind this chat`}
            {relay?.enabled && (relay.feishu_open_id || relay.feishu_chat_id) && `relay active → ${relay.agent_name} · open_id ${relay.feishu_open_id ?? '—'} · chat_id ${relay.feishu_chat_id ?? '—'}`}
            {relay && !relay.enabled && 'relay disabled'}
          </div>

          {error && (
            <div className="border-[2px] border-[#c0392b] px-3 py-1.5 text-[11px] text-[#e04050] mb-3">✕ {error}</div>
          )}

          {message && (
            <div className="border-[2px] border-[#1e3d55] bg-[#0e1520] px-3 py-1.5 text-[11px] text-[#6bc5e8] mb-3">{message}</div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => saveRelay(false, true)}
              disabled={!configured || loading || savingRelay}
              className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] px-4 py-2 text-[11px] uppercase hover:bg-[#243548] disabled:opacity-40"
            >
              {savingRelay ? 'saving...' : `bind to ${relay?.agent_name ?? 'Akara'}`}
            </button>
            <button
              type="button"
              onClick={() => saveRelay(true, true)}
              disabled={!configured || loading || savingRelay}
              className="border-[3px] border-black bg-[#3a2a12] text-[#e8c56b] px-4 py-2 text-[11px] uppercase hover:bg-[#4a3515] disabled:opacity-40"
            >
              reset binding
            </button>
            <button
              type="button"
              onClick={sendTest}
              disabled={!relay?.enabled || !(relay.feishu_open_id || relay.feishu_chat_id) || testing}
              className="border-[3px] border-black bg-[#153a20] text-[#7ce4a1] px-4 py-2 text-[11px] uppercase hover:bg-[#1b4a29] disabled:opacity-40"
            >
              {testing ? 'sending...' : 'send test'}
            </button>
          </div>
        </div>
      </div>
    </Section>
  )
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export default function SettingsPage() {
  const [vaultGitUrl, setVaultGitUrlState] = useState('')

  useEffect(() => {
    setupApi.getKeys().then(keys => {
      setVaultGitUrlState(keys.vault_git_url ?? '')
    }).catch(() => {})
  }, [])

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

        <VaultSection />
        <FeishuSection />
        <RecipeSection vaultGitUrl={vaultGitUrl} />
        <CronSection />
      </div>
    </div>
  )
}
