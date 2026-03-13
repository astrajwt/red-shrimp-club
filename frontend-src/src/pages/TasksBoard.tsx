/**
 * @file TasksBoard.tsx — 任务看板页面
 * @description 看板视图展示所有任务，按状态分为三列：
 *   - Open（待处理）→ Doing（进行中/已认领）→ Done（已完成）
 *
 * 核心功能：
 *   1. 三列看板布局，每列显示对应状态的任务卡片
 *   2. 实时更新 — 监听 task:updated 和 task:completed WebSocket 事件自动刷新
 *   3. 任务卡片展示：序列号、标题、认领 agent、关联文档（含读取状态）、技能标签
 *   4. 文档状态标记 — 点击未读文档可标记为已读
 *
 * 组件结构：
 *   - TasksBoard（主组件）— 看板布局 + 数据加载
 *   - TaskCard — 单个任务卡片
 *   - DocStatusDot — 文档状态指示点（writing=黄色脉冲, unread=蓝色, read=灰色）
 */

import { useEffect, useState } from 'react'
import { tasksApi, type Task, type TaskDoc } from '../lib/api'
import { socketClient } from '../lib/socket'

/** 看板列定义：状态 key、显示标签、背景色和文字色 */
const columns = [
  { key: 'open',      label: 'Open',  color: '#2a2622', textColor: '#9a8888' },
  { key: 'claimed',   label: 'Doing', color: '#1a2535', textColor: '#6bc5e8' },
  { key: 'completed', label: 'Done',  color: '#1e2e26', textColor: '#7ecfa8' },
] as const

type ColKey = typeof columns[number]['key']

export default function TasksBoard() {
  const [tasks, setTasks] = useState<Task[]>([])                  // 所有任务
  const [channelId, setChannelId] = useState<string | undefined>() // 可选频道过滤

  /** 从后端重新加载任务列表 */
  const reload = () =>
    tasksApi.list(channelId).then(({ tasks: t }) => setTasks(t))

  // 初始加载 + 监听实时任务变更事件
  useEffect(() => {
    reload()

    const unsub = socketClient.on('task:updated', () => reload())
    const unsub2 = socketClient.on('task:completed', () => reload())
    return () => { unsub(); unsub2() }
  }, [channelId])

  /**
   * 标记任务关联文档为已读
   * 调用 API 后乐观更新本地状态（不等待刷新列表）
   * @param taskId - 任务 ID
   * @param docId - 文档 ID
   */
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
        <div className="flex gap-2">
          <button className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] text-[12px] uppercase px-4 py-2 hover:bg-[#243548]">
            filter ▾
          </button>
          <button
            className="border-[3px] border-black bg-[#c0392b] text-black text-[12px] uppercase px-4 py-2 hover:bg-[#e04050]"
            style={{ transform: 'rotate(0.2deg)' }}
          >
            + new task
          </button>
        </div>
      </div>

      {/* Kanban columns */}
      <div className="grid grid-cols-3 gap-4 items-start">
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
                  rotate={i % 2 === 0 ? '-0.25deg' : '0.25deg'}
                  onMarkDocRead={markDocRead}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * TaskCard — 单个任务卡片组件
 * @param task - 任务数据
 * @param rotate - CSS 旋转角度（交替 +/- 0.25deg，模拟手工贴纸效果）
 * @param onMarkDocRead - 标记文档已读的回调
 * 卡片结构：标题栏 → 认领状态 → 关联文档列表 → 技能标签
 */
function TaskCard({
  task, rotate, onMarkDocRead,
}: {
  task: Task
  rotate: string
  onMarkDocRead: (taskId: string, docId: string) => void
}) {
  return (
    <div
      className="border-[3px] border-black bg-[#191619]"
      style={{
        transform: `rotate(${rotate})`,
        boxShadow: '3px 4px 0 rgba(0,0,0,0.85), 0 0 10px rgba(50,120,220,0.10)',
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
          <span className="text-[12px] text-[#6bc5e8]">@ agent</span>
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
    </div>
  )
}

/**
 * DocStatusDot — 文档状态指示点
 * @param status - 文档状态：writing（黄色脉冲）/ unread（蓝色）/ read（灰色）
 * writing 状态带脉冲动画，提示 agent 正在写入
 */
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
