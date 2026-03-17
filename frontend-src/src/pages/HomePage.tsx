// Red Shrimp Lab — Home Dashboard
// Leader Lanes (3 peer-level leaders) + Quick Links + Recent Activity

import { useEffect, useState, useCallback } from 'react'
import { bulletinApi, type DashboardData, type DashboardAgent, type DashboardTask, type Bulletin } from '../lib/api'

const LEADER_ROLES = ['coordinator', 'tech-lead', 'ops']

const ROLE_LABELS: Record<string, string> = {
  coordinator: '协调员',
  'tech-lead': '技术 Lead',
  ops: '运维',
  investigator: '调查员',
  developer: '开发工程师',
  profiler: '性能分析',
  observer: '指标观测',
  'exp-kernel': '算子实验',
  'exp-training': '训练实验',
  'exp-inference': '推理实验',
  general: '通用',
}

const STATUS_COLORS: Record<string, string> = {
  online: '#6bc5e8',
  running: '#6bc5e8',
  sleeping: '#f0b35e',
  idle: '#f0b35e',
  offline: '#8d8188',
  error: '#c0392b',
}

const TASK_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: 'open', color: '#8d8188' },
  in_progress: { label: '进行中', color: '#6bc5e8' },
  reviewing: { label: 'review', color: '#f0b35e' },
}

interface Props {
  onNavigate?: (page: string, data?: any) => void
}

export default function HomePage({ onNavigate }: Props) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddLink, setShowAddLink] = useState(false)
  const [newLink, setNewLink] = useState({ title: '', url: '', type: 'external' as 'external' | 'vault_doc' })
  const [showAddSticky, setShowAddSticky] = useState(false)
  const [newSticky, setNewSticky] = useState({ title: '', content: '', color: '#f0b35e' })

  const load = useCallback(async () => {
    try {
      const d = await bulletinApi.dashboard()
      setData(d)
    } catch (err) {
      console.error('Failed to load dashboard:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0e0c10] text-[#8d8188]"
           style={{ fontFamily: '"Share Tech Mono", monospace' }}>
        loading dashboard...
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0e0c10] text-[#8d8188]"
           style={{ fontFamily: '"Share Tech Mono", monospace' }}>
        failed to load dashboard — check backend connection
      </div>
    )
  }

  // Separate leaders and subordinates
  const leaders = data.leaders.filter(a => LEADER_ROLES.includes(a.role))
  const subordinates = data.leaders.filter(a => !LEADER_ROLES.includes(a.role))

  // Group subordinates by parent_agent_id
  const subsByLeader = new Map<string, DashboardAgent[]>()
  for (const sub of subordinates) {
    const key = sub.parent_agent_id ?? 'unassigned'
    if (!subsByLeader.has(key)) subsByLeader.set(key, [])
    subsByLeader.get(key)!.push(sub)
  }

  // Find tasks assigned to each agent
  const tasksByAgent = new Map<string, DashboardTask[]>()
  for (const task of data.activeTasks) {
    if (task.assigned_agent_id) {
      if (!tasksByAgent.has(task.assigned_agent_id)) tasksByAgent.set(task.assigned_agent_id, [])
      tasksByAgent.get(task.assigned_agent_id)!.push(task)
    }
  }

  const handleAddBookmark = async () => {
    if (!newLink.title.trim()) return
    try {
      await bulletinApi.create({
        category: 'bookmark',
        title: newLink.title.trim(),
        linked_url: newLink.type === 'external' ? newLink.url.trim() : undefined,
        linked_file: newLink.type === 'vault_doc' ? newLink.url.trim() : undefined,
        pinned: true,
      })
      setNewLink({ title: '', url: '', type: 'external' })
      setShowAddLink(false)
      load()
    } catch (err) {
      console.error('Failed to add bookmark:', err)
    }
  }

  const handleDeleteBookmark = async (id: string) => {
    try {
      await bulletinApi.delete(id)
      load()
    } catch (err) {
      console.error('Failed to delete bookmark:', err)
    }
  }

  const handleAddSticky = async () => {
    if (!newSticky.content.trim()) return
    try {
      await bulletinApi.create({
        category: 'sticky',
        title: newSticky.title.trim() || 'note',
        content: newSticky.content.trim(),
        metadata: { color: newSticky.color },
        pinned: true,
      })
      setNewSticky({ title: '', content: '', color: '#f0b35e' })
      setShowAddSticky(false)
      load()
    } catch (err) {
      console.error('Failed to add sticky:', err)
    }
  }

  const handleDeleteSticky = async (id: string) => {
    try {
      await bulletinApi.delete(id)
      load()
    } catch (err) {
      console.error('Failed to delete sticky:', err)
    }
  }

  const handleResizeSticky = async (id: string, size: string) => {
    const sticky = stickies.find(s => s.id === id)
    if (!sticky) return
    const meta = (sticky.metadata as any) ?? {}
    try {
      await bulletinApi.update(id, { metadata: { ...meta, size } })
      load()
    } catch (err) {
      console.error('Failed to resize sticky:', err)
    }
  }

  const stickies = data.stickies ?? []

  return (
    <div className="flex flex-col h-full bg-[#0e0c10] text-[#e7dfd3] overflow-y-auto"
         style={{ fontFamily: '"Share Tech Mono", monospace' }}>
      <div className="max-w-[1400px] w-full mx-auto px-6 py-5 space-y-5">

        {/* ── Quick Links ────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px] uppercase tracking-[0.12em] text-[#8d8188]">quick links</span>
          </div>
          <div className="space-y-2">
            {data.bookmarks.map(b => (
              <BookmarkChip key={b.id} bookmark={b} onDelete={handleDeleteBookmark}
                            onNavigate={onNavigate} />
            ))}
            {!showAddLink ? (
              <div
                className="torn-paper bg-[#191619] cursor-pointer w-full
                           hover:bg-[#1e1a20] transition-colors"
                onClick={() => setShowAddLink(true)}
                style={{
                  transform: 'rotate(0.3deg)',
                  boxShadow: '3px 4px 0 rgba(0,0,0,0.8)',
                }}
              >
                <div className="flex items-center gap-3 px-3 py-2 text-[#8d8188] hover:text-[#6bc5e8]">
                  <span className="text-[12px]">+</span>
                  <span className="text-[11px]">add link</span>
                </div>
              </div>
            ) : (
              <div
                className="torn-paper bg-[#191619] w-full"
                style={{
                  transform: 'rotate(-0.3deg)',
                  boxShadow: '3px 4px 0 rgba(0,0,0,0.8)',
                }}
              >
                <div className="px-3 py-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={newLink.type}
                      onChange={e => setNewLink(p => ({ ...p, type: e.target.value as any }))}
                      className="bg-[#141018] text-[11px] text-[#8d8188] outline-none border border-[#3a3340] px-2 py-1"
                    >
                      <option value="external">🔗 URL</option>
                      <option value="vault_doc">📄 Vault</option>
                    </select>
                    <input
                      placeholder="title"
                      value={newLink.title}
                      onChange={e => setNewLink(p => ({ ...p, title: e.target.value }))}
                      className="flex-1 bg-[#141018] text-[11px] text-[#e7dfd3] outline-none border border-[#3a3340] px-2 py-1"
                      autoFocus
                    />
                    <input
                      placeholder={newLink.type === 'external' ? 'https://...' : 'path/to/file.md'}
                      value={newLink.url}
                      onChange={e => setNewLink(p => ({ ...p, url: e.target.value }))}
                      className="flex-1 bg-[#141018] text-[11px] text-[#e7dfd3] outline-none border border-[#3a3340] px-2 py-1"
                    />
                    <button onClick={handleAddBookmark}
                            className="text-[11px] text-[#6bc5e8] hover:underline shrink-0">save</button>
                    <button onClick={() => { setShowAddLink(false); setNewLink({ title: '', url: '', type: 'external' }) }}
                            className="text-[11px] text-[#8d8188] hover:underline shrink-0">×</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Sticky Notes ──────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px] uppercase tracking-[0.12em] text-[#8d8188]">sticky notes</span>
          </div>
          <div style={{ columns: 'auto 180px', columnGap: '12px' }}>
            {stickies.map(s => (
              <div key={s.id} style={{ breakInside: 'avoid', marginBottom: '12px' }}>
                <StickyNote sticky={s} onDelete={handleDeleteSticky} onResize={handleResizeSticky} />
              </div>
            ))}
            <div style={{ breakInside: 'avoid', marginBottom: '12px' }}>
              {!showAddSticky ? (
                <button
                  onClick={() => setShowAddSticky(true)}
                  className="w-full h-[80px] border border-dashed border-[#3a3340] text-[#8d8188]
                             text-[11px] flex items-center justify-center
                             hover:border-[#f0b35e] hover:text-[#f0b35e] transition-colors"
                >
                  + new note
                </button>
              ) : (
                <div className="border-[2px] border-black bg-[#191619] p-3 space-y-2
                                shadow-[3px_4px_0_rgba(0,0,0,0.8)]">
                  <input
                    placeholder="title (optional)"
                    value={newSticky.title}
                    onChange={e => setNewSticky(p => ({ ...p, title: e.target.value }))}
                    className="w-full bg-transparent text-[11px] text-[#e7dfd3] outline-none
                               border-b border-[#3a3340] pb-1"
                  />
                  <textarea
                    placeholder="write a note..."
                    value={newSticky.content}
                    onChange={e => setNewSticky(p => ({ ...p, content: e.target.value }))}
                    className="w-full bg-transparent text-[11px] text-[#e7dfd3] outline-none resize-none h-16"
                  />
                  <div className="flex items-center gap-2">
                    {['#f0b35e', '#6bc5e8', '#7ecfa8', '#c0392b'].map(c => (
                      <button
                        key={c}
                        onClick={() => setNewSticky(p => ({ ...p, color: c }))}
                        className="w-4 h-4 rounded-full border-2 transition-transform"
                        style={{
                          backgroundColor: c,
                          borderColor: newSticky.color === c ? '#e7dfd3' : 'transparent',
                          transform: newSticky.color === c ? 'scale(1.2)' : 'scale(1)',
                        }}
                      />
                    ))}
                    <div className="flex-1" />
                    <button onClick={handleAddSticky}
                            className="text-[10px] text-[#6bc5e8] hover:underline">save</button>
                    <button onClick={() => setShowAddSticky(false)}
                            className="text-[10px] text-[#8d8188] hover:underline">cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Leader Lanes ───────────────────────────────────── */}
        <section>
          <div className="text-[11px] uppercase tracking-[0.12em] text-[#8d8188] mb-3">leader lanes</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {leaders.map(leader => (
              <LeaderCard
                key={leader.id}
                leader={leader}
                subordinates={subsByLeader.get(leader.id) ?? []}
                tasksByAgent={tasksByAgent}
              />
            ))}
            {leaders.length === 0 && (
              <div className="col-span-3 text-center text-[#8d8188] text-[12px] py-8">
                no leader agents found — create coordinator, tech-lead, and ops agents
              </div>
            )}
          </div>
        </section>

        {/* ── Recent Activity ────────────────────────────────── */}
        {data.recentActivity.length > 0 && (
          <section>
            <div className="text-[11px] uppercase tracking-[0.12em] text-[#8d8188] mb-3">
              recent activity
            </div>
            <div className="space-y-1">
              {data.recentActivity.map((act, i) => (
                <div key={i} className="flex items-baseline gap-3 text-[11px]">
                  <span className="text-[#8d8188] shrink-0">
                    {new Date(act.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-[#6bc5e8] shrink-0">{act.agent_name}</span>
                  <span className="text-[#c8bfb3] truncate">{act.content}</span>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function BookmarkChip({ bookmark, onDelete, onNavigate }: {
  bookmark: Bulletin
  onDelete: (id: string) => void
  onNavigate?: (page: string, data?: any) => void
}) {
  const handleClick = () => {
    if (bookmark.linked_url) {
      window.open(bookmark.linked_url, '_blank', 'noopener')
    } else if (bookmark.linked_file && onNavigate) {
      onNavigate('memory', { file: bookmark.linked_file })
    }
  }

  // Deterministic slight rotation for doodle feel
  const hash = bookmark.id.charCodeAt(0) + bookmark.id.charCodeAt(bookmark.id.length - 1)
  const rotation = ((hash % 5) - 2) * 0.4  // range: -0.8 to 0.8 degrees

  return (
    <div
      className="torn-paper group relative bg-[#191619] cursor-pointer
                  transition-all duration-150 hover:z-10 hover:bg-[#1e1a20] w-full"
      onClick={handleClick}
      style={{
        transform: `rotate(${rotation}deg)`,
        boxShadow: '3px 4px 0 rgba(0,0,0,0.8)',
      }}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="text-[12px] shrink-0">
          {bookmark.linked_file ? '📄' : '🔗'}
        </span>
        <span className="text-[12px] text-[#e7dfd3] font-bold truncate flex-1">
          {bookmark.title}
        </span>
        {(bookmark.linked_url || bookmark.linked_file) && (
          <span className="text-[10px] text-[#4a4048] truncate max-w-[200px] hidden sm:inline">
            {bookmark.linked_url || bookmark.linked_file}
          </span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onDelete(bookmark.id) }}
          className="text-[10px] text-[#8d8188] opacity-0 shrink-0
                     group-hover:opacity-100 hover:text-[#c0392b] transition-opacity"
        >
          ×
        </button>
      </div>
    </div>
  )
}

function LeaderCard({ leader, subordinates, tasksByAgent }: {
  leader: DashboardAgent
  subordinates: DashboardAgent[]
  tasksByAgent: Map<string, DashboardTask[]>
}) {
  const leaderTasks = tasksByAgent.get(leader.id) ?? []
  const statusColor = STATUS_COLORS[leader.status] ?? STATUS_COLORS.offline
  const isOps = leader.role === 'ops'

  return (
    <div className="border-[3px] border-black bg-[#191619] shadow-[4px_5px_0_rgba(0,0,0,0.9)]">
      {/* Header */}
      <div className="border-b-[3px] border-black bg-[#1e1a20] px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-[14px] text-[#e7dfd3] font-bold">{leader.name}</div>
          <div className="text-[10px] text-[#8d8188] uppercase tracking-wider">
            {ROLE_LABELS[leader.role] ?? leader.role}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
          <span className="text-[10px]" style={{ color: statusColor }}>{leader.status}</span>
        </div>
      </div>

      {/* Leader's current tasks */}
      <div className="px-4 py-3 space-y-2">
        {leaderTasks.length > 0 ? (
          <>
            <div className="text-[10px] text-[#8d8188] uppercase tracking-wider">focus</div>
            {leaderTasks.slice(0, 3).map(t => (
              <TaskMini key={t.id} task={t} />
            ))}
          </>
        ) : (
          <div className="text-[11px] text-[#8d8188] italic">no active tasks</div>
        )}
      </div>

      {/* Subordinates / monitoring */}
      {(subordinates.length > 0 || isOps) && (
        <div className="border-t border-[#2a2530] px-4 py-3 space-y-2">
          <div className="text-[10px] text-[#8d8188] uppercase tracking-wider">
            {isOps ? 'monitoring' : 'agents'}
          </div>
          {isOps && subordinates.length === 0 ? (
            <OpsMonitorBlock agents={[]} />
          ) : (
            subordinates.map(sub => {
              const subTasks = tasksByAgent.get(sub.id) ?? []
              const sc = STATUS_COLORS[sub.status] ?? STATUS_COLORS.offline
              return (
                <div key={sub.id} className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: sc }} />
                  <span className="text-[11px] text-[#e7dfd3] shrink-0">{sub.name}</span>
                  <span className="text-[10px] text-[#8d8188] truncate">
                    {subTasks[0]?.title ?? sub.status}
                  </span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

function OpsMonitorBlock({ agents: _agents }: { agents: DashboardAgent[] }) {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex justify-between text-[#8d8188]">
        <span>system status</span>
        <span className="text-[#7ecfa8]">nominal</span>
      </div>
    </div>
  )
}

const SIZE_CYCLE = ['s', 'm', 'l'] as const
const SIZE_STYLES: Record<string, string> = {
  s: 'max-h-[80px] overflow-hidden',
  m: '',
  l: 'min-h-[200px]',
}

function StickyNote({ sticky, onDelete, onResize }: {
  sticky: Bulletin
  onDelete: (id: string) => void
  onResize: (id: string, size: string) => void
}) {
  const meta = sticky.metadata as any ?? {}
  const color = meta.color ?? '#f0b35e'
  const size = meta.size ?? 'm'
  const sizeClass = SIZE_STYLES[size] ?? ''

  // Deterministic slight rotation based on id for doodle feel
  const hash = sticky.id.charCodeAt(0) + sticky.id.charCodeAt(sticky.id.length - 1)
  const rotation = ((hash % 5) - 2) * 0.6  // range: -1.2 to 1.2 degrees

  const cycleSize = () => {
    const idx = SIZE_CYCLE.indexOf(size)
    const next = SIZE_CYCLE[(idx + 1) % SIZE_CYCLE.length]
    onResize(sticky.id, next)
  }

  return (
    <div className={`group relative w-full min-h-[40px] border-[2px] border-black p-3
                    shadow-[3px_4px_0_rgba(0,0,0,0.8)] hover:shadow-[5px_6px_0_rgba(0,0,0,0.9)]
                    transition-all duration-150 hover:z-10 ${sizeClass}`}
         style={{
           backgroundColor: '#191619',
           borderTopColor: color,
           borderTopWidth: '3px',
           transform: `rotate(${rotation}deg)`,
         }}>
      {sticky.title && sticky.title !== 'note' && (
        <div className="text-[11px] font-bold mb-1" style={{ color }}>{sticky.title}</div>
      )}
      <div className="text-[11px] text-[#c8bfb3] whitespace-pre-wrap break-words">
        {sticky.content}
      </div>
      <div className="absolute top-1 right-2 flex items-center gap-1.5">
        <span className="text-[10px] text-[#8d8188]">
          {new Date(sticky.created_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="absolute bottom-1 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={cycleSize}
          className="text-[10px] text-[#8d8188] hover:text-[#6bc5e8] uppercase"
          title="Resize: S/M/L"
        >
          {size}
        </button>
        <button
          onClick={() => onDelete(sticky.id)}
          className="text-[10px] text-[#8d8188] hover:text-[#c0392b]"
        >
          ×
        </button>
      </div>
    </div>
  )
}

function TaskMini({ task }: { task: DashboardTask }) {
  const st = TASK_STATUS_LABELS[task.status] ?? { label: task.status, color: '#8d8188' }
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] px-1 border shrink-0"
            style={{ color: st.color, borderColor: st.color }}>
        {st.label}
      </span>
      <span className="text-[11px] text-[#c8bfb3] truncate">
        {task.display_number && <span className="text-[#6bc5e8]">{task.display_number} </span>}
        {task.title}
      </span>
    </div>
  )
}

