// Red Shrimp Lab — Tasks Board (connected to backend)

import { useEffect, useRef, useState } from 'react'
import { agentsApi, tasksApi, channelsApi, type Task, type TaskDoc, type TaskFeedback, type Channel, type Agent } from '../lib/api'
import { socketClient } from '../lib/socket'

const columns = [
  { key: 'open',        label: 'Unassigned',  color: '#2a2622', textColor: '#9a8888' },
  { key: 'claimed',     label: 'Assigned',    color: '#2a1a35', textColor: '#b08cd9' },
  { key: 'in_progress', label: 'In Progress', color: '#1a2535', textColor: '#6bc5e8' },
  { key: 'reviewing',   label: 'In Review',   color: '#352515', textColor: '#f0b35e' },
  { key: 'completed',   label: 'Done',        color: '#1e2e26', textColor: '#7ecfa8' },
] as const

type ColKey = typeof columns[number]['key']

interface HierarchyOption {
  agent: Agent
  depth: number
}

function pickDefaultTaskOwner(agents: Agent[]): string {
  return agents.find(agent => agent.name.toLowerCase() === 'donovan')?.id
    ?? agents.find(agent => !agent.parent_agent_id)?.id
    ?? agents[0]?.id
    ?? ''
}

function sortAgentsByHierarchy(agents: Agent[]): HierarchyOption[] {
  const byParent = new Map<string | null, Agent[]>()
  for (const agent of agents) {
    const key = agent.parent_agent_id ?? null
    const current = byParent.get(key) ?? []
    current.push(agent)
    byParent.set(key, current)
  }

  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  const rootAgents = byParent.get(null) ?? []
  const visited = new Set<string>()
  const ordered: HierarchyOption[] = []

  const walk = (agent: Agent, depth: number) => {
    if (visited.has(agent.id)) return
    visited.add(agent.id)
    ordered.push({ agent, depth })
    for (const child of byParent.get(agent.id) ?? []) {
      walk(child, depth + 1)
    }
  }

  for (const root of rootAgents) walk(root, 0)
  for (const agent of agents) {
    if (!visited.has(agent.id)) walk(agent, 0)
  }
  return ordered
}

function formatHierarchyLabel(option: HierarchyOption): string {
  const prefix = option.depth > 0 ? `${'— '.repeat(option.depth)}` : ''
  const role = option.agent.role ? ` · ${option.agent.role}` : ''
  return `${prefix}${option.agent.name}${role}`
}

function parseSubtaskLines(text: string, agents: Agent[]) {
  const agentByName = new Map(
    agents.map(agent => [agent.name.trim().toLowerCase(), agent])
  )
  const subtasks: Array<{ title: string; assigneeAgentId?: string }> = []
  const errors: string[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const match = line.match(/^@([^\s:：-]+)\s*[:：-]?\s+(.+)$/)
    if (!match) {
      subtasks.push({ title: line })
      continue
    }

    const assignee = agentByName.get(match[1].trim().toLowerCase())
    if (!assignee) {
      errors.push(`Unknown subtask assignee: @${match[1]}`)
      continue
    }

    subtasks.push({
      title: match[2].trim(),
      assigneeAgentId: assignee.id,
    })
  }

  return { subtasks, errors }
}

export default function TasksBoard({ onOpenDoc }: { onOpenDoc?: (docPath: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [channelId, setChannelId] = useState<string | undefined>()
  const [channels, setChannels] = useState<Channel[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newChannelId, setNewChannelId] = useState('')
  const [creating, setCreating] = useState(false)
  const [todoSummary, setTodoSummary] = useState('')
  const [subtasksText, setSubtasksText] = useState('')
  const [todoOwnerAgentId, setTodoOwnerAgentId] = useState('')
  const [todoCleanLevel, setTodoCleanLevel] = useState('待确认')
  const [todoDueDate, setTodoDueDate] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const agentOptions = sortAgentsByHierarchy(agents)

  const reload = () => {
    if (!channelId) {
      setTasks([])
      return Promise.resolve()
    }
    return tasksApi.list(channelId).then(({ tasks: t }) => setTasks(t)).catch(() => {})
  }

  useEffect(() => {
    reload()
    channelsApi.list().then(chs => {
      setChannels(chs)
      const defaultChannel = chs.find(ch => ch.name === 'all') ?? chs[0]
      if (!defaultChannel) return
      if (!channelId) setChannelId(defaultChannel.id)
      if (!newChannelId) setNewChannelId(defaultChannel.id)
    }).catch(() => {})
    agentsApi.list().then(list => {
      setAgents(list)
      setTodoOwnerAgentId(prev => prev || pickDefaultTaskOwner(list))
    }).catch(() => {})

    const unsub = socketClient.on('task:updated', () => reload())
    const unsub2 = socketClient.on('task:completed', () => reload())
    return () => { unsub(); unsub2() }
  }, [channelId])

  useEffect(() => {
    if (showNew) setTimeout(() => inputRef.current?.focus(), 50)
  }, [showNew])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title || !newChannelId || !todoOwnerAgentId) return
    setCreating(true)
    setCreateError(null)
    try {
      const { subtasks, errors } = parseSubtaskLines(subtasksText, agents)
      if (errors.length > 0) {
        setCreateError(errors.join(' | '))
        return
      }
      await tasksApi.intake({
        channelId: newChannelId,
        title,
        summary: todoSummary.trim() || undefined,
        ownerAgentId: todoOwnerAgentId || undefined,
        cleanLevel: todoCleanLevel.trim() || undefined,
        dueDate: todoDueDate || undefined,
        subtasks,
      })
      setNewTitle('')
      setTodoSummary('')
      setSubtasksText('')
      setTodoOwnerAgentId(pickDefaultTaskOwner(agents))
      setTodoCleanLevel('待确认')
      setTodoDueDate('')
      setShowNew(false)
      reload()
    } catch (e: any) {
      console.error('Failed to create task:', e)
      setCreateError(e?.message ?? 'Failed to create task')
    } finally {
      setCreating(false)
    }
  }

  const markDocRead = async (taskId: string, docId: string) => {
    await tasksApi.markDocRead(taskId, docId)
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t
      return {
        ...t,
        docs: t.docs?.map(d => d.id === docId ? { ...d, status: 'read' as const } : d),
      }
    }))
  }

  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] p-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 10% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 90% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">
            # {channels.find(ch => ch.id === channelId)?.name ?? 'channel'}
          </div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">task board</div>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={channelId ?? ''}
            onChange={e => {
              setChannelId(e.target.value)
              if (!newChannelId) setNewChannelId(e.target.value)
            }}
            className="rsl-control rsl-select bg-[#0e0c10] border-[3px] border-black text-[#9a8888] text-[11px] px-3 py-2 outline-none"
          >
            {channels.map(ch => (
              <option key={ch.id} value={ch.id}>#{ch.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNew(v => !v)}
            className="border-[3px] border-black bg-[#c0392b] text-black text-[12px] uppercase px-4 py-2 hover:bg-[#e04050]"
            style={{ transform: 'rotate(0.2deg)' }}
          >
            + new task
          </button>
        </div>
      </div>

      {/* New task form */}
      {showNew && (
        <div
          className="border-[3px] border-black bg-[#1e1a20] mb-5 p-4 flex flex-col gap-3"
          style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.85)' }}
        >
          <input
            ref={inputRef}
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') setShowNew(false)
            }}
            placeholder="task title..."
            className="bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[13px] px-3 py-2 outline-none focus:border-[#c0392b] placeholder:text-[#4a4048] w-full"
          />
          <textarea
            value={todoSummary}
            onChange={e => setTodoSummary(e.target.value)}
            placeholder="todo summary / user request..."
            rows={3}
            className="bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[12px] px-3 py-2 outline-none focus:border-[#c0392b] placeholder:text-[#4a4048] w-full resize-none"
          />
          <textarea
            value={subtasksText}
            onChange={e => setSubtasksText(e.target.value)}
            placeholder={"subtasks, one per line...\nread code\nwrite plan\nprepare review summary"}
            rows={4}
            className="bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[12px] px-3 py-2 outline-none focus:border-[#c0392b] placeholder:text-[#4a4048] w-full resize-none"
          />
          <div className="flex items-center gap-3">
            <select
              value={newChannelId}
              onChange={e => setNewChannelId(e.target.value)}
              className="rsl-control rsl-select bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[11px] px-2 py-1 outline-none flex-1"
            >
              {channels.map(ch => (
                <option key={ch.id} value={ch.id}>#{ch.name}</option>
              ))}
            </select>
            <select
              value={todoOwnerAgentId}
              onChange={e => setTodoOwnerAgentId(e.target.value)}
              className="rsl-control rsl-select bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[11px] px-2 py-1 outline-none flex-1"
            >
              {!agents.length && <option value="">no agents</option>}
              {agentOptions.map(option => (
                <option key={option.agent.id} value={option.agent.id}>{formatHierarchyLabel(option)}</option>
              ))}
            </select>
            <input
              value={todoCleanLevel}
              onChange={e => setTodoCleanLevel(e.target.value)}
              placeholder="agent memory clean level"
              className="bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[11px] px-2 py-1 outline-none flex-1"
            />
            <input
              type="date"
              value={todoDueDate}
              onChange={e => setTodoDueDate(e.target.value)}
              className="bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[11px] px-2 py-1 outline-none"
              title="due date"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newTitle.trim() || !todoOwnerAgentId}
              className="border-[3px] border-black bg-[#c0392b] text-black text-[12px] uppercase px-4 py-1 hover:bg-[#e04050] disabled:opacity-40"
            >
              {creating ? '...' : 'intake'}
            </button>
            <button
              onClick={() => setShowNew(false)}
              className="text-[#4a4048] text-[12px] hover:text-[#9a8888]"
            >
              cancel
            </button>
          </div>
          <div className="text-[10px] text-[#4a4048] leading-4">
            推荐把 root task 先指给上级 agent，再由它沿汇报关系向下分派。subtasks 支持 `@AgentName task title`，例如 `@Akara fix daemon restart`.
          </div>
          {createError && (
            <div className="border-[2px] border-[#c0392b] bg-[#2a1116] px-3 py-2 text-[11px] text-[#f3b0b0]">
              {createError}
            </div>
          )}
        </div>
      )}

      {/* Kanban columns */}
      <div className="grid grid-cols-5 gap-3 items-start">
        {columns.map((col) => {
          const colTasks = tasks.filter(t => t.status === col.key)
          return (
            <div key={col.key} className="flex flex-col gap-3">
              {/* Column header */}
              <div
                className="border-[3px] border-black px-4 py-2 flex items-center justify-between"
                style={{ background: col.color }}
              >
                <span className="text-[13px] uppercase" style={{ color: col.textColor }}>
                  {col.label}
                </span>
                <span
                  className="border-[2px] border-black text-[12px] px-2"
                  style={{ background: col.color, color: col.textColor }}
                >
                  {colTasks.length}
                </span>
              </div>

              {/* Cards */}
              {colTasks.map((task, i) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  cardIndex={i}
                  onMarkDocRead={markDocRead}
                  onTaskChanged={reload}
                  onOpenDoc={onOpenDoc}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Deterministic wobble values per card index — wide range for handmade scattered look
const WOBBLE = [
  { rotate: '-2.1deg',  tx: '-1px', ty: '1px',  shadow: '4px 5px 0 rgba(0,0,0,0.9)' },
  { rotate:  '1.4deg',  tx:  '2px', ty: '-1px', shadow: '3px 5px 0 rgba(0,0,0,0.85)' },
  { rotate: '-0.8deg',  tx: '-2px', ty:  '2px', shadow: '5px 4px 0 rgba(0,0,0,0.9)' },
  { rotate:  '2.5deg',  tx:  '1px', ty:  '1px', shadow: '3px 6px 0 rgba(0,0,0,0.8)' },
  { rotate: '-1.6deg',  tx:  '2px', ty: '-2px', shadow: '4px 4px 0 rgba(0,0,0,0.88)' },
  { rotate:  '0.6deg',  tx: '-1px', ty:  '2px', shadow: '5px 5px 0 rgba(0,0,0,0.85)' },
  { rotate: '-2.8deg',  tx:  '1px', ty: '-1px', shadow: '3px 5px 0 rgba(0,0,0,0.9)' },
  { rotate:  '1.9deg',  tx: '-2px', ty:  '1px', shadow: '4px 6px 0 rgba(0,0,0,0.82)' },
]

function TaskCard({
  task, cardIndex, onMarkDocRead, onTaskChanged, onOpenDoc,
}: {
  task: Task
  cardIndex: number
  onMarkDocRead: (taskId: string, docId: string) => void
  onTaskChanged: () => void
  onOpenDoc?: (docPath: string) => void
}) {
  const [showDocForm, setShowDocForm] = useState(false)
  const [docPath, setDocPath] = useState('')
  const [linkingDoc, setLinkingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [showFeedbackForm, setShowFeedbackForm] = useState(false)
  const [feedbackVerdict, setFeedbackVerdict] = useState<'accept' | 'reject' | 'revise'>('accept')
  const [feedbackCategory, setFeedbackCategory] = useState('')
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbacks, setFeedbacks] = useState<TaskFeedback[]>([])
  const [showFeedbacks, setShowFeedbacks] = useState(false)
  const wobble = WOBBLE[cardIndex % WOBBLE.length]

  const runAction = async (action: 'start' | 'review' | 'complete' | 'reject') => {
    if (acting) return
    let rejectionMessage: string | null = null
    if (action === 'reject') {
      const raw = window.prompt(`Leave a rejection note for #t${task.number}.`)
      if (raw === null) return
      rejectionMessage = raw.trim()
      if (!rejectionMessage) {
        window.alert('Rejection note is required.')
        return
      }
    }
    setActing(action)
    try {
      if (action === 'start') await tasksApi.start(task.id)
      if (action === 'review') await tasksApi.submitReview(task.id)
      if (action === 'complete') await tasksApi.complete(task.id)
      if (action === 'reject') await tasksApi.reject(task.id, rejectionMessage ?? '')
      await onTaskChanged()
    } catch (err) {
      console.error(`Failed to ${action} task:`, err)
    } finally {
      setActing(null)
    }
  }

  const submitDoc = async () => {
    const normalizedPath = docPath.trim()
    if (!normalizedPath || linkingDoc) return

    setLinkingDoc(true)
    setDocError(null)
    try {
      await tasksApi.addDoc(task.id, normalizedPath)
      setDocPath('')
      setShowDocForm(false)
      onTaskChanged()
    } catch (err: any) {
      console.error('Failed to link task document:', err)
      setDocError(err?.message ?? 'Failed to link task document')
    } finally {
      setLinkingDoc(false)
    }
  }

  const submitFeedback = async () => {
    setActing('feedback')
    try {
      await tasksApi.addFeedback(task.id, {
        verdict: feedbackVerdict,
        reasonCategory: feedbackCategory || undefined,
        reasonText: feedbackText.trim() || undefined,
      })
      setShowFeedbackForm(false)
      setFeedbackText('')
      setFeedbackCategory('')
      loadFeedbacks()
      onTaskChanged()
    } catch (err) {
      console.error('Failed to submit feedback:', err)
    } finally {
      setActing(null)
    }
  }

  const loadFeedbacks = async () => {
    try {
      const { feedbacks: fb } = await tasksApi.getFeedback(task.id)
      setFeedbacks(fb)
    } catch { /* ignore */ }
  }

  const deleteTask = async () => {
    if (acting) return
    const confirmed = window.confirm(`Permanently delete #t${task.number} "${task.title}"? This cannot be undone.`)
    if (!confirmed) return

    setActing('delete')
    try {
      await tasksApi.remove(task.id)
      await onTaskChanged()
    } catch (err) {
      console.error('Failed to delete task:', err)
    } finally {
      setActing(null)
    }
  }

  return (
    <div
      className="border-[3px] border-black bg-[#191619] transition-transform hover:rotate-0 relative"
      style={{
        transform: `rotate(${wobble.rotate}) translate(${wobble.tx}, ${wobble.ty})`,
        boxShadow: `${wobble.shadow}, 0 0 10px rgba(50,120,220,0.10)`,
        clipPath: 'polygon(0% 0%, calc(100% - 18px) 0%, 100% 18px, 100% 100%, 0% 100%)',
      }}
    >
      {/* Fold triangle */}
      <div
        className="absolute top-0 right-0 w-[18px] h-[18px] z-10 border-l border-b border-black/40"
        style={{ background: 'linear-gradient(135deg, transparent 50%, #2a2628 50%)' }}
      />
      {/* Title bar */}
      <div className="border-b-[3px] border-black px-3 py-2 bg-[#1e1a20]">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-[#4a4048] uppercase">#t{task.number}</span>
          {task.parent_task_number && (
            <span className="text-[9px] text-[#6bc5e8] bg-[#1a2535] border border-[#6bc5e8]/30 px-1.5 py-0">
              ↑ #t{task.parent_task_number}
            </span>
          )}
          {task.is_candidate && (
            <span className="text-[9px] text-[#f0b35e] bg-[#352515] border border-[#f0b35e]/30 px-1.5 py-0 uppercase">
              candidate
            </span>
          )}
          {(task as any).subtask_count > 0 && (
            <span className="text-[9px] text-[#3abfa0] bg-[#0f1a18] border border-[#3abfa0]/30 px-1.5 py-0">
              {(task as any).subtask_count} subtask{(task as any).subtask_count > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="text-[14px] leading-5">{task.title}</div>
        {task.estimated_minutes && (
          <div className="text-[10px] text-[#4a4048] mt-1">
            ⏱ est. {task.estimated_minutes >= 60 ? `${Math.round(task.estimated_minutes / 60)}h` : `${task.estimated_minutes}m`}
            {task.started_at && (() => {
              const elapsed = Math.round((Date.now() - new Date(task.started_at).getTime()) / 60000)
              const overdue = elapsed > task.estimated_minutes!
              return (
                <span style={{ color: overdue ? '#c0392b' : '#9a8888' }}>
                  {' '}· {elapsed >= 60 ? `${Math.round(elapsed / 60)}h` : `${elapsed}m`} elapsed
                  {overdue && ' (overdue)'}
                </span>
              )
            })()}
          </div>
        )}
        <div className="text-[10px] text-[#4a4048] mt-1 flex items-center gap-2 flex-wrap">
          <span>{new Date(task.created_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} created</span>
          {task.due_date && (() => {
            const due = new Date(task.due_date)
            const now = new Date()
            now.setHours(0, 0, 0, 0)
            const isOverdue = due < now && task.status !== 'completed'
            const isSoon = !isOverdue && due.getTime() - now.getTime() <= 2 * 86400000 && task.status !== 'completed'
            return (
              <span style={{ color: isOverdue ? '#c0392b' : isSoon ? '#f0b35e' : '#9a8888' }}>
                due {due.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                {isOverdue && ' (overdue)'}
              </span>
            )
          })()}
        </div>
      </div>

      {/* Agent */}
      {task.claimed_by_name ? (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13] flex items-center gap-2">
          <span className="w-2 h-2 bg-[#c0392b] border border-black" />
          <span className="text-[12px] text-[#6bc5e8]">
            {task.claimed_by_type === 'agent' ? '@' : ''}
            {task.claimed_by_name}
          </span>
        </div>
      ) : (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13]">
          <span className="text-[12px] text-[#4a4048]">needs assignment</span>
        </div>
      )}

      {/* Linked docs — inline card chips */}
      {task.docs && task.docs.length > 0 && (
        <div className="border-b-[3px] border-black px-3 py-2 bg-[#160f14]">
          <div className="text-[10px] text-[#4a4048] uppercase mb-2">linked docs</div>
          <div className="flex flex-wrap gap-1.5">
            {task.docs.map((doc) => {
              const borderColor = doc.status === 'unread' ? '#4A90D9' : doc.status === 'writing' ? '#D4A017' : '#3a3535'
              return (
                <div
                  key={doc.id}
                  className="cursor-pointer group flex items-center gap-1.5 px-2 py-1 border-[2px] border-black hover:border-[#f0b35e] transition-colors"
                  style={{
                    background: '#120f13',
                    boxShadow: '1px 1px 0 rgba(0,0,0,0.4)',
                  }}
                  onClick={() => {
                    if (doc.status === 'unread') onMarkDocRead(task.id, doc.id)
                    if (onOpenDoc) onOpenDoc(doc.doc_path)
                  }}
                >
                  <span className="w-1.5 h-1.5 shrink-0 border border-black" style={{ background: borderColor }} />
                  <span className="text-[10px] text-[#c8bdb8] truncate max-w-[120px] group-hover:text-[#f0b35e]" title={doc.doc_path}>
                    {doc.doc_path.split('/').pop()?.replace(/\.md$/, '')}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Skills */}
      {task.skills && task.skills.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1">
          {task.skills.map((skill) => (
            <span
              key={skill}
              className="border-[2px] border-black text-[10px] px-2 py-0.5 bg-[#0f1a18] text-[#3abfa0]"
            >
              {skill}
            </span>
          ))}
        </div>
      )}

      <div className="border-t-[3px] border-black px-3 py-2 bg-[#141018]">
        <div className="mb-2 flex flex-wrap gap-2">
          {task.status === 'claimed' && task.claimed_by_type === 'human' && (
            <ActionButton label="start" busy={acting === 'start'} onClick={() => runAction('start')} />
          )}
          {task.status === 'in_progress' && task.claimed_by_type === 'human' && (
            <ActionButton label="review" busy={acting === 'review'} onClick={() => runAction('review')} />
          )}
          {task.status === 'reviewing' && (
            <>
              <ActionButton label="complete" busy={acting === 'complete'} onClick={() => runAction('complete')} />
              <ActionButton label="reject" busy={acting === 'reject'} onClick={() => runAction('reject')} />
            </>
          )}
          {task.status === 'open' && (
            <span className="text-[10px] uppercase text-[#9a8888]">explicit assignment required</span>
          )}
          {task.is_candidate && (
            <ActionButton label="approve" busy={acting === 'approve'} onClick={async () => {
              setActing('approve')
              try {
                await tasksApi.approve(task.id)
                onTaskChanged()
              } catch { /* ignore */ }
              setActing(null)
            }} />
          )}
          <ActionButton label="feedback" busy={false} onClick={() => setShowFeedbackForm(v => !v)} />
          <ActionButton label={showFeedbacks ? 'hide history' : 'history'} busy={false} onClick={() => {
            if (!showFeedbacks) loadFeedbacks()
            setShowFeedbacks(v => !v)
          }} />
        </div>

        {/* Feedback form */}
        {showFeedbackForm && (
          <div className="mb-2 border-[2px] border-black bg-[#1a1520] p-2 space-y-2">
            <div className="flex gap-2">
              {(['accept', 'reject', 'revise'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setFeedbackVerdict(v)}
                  className={`border-[2px] border-black text-[10px] uppercase px-2 py-0.5 ${
                    feedbackVerdict === v
                      ? v === 'accept' ? 'bg-[#1e2e26] text-[#7ecfa8]'
                      : v === 'reject' ? 'bg-[#2a1116] text-[#f3b0b0]'
                      : 'bg-[#352515] text-[#f0b35e]'
                      : 'bg-[#0e0c10] text-[#4a4048]'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            {feedbackVerdict !== 'accept' && (
              <select
                value={feedbackCategory}
                onChange={e => setFeedbackCategory(e.target.value)}
                className="rsl-control rsl-select w-full bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[10px] px-2 py-1 outline-none"
              >
                <option value="">reason category (optional)</option>
                <option value="skill_gap">skill_gap</option>
                <option value="prompt_gap">prompt_gap</option>
                <option value="bad_split">bad_split</option>
                <option value="missing_context">missing_context</option>
                <option value="execution_error">execution_error</option>
                <option value="permission_issue">permission_issue</option>
              </select>
            )}
            <input
              value={feedbackText}
              onChange={e => setFeedbackText(e.target.value)}
              placeholder="reason / comment..."
              className="w-full bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[10px] px-2 py-1 outline-none placeholder:text-[#4a4048]"
            />
            <div className="flex gap-2">
              <ActionButton label="submit" busy={acting === 'feedback'} onClick={submitFeedback} />
              <button onClick={() => setShowFeedbackForm(false)} className="text-[10px] text-[#4a4048] hover:text-[#9a8888] uppercase">cancel</button>
            </div>
          </div>
        )}

        {/* Feedback history */}
        {showFeedbacks && feedbacks.length > 0 && (
          <div className="mb-2 border-[2px] border-black bg-[#130f16] p-2 space-y-1">
            <div className="text-[10px] text-[#4a4048] uppercase mb-1">feedback history</div>
            {feedbacks.map(fb => (
              <div key={fb.id} className="text-[10px] border-b border-[#1e1a20] pb-1">
                <span className={
                  fb.verdict === 'accept' ? 'text-[#7ecfa8]'
                  : fb.verdict === 'reject' ? 'text-[#f3b0b0]'
                  : 'text-[#f0b35e]'
                }>
                  {fb.verdict}
                </span>
                <span className="text-[#4a4048]"> by {fb.reviewer_name}</span>
                {fb.reason_category && <span className="text-[#6bc5e8]"> [{fb.reason_category}]</span>}
                {fb.reason_text && <div className="text-[#9a8888] mt-0.5">{fb.reason_text}</div>}
                <div className="text-[#3a3438] text-[9px]">{new Date(fb.created_at).toLocaleString('zh-CN')}</div>
              </div>
            ))}
          </div>
        )}
        {showFeedbacks && feedbacks.length === 0 && (
          <div className="mb-2 text-[10px] text-[#4a4048]">no feedback yet</div>
        )}

        <button
          onClick={() => {
            setShowDocForm(v => !v)
            setDocError(null)
          }}
          className="w-full border-[2px] border-black bg-[#1c1810] text-[#f0b35e] text-[10px] uppercase px-2 py-1 hover:bg-[#2a2416] transition-colors"
        >
          {showDocForm ? 'hide doc link' : '+ link doc'}
        </button>
        <button
          onClick={deleteTask}
          disabled={acting === 'delete'}
          className="mt-2 w-full border-[2px] border-black bg-[#2b1114] text-[#f3b0b0] text-[10px] uppercase px-2 py-1 hover:bg-[#3a171b] transition-colors disabled:opacity-40"
        >
          {acting === 'delete' ? 'deleting...' : 'delete forever'}
        </button>
        {showDocForm && (
          <div className="mt-2 space-y-2">
            <input
              value={docPath}
              onChange={e => setDocPath(e.target.value)}
              placeholder="todos/xxx/plan.md"
              className="w-full bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[11px] px-2 py-1.5 outline-none focus:border-[#f0b35e] placeholder:text-[#4a4048]"
            />
            <div className="text-[10px] text-[#4a4048] leading-4">
              link an existing vault path into this task
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={submitDoc}
                disabled={linkingDoc || !docPath.trim()}
                className="border-[2px] border-black bg-[#d4a017] text-black text-[10px] uppercase px-3 py-1 hover:bg-[#e0b840] disabled:opacity-40"
              >
                {linkingDoc ? '...' : 'link'}
              </button>
              <button
                onClick={() => {
                  setShowDocForm(false)
                  setDocPath('')
                  setDocError(null)
                }}
                className="text-[10px] text-[#4a4048] hover:text-[#9a8888] uppercase"
              >
                cancel
              </button>
            </div>
            {docError && (
              <div className="border-[2px] border-[#c0392b] bg-[#2a1116] px-2 py-2 text-[10px] text-[#f3b0b0]">
                {docError}
              </div>
            )}
          </div>
        )}
        {task.review_feedback?.trim() && (
          <div className="mt-2 border-[2px] border-black bg-[#2a1116] px-2 py-2 text-[10px] text-[#f3c6bf]">
            <div className="uppercase text-[#f0b35e] mb-1">
              rejected by {task.review_feedback_by_name ?? 'reviewer'}
              {task.review_feedback_at ? ` · ${new Date(task.review_feedback_at).toLocaleString('zh-CN')}` : ''}
            </div>
            <div className="whitespace-pre-wrap break-words">{task.review_feedback}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function DocStatusDot({ status }: { status: TaskDoc['status'] }) {
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

function ActionButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="border-[2px] border-black bg-[#201a26] text-[#e7dfd3] text-[10px] uppercase px-2 py-1 hover:bg-[#2a2232] disabled:opacity-40"
    >
      {busy ? '...' : label}
    </button>
  )
}
