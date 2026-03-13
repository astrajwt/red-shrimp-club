/**
 * @file ChannelsView.tsx — 主频道视图（应用主 shell）
 * @description 类 Slack 的三栏布局：
 *   1. 左侧 — 频道列表 + 私信列表（带未读计数）
 *   2. 中间 — 消息流 + 输入框（实时收发）
 *   3. 右侧 — 当前频道的任务侧边栏
 *
 * 核心功能：
 *   - 加载频道列表和未读计数
 *   - 切换频道时加载历史消息和任务、加入 WebSocket 房间
 *   - 实时接收新消息（当前频道追加显示，其他频道增加未读计数）
 *   - 发送消息（Enter 快捷键 + 发送按钮）
 *
 * 状态管理：全部使用组件内 useState，无外部 store
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  channelsApi, messagesApi, tasksApi,
  type Channel, type Message, type Task, type UnreadCount,
} from '../lib/api'
import { socketClient } from '../lib/socket'
import { useAuthStore } from '../store/auth'

export default function ChannelsView() {
  const { user } = useAuthStore()

  // ── 组件状态 ──
  const [channels, setChannels] = useState<Channel[]>([])           // 普通频道列表
  const [dms, setDMs] = useState<Channel[]>([])                     // 私信频道列表
  const [activeId, setActiveId] = useState<string | null>(null)     // 当前选中的频道 ID
  const [messages, setMessages] = useState<Message[]>([])           // 当前频道的消息列表
  const [tasks, setTasks] = useState<Task[]>([])                    // 当前频道的任务列表
  const [unread, setUnread] = useState<Record<string, number>>({})  // 各频道未读计数 { channelId: count }
  const [input, setInput] = useState('')                            // 消息输入框内容
  const [sending, setSending] = useState(false)                     // 发送中锁定标志
  const bottomRef = useRef<HTMLDivElement>(null)                    // 消息列表底部锚点（用于自动滚动）

  // 初始化：加载频道列表 + 未读计数，默认选中第一个普通频道
  useEffect(() => {
    channelsApi.list().then(({ channels: chs }) => {
      const regular = chs.filter(c => c.type === 'text')
      const dmList  = chs.filter(c => c.type === 'dm')
      setChannels(regular)
      setDMs(dmList)
      if (regular.length > 0) setActiveId(regular[0].id)
    })
    channelsApi.unread().then(({ unread: u }) => {
      const map: Record<string, number> = {}
      for (const r of u) map[r.channel_id] = r.count
      setUnread(map)
    })
  }, [])

  // 切换频道：加载消息历史 + 任务列表 + 加入 WebSocket 房间 + 标记已读
  useEffect(() => {
    if (!activeId) return
    socketClient.joinChannel(activeId)
    messagesApi.history(activeId).then(({ messages: msgs }) =>
      setMessages(msgs.reverse()))  // API 返回降序，反转为升序显示
    tasksApi.list(activeId).then(({ tasks: t }) => setTasks(t))
    // 标记当前频道为全部已读（seq=999999 表示读到最新）
    channelsApi.markRead(activeId, 999999).catch(() => {})
    setUnread(u => ({ ...u, [activeId]: 0 }))
    return () => { socketClient.leaveChannel(activeId) }  // 离开时退出房间
  }, [activeId])

  // 实时消息处理：当前频道的消息追加到列表，其他频道增加未读计数
  useEffect(() => {
    return socketClient.on('message', ({ channelId, message }) => {
      if (channelId !== activeId) {
        setUnread(u => ({ ...u, [channelId]: (u[channelId] ?? 0) + 1 }))
      } else {
        setMessages(m => [...m, message as Message])
      }
    })
  }, [activeId])

  // 新消息到来时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /**
   * 发送消息
   * 校验：输入非空 + 已选频道 + 非发送中
   * 成功后清空输入框
   */
  const send = useCallback(async () => {
    if (!input.trim() || !activeId || sending) return
    setSending(true)
    try {
      await messagesApi.send(activeId, input.trim())
      setInput('')
    } catch (err: any) {
      console.error('Send failed:', err.message)
    } finally {
      setSending(false)
    }
  }, [input, activeId, sending])

  // 查找当前选中的频道对象（用于显示频道名称）
  const activeChannel = [...channels, ...dms].find(c => c.id === activeId)

  return (
    <div
      className="flex h-screen bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* ── Channel List ─────────────────────────────────────────────── */}
      <aside className="w-[200px] border-r-[3px] border-black bg-[#141118] flex flex-col">
        <div className="border-b-[3px] border-black px-3 py-3 bg-[#1a161b]">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">workspace</div>
          <div className="text-[16px]">red-shrimp-lab</div>
        </div>

        {/* Channels */}
        <div className="px-3 pt-3">
          <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">channels</div>
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

        {/* DMs */}
        {dms.length > 0 && (
          <div className="px-3 pt-4">
            <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">direct messages</div>
            {dms.map((dm) => (
              <button
                key={dm.id}
                onClick={() => setActiveId(dm.id)}
                className={`w-full flex items-center gap-2 px-2 py-1 mb-1 text-left
                  ${dm.id === activeId ? 'text-[#f0e8e8]' : 'text-[#9a8888] hover:text-[#c8bdb8]'}`}
              >
                <span className="w-2 h-2 border border-black bg-[#6bc5e8]" />
                <span className="text-[13px] truncate">{dm.name}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* ── Message Area ─────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col border-r-[3px] border-black min-w-0">
        {/* Header */}
        <div className="border-b-[3px] border-black bg-[#141118] px-5 py-3 flex items-center gap-3">
          <span className="text-[22px] text-[#c0392b]">#</span>
          <div>
            <div className="text-[16px]">{activeChannel?.name ?? '...'}</div>
            <div className="text-[11px] text-[#6bc5e8]">General channel</div>
          </div>
          <div className="ml-auto flex gap-2">
            <Chip>{tasks.length} tasks</Chip>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {messages.map((msg) => {
            const isAgent = !!msg.sender_agent_id
            const name = msg.sender?.display_name ?? msg.sender?.username ?? (isAgent ? 'agent' : 'user')
            const time = new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            return (
              <div key={msg.id} className="flex gap-3 group">
                <div
                  className="w-8 h-8 border-[2px] border-black flex items-center justify-center text-[11px] shrink-0 mt-1"
                  style={{
                    background: isAgent ? '#1a2535' : '#3a1520',
                    color: isAgent ? '#6bc5e8' : '#f0e8e8',
                  }}
                >
                  {name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className={`text-[13px] ${isAgent ? 'text-[#6bc5e8]' : 'text-[#c0392b]'}`}>
                      {isAgent ? '(agent) ' : ''}{name}
                    </span>
                    <span className="text-[11px] text-[#4a4048]">{time}</span>
                  </div>
                  <div
                    className="text-[14px] text-[#e0d8d0] leading-6 pl-2 border-l-[2px] whitespace-pre-wrap break-words"
                    style={{ borderColor: isAgent ? '#6bc5e8' : '#c0392b' }}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t-[3px] border-black px-4 py-3 bg-[#120f13]">
          <div
            className="flex items-center gap-3 border-[3px] border-black bg-[#191619] px-3 py-2"
            style={{ boxShadow: '0 0 12px rgba(50,120,220,0.10)' }}
          >
            <span className="text-[#4a4048] text-[13px] shrink-0">
              #{activeChannel?.name ?? '...'}
            </span>
            <input
              className="flex-1 bg-transparent text-[14px] text-[#e7dfd3] outline-none placeholder-[#4a4048]"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
              placeholder="type a message..."
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="border-[2px] border-black bg-[#c0392b] text-black px-3 py-1 text-[12px] uppercase hover:bg-[#e04050] disabled:opacity-40"
            >
              send ↑
            </button>
          </div>
        </div>
      </main>

      {/* ── Task Sidebar ──────────────────────────────────────────────── */}
      <aside className="w-[260px] bg-[#141118] flex flex-col">
        <div className="border-b-[3px] border-black px-3 py-3 bg-[#c0392b]">
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
                      <div className="text-[11px] text-[#6bc5e8] mt-1">@ agent</div>
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

        <div className="border-t-[3px] border-black px-3 py-2">
          <button className="w-full border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] text-[12px] uppercase py-2 hover:bg-[#243548]">
            + new task
          </button>
        </div>
      </aside>
    </div>
  )
}

/**
 * Chip — 小标签组件（深蓝背景 + 青色文字，用于头部信息展示）
 * @param children - 标签内容
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase">
      {children}
    </span>
  )
}

/**
 * 根据任务状态返回对应的颜色配置
 * @param status - 任务状态字符串
 * @returns { bg: 背景色, text: 文字色, label: 显示标签 }
 */
function taskStatus(status: string) {
  if (status === 'completed') return { bg: '#1e2e26', text: '#7ecfa8', label: '✓ done'  }
  if (status === 'claimed')   return { bg: '#1a2535', text: '#6bc5e8', label: '▶ doing' }
  return                             { bg: '#2a2622', text: '#9a8888', label: '○ open'  }
}
