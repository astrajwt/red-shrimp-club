// Red Shrimp Lab — Bulletin Board (公告栏)
// Category-tabbed card feed: chrono, ops, report, announcement
// Cards: 3px border, 3D shadow, category color stripe, time-sorted

import { useCallback, useEffect, useState } from 'react'
import { bulletinApi, type Bulletin } from '../lib/api'
import { socketClient } from '../lib/socket'

const CATEGORIES = [
  { key: '',             label: '全部' },
  { key: 'chrono',       label: 'Chrono',  color: '#6bc5e8' },
  { key: 'ops',          label: 'Ops',     color: '#f0b35e' },
  { key: 'report',       label: '报告',    color: '#7ecfa8' },
  { key: 'announcement', label: '公告',    color: '#c0392b' },
] as const

const CAT_COLORS: Record<string, string> = {
  chrono:       '#6bc5e8',
  ops:          '#f0b35e',
  report:       '#7ecfa8',
  announcement: '#c0392b',
  bookmark:     '#8d8188',
  sticky:       '#f0b35e',
}

const PRIORITY_BADGE: Record<string, { label: string; color: string }> = {
  urgent: { label: 'URGENT', color: '#c0392b' },
  normal: { label: '', color: '' },
  low:    { label: 'low', color: '#8d8188' },
}

const TIME_FILTERS = [
  { key: '',      label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'week',  label: '本周' },
] as const

interface Props {
  onOpenDoc?: (path: string) => void
}

export default function BulletinBoard({ onOpenDoc }: Props) {
  const [bulletins, setBulletins] = useState<Bulletin[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [timeFilter, setTimeFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    try {
      const { bulletins: list } = await bulletinApi.list({
        category: category || undefined,
        limit: 100,
      })
      setBulletins(list)
    } catch (err) {
      console.error('Failed to load bulletins:', err)
    } finally {
      setLoading(false)
    }
  }, [category])

  useEffect(() => { load() }, [load])

  // Real-time updates via socket
  useEffect(() => {
    const unsubs = [
      socketClient.on('bulletin:created', () => load()),
      socketClient.on('bulletin:updated', () => load()),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [load])

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  const handleDelete = async (id: string) => {
    try {
      await bulletinApi.delete(id)
      setBulletins(prev => prev.filter(b => b.id !== id))
    } catch (err) {
      console.error('Failed to delete bulletin:', err)
    }
  }

  const handleTogglePin = async (b: Bulletin) => {
    try {
      await bulletinApi.update(b.id, { pinned: !b.pinned })
      load()
    } catch (err) {
      console.error('Failed to toggle pin:', err)
    }
  }

  // Time filtering (client-side)
  const filtered = bulletins.filter(b => {
    if (!timeFilter) return true
    const created = new Date(b.created_at)
    const now = new Date()
    if (timeFilter === 'today') {
      return created.toDateString() === now.toDateString()
    }
    if (timeFilter === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return created >= weekAgo
    }
    return true
  })

  // Pinned first, then by date
  const pinned = filtered.filter(b => b.pinned)
  const unpinned = filtered.filter(b => !b.pinned)

  return (
    <div className="flex flex-col h-full bg-[#0e0c10] text-[#e7dfd3] overflow-hidden"
         style={{ fontFamily: '"Share Tech Mono", monospace' }}>

      {/* ── Header ───────────────────────────────── */}
      <div className="shrink-0 border-b-[3px] border-black bg-[#110e12] px-6 py-3 flex items-center justify-between">
        <div className="text-[14px] uppercase tracking-[0.15em]">公告栏</div>
        <button
          onClick={() => setShowCreate(true)}
          className="text-[11px] px-3 py-1 border-[2px] border-black bg-[#191619]
                     shadow-[2px_3px_0_rgba(0,0,0,0.8)] hover:shadow-[3px_4px_0_rgba(0,0,0,0.9)]
                     hover:bg-[#1e1a20] transition-all active:translate-x-[2px] active:translate-y-[2px]
                     active:shadow-none uppercase tracking-wider"
        >
          + 新公告
        </button>
      </div>

      {/* ── Category tabs + time filter ──────────── */}
      <div className="shrink-0 flex items-center gap-1 px-6 py-2 border-b border-[#2a2530]">
        {CATEGORIES.map(c => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`px-3 py-1 text-[11px] uppercase tracking-wider border-b-[2px] transition-colors ${
              category === c.key
                ? 'text-[#e7dfd3]'
                : 'border-transparent text-[#6a6068] hover:text-[#c8bdb8]'
            }`}
            style={{
              borderBottomColor: category === c.key
                ? ('color' in c ? c.color : '#e7dfd3')
                : 'transparent',
            }}
          >
            {c.label}
          </button>
        ))}
        <div className="flex-1" />
        {TIME_FILTERS.map(t => (
          <button
            key={t.key}
            onClick={() => setTimeFilter(t.key)}
            className={`px-2 py-1 text-[10px] tracking-wider transition-colors ${
              timeFilter === t.key
                ? 'text-[#e7dfd3]'
                : 'text-[#6a6068] hover:text-[#c8bdb8]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Cards grid ───────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="text-center text-[#8d8188] text-[12px] py-12">loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-[#8d8188] text-[12px] py-12">
            暂无公告 — 点击 "+ 新公告" 创建
          </div>
        ) : (
          <>
            {/* Pinned */}
            {pinned.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#8d8188] mb-2">
                  📌 置顶
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {pinned.map(b => (
                    <BulletinCard
                      key={b.id}
                      bulletin={b}
                      onDelete={handleDelete}
                      onTogglePin={handleTogglePin}
                      onOpenDoc={onOpenDoc}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Rest */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {unpinned.map(b => (
                <BulletinCard
                  key={b.id}
                  bulletin={b}
                  onDelete={handleDelete}
                  onTogglePin={handleTogglePin}
                  onOpenDoc={onOpenDoc}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Create modal ─────────────────────────── */}
      {showCreate && (
        <CreateBulletinModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
        />
      )}
    </div>
  )
}

/* ── Bulletin Card ─────────────────────────────────────────────── */

function BulletinCard({ bulletin: b, onDelete, onTogglePin, onOpenDoc }: {
  bulletin: Bulletin
  onDelete: (id: string) => void
  onTogglePin: (b: Bulletin) => void
  onOpenDoc?: (path: string) => void
}) {
  const color = CAT_COLORS[b.category] ?? '#8d8188'
  const priority = PRIORITY_BADGE[b.priority] ?? PRIORITY_BADGE.normal
  const meta = b.metadata as Record<string, any> ?? {}
  const progress = typeof meta.progress === 'number' ? meta.progress : null

  // Slight rotation for doodle feel
  const hash = b.id.charCodeAt(0) + b.id.charCodeAt(b.id.length - 1)
  const rotation = ((hash % 5) - 2) * 0.3

  const timeStr = new Date(b.created_at).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  return (
    <div
      className="group relative border-[3px] border-black bg-[#191619]
                 shadow-[3px_4px_0_rgba(0,0,0,0.8)] hover:shadow-[5px_6px_0_rgba(0,0,0,0.9)]
                 transition-all duration-150 hover:z-10 overflow-hidden"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      {/* Category color stripe */}
      <div className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ backgroundColor: color }} />

      <div className="pl-4 pr-3 py-3">
        {/* Header line */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color }}>
              {b.category}
            </span>
            {priority.label && (
              <span className="text-[9px] px-1 border shrink-0"
                    style={{ color: priority.color, borderColor: priority.color }}>
                {priority.label}
              </span>
            )}
            {b.pinned && <span className="text-[10px] shrink-0">📌</span>}
          </div>
          <span className="text-[10px] text-[#8d8188] shrink-0">{timeStr}</span>
        </div>

        {/* Title */}
        <div className="text-[13px] text-[#e7dfd3] font-bold mb-1 leading-tight">
          {b.title}
        </div>

        {/* Content preview */}
        {b.content && (
          <div className="text-[11px] text-[#c8bfb3] line-clamp-2 mb-2">
            {b.content}
          </div>
        )}

        {/* Progress bar (ops type) */}
        {progress !== null && (
          <div className="mb-2">
            <div className="flex justify-between text-[10px] text-[#8d8188] mb-0.5">
              <span>progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-[3px] bg-[#2a2530] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress}%`, backgroundColor: color }}
              />
            </div>
          </div>
        )}

        {/* Footer: author + links */}
        <div className="flex items-center gap-2 text-[10px] text-[#8d8188]">
          <span className={b.author_type === 'agent' ? 'text-[#6bc5e8]' : ''}>
            {b.author_name}
          </span>
          <div className="flex-1" />
          {b.linked_file && (
            <button
              onClick={() => onOpenDoc?.(b.linked_file!)}
              className="hover:text-[#6bc5e8] transition-colors"
              title={b.linked_file}
            >
              📄
            </button>
          )}
          {b.linked_url && (
            <a
              href={b.linked_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#6bc5e8] transition-colors"
              title={b.linked_url}
            >
              🔗
            </a>
          )}
          {b.linked_task_id && (
            <span className="text-[#6bc5e8]" title={`Task ${b.linked_task_id}`}>
              📋
            </span>
          )}
        </div>

        {/* Hover actions */}
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onTogglePin(b)}
            className="text-[10px] text-[#8d8188] hover:text-[#f0b35e]"
            title={b.pinned ? 'Unpin' : 'Pin'}
          >
            {b.pinned ? '📌' : '📍'}
          </button>
          <button
            onClick={() => onDelete(b.id)}
            className="text-[10px] text-[#8d8188] hover:text-[#c0392b]"
            title="Delete"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Create Bulletin Modal ─────────────────────────────────────── */

function CreateBulletinModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    category: 'announcement',
    title: '',
    content: '',
    priority: 'normal',
    linked_file: '',
    linked_url: '',
    pinned: false,
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      await bulletinApi.create({
        category: form.category,
        title: form.title.trim(),
        content: form.content.trim() || undefined,
        priority: form.priority,
        linked_file: form.linked_file.trim() || undefined,
        linked_url: form.linked_url.trim() || undefined,
        pinned: form.pinned,
      })
      onCreated()
    } catch (err) {
      console.error('Failed to create bulletin:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
         onClick={onClose}>
      <div
        className="w-[480px] border-[3px] border-black bg-[#191619]
                   shadow-[6px_8px_0_rgba(0,0,0,0.9)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b-[3px] border-black bg-[#1e1a20] px-5 py-3 flex items-center justify-between">
          <span className="text-[13px] uppercase tracking-wider">新公告</span>
          <button onClick={onClose} className="text-[#8d8188] hover:text-[#c0392b] text-[14px]">×</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* Category */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">category</label>
            <div className="flex gap-2">
              {CATEGORIES.filter(c => c.key).map(c => (
                <button
                  key={c.key}
                  onClick={() => setForm(p => ({ ...p, category: c.key }))}
                  className={`px-2 py-0.5 text-[10px] border transition-colors ${
                    form.category === c.key
                      ? 'border-current'
                      : 'border-[#3a3340] text-[#6a6068] hover:text-[#c8bdb8]'
                  }`}
                  style={form.category === c.key ? { color: 'color' in c ? c.color : '#e7dfd3' } : {}}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">title</label>
            <input
              value={form.title}
              onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className="w-full bg-[#0e0c10] border border-[#3a3340] px-3 py-1.5 text-[12px]
                         text-[#e7dfd3] outline-none focus:border-[#6bc5e8]"
              placeholder="公告标题..."
              autoFocus
            />
          </div>

          {/* Content */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">content</label>
            <textarea
              value={form.content}
              onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
              className="w-full bg-[#0e0c10] border border-[#3a3340] px-3 py-1.5 text-[12px]
                         text-[#e7dfd3] outline-none focus:border-[#6bc5e8] resize-none h-24"
              placeholder="详细内容（可选）..."
            />
          </div>

          {/* Priority + Pin */}
          <div className="flex items-center gap-4">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">priority</label>
              <select
                value={form.priority}
                onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
                className="bg-[#0e0c10] border border-[#3a3340] px-2 py-1 text-[11px]
                           text-[#e7dfd3] outline-none"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer mt-4">
              <input
                type="checkbox"
                checked={form.pinned}
                onChange={e => setForm(p => ({ ...p, pinned: e.target.checked }))}
                className="accent-[#f0b35e]"
              />
              <span className="text-[11px] text-[#8d8188]">置顶</span>
            </label>
          </div>

          {/* Links */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">vault file</label>
              <input
                value={form.linked_file}
                onChange={e => setForm(p => ({ ...p, linked_file: e.target.value }))}
                className="w-full bg-[#0e0c10] border border-[#3a3340] px-2 py-1 text-[11px]
                           text-[#e7dfd3] outline-none"
                placeholder="path/to/file.md"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] uppercase tracking-wider text-[#8d8188] block mb-1">URL</label>
              <input
                value={form.linked_url}
                onChange={e => setForm(p => ({ ...p, linked_url: e.target.value }))}
                className="w-full bg-[#0e0c10] border border-[#3a3340] px-2 py-1 text-[11px]
                           text-[#e7dfd3] outline-none"
                placeholder="https://..."
              />
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose}
                    className="px-4 py-1.5 text-[11px] text-[#8d8188] hover:text-[#e7dfd3]">
              cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || !form.title.trim()}
              className="px-4 py-1.5 text-[11px] border-[2px] border-black bg-[#1e1a20]
                         shadow-[2px_3px_0_rgba(0,0,0,0.8)] hover:bg-[#2a2530]
                         active:translate-x-[2px] active:translate-y-[2px] active:shadow-none
                         disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider"
            >
              {saving ? 'saving...' : 'create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
