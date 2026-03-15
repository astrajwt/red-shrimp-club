// Red Shrimp Lab — Document Browser
// Three-panel: left=file tree, center=doc viewer, right=AI Q&A

import { useEffect, useRef, useState } from 'react'
import { obsidianApi, askApi, agentsApi, type ObsidianEntry, type ModelInfo } from '../lib/api'
import { isImeComposing } from '../lib/ime'
import DocumentViewer from './DocumentViewer'

export default function DocBrowser() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  return (
    <div className="h-full flex overflow-hidden bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}>

      {/* ── Left: recursive file tree (fixed 220px) ── */}
      <div className="w-[220px] shrink-0 flex flex-col border-r-[3px] border-black bg-[#141018]">
        <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] shrink-0">
          <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest mb-0.5">obsidian vault</div>
          <div className="text-[16px] leading-none">documents</div>
        </div>
        <div className="flex-1 overflow-auto py-1">
          <TreeNode path="" depth={0} selectedPath={selectedPath} onSelect={setSelectedPath} />
        </div>
      </div>

      {/* ── Center: document viewer (flex-1) ── */}
      <div className="flex-1 overflow-auto border-r-[3px] border-black">
        {selectedPath ? (
          <DocumentViewer filePath={selectedPath} embedded />
        ) : (
          <div className="h-full flex items-center justify-center text-center">
            <div>
              <div className="text-[48px] mb-3 opacity-10">⊡</div>
              <div className="text-[13px] text-[#4a4048]">select a file to view</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: AI Q&A panel (fixed 280px) ── */}
      <AskPanel filePath={selectedPath} />
    </div>
  )
}

// ── Thinking Indicator ────────────────────────────────────────────────────────

const THINKING_PHRASES = [
  'reading context...',
  'scanning documents...',
  'cross-referencing tasks...',
  'checking agent memory...',
  'analyzing patterns...',
  'synthesizing answer...',
  'formulating response...',
]

function ThinkingIndicator() {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [dots, setDots] = useState(0)

  useEffect(() => {
    const phraseTimer = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length)
    }, 900)
    const dotTimer = setInterval(() => {
      setDots(d => (d + 1) % 4)
    }, 350)
    return () => { clearInterval(phraseTimer); clearInterval(dotTimer) }
  }, [])

  return (
    <div className="bg-[#0e1520] border-[2px] border-[#1e3d55] px-3 py-2 max-w-[240px]">
      <div className="text-[10px] text-[#3a6a8a] uppercase tracking-widest mb-1">processing</div>
      <div className="text-[11px] text-[#4a9ac8] font-mono">
        {'> '}{THINKING_PHRASES[phraseIdx]}
        <span
          className="inline-block w-[7px] h-[11px] bg-[#4a9ac8] ml-0.5 align-middle"
          style={{ animation: 'blink 0.7s step-start infinite' }}
        />
      </div>
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
    </div>
  )
}

// ── AI Q&A Panel ──────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  text: string
}

const SAVED_MODEL_KEY = 'rsl_ask_model'

function AskPanel({ filePath }: { filePath: string | null }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [ctxPath, setCtxPath] = useState<string | null>(filePath)
  const [ctxLocked, setCtxLocked] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; label: string; provider: string }>>([])
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem(SAVED_MODEL_KEY) ?? 'claude-sonnet-4-6'
  )
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-sync ctx with tree selection unless user has locked it
  useEffect(() => {
    if (!ctxLocked) setCtxPath(filePath)
  }, [filePath, ctxLocked])

  // Load available models
  useEffect(() => {
    agentsApi.models().then(reg => {
      const all = [
        ...reg.anthropic.map(m => ({ ...m, provider: 'claude' })),
        ...reg.moonshot.map(m => ({ ...m, provider: 'kimi' })),
        ...reg.openai.map(m => ({ ...m, provider: 'openai' })),
      ]
      setModels(all)
    }).catch(() => {})
  }, [])

  const send = async () => {
    const q = input.trim()
    if (!q || loading) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setLoading(true)

    // Add empty assistant message — filled incrementally via SSE
    setMessages(prev => [...prev, { role: 'assistant', text: '' }])

    try {
      await askApi.askStream(
        q,
        (fullText) => {
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'assistant') {
              updated[updated.length - 1] = { ...last, text: fullText }
            }
            return updated
          })
        },
        ctxPath ?? undefined,
        selectedModel,
      )
    } catch (err: any) {
      const detail = err?.body?.detail ?? err?.message ?? 'request failed'
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role === 'assistant' && !last.text) {
          updated[updated.length - 1] = { ...last, text: `⚠ ${detail}` }
        } else {
          updated.push({ role: 'assistant', text: `⚠ ${detail}` })
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const clearCtx = () => { setCtxPath(null); setCtxLocked(true) }
  const toggleLock = () => setCtxLocked(l => !l)

  const onModelChange = (id: string) => {
    setSelectedModel(id)
    localStorage.setItem(SAVED_MODEL_KEY, id)
  }

  return (
    <div className="w-[280px] shrink-0 flex flex-col bg-[#100e13]">
      {/* Header */}
      <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] shrink-0">
        <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest mb-0.5">ai assistant</div>
        <div className="text-[14px] leading-none">ask anything</div>
        {/* ctx row */}
        <div className="flex items-center gap-1 mt-1.5 min-w-0">
          <span className="text-[10px] text-[#4a4048] shrink-0">ctx:</span>
          <span className="text-[10px] text-[#6a5a5a] flex-1 truncate min-w-0" title={ctxPath ?? 'none'}>
            {ctxPath ? ctxPath.split('/').pop() : 'none'}
          </span>
          <button
            onClick={toggleLock}
            title={ctxLocked ? 'unlock — follow selected file' : 'lock this context file'}
            className={`text-[9px] border px-1 py-0.5 leading-none shrink-0 transition-colors ${
              ctxLocked
                ? 'border-[#c0392b] text-[#c0392b]'
                : 'border-[#3a3535] text-[#3a3535] hover:border-[#5a4545] hover:text-[#5a4545]'
            }`}
          >
            {ctxLocked ? 'locked' : 'auto'}
          </button>
          {ctxPath && (
            <button
              onClick={clearCtx}
              title="clear context"
              className="text-[12px] text-[#4a4048] hover:text-[#c0392b] px-0.5 shrink-0 leading-none"
            >x</button>
          )}
        </div>
        {/* model selector row */}
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[10px] text-[#4a4048] shrink-0">model:</span>
          <select
            value={selectedModel}
            onChange={e => onModelChange(e.target.value)}
            className="rsl-control rsl-select flex-1 bg-[#141018] border border-[#2a2228] text-[#9a8888] text-[10px] px-1.5 py-0.5 outline-none cursor-pointer"
            style={{ fontFamily: 'inherit' }}
          >
            {models.length === 0 && (
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            )}
            {models.map(m => (
              <option key={m.id} value={m.id}>[{m.provider}] {m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-[11px] text-[#3a3535] leading-relaxed">
            {filePath
              ? 'ask about the current document, tasks, or team status'
              : 'select a document, or ask about tasks and agents'}
          </div>
        )}
        {messages.map((m, i) => {
          const isStreamingThis = loading && i === messages.length - 1 && m.role === 'assistant'
          return (
            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              {m.role === 'user' ? (
                <span className="inline-block bg-[#2a1a1a] border-[2px] border-[#c0392b] text-[#e7dfd3] text-[12px] px-3 py-2 max-w-[220px] text-left break-words">
                  {m.text}
                </span>
              ) : (
                <span className="inline-block bg-[#1a2535] border-[2px] border-[#1e3d55] text-[#c8bdb8] text-[12px] px-3 py-2 max-w-[240px] text-left break-words whitespace-pre-wrap">
                  {m.text}
                  {isStreamingThis && m.text && (
                    <span
                      className="inline-block w-[6px] h-[12px] bg-[#4a9ac8] ml-0.5 align-middle"
                      style={{ animation: 'blink 0.7s step-start infinite' }}
                    />
                  )}
                </span>
              )}
            </div>
          )
        })}
        {/* ThinkingIndicator: only while waiting for first chunk */}
        {loading && messages[messages.length - 1]?.text === '' && messages[messages.length - 1]?.role === 'assistant' && (
          <ThinkingIndicator />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t-[3px] border-black px-3 py-3 shrink-0">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="ask a question..."
          rows={3}
          className="w-full bg-[#1e1a20] border-[2px] border-[#2a2228] text-[#e7dfd3] text-[12px] px-3 py-2 resize-none outline-none focus:border-[#c0392b] placeholder-[#3a3535]"
          style={{ fontFamily: 'inherit' }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="mt-2 w-full py-1.5 text-[12px] uppercase tracking-wider bg-[#1e1a20] border-[2px] border-[#2a2228] text-[#9a8888] hover:bg-[#2a1a1a] hover:border-[#c0392b] hover:text-[#e7dfd3] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? '⟳ processing...' : 'ask →'}
        </button>
      </div>
    </div>
  )
}

// ── Recursive tree node ───────────────────────────────────────────────────────

interface TreeNodeProps {
  path: string
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}

function TreeNode({ path, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [entries, setEntries] = useState<ObsidianEntry[]>([])
  const [expanded, setExpanded] = useState(depth === 0)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  // Root auto-loads. Others load on expand.
  useEffect(() => {
    if (depth === 0) {
      setLoading(true)
      obsidianApi.tree(path)
        .then(({ items }) => { setEntries(items); setLoaded(true) })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  }, [])

  const toggle = () => {
    if (!loaded && !loading) {
      setLoading(true)
      obsidianApi.tree(path)
        .then(({ items }) => { setEntries(items); setLoaded(true); setExpanded(true) })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false))
    } else {
      setExpanded(e => !e)
    }
  }

  const dirs  = entries.filter(e => e.type === 'directory')
  const files = entries.filter(e => e.type === 'file')

  return (
    <div>
      {loading && depth === 0 && (
        <div className="text-[11px] text-[#4a4048] px-4 pt-4">loading...</div>
      )}
      {(expanded || depth === 0) && (
        <>
          {dirs.map(entry => (
            <DirNode
              key={entry.path}
              entry={entry}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {files.map(entry => (
            <button
              key={entry.path}
              onClick={() => onSelect(entry.path)}
              className={`w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] transition-colors
                ${selectedPath === entry.path
                  ? 'bg-[#2a1a1a] border-l-[3px] border-l-[#c0392b]'
                  : 'hover:bg-[#1e1a20] border-l-[3px] border-l-transparent'}`}
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              <span className="text-[11px] text-[#4a4048] shrink-0">·</span>
              <span className="text-[12px] text-[#9a8888] truncate">{entry.name}</span>
            </button>
          ))}
          {entries.length === 0 && loaded && depth === 0 && (
            <div className="text-[11px] text-[#4a4048] px-4 pt-4">
              OBSIDIAN_ROOT not configured
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface DirNodeProps {
  entry: ObsidianEntry
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}

function DirNode({ entry, depth, selectedPath, onSelect }: DirNodeProps) {
  const [entries, setEntries] = useState<ObsidianEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  const toggle = () => {
    if (!loaded && !loading) {
      setLoading(true)
      obsidianApi.tree(entry.path)
        .then(({ items }) => { setEntries(items); setLoaded(true); setExpanded(true) })
        .catch(() => setExpanded(true))
        .finally(() => setLoading(false))
    } else {
      setExpanded(e => !e)
    }
  }

  const dirs  = entries.filter(e => e.type === 'directory')
  const files = entries.filter(e => e.type === 'file')

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] hover:bg-[#1e1a20] transition-colors border-l-[3px] border-l-transparent"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <span className="text-[11px] text-[#6bc5e8] shrink-0">
          {loading ? '…' : expanded ? '▾' : '▸'}
        </span>
        <span className="text-[12px] text-[#c8bdb8] truncate">{entry.name}</span>
      </button>
      {expanded && (
        <div>
          {dirs.map(d => (
            <DirNode key={d.path} entry={d} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
          {files.map(f => (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className={`w-full flex items-center gap-1.5 text-left py-1 border-b border-[#1a1620] transition-colors
                ${selectedPath === f.path
                  ? 'bg-[#2a1a1a] border-l-[3px] border-l-[#c0392b]'
                  : 'hover:bg-[#1e1a20] border-l-[3px] border-l-transparent'}`}
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              <span className="text-[11px] text-[#4a4048] shrink-0">·</span>
              <span className="text-[12px] text-[#9a8888] truncate">{f.name}</span>
            </button>
          ))}
          {entries.length === 0 && loaded && (
            <div className="text-[11px] text-[#3a3535] py-1" style={{ paddingLeft: (depth + 1) * 12 + 4 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}
