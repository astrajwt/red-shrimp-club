// Red Shrimp Lab — Channels View (connected to backend)

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  channelsApi, messagesApi, tasksApi, agentsApi, filesApi, obsidianApi,
  type Channel, type Message, type Task, type Agent, type AgentAuthoredDoc, type AgentLog, type AgentMemory, type AgentTodo,
  type MessageAttachment, type MessageMention, type MessageFeedbackVerdict,
} from '../lib/api'
import { markSent } from '../lib/sent-tracker'
import { AgentAvatar } from '../components/AgentAvatar'
import { MenuButton, MenuShell } from '../components/Menu'
import { isImeComposing } from '../lib/ime'
import { socketClient } from '../lib/socket'
import { useAuthStore } from '../store/auth'
import DocumentViewer from './DocumentViewer'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type WorkspaceSectionKey = 'memory' | 'knowledge' | 'notes' | 'docs'

export default function ChannelsView({ requestedChannelId, onOpenDoc }: { requestedChannelId?: string | null; onOpenDoc?: (path: string) => void }) {
  const { user } = useAuthStore()
  const [channels, setChannels]     = useState<Channel[]>([])
  const [dms, setDMs]               = useState<Channel[]>([])
  const [activeId, setActiveId]     = useState<string | null>(null)
  const [messages, setMessages]     = useState<Message[]>([])
  const [tasks, setTasks]           = useState<Task[]>([])
  const [unread, setUnread]         = useState<Record<string, number>>({})
  const [agents, setAgents]         = useState<Agent[]>([])
  const [input, setInput]           = useState('')
  const [sending, setSending]       = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<Array<{
    fileId: string
    url: string
    filename: string
    mimeType: string
    sizeBytes: number
    previewUrl?: string
  }>>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActive, setDragActive]   = useState(false)
  const [showCreateCh, setShowCreateCh] = useState(false)
  const [newChName, setNewChName]       = useState('')
  const [creatingCh, setCreatingCh]     = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [showInvite, setShowInvite]     = useState(false)
  const [inviting, setInviting]         = useState(false)
  const [agentPanelTab, setAgentPanelTab] = useState<'workspace' | 'tasks' | 'activity'>('workspace')
  const [agentWorkspaceSection, setAgentWorkspaceSection] = useState<WorkspaceSectionKey>('memory')
  const [agentDetailMemory, setAgentDetailMemory] = useState<AgentMemory | null>(null)
  const [agentDetailDocs, setAgentDetailDocs] = useState<AgentAuthoredDoc[]>([])
  const [agentDetailTodos, setAgentDetailTodos] = useState<AgentTodo[]>([])
  const [agentDetailLogs, setAgentDetailLogs] = useState<AgentLog[]>([])
  const [agentPanelLoading, setAgentPanelLoading] = useState(false)
  const [selectedAgentDocPath, setSelectedAgentDocPath] = useState<string | null>(null)
  const [selectedTodoDocPath, setSelectedTodoDocPath] = useState<string | null>(null)
  const [selectedTodoDocContent, setSelectedTodoDocContent] = useState('')
  const [selectedTodoDocLoading, setSelectedTodoDocLoading] = useState(false)
  const [selectedTodoDocError, setSelectedTodoDocError] = useState<string | null>(null)

  // Agent streaming state (for DM view)
  const [agentStreaming, setAgentStreaming] = useState(false)
  const [agentStreamLines, setAgentStreamLines] = useState<string[]>([])
  const [stoppingAgent, setStoppingAgent] = useState(false)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)

  // ── Load initial data ──────────────────────────────────────────────
  useEffect(() => {
    channelsApi.list().then(chs => {
      setChannels(chs)
      if (chs.length > 0) setActiveId(a => a ?? chs[0].id)
      // Auto-join all channel rooms for unread notifications
      for (const ch of chs) socketClient.joinChannel(ch.id)
    })
    channelsApi.listDMs().then(dmList => {
      setDMs(dmList)
      // Auto-join all DM rooms for unread notifications
      for (const dm of dmList) socketClient.joinChannel(dm.id)
    }).catch(() => {})
    channelsApi.unread().then(setUnread).catch(() => {})
    agentsApi.list().then(setAgents).catch(() => {})
  }, [])

  useEffect(() => {
    if (!requestedChannelId) return
    setActiveId(requestedChannelId)
  }, [requestedChannelId])

  // ── Switch channel ─────────────────────────────────────────────────
  useEffect(() => {
    if (!activeId) return
    socketClient.joinChannel(activeId)
    messagesApi.history(activeId).then(msgs => {
      setMessages(msgs)
      // Mark read up to the actual latest message seq
      const maxSeq = msgs.reduce((max, m) => Math.max(max, m.seq ?? 0), 0)
      if (maxSeq > 0) channelsApi.markRead(activeId, maxSeq).catch(() => {})
    })
    tasksApi.list(activeId).then(({ tasks: t }) => setTasks(t))
    setUnread(u => ({ ...u, [activeId]: 0 }))
    return () => { socketClient.leaveChannel(activeId) }
  }, [activeId])

  // ── Real-time messages ─────────────────────────────────────────────
  useEffect(() => {
    return socketClient.on('message', ({ channelId, message }) => {
      if (channelId !== activeId) {
        setUnread(u => ({ ...u, [channelId]: (u[channelId] ?? 0) + 1 }))
      } else {
        // Dedup: optimistic update may have already added this message
        setMessages(m => m.find(x => x.id === (message as Message).id) ? m : [...m, message as Message])
        // Mark read for active channel
        const msg = message as Message
        if (msg.seq) channelsApi.markRead(channelId, msg.seq).catch(() => {})
      }
    })
  }, [activeId])

  // ── Scroll to bottom ───────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, agentStreamLines])

  // ── Attachment upload ──────────────────────────────────────────────
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    setUploadingFiles(true)
    setUploadError(null)
    try {
      const uploadedFiles = await Promise.all(files.map(async (file) => {
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        const { file: uploaded } = await filesApi.upload(file)
        return {
          fileId: uploaded.id,
          url: uploaded.url,
          filename: uploaded.filename,
          mimeType: uploaded.mime_type,
          sizeBytes: uploaded.size_bytes,
          previewUrl,
        }
      }))
      setPendingFiles(prev => [...prev, ...uploadedFiles])
    } catch (err: any) {
      setUploadError(err?.message ?? 'Upload failed')
      console.error('Upload failed:', err.message)
    } finally {
      setUploadingFiles(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    await uploadFiles(files)
  }

  const removePendingFile = (fileId: string) => {
    setPendingFiles(prev => {
      const target = prev.find(file => file.fileId === fileId)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(file => file.fileId !== fileId)
    })
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(e.clipboardData.files ?? [])
    if (!files.length) return
    e.preventDefault()
    await uploadFiles(files)
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    await uploadFiles(Array.from(e.dataTransfer.files))
  }

  // ── @ mention handling ─────────────────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setInput(val)
    const cursor = e.target.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const match = before.match(/@(\w*)$/)
    setMentionQuery(match ? match[1] : null)
    setMentionIndex(0)
  }

  const insertMention = (name: string) => {
    const cursor = inputRef.current?.selectionStart ?? input.length
    const before = input.slice(0, cursor)
    const after  = input.slice(cursor)
    const match  = before.match(/@(\w*)$/)
    if (match) {
      setInput(before.slice(0, match.index) + `@${name} ` + after)
    }
    setMentionQuery(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // ── Send message ───────────────────────────────────────────────────
  const send = useCallback(async () => {
    if ((!input.trim() && pendingFiles.length === 0) || !activeId || sending) return
    setSending(true)
    const content = input.trim() || '\u200b'
    const fileIds = pendingFiles.length > 0 ? pendingFiles.map(file => file.fileId) : undefined
    const releasingFiles = pendingFiles
    let sent = false
    setInput('')
    setPendingFiles([])
    setUploadError(null)
    setMentionQuery(null)
    try {
      const msg = await messagesApi.send(activeId, content, fileIds)
      markSent(msg.id)
      // Optimistically show sent message immediately (dedup by id in WebSocket handler)
      setMessages(m => m.find(x => x.id === msg.id) ? m : [...m, msg])
      sent = true
    } catch (err: any) {
      console.error('Send failed:', err.message)
      setPendingFiles(releasingFiles)
    } finally {
      if (sent) {
        releasingFiles.forEach(file => {
          if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
        })
      }
      setSending(false)
    }
  }, [input, activeId, sending, pendingFiles])

  // ── Open DM with a shrimp ──────────────────────────────────────────
  const openDM = async (agentId: string) => {
    try {
      const dm = await channelsApi.openDM(agentId)
      socketClient.joinChannel(dm.id)  // join room for unread notifications
      setDMs(prev => prev.find(d => d.id === dm.id) ? prev : [...prev, dm])
      setActiveId(dm.id)
    } catch (err: any) {
      console.error('DM failed:', err.message)
    }
  }

  // ── Create channel ─────────────────────────────────────────────────
  const createChannel = async () => {
    const name = newChName.trim()
    if (!name || creatingCh) return
    const serverId = channels[0]?.server_id
    if (!serverId) return
    setCreatingCh(true)
    try {
      const ch = await channelsApi.create(name, serverId)
      setChannels(prev => [...prev, ch])
      setActiveId(ch.id)
      setShowCreateCh(false)
      setNewChName('')
    } catch (err: any) {
      console.error('Create channel failed:', err.message)
    } finally {
      setCreatingCh(false)
    }
  }

  // ── Invite shrimp to channel ────────────────────────────────────
  const inviteShrimp = async (agentId: string) => {
    if (!activeId || inviting) return
    setInviting(true)
    try {
      await channelsApi.invite(activeId, agentId)
      setShowInvite(false)
    } catch (err: any) {
      console.error('Invite failed:', err.message)
    } finally {
      setInviting(false)
    }
  }

  const activeChannel = [...channels, ...dms].find(c => c.id === activeId)
  const activeChName  = activeChannel?.display_name ?? activeChannel?.name ?? '...'
  const activeAgent = activeChannel?.type === 'dm'
    ? agents.find(agent => agent.name === activeChName) ?? null
    : null

  // @ mention suggestions (agents whose name starts with mentionQuery)
  const mentionSuggestions = mentionQuery !== null
    ? agents.filter(a => a.name.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6)
    : []

  const loadTodoDocPreview = useCallback(async (docPath: string | null) => {
    setSelectedTodoDocPath(docPath)
    setSelectedTodoDocContent('')
    setSelectedTodoDocError(null)
    if (!docPath) return

    setSelectedTodoDocLoading(true)
    try {
      const file = await obsidianApi.file(docPath)
      setSelectedTodoDocContent(file.content)
    } catch (err: any) {
      setSelectedTodoDocError(err.message ?? 'Failed to load todo doc')
    } finally {
      setSelectedTodoDocLoading(false)
    }
  }, [])

  const loadActiveAgentPanel = useCallback(async (agent: Agent) => {
    setAgentPanelLoading(true)
    try {
      const [memory, { docs }, { todos }, { logs }] = await Promise.all([
        agentsApi.memory(agent.id),
        agentsApi.authoredDocs(agent.id),
        agentsApi.todos(agent.id),
        agentsApi.logs(agent.id, 100),
      ])
      setAgentDetailMemory(memory)
      setAgentDetailDocs(docs)
      setAgentDetailTodos(todos)
      setAgentDetailLogs(logs)
      setSelectedAgentDocPath(current => current && docs.some(doc => doc.path === current) ? current : (docs[0]?.path ?? null))

      const defaultTodoDoc = todos.find(todo => todo.docs.length > 0)?.docs[0]?.doc_path ?? null
      await loadTodoDocPreview(defaultTodoDoc)
    } catch {
      setAgentDetailMemory(null)
      setAgentDetailDocs([])
      setAgentDetailTodos([])
      setAgentDetailLogs([])
      setSelectedAgentDocPath(null)
      await loadTodoDocPreview(null)
    } finally {
      setAgentPanelLoading(false)
    }
  }, [loadTodoDocPreview])

  const submitMessageFeedback = useCallback(async (messageId: string, itemIndex: number, verdict: MessageFeedbackVerdict) => {
    const result = await messagesApi.feedback(messageId, itemIndex, verdict)
    setMessages(prev => prev.map(msg => (
      msg.id === messageId
        ? { ...msg, feedback: result.feedback }
        : msg
    )))
  }, [])

  useEffect(() => {
    setAgentPanelTab('workspace')
    setAgentWorkspaceSection('memory')
    setAgentDetailMemory(null)
    setAgentDetailDocs([])
    setAgentDetailTodos([])
    setAgentDetailLogs([])
    setSelectedAgentDocPath(null)
    setSelectedTodoDocPath(null)
    setSelectedTodoDocContent('')
    setSelectedTodoDocError(null)

    if (!activeAgent) return
    loadActiveAgentPanel(activeAgent).catch(() => {})
  }, [activeAgent, loadActiveAgentPanel])

  // ── Agent streaming events (for DM thinking/output cards) ────────
  useEffect(() => {
    if (!activeAgent) {
      setAgentStreaming(false)
      setAgentStreamLines([])
      setStoppingAgent(false)
      return
    }
    const aid = activeAgent.id
    const unsub = [
      socketClient.on('agent:started', (e) => {
        if (e.agentId === aid) {
          setAgentStreaming(true)
          setAgentStreamLines([])
          setStoppingAgent(false)
        }
      }),
      socketClient.on('agent:log', (e) => {
        if (e.agentId === aid) {
          setAgentStreaming(true)
          setAgentStreamLines(prev => {
            const next = [...prev, e.content]
            return next.length > 50 ? next.slice(-50) : next
          })
        }
      }),
      socketClient.on('agent:stopped', (e) => {
        if (e.agentId === aid) {
          setAgentStreaming(false)
          setAgentStreamLines([])
          setStoppingAgent(false)
        }
      }),
      socketClient.on('agent:crashed', (e) => {
        if (e.agentId === aid) {
          setAgentStreaming(false)
          setAgentStreamLines([])
          setStoppingAgent(false)
        }
      }),
    ]
    return () => unsub.forEach(fn => fn())
  }, [activeAgent])

  return (
    <div
      className="flex h-full bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* ── Channel List ─────────────────────────────────────────────── */}
      <aside className="w-[200px] border-r-[3px] border-black bg-[#141118] flex flex-col overflow-y-auto">

        {/* Channels section */}
        <div className="px-3 pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em]">channels</div>
            <button
              onClick={() => { setShowCreateCh(v => !v); setNewChName('') }}
              className="text-[12px] text-[#4a4048] hover:text-[#6bc5e8] px-1 leading-none"
              title="new channel"
            >+</button>
          </div>

          {/* Create channel form */}
          {showCreateCh && (
            <div className="mb-3">
              <input
                autoFocus
                className="w-full bg-[#1e1a20] border-[2px] border-black text-[12px] text-[#e7dfd3] px-2 py-1 outline-none placeholder-[#4a4048]"
                placeholder="channel-name"
                value={newChName}
                onChange={e => setNewChName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                onKeyDown={e => {
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') createChannel()
                  if (e.key === 'Escape') { setShowCreateCh(false); setNewChName('') }
                }}
              />
              <button
                onClick={createChannel}
                disabled={!newChName.trim() || creatingCh}
                className="w-full mt-1 text-[10px] bg-[#c0392b] text-black py-1 disabled:opacity-40 uppercase tracking-wider"
              >
                {creatingCh ? 'creating...' : 'create ↵'}
              </button>
            </div>
          )}

          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setActiveId(ch.id)}
              className={`w-full flex items-center justify-between px-2 py-1 mb-1 text-left border-l-[3px]
                ${ch.id === activeId
                  ? 'border-[#c0392b] bg-[#3a1520] text-[#f0e8e8]'
                  : 'border-transparent text-[#9a8888] hover:text-[#c8bdb8] hover:border-[#3a1520]'
                }`}
            >
              <span className="text-[13px]"># {ch.name}</span>
              {(unread[ch.id] ?? 0) > 0 && (
                <span className="text-[10px] bg-[#c0392b] text-black px-1">{unread[ch.id]}</span>
              )}
            </button>
          ))}
        </div>

        {/* Agents — click to open DM directly */}
        {agents.length > 0 && (
          <div className="px-3 pt-4">
            <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">agents</div>
            {agents.map(ag => {
              // Check if there's already a DM channel open with this agent
              const existingDM = dms.find(d => d.display_name === ag.name || d.name?.includes(ag.name.toLowerCase()))
              const isActive = existingDM?.id === activeId
              return (
              <button
                key={ag.id}
                onClick={() => openDM(ag.id)}
                className={`w-full flex items-center gap-2 px-2 py-1 mb-1 text-left group border-l-[3px]
                  ${isActive
                    ? 'border-[#6bc5e8] bg-[#1a2535] text-[#f0e8e8]'
                    : 'border-transparent text-[#9a8888] hover:text-[#c8bdb8] hover:border-[#1a2535]'
                  }`}
                title={`私聊 ${ag.name}`}
              >
                <div className="relative shrink-0">
                  <div style={ag.status === 'running' ? { animation: 'agent-glow 1.5s ease-in-out infinite' } : undefined}>
                    <AgentAvatar name={ag.name} size={24} />
                  </div>
                  <span
                    className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 border border-black"
                    style={{
                      background: ag.status === 'running' ? '#3abfa0' : ag.status === 'idle' ? '#f0b35e' : '#3a3535',
                      animation: ag.status === 'running' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                    }}
                  />
                </div>
                <span className={`text-[12px] group-hover:text-[#6bc5e8] truncate ${isActive ? 'text-[#6bc5e8]' : 'text-[#9a8888]'}`}>
                  {ag.name}
                </span>
                {existingDM && (unread[existingDM.id] ?? 0) > 0 && (
                  <span className="text-[10px] bg-[#c0392b] text-black px-1 shrink-0">{unread[existingDM.id]}</span>
                )}
              </button>
              )
            })}
          </div>
        )}

        {/* Current user */}
        <div className="mt-auto border-t-[3px] border-black px-3 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 border-[2px] border-black bg-[#3a1520] flex items-center justify-center text-[10px] text-[#f0e8e8] shrink-0">
              {user?.name?.[0]?.toUpperCase() ?? 'U'}
            </div>
            <div className="min-w-0">
              <div className="text-[12px] truncate">{user?.name ?? '...'}</div>
              <div className="text-[10px] text-[#4a4048]">human</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Message Area ─────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col border-r-[3px] border-black min-w-0">
        {/* Header */}
        <div className="border-b-[3px] border-black bg-[#141118] px-5 py-3 flex items-center gap-3 shrink-0">
          {activeChannel?.type === 'dm'
            ? <div style={activeAgent?.status === 'running' ? { animation: 'agent-glow 1.5s ease-in-out infinite' } : undefined}>
                <AgentAvatar name={activeChName} size={32} />
              </div>
            : <span className="text-[22px] text-[#c0392b]">#</span>}
          <div>
            <div className="text-[16px] flex items-center gap-2">
              {activeChName}
              {activeAgent?.status === 'running' && (
                <span className="w-2 h-2 bg-[#3abfa0]" style={{ animation: 'pulse 1.2s ease-in-out infinite' }} />
              )}
            </div>
            <div className="text-[11px] text-[#6bc5e8]">
              {activeChannel?.type === 'dm' ? 'direct message' : 'channel'}
            </div>
          </div>
          {activeAgent?.status === 'running' && (
            <button
              onClick={async () => {
                if (!activeAgent || stoppingAgent) return
                setStoppingAgent(true)
                try { await agentsApi.stop(activeAgent.id) } catch (e: any) { console.error(e.message) }
                setStoppingAgent(false)
              }}
              disabled={stoppingAgent}
              className="text-[11px] text-[#c0392b] border border-[#c0392b]/40 px-2 py-0.5 hover:bg-[#2b1414] disabled:opacity-40 uppercase tracking-wider"
            >
              {stoppingAgent ? 'stopping...' : 'stop'}
            </button>
          )}
          <div className="ml-auto flex gap-2 items-center relative">
            {activeChannel?.type !== 'dm' && (
              <div className="relative">
                <button
                  onClick={() => setShowInvite(v => !v)}
                  className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase hover:bg-[#243548]"
                  title="邀请 Agent 加入频道"
                >
                  + agent
                </button>
                {showInvite && (
                  <MenuShell title="invite agent" className="absolute top-full right-0 z-30 mt-2 min-w-[220px]">
                    {agents.map(ag => (
                      <MenuButton
                        key={ag.id}
                        onClick={() => inviteShrimp(ag.id)}
                        disabled={inviting}
                        className="disabled:opacity-40"
                      >
                        <span
                          className="w-1.5 h-1.5 shrink-0"
                          style={{ background: ag.status === 'running' ? '#c0392b' : '#4a4048' }}
                        />
                        <span className="text-[#6bc5e8]">{ag.name}</span>
                      </MenuButton>
                    ))}
                    {agents.length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-[#4a4048]">no agents yet</div>
                    )}
                  </MenuShell>
                )}
              </div>
            )}
            <Chip>{tasks.length} tasks</Chip>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {messages.map((msg, index) => {
            const isAgent = msg.sender_type === 'agent'
            const name = msg.sender_name || (isAgent ? 'agent' : 'user')
            const time = new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            const feedbackItems = activeChannel?.type === 'dm' && activeAgent?.name === 'Donovan' && isAgent
              ? extractFeedbackItems(msg.content)
              : []
            const prev = messages[index - 1]
            const sameAsPrev =
              prev &&
              prev.sender_id === msg.sender_id &&
              prev.sender_type === msg.sender_type

            return (
              <div
                key={msg.id}
                className={`flex ${isAgent ? 'justify-start' : 'justify-end'} ${sameAsPrev ? 'mt-2' : 'mt-5'}`}
              >
                <div className={`flex gap-3 max-w-[78%] ${isAgent ? '' : 'flex-row-reverse'}`}>
                  {sameAsPrev ? (
                    <div className="w-8 shrink-0" />
                  ) : isAgent ? (
                    <div className="shrink-0 mt-1">
                      <AgentAvatar name={name} size={32} />
                    </div>
                  ) : (
                    <div
                      className="w-8 h-8 border-[2px] border-black flex items-center justify-center text-[11px] shrink-0 mt-1"
                      style={{
                        background: '#3a1520',
                        color: '#f0e8e8',
                      }}
                    >
                      {name[0]?.toUpperCase()}
                    </div>
                  )}

                  <div className={`min-w-0 ${isAgent ? '' : 'items-end'} flex flex-col`}>
                    {!sameAsPrev && (
                      <div className={`flex items-baseline gap-2 mb-1 ${isAgent ? '' : 'flex-row-reverse'}`}>
                        <span className={`text-[13px] ${isAgent ? 'text-[#6bc5e8]' : 'text-[#c0392b]'}`}>
                          {isAgent ? '(agent) ' : ''}{name}
                        </span>
                        <span className="text-[11px] text-[#4a4048]">{time}</span>
                      </div>
                    )}
                    {sameAsPrev && (
                      <div className={`text-[10px] text-[#4a4048] mb-1 ${isAgent ? '' : 'text-right'}`}>{time}</div>
                    )}
                    <div
                      className="text-[14px] leading-6 px-3 py-2 border-[2px] border-black"
                      style={{
                        background: isAgent ? '#161d24' : '#2a1519',
                        color: '#e0d8d0',
                        boxShadow: '2px 3px 0 rgba(0,0,0,0.45)',
                      }}
                    >
                      <MessageContent content={msg.content} mentions={msg.mentions} thinking={msg.thinking} onOpenDoc={onOpenDoc} />
                      {/* Attachments */}
                      {msg.attachments?.map((att, i) =>
                        att.mime_type.startsWith('image/') ? (
                          <div key={i} className="mt-3">
                            <img
                              src={att.url}
                              alt={att.filename}
                              className="max-w-[420px] max-h-[320px] border-[2px] border-black object-contain cursor-pointer bg-[#0e0c10]"
                              onClick={() => window.open(att.url, '_blank')}
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                            <div className="mt-1 text-[10px] text-[#6a6068]">{att.filename}</div>
                          </div>
                        ) : (
                          <a
                            key={i}
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 flex items-center gap-2 border border-black bg-[#100e13] px-2 py-2 text-[12px] text-[#6bc5e8] hover:bg-[#1a2535]"
                          >
                            <span className="text-[14px]">📎</span>
                            <span className="flex-1 truncate">{att.filename}</span>
                            <span className="text-[10px] text-[#4a4048] shrink-0">
                              {Math.max(1, Math.round((att.size ?? 0) / 1024))}KB
                            </span>
                          </a>
                        )
                      )}
                      {feedbackItems.length > 0 && (
                        <MessageFeedbackPanel
                          messageId={msg.id}
                          items={feedbackItems}
                          feedback={msg.feedback}
                          onSubmit={submitMessageFeedback}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          {/* Agent streaming/thinking card */}
          {activeAgent && agentStreaming && (
            <div className="flex justify-start mt-5">
              <div className="flex gap-3 max-w-[78%]">
                <div className="shrink-0 mt-1">
                  <AgentAvatar name={activeAgent.name} size={32} />
                </div>
                <div className="min-w-0 flex flex-col">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-[13px] text-[#6bc5e8]">(agent) {activeAgent.name}</span>
                    <span className="text-[11px] text-[#4a4048]">thinking...</span>
                  </div>
                  <div
                    className="text-[13px] leading-5 px-3 py-2 border-[2px] border-black min-w-[200px]"
                    style={{
                      background: '#161d24',
                      color: '#8d8a85',
                      boxShadow: '2px 3px 0 rgba(0,0,0,0.45)',
                    }}
                  >
                    {agentStreamLines.length === 0 ? (
                      <span className="text-[#4a4048] animate-pulse">processing...</span>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-[inherit] text-[12px] max-h-[300px] overflow-y-auto">
                        {agentStreamLines.slice(-20).join('\n')}
                      </pre>
                    )}
                    <div className="mt-2 pt-2 border-t border-black/30 flex items-center justify-between">
                      <span className="text-[10px] text-[#4a4048]">
                        {agentStreamLines.length > 0 ? `${agentStreamLines.length} lines` : 'waiting'}
                      </span>
                      <button
                        onClick={async () => {
                          if (!activeAgent || stoppingAgent) return
                          setStoppingAgent(true)
                          try {
                            await agentsApi.stop(activeAgent.id)
                          } catch (err: any) {
                            console.error('Stop agent failed:', err.message)
                          } finally {
                            setStoppingAgent(false)
                          }
                        }}
                        disabled={stoppingAgent}
                        className="text-[11px] text-[#c0392b] border border-[#c0392b]/40 px-2 py-0.5 hover:bg-[#2b1414] disabled:opacity-40 uppercase tracking-wider"
                      >
                        {stoppingAgent ? 'stopping...' : 'stop'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t-[3px] border-black px-4 py-3 bg-[#120f13] relative shrink-0">
          {/* Pending attachments */}
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingFiles.map((file) => (
                <div
                  key={file.fileId}
                  className="flex items-center gap-2 border-[2px] border-black bg-[#1a161c] px-2 py-2 max-w-[280px]"
                >
                  {file.previewUrl ? (
                    <img
                      src={file.previewUrl}
                      alt={file.filename}
                      className="h-14 w-14 border border-black object-cover shrink-0"
                    />
                  ) : (
                    <div className="h-14 w-14 border border-black shrink-0 flex items-center justify-center text-[18px] text-[#6bc5e8]">
                      📎
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-[11px] text-[#e7dfd3] truncate">{file.filename}</div>
                    <div className="text-[10px] text-[#4a4048]">
                      {file.mimeType} · {Math.max(1, Math.round(file.sizeBytes / 1024))}KB
                    </div>
                  </div>
                  <button
                    onClick={() => removePendingFile(file.fileId)}
                    className="text-[11px] text-[#c0392b] hover:underline shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {uploadError && (
            <div className="mb-2 text-[11px] text-[#ff8a8a]">{uploadError}</div>
          )}

          {/* @ mention dropdown */}
          {mentionSuggestions.length > 0 && (
            <MenuShell className="absolute bottom-full left-4 z-20 mb-2 min-w-[190px]">
              {mentionSuggestions.map((ag, idx) => (
                <MenuButton
                  key={ag.id}
                  onMouseDown={e => { e.preventDefault(); insertMention(ag.name) }}
                  onMouseEnter={() => setMentionIndex(idx)}
                  className={idx === mentionIndex ? 'bg-[#2b1820] text-[#e7dfd3]' : ''}
                >
                  <span
                    className="w-1.5 h-1.5 shrink-0"
                    style={{ background: ag.status === 'running' ? '#c0392b' : '#4a4048' }}
                  />
                  <span className={idx === mentionIndex ? 'text-[#e7dfd3]' : 'text-[#6bc5e8]'}>
                    {ag.name}
                  </span>
                </MenuButton>
              ))}
            </MenuShell>
          )}

          <div
            className="flex items-center gap-3 border-[3px] border-black bg-[#191619] px-3 py-2 transition-colors"
            style={{
              boxShadow: dragActive ? '0 0 0 2px rgba(107,197,232,0.25), 0 0 18px rgba(107,197,232,0.18)' : '0 0 12px rgba(50,120,220,0.10)',
              background: dragActive ? '#161d24' : '#191619',
            }}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
            {/* Attach file button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFiles}
              className="text-[#4a4048] hover:text-[#6bc5e8] transition-colors disabled:opacity-40 shrink-0 text-[16px]"
              title="发送附件"
            >
              {uploadingFiles ? '↑' : '⌅'}
            </button>
            <span className="text-[#4a4048] text-[13px] shrink-0">
              {activeChannel?.type === 'dm' ? '✉' : '#'}{activeChName}
            </span>
            <input
              ref={inputRef}
              className="flex-1 bg-transparent text-[14px] text-[#e7dfd3] outline-none placeholder-[#4a4048]"
              value={input}
              onChange={handleInputChange}
              onPaste={handlePaste}
              onKeyDown={e => {
                if (isImeComposing(e)) return
                if (e.key === 'Backspace') {
                  const cursor = inputRef.current?.selectionStart ?? input.length
                  const selEnd = inputRef.current?.selectionEnd ?? cursor
                  // Only intercept when no text is selected
                  if (cursor === selEnd) {
                    const before = input.slice(0, cursor)
                    const match = before.match(/@\w+\s?$/)
                    if (match) {
                      e.preventDefault()
                      setInput(input.slice(0, cursor - match[0].length) + input.slice(cursor))
                      return
                    }
                  }
                }
                if (e.key === 'Escape') { setMentionQuery(null); return }
                if (mentionSuggestions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionIndex(i => (i + 1) % mentionSuggestions.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIndex(i => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length)
                    return
                  }
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault()
                    insertMention(mentionSuggestions[mentionIndex].name)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
              placeholder={dragActive ? 'drop files to upload...' : 'type a message... (@name to mention, paste/drag files)'}
            />
            <button
              onClick={send}
              disabled={sending || (!input.trim() && pendingFiles.length === 0)}
              className="border-[2px] border-black bg-[#c0392b] text-black px-3 py-1 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
            >
              send ↑
            </button>
          </div>
        </div>
      </main>

      {/* ── Right Sidebar ─────────────────────────────────────────────── */}
      {activeAgent ? (
        <aside className="w-[420px] bg-[#141118] flex flex-col border-l-[3px] border-black">
          <div className="border-b-[3px] border-black px-4 py-3 bg-[#1a2535] shrink-0">
            <div className="flex items-center gap-3">
              <AgentAvatar name={activeAgent.name} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-[15px] text-[#e7dfd3] truncate">{activeAgent.name}</div>
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full border border-black shrink-0"
                    style={{ background: agentStatus(activeAgent.status).text }}
                  />
                </div>
                <div className="text-[10px] text-[#6bc5e8] uppercase tracking-wider truncate">
                  {roleLabel(activeAgent.role)}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <AgentMetaItem label="Name" value={activeAgent.name} />
              <AgentMetaItem label="Role" value={roleLabel(activeAgent.role)} />
              <AgentMetaItem label="Runtime" value={runtimeLabel(activeAgent.runtime)} />
              <AgentMetaItem label="Model" value={activeAgent.model_id} />
              <AgentMetaItem label="Reasoning" value={reasoningLabel(activeAgent.reasoning_effort)} />
              <AgentMetaItem label="Machine" value={machineLabel(activeAgent)} />
              <AgentMetaItem label="Connected" value={connectedLabel(activeAgent)} />
              <AgentMetaItem label="Created" value={createdLabel(activeAgent.created_at)} />
              {activeAgent.description?.trim() && (
                <div className="col-span-2">
                  <AgentMetaItem label="Desc" value={activeAgent.description.trim()} />
                </div>
              )}
              <div className="col-span-2">
                <AgentMetaItem label="Workspace" value={activeAgent.workspace_path ?? '—'} small />
              </div>
            </div>
            <div className="mt-3 border-[2px] border-black bg-[#100e13] px-3 py-2">
              <div className="text-[10px] text-[#4a4048] uppercase mb-1">note</div>
              <div className="text-[12px] text-[#c8bdb8] leading-5 whitespace-pre-wrap break-words">
                {activeAgent.note?.trim() || 'no note yet'}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <SidebarMiniButton active={agentPanelTab === 'workspace'} onClick={() => setAgentPanelTab('workspace')}>workspace</SidebarMiniButton>
              <SidebarMiniButton active={agentPanelTab === 'tasks'} onClick={() => setAgentPanelTab('tasks')}>tasks</SidebarMiniButton>
              <SidebarMiniButton active={agentPanelTab === 'activity'} onClick={() => setAgentPanelTab('activity')}>activity</SidebarMiniButton>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {agentPanelTab === 'workspace' && (
              <div className="h-full flex flex-col">
                <div className="grid grid-cols-4 gap-2 border-b-[3px] border-black bg-[#100e13] px-3 py-2 shrink-0">
                  <SidebarMiniButton active={agentWorkspaceSection === 'memory'} onClick={() => setAgentWorkspaceSection('memory')}>memory</SidebarMiniButton>
                  <SidebarMiniButton active={agentWorkspaceSection === 'knowledge'} onClick={() => setAgentWorkspaceSection('knowledge')}>knowledge</SidebarMiniButton>
                  <SidebarMiniButton active={agentWorkspaceSection === 'notes'} onClick={() => setAgentWorkspaceSection('notes')}>notes</SidebarMiniButton>
                  <SidebarMiniButton active={agentWorkspaceSection === 'docs'} onClick={() => setAgentWorkspaceSection('docs')}>docs</SidebarMiniButton>
                </div>
                {agentWorkspaceSection === 'docs' ? (
                  <div className="h-full flex flex-col">
                    <div className="max-h-[42%] overflow-auto border-b-[3px] border-black bg-[#100e13] p-3 space-y-2 shrink-0">
                      {agentPanelLoading ? (
                        <div className="text-[12px] text-[#4a4048] text-center py-6">loading docs...</div>
                      ) : agentDetailDocs.length === 0 ? (
                        <div className="text-[12px] text-[#4a4048] text-center py-6">no authored docs</div>
                      ) : agentDetailDocs.map((doc) => (
                        <button
                          key={doc.path}
                          onClick={() => setSelectedAgentDocPath(doc.path)}
                          className="w-full text-left border-[2px] border-black px-3 py-2"
                          style={{ background: selectedAgentDocPath === doc.path ? '#1a2535' : '#191619' }}
                        >
                          <div className="text-[10px] text-[#4a4048] uppercase">{doc.type ?? 'doc'}{doc.date ? ` · ${doc.date}` : ''}</div>
                          <div className="text-[12px] mt-1 leading-5">{doc.title}</div>
                          <div className="text-[10px] text-[#6bc5e8] mt-1 truncate">{doc.path}</div>
                        </button>
                      ))}
                    </div>
                    <div className="flex-1 overflow-auto bg-[#0e0c10]">
                      {selectedAgentDocPath ? (
                        <DocumentViewer filePath={selectedAgentDocPath} embedded onNavigate={setSelectedAgentDocPath} />
                      ) : (
                        <div className="h-full flex items-center justify-center text-[12px] text-[#4a4048]">select a doc above</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 overflow-auto">
                    {agentPanelLoading ? (
                      <div className="text-[12px] text-[#4a4048] text-center py-8">loading workspace...</div>
                    ) : (
                      <div className="p-4">
                        <div className="text-[10px] text-[#4a4048] uppercase mb-2">
                          {getAgentMemorySection(agentDetailMemory, agentWorkspaceSection)?.path ?? activeAgent.workspace_path ?? 'workspace unknown'}
                        </div>
                        <pre className="text-[12px] leading-6 text-[#c8bdb8] whitespace-pre-wrap break-words">
                          {getAgentMemorySection(agentDetailMemory, agentWorkspaceSection)?.content || 'no content yet'}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {agentPanelTab === 'tasks' && (
              <div className="h-full flex flex-col">
                <div className="max-h-[45%] overflow-auto border-b-[3px] border-black bg-[#100e13] p-3 space-y-3 shrink-0">
                  {agentPanelLoading ? (
                    <div className="text-[12px] text-[#4a4048] text-center py-6">loading todos...</div>
                  ) : agentDetailTodos.length === 0 ? (
                    <div className="text-[12px] text-[#4a4048] text-center py-6">no assigned todos</div>
                  ) : agentDetailTodos.map((todo) => (
                    <div key={todo.id} className="border-[2px] border-black bg-[#191619]">
                      <div className="border-b-[2px] border-black px-3 py-2 bg-[#1e1a20]">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[10px] text-[#4a4048] uppercase">#t{todo.number} · #{todo.channel_name}</div>
                          <TodoStatusBadge status={todo.status} />
                        </div>
                        <div className="text-[12px] mt-1 leading-5">{todo.title}</div>
                      </div>
                      <div className="px-3 py-2 space-y-2">
                        {todo.docs.length === 0 ? (
                          <div className="text-[11px] text-[#4a4048]">no linked docs</div>
                        ) : todo.docs.map((doc) => (
                          <button
                            key={doc.id}
                            onClick={() => loadTodoDocPreview(doc.doc_path)}
                            className="w-full text-left border border-black px-2 py-2"
                            style={{ background: selectedTodoDocPath === doc.doc_path ? '#1a2535' : '#120f13' }}
                          >
                            <div className="flex items-center gap-2">
                              <TodoDocStatusDot status={doc.status} />
                              <span className="text-[11px] text-[#e7dfd3] truncate">{doc.doc_name}</span>
                            </div>
                            <div className="text-[10px] text-[#4a4048] mt-1 truncate">{doc.doc_path}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex-1 overflow-auto bg-[#0e0c10] p-4">
                  <div className="text-[10px] text-[#4a4048] uppercase mb-2">{selectedTodoDocPath ?? 'select a linked todo doc'}</div>
                  {selectedTodoDocLoading ? (
                    <div className="text-[12px] text-[#4a4048] text-center py-8">loading doc...</div>
                  ) : selectedTodoDocError ? (
                    <div className="text-[12px] text-[#c0392b] text-center py-8">{selectedTodoDocError}</div>
                  ) : selectedTodoDocContent ? (
                    <pre className="text-[12px] leading-6 text-[#c8bdb8] whitespace-pre-wrap break-words">{selectedTodoDocContent}</pre>
                  ) : (
                    <div className="text-[12px] text-[#4a4048] text-center py-8">pick a todo note above</div>
                  )}
                </div>
              </div>
            )}

            {agentPanelTab === 'activity' && (
              <div className="h-full overflow-auto">
                {agentPanelLoading ? (
                  <div className="text-[12px] text-[#4a4048] text-center py-8">loading logs...</div>
                ) : agentDetailLogs.length === 0 ? (
                  <div className="text-[12px] text-[#4a4048] text-center py-8">no logs yet</div>
                ) : agentDetailLogs.map((log, index) => (
                  <div key={log.id ?? index} className="border-b border-[#1a1620] flex text-[12px]" style={{ background: index % 2 === 0 ? '#0e0c10' : '#100e13' }}>
                    <div className="px-2 py-1 text-[#4a4048] w-[64px] shrink-0 border-r border-[#1a1620]">
                      {new Date(log.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div className="px-2 py-1 flex-1 text-[#c8bdb8] break-words whitespace-pre-wrap">{log.content}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      ) : (
        <aside className="w-[260px] bg-[#141118] flex flex-col">
          <div className="border-b-[3px] border-black px-3 py-3 bg-[#c0392b] shrink-0">
            <div className="text-[11px] text-black/60 uppercase">task board</div>
            <div className="text-[20px] text-black"># {activeChannel?.name ?? '...'}</div>
          </div>

          <div className="flex-1 overflow-auto px-3 py-3 space-y-2">
            {tasks.map((task, i) => {
              const s = taskStatus(task.status)
              return (
                <div
                  key={task.id}
                  className="border-[3px] border-black bg-[#1e1a20]"
                  style={{
                    transform: `rotate(${i % 2 === 0 ? '-0.2deg' : '0.2deg'})`,
                    boxShadow: '2px 3px 0 rgba(0,0,0,0.8), 0 0 8px rgba(50,120,220,0.08)',
                  }}
                >
                  <div className="flex items-start gap-2 px-3 py-2">
                    <span className="text-[11px] text-[#4a4048] shrink-0 mt-0.5">#t{task.number}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] leading-5">{task.title}</div>
                      {task.claimed_by_name && (
                        <div className="text-[11px] text-[#6bc5e8] mt-1">
                          {task.claimed_by_type === 'agent' ? '@' : ''}
                          {task.claimed_by_name}
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    className="border-t-[3px] border-black px-3 py-1 text-[11px] uppercase"
                    style={{ background: s.bg, color: s.text }}
                  >
                    {s.label}
                  </div>
                </div>
              )
            })}
            {tasks.length === 0 && (
              <div className="text-[12px] text-[#4a4048] text-center pt-4">no tasks</div>
            )}
          </div>

          <div className="border-t-[3px] border-black px-3 py-2 shrink-0">
            <button className="w-full border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] text-[12px] uppercase py-2 hover:bg-[#243548]">
              + new task
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}

// ─── MessageContent ────────────────────────────────────────────────────────────
// Renders message text: ![...](url) → <img>, @Name → highlighted mention

function SidebarMiniButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      onClick={onClick}
      className="border-[2px] border-black px-2 py-1 text-[10px] uppercase"
      style={{ background: active ? '#1a2535' : '#141018', color: active ? '#6bc5e8' : '#4a4048' }}
    >
      {children}
    </button>
  )
}

function AgentMetaItem({
  label,
  value,
  small = false,
}: {
  label: string
  value: string
  small?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-[#4a4048] uppercase">{label}</div>
      <div className={`${small ? 'text-[10px]' : 'text-[11px]'} text-[#c8bdb8] truncate`} title={value}>
        {value}
      </div>
    </div>
  )
}

function agentStatus(status: Agent['status']) {
  if (status === 'running' || status === 'online') return { text: '#3abfa0', label: 'running' }
  if (status === 'idle') return { text: '#6bc5e8', label: 'idle' }
  if (status === 'offline') return { text: '#c0392b', label: 'offline' }
  if (status === 'starting') return { text: '#f0b35e', label: 'starting' }
  return { text: '#e04050', label: 'error' }
}

function runtimeLabel(runtime: Agent['runtime']) {
  if (runtime === 'codex') return 'Codex CLI'
  if (runtime === 'claude') return 'Claude CLI'
  if (runtime === 'kimi') return 'Kimi CLI'
  return runtime
}

function roleLabel(role: Agent['role']) {
  const labels: Record<string, string> = {
    coordinator: 'Coordinator', ops: 'Ops',
    investigator: 'Investigator',
    developer: 'Developer',
    profiler: 'Profiler', observer: 'Observer',
    'exp-kernel': 'Kernel Exp', 'exp-training': 'Training Exp',
    'exp-inference': 'Inference Exp',
    general: 'General', tester: 'Tester', pm: 'PM',
  }
  return labels[role ?? ''] ?? role ?? 'No role'
}

function reasoningLabel(reasoning: Agent['reasoning_effort']) {
  if (!reasoning?.trim()) return 'medium'
  return reasoning
}

function machineLabel(agent: Agent) {
  return agent.machine_name || agent.machine_hostname || 'unassigned'
}

function connectedLabel(agent: Agent) {
  return agentStatus(agent.status).label
}

function createdLabel(createdAt: string) {
  return new Date(createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function getAgentMemorySection(memory: AgentMemory | null, section: WorkspaceSectionKey) {
  if (!memory) return null
  if (section === 'knowledge') return memory.knowledge ?? null
  if (section === 'notes') return memory.notesIndex ?? null
  if (section === 'docs') return null
  return memory.memory ?? { path: memory.path, content: memory.content, updatedAt: memory.updatedAt }
}

function TodoStatusBadge({ status }: { status: AgentTodo['status'] }) {
  const styles =
    status === 'completed' ? { bg: '#1e2e26', text: '#7ecfa8', label: 'done' } :
    status === 'reviewing' ? { bg: '#352515', text: '#f0b35e', label: 'review' } :
    status === 'in_progress' ? { bg: '#1a2535', text: '#6bc5e8', label: 'doing' } :
    status === 'claimed' ? { bg: '#2a1a35', text: '#b08cd9', label: 'assigned' } :
    { bg: '#2a2622', text: '#9a8888', label: 'todo' }

  return (
    <span className="border border-black px-1.5 py-0.5 text-[10px] uppercase" style={{ background: styles.bg, color: styles.text }}>
      {styles.label}
    </span>
  )
}

function TodoDocStatusDot({ status }: { status: string }) {
  const color =
    status === 'read' ? '#3abfa0' :
    status === 'writing' ? '#f0b35e' :
    '#6bc5e8'

  return <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
}

const IMG_MD = /!\[([^\]]*)\]\(([^)]+)\)/g
const ZERO_WIDTH = '\u200b'
const FEEDBACK_ITEM_RE = /^(?:[-*•]\s+|\d+[.)、]\s+|[一二三四五六七八九十]+[、.]\s+)(.+)$/

interface FeedbackItem {
  index: number
  text: string
  type: 'opinion' | 'option'  // opinion = 对/错, option = selectable choice
  label?: string              // e.g. 'A', 'B', 'C' for options
  details?: string[]
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-[#8a7e88] hover:text-[#c8bdb8] transition-colors"
      >
        <span className="inline-block transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        <span className="italic">思考过程</span>
      </button>
      {open && (
        <div className="mt-1 ml-3 pl-2 border-l-[2px] border-[#3a3035] text-[11px] text-[#7a6e78] whitespace-pre-wrap max-h-[300px] overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  )
}

function MessageContent({
  content,
  mentions,
  thinking,
  onOpenDoc,
}: {
  content: string
  mentions?: MessageMention[]
  thinking?: string | null
  onOpenDoc?: (path: string) => void
}) {
  const text = content === ZERO_WIDTH ? '' : content
  if (!text) return null

  const mentionNames = new Set((mentions ?? []).map(m => m.name.toLowerCase()))

  // Pre-process: highlight @mentions and auto-link vault paths
  let processed = text.replace(MENTION_RE, (seg) => {
    if (mentionNames.has(seg.slice(1).toLowerCase())) {
      return `**${seg}**`
    }
    return seg
  })
  // Auto-detect vault paths like 03_knowlage/..., 02_project/..., 04_routine/... and wrap as vault links
  if (onOpenDoc) {
    processed = processed.replace(
      /(?:^|\s)`?((?:0[0-6]_\w+\/)[^\s`\])<]+\.md)`?/gm,
      (match, path) => match.replace(path, `[${path}](vault://${path})`)
    )
  }

  return (
    <div className="chat-markdown whitespace-pre-wrap break-words">
      {thinking && <ThinkingBlock thinking={thinking} />}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          strong: ({ children }) => {
            const text = String(children)
            if (text.startsWith('@') && mentionNames.has(text.slice(1).toLowerCase())) {
              return <span className="text-[#6bc5e8] font-bold">{text}</span>
            }
            return <strong className="font-bold text-[#e7dfd3]">{children}</strong>
          },
          em: ({ children }) => <em className="italic text-[#c8bdb8]">{children}</em>,
          code: ({ className, children }) => {
            const lang = className?.replace('language-', '')
            if (lang) {
              return (
                <code>
                  <span className="text-[10px] text-[#6b6060] select-none">{lang}</span>
                  {children}
                </code>
              )
            }
            return <code className="chat-code-inline">{children}</code>
          },
          pre: ({ children }) => (
            <pre className="my-1 bg-[#0a0809] border border-[#2a2622] rounded px-3 py-2 text-[12px] text-[#7ecfa8] overflow-x-auto whitespace-pre">
              {children}
            </pre>
          ),
          a: ({ href, children }) => {
            const vaultMatch = href?.match(/^vault:\/\/(.+)/)
            if (vaultMatch && onOpenDoc) {
              return (
                <span
                  className="text-[#6bc5e8] underline cursor-pointer hover:text-[#f0b35e]"
                  onClick={() => onOpenDoc(vaultMatch[1])}
                >{children}</span>
              )
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#6bc5e8] underline hover:text-[#f0b35e]">{children}</a>
          },
          ul: ({ children }) => <ul className="list-disc list-inside ml-2 mb-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside ml-2 mb-1">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-[3px] border-[#4a4048] pl-2 ml-1 my-1 text-[#8a7e88] italic">{children}</blockquote>
          ),
          h1: ({ children }) => <h1 className="text-[15px] font-bold text-[#e7dfd3] mb-1 mt-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-bold text-[#e7dfd3] mb-1 mt-1.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13px] font-bold text-[#c8bdb8] mb-0.5 mt-1">{children}</h3>,
          hr: () => <hr className="border-[#2a2622] my-2" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-1">
              <table className="border-collapse border border-[#2a2622] text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-[#2a2622] px-2 py-1 bg-[#1a1614] text-left text-[#c8bdb8]">{children}</th>,
          td: ({ children }) => <td className="border border-[#2a2622] px-2 py-1">{children}</td>,
          img: ({ src, alt }) => (
            <div className="my-2">
              <img
                src={src}
                alt={alt || 'image'}
                className="max-w-[360px] max-h-[260px] border-[2px] border-black object-contain cursor-pointer"
                onClick={() => src && window.open(src, '_blank')}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

const OPTION_ITEM_RE = /^\[([A-Za-z\d])\]\s+(.+)$/

function extractFeedbackItems(content: string): FeedbackItem[] {
  const lines = content.split(/\r?\n/)
  const items: FeedbackItem[] = []
  let hasOptions = false

  // First pass: detect if there are option-style items [A] [B] [C]
  for (const line of lines) {
    if (OPTION_ITEM_RE.test(line.trim())) { hasOptions = true; break }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!trimmed) continue

    // Option format: [A] option text
    const optMatch = trimmed.match(OPTION_ITEM_RE)
    if (optMatch) {
      const text = optMatch[2]?.trim()
      if (text) {
        const details: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const detailLine = lines[j] ?? ''
          const detailTrimmed = detailLine.trim()
          if (!detailTrimmed) continue
          if (detailTrimmed.match(OPTION_ITEM_RE)) break
          if (!/^\s+/.test(detailLine) && !detailTrimmed.startsWith('>')) break
          details.push(detailTrimmed.replace(/^>\s?/, ''))
          i = j
        }
        items.push({
          index: items.length,
          text,
          type: 'option',
          label: optMatch[1].toUpperCase(),
          details,
        })
      }
      continue
    }

    // Opinion format: bullet/numbered list items (only if no options present)
    if (!hasOptions) {
      const match = trimmed.match(FEEDBACK_ITEM_RE)
      if (!match) continue
      const text = match[1]?.trim()
      if (!text) continue
      items.push({ index: items.length, text, type: 'opinion' })
    }
  }

  return items
}

// Renders text, highlighting @Name patterns that match known mentions
const MENTION_RE = /(@\w+)/g

function TextWithMentions({
  text,
  mentionNames,
}: {
  text: string
  mentionNames: Set<string>
}) {
  const segments = text.split(MENTION_RE)
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((seg, i) => {
        if (seg.startsWith('@') && mentionNames.has(seg.slice(1).toLowerCase())) {
          return (
            <span key={i} className="text-[#6bc5e8] font-bold">{seg}</span>
          )
        }
        return seg
      })}
    </span>
  )
}

function MessageFeedbackPanel({
  messageId,
  items,
  feedback,
  onSubmit,
}: {
  messageId: string
  items: FeedbackItem[]
  feedback?: Record<string, MessageFeedbackVerdict>
  onSubmit: (messageId: string, itemIndex: number, verdict: MessageFeedbackVerdict) => Promise<void>
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const isOptionMode = items.some(i => i.type === 'option')

  // For option mode: find which option is currently selected
  const selectedOptionIndex = isOptionMode
    ? items.findIndex(i => feedback?.[String(i.index)] === 'selected')
    : -1

  return (
    <div className="mt-3 border-t border-black/30 pt-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#4a606c]">
        {isOptionMode ? 'donovan decision card' : 'donovan feedback'}
      </div>

      {isOptionMode ? (
        /* Option mode: selectable choices */
        <div className="space-y-2">
          <div className="text-[11px] text-[#7f8e97]">
            选择后会同步回对话，作为你对 Donovan 的明确决策。
          </div>
          {items.filter(i => i.type === 'option').map((item) => {
            const isSelected = feedback?.[String(item.index)] === 'selected'
            const otherSelected = selectedOptionIndex >= 0 && !isSelected
            const key = `${item.index}:selected`

            return (
              <button
                key={item.index}
                onClick={async () => {
                  if (pendingKey) return
                  setPendingKey(key)
                  try {
                    await onSubmit(messageId, item.index, 'selected')
                  } finally {
                    setPendingKey(null)
                  }
                }}
                disabled={pendingKey !== null}
                className={`w-full text-left border px-3 py-2 text-[12px] flex items-start gap-3 transition-colors ${
                  isSelected
                    ? 'border-[#6bc5e8] bg-[#142535] text-[#e0d8d0]'
                    : otherSelected
                    ? 'border-black/50 bg-[#0c0a0e] text-[#4a4048]'
                    : 'border-black bg-[#10161c] text-[#d7d0c8] hover:bg-[#162030] hover:border-[#6bc5e8]/40'
                } disabled:opacity-50`}
              >
                <span className={`w-5 h-5 border-[2px] flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  isSelected ? 'border-[#6bc5e8] bg-[#1a3545] text-[#6bc5e8]' : 'border-black bg-[#0e0c10] text-[#4a4048]'
                }`}>
                  {item.label}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] leading-5">
                    {pendingKey === key ? 'saving...' : item.text}
                  </span>
                  {item.details && item.details.length > 0 && (
                    <span className="mt-1 block space-y-1">
                      {item.details.map((detail, idx) => (
                        <span key={idx} className="block text-[11px] leading-4 text-[#8ea2af]">
                          {detail}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {isSelected && <span className="text-[#6bc5e8] text-[10px]">✓</span>}
              </button>
            )
          })}
        </div>
      ) : (
        /* Opinion mode: 对/错 buttons */
        items.filter(i => i.type === 'opinion').map((item) => {
          const selected = feedback?.[String(item.index)] ?? null
          const correctKey = `${item.index}:correct`
          const wrongKey = `${item.index}:wrong`

          return (
            <div key={item.index} className="border border-black bg-[#10161c] px-2 py-2">
              <div className="text-[12px] text-[#d7d0c8] leading-5">{item.text}</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={async () => {
                    if (pendingKey) return
                    setPendingKey(correctKey)
                    try {
                      await onSubmit(messageId, item.index, 'correct')
                    } finally {
                      setPendingKey(null)
                    }
                  }}
                  disabled={pendingKey !== null}
                  className={`border px-2 py-1 text-[11px] uppercase tracking-[0.08em] ${
                    selected === 'correct'
                      ? 'border-[#3abfa0] bg-[#183126] text-[#8ee0b1]'
                      : 'border-black bg-[#152018] text-[#7ecfa8] hover:bg-[#1c2b20]'
                  } disabled:opacity-50`}
                >
                  {pendingKey === correctKey ? 'saving...' : '对'}
                </button>
                <button
                  onClick={async () => {
                    if (pendingKey) return
                    setPendingKey(wrongKey)
                    try {
                      await onSubmit(messageId, item.index, 'wrong')
                    } finally {
                      setPendingKey(null)
                    }
                  }}
                  disabled={pendingKey !== null}
                  className={`border px-2 py-1 text-[11px] uppercase tracking-[0.08em] ${
                    selected === 'wrong'
                      ? 'border-[#c96a6a] bg-[#311818] text-[#ff9b9b]'
                      : 'border-black bg-[#251515] text-[#d78787] hover:bg-[#311a1a]'
                  } disabled:opacity-50`}
                >
                  {pendingKey === wrongKey ? 'saving...' : '错'}
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase">
      {children}
    </span>
  )
}

function taskStatus(status: string) {
  if (status === 'completed')   return { bg: '#1e2e26', text: '#7ecfa8', label: '✓ done' }
  if (status === 'reviewing')   return { bg: '#352515', text: '#f0b35e', label: '◌ in review' }
  if (status === 'in_progress') return { bg: '#1a2535', text: '#6bc5e8', label: '▶ in progress' }
  if (status === 'claimed')     return { bg: '#2a1a35', text: '#b08cd9', label: '● assigned' }
  return                               { bg: '#2a2622', text: '#9a8888', label: '○ unassigned'  }
}
