// Red Shrimp Lab — Tasks Board (connected to backend)

import { useEffect, useRef, useState } from 'react'
import { agentsApi, tasksApi, channelsApi, type Task, type TaskDoc, type Channel, type Agent } from '../lib/api'
import { socketClient } from '../lib/socket'

const columns = [
  { key: 'open',      label: 'Open',  color: '#2a2622', textColor: '#9a8888' },
  { key: 'claimed',   label: 'Doing', color: '#1a2535', textColor: '#6bc5e8' },
  { key: 'reviewing', label: 'Reviewing', color: '#352515', textColor: '#f0b35e' },
  { key: 'completed', label: 'Done',  color: '#1e2e26', textColor: '#7ecfa8' },
] as const

type ColKey = typeof columns[number]['key']

export default function TasksBoard() {
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
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = () =>
    tasksApi.list(channelId).then(({ tasks: t }) => setTasks(t)).catch(() => {})

  useEffect(() => {
    reload()
    channelsApi.list().then(chs => {
      setChannels(chs)
      if (!newChannelId && chs.length > 0) setNewChannelId(chs[0].id)
    }).catch(() => {})
    agentsApi.list().then(setAgents).catch(() => {})

    const unsub = socketClient.on('task:updated', () => reload())
    const unsub2 = socketClient.on('task:completed', () => reload())
    return () => { unsub(); unsub2() }
  }, [channelId])

  useEffect(() => {
    if (showNew) setTimeout(() => inputRef.current?.focus(), 50)
  }, [showNew])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title || !newChannelId) return
    setCreating(true)
    try {
      const subtasks = subtasksText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => ({ title: line }))
      await tasksApi.intake({
        channelId: newChannelId,
        title,
        summary: todoSummary.trim() || undefined,
        ownerAgentId: todoOwnerAgentId || undefined,
        cleanLevel: todoCleanLevel.trim() || undefined,
        subtasks,
      })
      setNewTitle('')
      setTodoSummary('')
      setSubtasksText('')
      setTodoOwnerAgentId('')
      setTodoCleanLevel('待确认')
      setShowNew(false)
      reload()
    } catch (e) {
      console.error('Failed to create task:', e)
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
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-5"
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
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1"># all</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">task board</div>
        </div>
        <button
          onClick={() => setShowNew(v => !v)}
          className="border-[3px] border-black bg-[#c0392b] text-black text-[12px] uppercase px-4 py-2 hover:bg-[#e04050]"
          style={{ transform: 'rotate(0.2deg)' }}
        >
          + new task
        </button>
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
              className="bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[11px] px-2 py-1 outline-none flex-1"
            >
              {channels.map(ch => (
                <option key={ch.id} value={ch.id}>#{ch.name}</option>
              ))}
            </select>
            <select
              value={todoOwnerAgentId}
              onChange={e => setTodoOwnerAgentId(e.target.value)}
              className="bg-[#0e0c10] border-[2px] border-black text-[#9a8888] text-[11px] px-2 py-1 outline-none flex-1"
            >
              <option value="">unassigned</option>
              {agents.map(agent => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <input
              value={todoCleanLevel}
              onChange={e => setTodoCleanLevel(e.target.value)}
              placeholder="memory clean level"
              className="bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[11px] px-2 py-1 outline-none flex-1"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newTitle.trim()}
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
        </div>
      )}

      {/* Kanban columns */}
      <div className="grid grid-cols-4 gap-4 items-start">
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
                  onAddMemoryNote={reload}
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
  task, cardIndex, onMarkDocRead, onAddMemoryNote,
}: {
  task: Task
  cardIndex: number
  onMarkDocRead: (taskId: string, docId: string) => void
  onAddMemoryNote: () => void
}) {
  const [showNoteForm, setShowNoteForm] = useState(false)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const wobble = WOBBLE[cardIndex % WOBBLE.length]

  const submitNote = async () => {
    const title = noteTitle.trim()
    const content = noteContent.trim()
    if (!title || !content || savingNote) return

    setSavingNote(true)
    try {
      await tasksApi.addMemoryNote(task.id, { title, content })
      setNoteTitle('')
      setNoteContent('')
      setShowNoteForm(false)
      onAddMemoryNote()
    } catch (err) {
      console.error('Failed to append memory note:', err)
    } finally {
      setSavingNote(false)
    }
  }

  return (
    <div
      className="border-[3px] border-black bg-[#191619] transition-transform hover:rotate-0"
      style={{
        transform: `rotate(${wobble.rotate}) translate(${wobble.tx}, ${wobble.ty})`,
        boxShadow: `${wobble.shadow}, 0 0 10px rgba(50,120,220,0.10)`,
      }}
    >
      {/* Title bar */}
      <div className="border-b-[3px] border-black px-3 py-2 bg-[#1e1a20]">
        <div className="text-[10px] text-[#4a4048] uppercase mb-1">#{task.seq}</div>
        <div className="text-[14px] leading-5">{task.title}</div>
      </div>

      {/* Agent */}
      {task.claimed_by_agent_id ? (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13] flex items-center gap-2">
          <span className="w-2 h-2 bg-[#c0392b] border border-black" />
          <span className="text-[12px] text-[#6bc5e8]">@ shrimp</span>
        </div>
      ) : (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13]">
          <span className="text-[12px] text-[#4a4048]">unclaimed</span>
        </div>
      )}

      {/* Linked docs */}
      {task.docs && task.docs.length > 0 && (
        <div className="border-b-[3px] border-black px-3 py-2 bg-[#160f14] space-y-1">
          <div className="text-[10px] text-[#4a4048] uppercase mb-1">linked docs</div>
          {task.docs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-2 cursor-pointer group"
              onClick={() => doc.status === 'unread' && onMarkDocRead(task.id, doc.id)}
            >
              <DocStatusDot status={doc.status} />
              <span className="text-[11px] text-[#c8bdb8] truncate group-hover:text-[#e7dfd3]">
                {doc.doc_path.split('/').pop()}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {task.skills && task.skills.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1">
          {task.skills.map((skill) => (
            <span
              key={skill.id}
              className="border-[2px] border-black text-[10px] px-2 py-0.5 bg-[#0f1a18] text-[#3abfa0]"
            >
              {skill.name}
            </span>
          ))}
        </div>
      )}

      <div className="border-t-[3px] border-black px-3 py-2 bg-[#141018]">
        <button
          onClick={() => setShowNoteForm(v => !v)}
          className="w-full border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[10px] uppercase px-2 py-1 hover:bg-[#243548] transition-colors"
        >
          {showNoteForm ? 'hide memory note' : '+ memory note'}
        </button>
        {showNoteForm && (
          <div className="mt-2 space-y-2">
            <input
              value={noteTitle}
              onChange={e => setNoteTitle(e.target.value)}
              placeholder="note title..."
              className="w-full bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[11px] px-2 py-1.5 outline-none focus:border-[#c0392b] placeholder:text-[#4a4048]"
            />
            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              rows={4}
              placeholder="plan, summary, reading note..."
              className="w-full bg-[#0e0c10] border-[2px] border-black text-[#e7dfd3] text-[11px] px-2 py-2 outline-none focus:border-[#c0392b] placeholder:text-[#4a4048] resize-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={submitNote}
                disabled={savingNote || !noteTitle.trim() || !noteContent.trim()}
                className="border-[2px] border-black bg-[#c0392b] text-black text-[10px] uppercase px-3 py-1 hover:bg-[#e04050] disabled:opacity-40"
              >
                {savingNote ? '...' : 'append'}
              </button>
              <button
                onClick={() => {
                  setShowNoteForm(false)
                  setNoteTitle('')
                  setNoteContent('')
                }}
                className="text-[10px] text-[#4a4048] hover:text-[#9a8888] uppercase"
              >
                cancel
              </button>
            </div>
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
