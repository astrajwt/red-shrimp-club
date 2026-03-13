// Red Shrimp Lab — Document Viewer (Obsidian, read-only, connected to backend)

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { obsidianApi, tasksApi, type Task } from '../lib/api'

interface Props {
  filePath: string
  onClose?: () => void
  embedded?: boolean   // true = fills parent, no close button
}

export default function DocumentViewer({ filePath, onClose, embedded = false }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([])

  useEffect(() => {
    setLoading(true)
    setError(null)
    obsidianApi.file(filePath)
      .then(({ content: c }) => setContent(c))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))

    tasksApi.list().then(({ tasks }) => {
      const linked = tasks.filter(t =>
        t.docs?.some(d => d.doc_path === filePath || d.doc_path.endsWith(filePath))
      )
      setLinkedTasks(linked)
    }).catch(() => {})
  }, [filePath])

  const fileName = filePath.split('/').pop() ?? filePath
  const pathParts = filePath.split('/').slice(0, -1)

  const outline = content
    ? content.split('\n')
        .filter(l => /^#{1,3} /.test(l))
        .map(l => ({
          level: l.match(/^(#+)/)?.[1].length ?? 1,
          text:  l.replace(/^#+\s+/, ''),
        }))
    : []

  return (
    <div
      className={`${embedded ? 'h-full' : 'min-h-screen'} bg-[#0e0c10] text-[#e7dfd3] flex flex-col`}
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* Breadcrumb */}
      <div className="border-b-[3px] border-black bg-[#141018] px-5 py-2 flex items-center gap-2 text-[12px] text-[#4a4048] shrink-0">
        {pathParts.map((part, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-[#6bc5e8]">{part}</span>
            <span>/</span>
          </span>
        ))}
        <span className="text-[#e7dfd3]">{fileName}</span>
        <div className="ml-auto flex gap-2">
          <span className="border-[2px] border-black bg-[#0f1a18] text-[#3abfa0] px-2 py-0.5 uppercase text-[10px]">read-only</span>
          <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] px-2 py-0.5 uppercase text-[10px]">obsidian</span>
          {onClose && !embedded && (
            <button
              onClick={onClose}
              className="border-[2px] border-black bg-[#3a1520] text-[#c0392b] px-2 py-0.5 text-[10px] hover:bg-[#c0392b] hover:text-black"
            >
              close
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Outline sidebar — hidden in embedded mode (tree is in DocBrowser) */}
        {!embedded && (
          <aside className="w-[200px] shrink-0 border-r-[3px] border-black bg-[#141018] flex flex-col overflow-auto">
            <div className="border-b-[3px] border-black px-3 py-2 text-[11px] text-[#4a4048] uppercase">outline</div>
            {outline.map((h, i) => (
              <div
                key={i}
                className={`px-3 py-1 text-[12px] cursor-pointer hover:text-[#6bc5e8] border-l-[2px]
                  ${h.level === 1
                    ? 'text-[#c8bdb8] border-[#c0392b] pl-3'
                    : h.level === 2
                    ? 'text-[#9a8888] border-transparent pl-5'
                    : 'text-[#6a5858] border-transparent pl-7'}`}
              >
                {h.text}
              </div>
            ))}
            {linkedTasks.length > 0 && (
              <div className="border-t-[3px] border-black mt-3 px-3 py-2">
                <div className="text-[11px] text-[#4a4048] uppercase mb-2">linked tasks</div>
                {linkedTasks.map(t => (
                  <div key={t.id} className="text-[11px] leading-5 mb-1">
                    <div className="text-[#6bc5e8]">#{t.seq}</div>
                    <div className="text-[#6a5858] truncate">{t.title}</div>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}

        {/* Main document */}
        <main className="flex-1 overflow-auto min-w-0 bg-[#161318]">
          {loading && (
            <div className="text-[#4a4048] text-[14px] text-center pt-16">loading...</div>
          )}
          {error && (
            <div className="text-[#c0392b] text-[14px] text-center pt-16">✕ {error}</div>
          )}
          {!loading && !error && content !== null && (
            <div className="p-4 md:p-6 h-full">
              <div
                className="w-full border-[3px] border-black bg-[#d8d0bf] text-black"
                style={{
                  boxShadow: '4px 5px 0 rgba(0,0,0,0.6)',
                }}
              >
                {/* Doc toolbar */}
                <div className="border-b-[3px] border-black px-4 md:px-6 py-3 bg-[#ccc4b2] flex items-center justify-between">
                  <div className="text-[11px] uppercase tracking-[0.06em] opacity-60 truncate mr-2">{fileName}</div>
                  <button
                    onClick={() => navigator.clipboard.writeText(filePath)}
                    className="border-[2px] border-black px-2 py-0.5 bg-[#ece4d4] text-[11px] uppercase hover:bg-[#c0392b] hover:text-white hover:border-[#c0392b] transition-colors shrink-0"
                  >
                    copy path
                  </button>
                </div>

                {/* Markdown content */}
                <div className="px-4 md:px-8 py-6 overflow-x-auto">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={mdComponents}
                  >
                    {content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ─── react-markdown component overrides ──────────────────────────────────────

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1.25, marginTop: 8, marginBottom: 8 }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 20, fontWeight: 'bold', borderTop: '3px solid rgba(0,0,0,0.25)', paddingTop: 12, marginTop: 24, marginBottom: 8 }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 6 }}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: 14, fontWeight: 'bold', marginTop: 12, marginBottom: 4 }}>{children}</h4>
  ),
  p: ({ children }) => (
    <p style={{ fontSize: 15, margin: '6px 0', lineHeight: 1.75 }}>{children}</p>
  ),
  ul: ({ children }) => (
    <ul style={{ paddingLeft: 20, margin: '6px 0' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ paddingLeft: 20, margin: '6px 0' }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ fontSize: 15, lineHeight: 1.75, marginBottom: 2 }}>{children}</li>
  ),
  pre: ({ children }) => {
    // code block inside pre
    return (
      <div style={{ margin: '12px 0', overflowX: 'auto' }}>
        <div style={{ border: '3px solid black', background: '#0e0c10', color: '#3abfa0', padding: '12px 16px', fontSize: 12, fontFamily: 'inherit' }}>
          <pre style={{ margin: 0, whiteSpace: 'pre', overflowX: 'auto' }}>{children}</pre>
        </div>
      </div>
    )
  },
  code: ({ className, children }) => {
    const lang = className?.replace('language-', '') ?? ''
    // Inline code (no className, short content)
    if (!className) {
      return (
        <code style={{ background: 'rgba(0,0,0,0.12)', padding: '0 4px', fontFamily: 'inherit', fontSize: 13, borderRadius: 2 }}>{children}</code>
      )
    }
    // Code block (has language class, rendered inside pre)
    return (
      <>
        {lang && <div style={{ opacity: 0.4, marginBottom: 6, fontSize: 10, textTransform: 'uppercase' }}>{lang}</div>}
        <code>{children}</code>
      </>
    )
  },
  blockquote: ({ children }) => (
    <div style={{ borderLeft: '4px solid black', background: '#e8e0d0', padding: '8px 16px', margin: '8px 0', fontSize: 14 }}>
      {children}
    </div>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '12px 0' }}>
      <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: '2px solid black', padding: '6px 12px', background: '#ccc4b2', textAlign: 'left', fontWeight: 'bold', fontSize: 12 }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{ border: '1px solid rgba(0,0,0,0.3)', padding: '5px 12px' }}>{children}</td>
  ),
  img: ({ src, alt }) => {
    const resolvedSrc = src?.startsWith('http') ? src
      : `/api/daemon/obsidian/image?path=${encodeURIComponent(src ?? '')}`
    return (
      <div style={{ margin: '12px 0' }}>
        <img
          src={resolvedSrc}
          alt={alt ?? ''}
          style={{ maxWidth: '100%', border: '3px solid black', display: 'block' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        {alt && <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>{alt}</div>}
      </div>
    )
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1a5a8a', textDecoration: 'underline' }}>{children}</a>
  ),
  hr: () => <hr style={{ border: 'none', borderTop: '3px solid rgba(0,0,0,0.25)', margin: '16px 0' }} />,
  strong: ({ children }) => <strong style={{ fontWeight: 'bold' }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
}
