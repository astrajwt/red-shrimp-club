// Red Shrimp Lab — Vault Viewer (Obsidian, read-only, with [[wikilink]] support)

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { obsidianApi, tasksApi, type Task, type Backlink } from '../lib/api'

type FrontmatterValue = string | string[]

interface Props {
  filePath: string
  onClose?: () => void
  embedded?: boolean   // true = fills parent, no close button
  onNavigate?: (path: string) => void  // called when user clicks a [[wikilink]]
}

// ─── Clipboard helper (works on HTTP too) ───────────────────────────────────
function copyToClipboard(text: string): boolean {
  // On insecure origins (HTTP), navigator.clipboard exists but throws — always use fallback
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    return true
  }
  return fallbackCopy(text)
}
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ─── Wikilink preprocessing ─────────────────────────────────────────────────
// Convert [[target]] and [[target|alias]] into markdown links before rendering
function preprocessWikilinks(content: string): string {
  return content.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, target: string, alias?: string) => {
      const display = alias?.trim() || target.trim()
      // Encode as a special wikilink:// protocol so we can intercept clicks
      return `[${display}](wikilink://${encodeURIComponent(target.trim())})`
    }
  )
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function parseInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(',')
    .map(part => stripQuotes(part.trim()))
    .filter(Boolean)
}

function extractFrontmatter(content: string): {
  properties: Record<string, FrontmatterValue>
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { properties: {}, body: content }

  const properties: Record<string, FrontmatterValue> = {}
  const lines = match[1].split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!entry) continue

    const key = entry[1].toLowerCase()
    const rawValue = entry[2].trim()

    if (!rawValue) {
      const items: string[] = []
      while (index + 1 < lines.length) {
        const listItem = lines[index + 1].match(/^\s*-\s+(.*)$/)
        if (!listItem) break
        items.push(stripQuotes(listItem[1].trim()))
        index += 1
      }
      if (items.length > 0) properties[key] = items
      continue
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      properties[key] = parseInlineList(rawValue)
      continue
    }

    properties[key] = stripQuotes(rawValue)
  }

  return { properties, body: content.slice(match[0].length) }
}

function propertyValues(value: FrontmatterValue | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function propertyValue(value: FrontmatterValue | undefined): string | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] ?? null : value
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack.join('/')
}

function resolveVaultPath(currentFilePath: string, targetPath: string): string {
  if (!targetPath) return targetPath
  if (/^(https?:)?\/\//i.test(targetPath) || targetPath.startsWith('data:')) return targetPath
  if (targetPath.startsWith('/')) return normalizePath(targetPath.slice(1))
  if (targetPath.startsWith('./') || targetPath.startsWith('../')) {
    const baseDir = currentFilePath.split('/').slice(0, -1).join('/')
    return normalizePath([baseDir, targetPath].filter(Boolean).join('/'))
  }
  if (targetPath.includes('/')) return normalizePath(targetPath)

  return targetPath
}

function stripDuplicateTitleHeading(body: string, title: string | null): string {
  if (!title) return body
  const lines = body.split(/\r?\n/)
  let index = 0
  while (index < lines.length && !lines[index].trim()) index += 1
  const firstContent = lines[index]
  if (!firstContent) return body

  const heading = firstContent.match(/^#\s+(.*)$/)
  if (!heading) return body
  if (heading[1].trim() !== title.trim()) return body

  return lines.slice(index + 1).join('\n').replace(/^\r?\n+/, '')
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

type DocumentKind = 'markdown' | 'image' | 'pdf' | 'asset'

function isExternalAssetPath(targetPath: string): boolean {
  return /^(https?:)?\/\//i.test(targetPath)
    || targetPath.startsWith('data:')
    || targetPath.startsWith('mailto:')
    || targetPath.startsWith('tel:')
}

function getFileExtension(targetPath: string): string {
  const withoutQuery = targetPath.split('#')[0]?.split('?')[0] ?? ''
  const lastDot = withoutQuery.lastIndexOf('.')
  if (lastDot === -1) return ''
  return withoutQuery.slice(lastDot).toLowerCase()
}

function getDocumentKind(targetPath: string): DocumentKind {
  const ext = getFileExtension(targetPath)
  if (!ext || ext === '.md') return 'markdown'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  return 'asset'
}

function getNavigablePath(targetPath: string): string {
  const ext = getFileExtension(targetPath)
  if (!ext || ext === '.md') {
    return targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`
  }
  return targetPath
}

function resolveAssetSource(src: string, currentFilePath?: string): string {
  if (!src) return ''

  const resolved = src.startsWith('wikilink://')
    ? decodeURIComponent(src.replace('wikilink://', ''))
    : src

  if (!currentFilePath || isExternalAssetPath(resolved)) return resolved
  return src.startsWith('wikilink://') ? resolved : resolveVaultPath(currentFilePath, resolved)
}

function buildAssetUrl(src: string, currentFilePath?: string): string {
  const resolved = resolveAssetSource(src, currentFilePath)
  if (!resolved) return ''
  if (isExternalAssetPath(resolved)) return resolved
  return obsidianApi.assetUrl(resolved, currentFilePath)
}

export default function DocumentViewer({ filePath, onClose, embedded = false, onNavigate }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([])
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [backlinkLoading, setBacklinkLoading] = useState(false)
  const [resolvedPath, setResolvedPath] = useState(filePath)
  const documentKind = getDocumentKind(filePath)
  const isMarkdown = documentKind === 'markdown'

  useEffect(() => {
    setLoading(true)
    setError(null)
    setContent(null)
    setBacklinks([])
    setResolvedPath(filePath)

    tasksApi.list().then(({ tasks }) => {
      const linked = tasks.filter(t =>
        t.docs?.some(d => d.doc_path === filePath || d.doc_path.endsWith(filePath))
      )
      setLinkedTasks(linked)
    }).catch(() => {})

    if (!isMarkdown) {
      setBacklinkLoading(false)
      setLoading(false)
      return
    }

    obsidianApi.file(filePath)
      .then(({ path, content: c }) => {
        setResolvedPath(path)
        setContent(c)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))

    setBacklinkLoading(true)
    obsidianApi.backlinks(filePath)
      .then(({ backlinks: bl }) => setBacklinks(bl))
      .catch(() => {})
      .finally(() => setBacklinkLoading(false))
  }, [filePath, isMarkdown])

  const effectivePath = isMarkdown ? resolvedPath : filePath
  const fileName = effectivePath.split('/').pop() ?? effectivePath
  const pathParts = effectivePath.split('/').slice(0, -1)
  const { properties, body } = extractFrontmatter(content ?? '')
  const noteTitle = propertyValue(properties.title) ?? fileName
  const displayBody = stripDuplicateTitleHeading(body, propertyValue(properties.title))

  // Extract forward wikilinks from content
  const forwardLinks: Array<{ target: string; alias?: string }> = []
  if (displayBody) {
    const re = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(displayBody)) !== null) {
      forwardLinks.push({ target: m[1].trim(), alias: m[2]?.trim() })
    }
  }

  const outline = isMarkdown && displayBody
    ? displayBody.split('\n')
        .filter(l => /^#{1,3} /.test(l))
        .map(l => ({
          level: l.match(/^(#+)/)?.[1].length ?? 1,
          text:  l.replace(/^#+\s+/, ''),
        }))
    : []

  // Build markdown components with wikilink click handler
  const mdComps = buildMdComponents(onNavigate, effectivePath)

  // Preprocess content to convert [[wikilinks]] to markdown links
  const processedContent = isMarkdown && displayBody ? preprocessWikilinks(displayBody) : ''

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
          <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] px-2 py-0.5 uppercase text-[10px]">vault</span>
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
        {/* Outline + links sidebar — hidden in embedded mode (tree is in MemoryBrowser) */}
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
                    <div className="text-[#6bc5e8]">#t{t.number}</div>
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
          {!loading && !error && isMarkdown && content !== null && (
            <div className="p-4 md:p-6 h-full">
              <div
                className="w-full border-[3px] border-black bg-[#d8d0bf] text-black"
                style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.6)' }}
              >
                {/* Doc toolbar */}
                <div className="border-b-[3px] border-black px-4 md:px-6 py-3 bg-[#ccc4b2] flex items-center justify-between">
                  <div className="min-w-0 mr-2">
                    <div className="text-[11px] uppercase tracking-[0.06em] opacity-60 truncate">{fileName}</div>
                    <div className="text-[18px] leading-tight mt-1 truncate">{noteTitle}</div>
                  </div>
                  <button
                    onClick={() => { copyToClipboard(effectivePath); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                    className="border-[2px] border-black px-2 py-0.5 text-[11px] uppercase transition-colors shrink-0"
                    style={{ background: copied ? '#c0392b' : '#ece4d4', color: copied ? '#fff' : 'inherit' }}
                  >
                    {copied ? 'copied!' : 'copy path'}
                  </button>
                </div>

                {/* Markdown content */}
                <div className="px-4 md:px-8 py-6 overflow-x-auto">
                  <PropertiesPanel properties={properties} />
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={mdComps}
                  >
                    {processedContent}
                  </ReactMarkdown>
                </div>
              </div>

              {/* ── Backlinks panel ── */}
              <BacklinksPanel
                backlinks={backlinks}
                loading={backlinkLoading}
                forwardLinks={forwardLinks}
                currentFilePath={effectivePath}
                onNavigate={onNavigate}
              />
            </div>
          )}
          {!loading && !error && !isMarkdown && (
            <div className="p-4 md:p-6 h-full">
              <AssetDocumentCard
                filePath={effectivePath}
                fileName={fileName}
                kind={documentKind as Exclude<DocumentKind, 'markdown'>}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ─── Backlinks Panel ────────────────────────────────────────────────────────

function AssetDocumentCard({
  filePath,
  fileName,
  kind,
}: {
  filePath: string
  fileName: string
  kind: Exclude<DocumentKind, 'markdown'>
}) {
  const assetUrl = buildAssetUrl(filePath)
  const [assetCopied, setAssetCopied] = useState(false)

  return (
    <div
      className="w-full border-[3px] border-black bg-[#d8d0bf] text-black"
      style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.6)' }}
    >
      <div className="border-b-[3px] border-black px-4 md:px-6 py-3 bg-[#ccc4b2] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.06em] opacity-60 truncate">{fileName}</div>
          <div className="text-[18px] leading-tight mt-1 truncate">{kind === 'pdf' ? 'PDF preview' : kind === 'image' ? 'image preview' : 'file preview'}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={assetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="border-[2px] border-black px-2 py-0.5 bg-[#ece4d4] text-[11px] uppercase hover:bg-[#1a5a8a] hover:text-white hover:border-[#1a5a8a] transition-colors"
          >
            open raw
          </a>
          <button
            onClick={() => { copyToClipboard(filePath); setAssetCopied(true); setTimeout(() => setAssetCopied(false), 1500) }}
            className="border-[2px] border-black px-2 py-0.5 text-[11px] uppercase transition-colors"
            style={{ background: assetCopied ? '#c0392b' : '#ece4d4', color: assetCopied ? '#fff' : 'inherit' }}
          >
            {assetCopied ? 'copied!' : 'copy path'}
          </button>
        </div>
      </div>

      <div className="px-4 md:px-8 py-6">
        <AssetPreview src={filePath} kind={kind} fileLabel={fileName} className="min-h-[65vh]" />
      </div>
    </div>
  )
}

function BacklinksPanel({
  backlinks, loading, forwardLinks, currentFilePath, onNavigate,
}: {
  backlinks: Backlink[]
  loading: boolean
  forwardLinks: Array<{ target: string; alias?: string }>
  currentFilePath?: string
  onNavigate?: (path: string) => void
}) {
  if (!loading && backlinks.length === 0 && forwardLinks.length === 0) return null

  return (
    <div className="mt-4 border-[3px] border-black bg-[#d8d0bf] text-black" style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.6)' }}>
      {/* Forward links */}
      {forwardLinks.length > 0 && (
        <div className="border-b-[3px] border-black px-4 md:px-6 py-3">
          <div className="text-[11px] uppercase tracking-[0.06em] opacity-60 mb-2">outgoing links ({forwardLinks.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {forwardLinks.map((link, i) => (
              <button
                key={i}
                onClick={() => {
                  const resolvedTarget = currentFilePath ? resolveVaultPath(currentFilePath, link.target) : link.target
                  onNavigate?.(getNavigablePath(resolvedTarget))
                }}
                className="border-[2px] border-[#1a5a8a] bg-[#e8e0d0] text-[#1a5a8a] px-2 py-0.5 text-[11px] hover:bg-[#1a5a8a] hover:text-white transition-colors"
              >
                {link.alias || link.target}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Backlinks */}
      <div className="px-4 md:px-6 py-3">
        <div className="text-[11px] uppercase tracking-[0.06em] opacity-60 mb-2">
          {loading ? 'scanning backlinks...' : `backlinks (${backlinks.length})`}
        </div>
        {backlinks.length === 0 && !loading && (
          <div className="text-[12px] opacity-40">no other pages link to this note</div>
        )}
        {backlinks.map((bl, i) => (
          <button
            key={i}
            onClick={() => onNavigate?.(bl.path)}
            className="w-full text-left border-b border-[rgba(0,0,0,0.15)] py-2 hover:bg-[#ccc4b2] transition-colors group"
          >
            <div className="text-[12px] text-[#1a5a8a] group-hover:underline">{bl.name}</div>
            <div className="text-[11px] opacity-50 truncate">{bl.context}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function AssetPreview({
  src,
  kind,
  fileLabel,
  alt,
  currentFilePath,
  className = '',
}: {
  src: string
  kind: Exclude<DocumentKind, 'markdown'>
  fileLabel: string
  alt?: string
  currentFilePath?: string
  className?: string
}) {
  const resolvedUrl = buildAssetUrl(src, currentFilePath)
  const caption = alt?.trim()

  if (kind === 'image') {
    return (
      <div className={className}>
        <img
          src={resolvedUrl}
          alt={caption ?? fileLabel}
          style={{ maxWidth: '100%', maxHeight: '75vh', border: '3px solid black', display: 'block', margin: '0 auto', background: '#f4ede0' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] opacity-70">
          <span>{caption || fileLabel}</span>
          <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="underline text-[#1a5a8a]">
            open raw image
          </a>
        </div>
      </div>
    )
  }

  if (kind === 'pdf') {
    return (
      <div className={className}>
        <iframe
          src={resolvedUrl}
          title={fileLabel}
          className="w-full min-h-[70vh] border-[3px] border-black bg-white"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] opacity-70">
          <span>{caption || fileLabel}</span>
          <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="underline text-[#1a5a8a]">
            open raw pdf
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className={`border-[3px] border-black bg-[#ece4d4] p-4 text-[13px] ${className}`}>
      <div className="font-bold uppercase text-[11px] tracking-[0.06em] opacity-60 mb-2">preview unavailable</div>
      <div className="mb-3">this file type does not have an inline renderer yet.</div>
      <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="underline text-[#1a5a8a]">
        open raw file
      </a>
    </div>
  )
}

// ─── react-markdown component overrides ──────────────────────────────────────

function buildMdComponents(
  onNavigate?: (path: string) => void,
  currentFilePath?: string,
): React.ComponentProps<typeof ReactMarkdown>['components'] {
  return {
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
    pre: ({ children }) => (
      <div style={{ margin: '12px 0', overflowX: 'auto' }}>
        <div style={{ border: '3px solid black', background: '#0e0c10', color: '#3abfa0', padding: '12px 16px', fontSize: 12, fontFamily: 'inherit' }}>
          <pre style={{ margin: 0, whiteSpace: 'pre', overflowX: 'auto' }}>{children}</pre>
        </div>
      </div>
    ),
    code: ({ className, children }) => {
      const lang = className?.replace('language-', '') ?? ''
      if (!className) {
        return (
          <code style={{ background: 'rgba(0,0,0,0.12)', padding: '0 4px', fontFamily: 'inherit', fontSize: 13, borderRadius: 2 }}>{children}</code>
        )
      }
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
      const rawTarget = src ?? ''
      const resolvedTarget = resolveAssetSource(rawTarget, currentFilePath)
      const kind = getDocumentKind(resolvedTarget)
      const previewKind = (kind === 'markdown' ? 'asset' : kind) as Exclude<DocumentKind, 'markdown'>

      return (
        <div style={{ margin: '12px 0' }}>
          <AssetPreview
            src={rawTarget}
            kind={previewKind}
            fileLabel={resolvedTarget.split('/').pop() ?? resolvedTarget}
            alt={alt ?? ''}
            currentFilePath={currentFilePath}
          />
        </div>
      )
    },
    a: ({ href, children }) => {
      if (href?.startsWith('wikilink://')) {
        const target = decodeURIComponent(href.replace('wikilink://', ''))
        const resolvedTarget = currentFilePath ? resolveVaultPath(currentFilePath, target) : target
        const targetPath = getNavigablePath(resolvedTarget)
        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              onNavigate?.(targetPath)
            }}
            style={{
              color: '#6a3d9a',
              textDecoration: 'none',
              borderBottom: '2px dashed #6a3d9a',
              background: 'rgba(106, 61, 154, 0.08)',
              padding: '0 3px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
            title={`Navigate to ${target}`}
          >
            {children}
          </button>
        )
      }

      if (href && !href.startsWith('#') && !isExternalAssetPath(href) && onNavigate) {
        const targetPath = currentFilePath ? resolveVaultPath(currentFilePath, href) : href
        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              onNavigate(getNavigablePath(targetPath))
            }}
            style={{
              color: '#1a5a8a',
              textDecoration: 'underline',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
          >
            {children}
          </button>
        )
      }

      return (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1a5a8a', textDecoration: 'underline' }}>{children}</a>
      )
    },
    hr: () => <hr style={{ border: 'none', borderTop: '3px solid rgba(0,0,0,0.25)', margin: '16px 0' }} />,
    strong: ({ children }) => <strong style={{ fontWeight: 'bold' }}>{children}</strong>,
    em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  }
}

function PropertiesPanel({ properties }: { properties: Record<string, FrontmatterValue> }) {
  const entries = Object.entries(properties)
    .filter(([key]) => key !== 'title')
    .sort(([left], [right]) => propertySortOrder(left) - propertySortOrder(right) || left.localeCompare(right))

  if (entries.length === 0) return null

  return (
    <div className="mb-6 border-[3px] border-black bg-[#ece4d4]">
      <div className="border-b-[3px] border-black px-4 py-2 text-[11px] uppercase tracking-[0.06em] opacity-60">
        properties
      </div>
      <div className="px-4 py-3 space-y-2">
        {entries.map(([key, value]) => (
          <div key={key} className="grid gap-3 items-start md:grid-cols-[120px,minmax(0,1fr)]">
            <div className="text-[11px] uppercase tracking-[0.06em] opacity-50 pt-1">
              {formatPropertyLabel(key)}
            </div>
            <PropertyValue value={value} propertyKey={key} />
          </div>
        ))}
      </div>
    </div>
  )
}

function PropertyValue({ propertyKey, value }: { propertyKey: string; value: FrontmatterValue }) {
  const values = propertyValues(value)
  if (values.length === 0) return <div className="text-[13px] opacity-50">—</div>

  if (propertyKey === 'tags') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {values.map(tag => (
          <span
            key={tag}
            className="border-[2px] border-black bg-[#d8d0bf] px-2 py-0.5 text-[11px]"
          >
            #{tag}
          </span>
        ))}
      </div>
    )
  }

  if (propertyKey === 'youtube') {
    return (
      <div className="flex flex-wrap gap-2">
        {values.map(item => (
          <a
            key={item}
            href={item}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center border-[2px] border-black bg-[#d8d0bf] px-2 py-1 text-[11px] text-[#1a5a8a] hover:bg-[#1a5a8a] hover:text-white transition-colors"
          >
            {item}
          </a>
        ))}
      </div>
    )
  }

  const pillLike = propertyKey === 'author'

  return (
    <div className={`flex flex-wrap gap-1.5 ${pillLike ? '' : 'items-center'}`}>
      {values.map(item => (
        pillLike ? (
          <span key={item} className="border-[2px] border-black bg-[#d8d0bf] px-2 py-0.5 text-[11px]">
            {item}
          </span>
        ) : (
          <span key={item} className="text-[14px] leading-6">
            {item}
          </span>
        )
      ))}
    </div>
  )
}

function propertySortOrder(key: string): number {
  const order = ['author', 'lecture', 'youtube', 'date', 'tags', 'type', 'source']
  const index = order.indexOf(key)
  return index === -1 ? order.length : index
}

function formatPropertyLabel(key: string): string {
  return key.replace(/[-_]+/g, ' ')
}
