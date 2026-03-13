// Red Shrimp Lab — Channels View (connected to backend)

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  channelsApi, messagesApi, tasksApi, agentsApi, filesApi,
  type Channel, type Message, type Task, type Agent,
  type MessageAttachment, type MessageMention,
} from '../lib/api'
import { socketClient } from '../lib/socket'
import { useAuthStore } from '../store/auth'

export default function ChannelsView() {
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
  const [imgUploading, setImgUploading] = useState(false)
  const [pendingImg, setPendingImg] = useState<{
    url: string; previewUrl: string; fileId: string
  } | null>(null)
  const [showCreateCh, setShowCreateCh] = useState(false)
  const [newChName, setNewChName]       = useState('')
  const [creatingCh, setCreatingCh]     = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [showInvite, setShowInvite]     = useState(false)
  const [inviting, setInviting]         = useState(false)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)

  // ── Load initial data ──────────────────────────────────────────────
  useEffect(() => {
    channelsApi.list().then(chs => {
      setChannels(chs)
      if (chs.length > 0) setActiveId(a => a ?? chs[0].id)
    })
    channelsApi.listDMs().then(setDMs).catch(() => {})
    channelsApi.unread().then(setUnread).catch(() => {})
    agentsApi.list().then(setAgents).catch(() => {})
  }, [])

  // ── Switch channel ─────────────────────────────────────────────────
  useEffect(() => {
    if (!activeId) return
    socketClient.joinChannel(activeId)
    messagesApi.history(activeId).then(setMessages)
    tasksApi.list(activeId).then(({ tasks: t }) => setTasks(t))
    channelsApi.markRead(activeId, 999999).catch(() => {})
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
      }
    })
  }, [activeId])

  // ── Scroll to bottom ───────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Image upload ───────────────────────────────────────────────────
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImgUploading(true)
    try {
      const localPreview = URL.createObjectURL(file)
      const { file: uploaded } = await filesApi.upload(file)
      setPendingImg({ url: uploaded.url, previewUrl: localPreview, fileId: uploaded.id })
    } catch (err: any) {
      console.error('Upload failed:', err.message)
    } finally {
      setImgUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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
    if ((!input.trim() && !pendingImg) || !activeId || sending) return
    setSending(true)
    const content = input.trim() || '\u200b'
    const fileIds = pendingImg ? [pendingImg.fileId] : undefined
    setInput('')
    setPendingImg(null)
    setMentionQuery(null)
    try {
      const msg = await messagesApi.send(activeId, content, fileIds)
      // Optimistically show sent message immediately (dedup by id in WebSocket handler)
      setMessages(m => m.find(x => x.id === msg.id) ? m : [...m, msg])
    } catch (err: any) {
      console.error('Send failed:', err.message)
    } finally {
      setSending(false)
    }
  }, [input, activeId, sending, pendingImg])

  // ── Open DM with a shrimp ──────────────────────────────────────────
  const openDM = async (agentId: string) => {
    try {
      const dm = await channelsApi.openDM(agentId)
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

  // @ mention suggestions (agents whose name starts with mentionQuery)
  const mentionSuggestions = mentionQuery !== null
    ? agents.filter(a => a.name.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6)
    : []

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

        {/* Shrimps — click to open DM directly */}
        {agents.length > 0 && (
          <div className="px-3 pt-4">
            <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">shrimps</div>
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
                <span
                  className="w-2 h-2 border border-black shrink-0"
                  style={{ background: ag.status === 'running' ? '#c0392b' : '#3a3535' }}
                />
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
          <span className="text-[22px] text-[#c0392b]">
            {activeChannel?.type === 'dm' ? '✉' : '#'}
          </span>
          <div>
            <div className="text-[16px]">{activeChName}</div>
            <div className="text-[11px] text-[#6bc5e8]">
              {activeChannel?.type === 'dm' ? 'direct message' : 'channel'}
            </div>
          </div>
          <div className="ml-auto flex gap-2 items-center relative">
            {activeChannel?.type !== 'dm' && (
              <div className="relative">
                <button
                  onClick={() => setShowInvite(v => !v)}
                  className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase hover:bg-[#243548]"
                  title="邀请 Shrimp 加入频道"
                >
                  + shrimp
                </button>
                {showInvite && (
                  <div className="absolute top-full right-0 mt-1 bg-[#141118] border-[3px] border-black z-30 min-w-[180px]">
                    <div className="px-3 py-1.5 text-[10px] text-[#4a4048] uppercase border-b border-black/40">
                      invite shrimp
                    </div>
                    {agents.map(ag => (
                      <button
                        key={ag.id}
                        onClick={() => inviteShrimp(ag.id)}
                        disabled={inviting}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#3a1520] text-[13px] text-[#6bc5e8] disabled:opacity-40"
                      >
                        <span
                          className="w-1.5 h-1.5 shrink-0"
                          style={{ background: ag.status === 'running' ? '#c0392b' : '#4a4048' }}
                        />
                        {ag.name}
                      </button>
                    ))}
                    {agents.length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-[#4a4048]">no shrimps yet</div>
                    )}
                  </div>
                )}
              </div>
            )}
            <Chip>{tasks.length} tasks</Chip>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {messages.map((msg) => {
            const isAgent = msg.sender_type === 'agent'
            const name = msg.sender_name || (isAgent ? 'agent' : 'user')
            const time = new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            return (
              <div key={msg.id} className="flex gap-3 group">
                <div
                  className="w-8 h-8 border-[2px] border-black flex items-center justify-center text-[11px] shrink-0 mt-1"
                  style={{
                    background: isAgent ? '#1a2535' : '#3a1520',
                    color:      isAgent ? '#6bc5e8' : '#f0e8e8',
                  }}
                >
                  {name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className={`text-[13px] ${isAgent ? 'text-[#6bc5e8]' : 'text-[#c0392b]'}`}>
                      {isAgent ? '(shrimp) ' : ''}{name}
                    </span>
                    <span className="text-[11px] text-[#4a4048]">{time}</span>
                  </div>
                  <div
                    className="text-[14px] text-[#e0d8d0] leading-6 pl-2 border-l-[2px]"
                    style={{ borderColor: isAgent ? '#6bc5e8' : '#c0392b' }}
                  >
                    <MessageContent content={msg.content} mentions={msg.mentions} />
                    {/* Attachments */}
                    {msg.attachments?.map((att, i) =>
                      att.mime_type.startsWith('image/') ? (
                        <div key={i} className="mt-2">
                          <img
                            src={att.url}
                            alt={att.filename}
                            className="max-w-[360px] max-h-[260px] border-[2px] border-black object-contain cursor-pointer"
                            onClick={() => window.open(att.url, '_blank')}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        </div>
                      ) : (
                        <div key={i} className="mt-1 flex items-center gap-2 text-[12px] text-[#6bc5e8]">
                          <span>📎</span>
                          <a href={att.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {att.filename}
                          </a>
                          <span className="text-[10px] text-[#4a4048]">
                            ({Math.round((att.size ?? 0) / 1024)}KB)
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t-[3px] border-black px-4 py-3 bg-[#120f13] relative shrink-0">
          {/* Pending image preview */}
          {pendingImg && (
            <div className="mb-2 flex items-center gap-2">
              <img
                src={pendingImg.previewUrl}
                alt="pending"
                className="h-16 border-[2px] border-black object-cover"
              />
              <button
                onClick={() => setPendingImg(null)}
                className="text-[11px] text-[#c0392b] hover:underline"
              >
                ✕ 移除
              </button>
            </div>
          )}

          {/* @ mention dropdown */}
          {mentionSuggestions.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-[#141118] border-[3px] border-black z-20 min-w-[160px]">
              {mentionSuggestions.map((ag, idx) => (
                <button
                  key={ag.id}
                  onMouseDown={e => { e.preventDefault(); insertMention(ag.name) }}
                  onMouseEnter={() => setMentionIndex(idx)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[#6bc5e8] ${idx === mentionIndex ? 'bg-[#3a1520]' : 'hover:bg-[#3a1520]'}`}
                >
                  <span
                    className="w-1.5 h-1.5 shrink-0"
                    style={{ background: ag.status === 'running' ? '#c0392b' : '#4a4048' }}
                  />
                  {ag.name}
                </button>
              ))}
            </div>
          )}

          <div
            className="flex items-center gap-3 border-[3px] border-black bg-[#191619] px-3 py-2"
            style={{ boxShadow: '0 0 12px rgba(50,120,220,0.10)' }}
          >
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />
            {/* Attach image button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={imgUploading}
              className="text-[#4a4048] hover:text-[#6bc5e8] transition-colors disabled:opacity-40 shrink-0 text-[16px]"
              title="发送图片"
            >
              {imgUploading ? '↑' : '⌅'}
            </button>
            <span className="text-[#4a4048] text-[13px] shrink-0">
              {activeChannel?.type === 'dm' ? '✉' : '#'}{activeChName}
            </span>
            <input
              ref={inputRef}
              className="flex-1 bg-transparent text-[14px] text-[#e7dfd3] outline-none placeholder-[#4a4048]"
              value={input}
              onChange={handleInputChange}
              onKeyDown={e => {
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
              placeholder="type a message... (@name to mention)"
            />
            <button
              onClick={send}
              disabled={sending || (!input.trim() && !pendingImg)}
              className="border-[2px] border-black bg-[#c0392b] text-black px-3 py-1 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
            >
              send ↑
            </button>
          </div>
        </div>
      </main>

      {/* ── Task Sidebar ──────────────────────────────────────────────── */}
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
                  <span className="text-[11px] text-[#4a4048] shrink-0 mt-0.5">#{task.seq}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] leading-5">{task.title}</div>
                    {task.claimed_by_agent_id && (
                      <div className="text-[11px] text-[#6bc5e8] mt-1">@ shrimp</div>
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
    </div>
  )
}

// ─── MessageContent ────────────────────────────────────────────────────────────
// Renders message text: ![...](url) → <img>, @Name → highlighted mention

const IMG_MD = /!\[([^\]]*)\]\(([^)]+)\)/g
const ZERO_WIDTH = '\u200b'

function MessageContent({
  content,
  mentions,
}: {
  content: string
  mentions?: MessageMention[]
}) {
  // Skip zero-width placeholder (image-only messages)
  const text = content === ZERO_WIDTH ? '' : content

  if (!text) return null

  const mentionNames = new Set((mentions ?? []).map(m => m.name.toLowerCase()))

  // Build parts: images and text with @mentions highlighted
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  IMG_MD.lastIndex = 0

  while ((match = IMG_MD.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(
        <TextWithMentions
          key={`t${lastIdx}`}
          text={text.slice(lastIdx, match.index)}
          mentionNames={mentionNames}
        />
      )
    }
    parts.push(
      <div key={`img${match.index}`} className="my-2">
        <img
          src={match[2]}
          alt={match[1] || 'image'}
          className="max-w-[360px] max-h-[260px] border-[2px] border-black object-contain cursor-pointer"
          onClick={() => window.open(match![2], '_blank')}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      </div>
    )
    lastIdx = match.index + match[0].length
  }

  if (lastIdx < text.length) {
    parts.push(
      <TextWithMentions
        key={`t${lastIdx}`}
        text={text.slice(lastIdx)}
        mentionNames={mentionNames}
      />
    )
  }

  return <>{parts}</>
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase">
      {children}
    </span>
  )
}

function taskStatus(status: string) {
  if (status === 'completed') return { bg: '#1e2e26', text: '#7ecfa8', label: '✓ done'  }
  if (status === 'reviewing') return { bg: '#352515', text: '#f0b35e', label: '◌ reviewing' }
  if (status === 'claimed')   return { bg: '#1a2535', text: '#6bc5e8', label: '▶ doing' }
  return                             { bg: '#2a2622', text: '#9a8888', label: '○ open'  }
}
