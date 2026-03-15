import { useState } from 'react'
import { searchApi, type SearchResults } from '../lib/api'
import DocumentViewer from './DocumentViewer'

interface Props {
  onOpenChannel: (channelId: string) => void
}

const EMPTY_RESULTS: SearchResults = {
  query: '',
  messages: [],
  docs: [],
}

export default function SearchPage({ onOpenChannel }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null)

  const runSearch = async () => {
    const trimmed = query.trim()
    setError(null)

    if (trimmed.length < 2) {
      setResults({ query: trimmed, messages: [], docs: [] })
      setSelectedDocPath(null)
      return
    }

    setSearching(true)
    try {
      const nextResults = await searchApi.query(trimmed)
      setResults(nextResults)
      setSelectedDocPath(current =>
        current && nextResults.docs.some(doc => doc.path === current)
          ? current
          : nextResults.docs[0]?.path ?? null
      )
    } catch (err: any) {
      setError(err.message ?? 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div
      className="h-full overflow-hidden bg-[#0e0c10] text-[#e7dfd3] px-6 py-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      <div className="h-full max-w-[1400px] mx-auto flex flex-col gap-5">
        <div className="shrink-0">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">retrieval</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-2">search</div>
          <div className="text-[12px] text-[#8d8188] mt-3">
            搜对话和 vault 文档。先输入关键词，再决定是跳回 channel 还是直接预览文档。
          </div>
        </div>

        <div className="shrink-0 border-[3px] border-black bg-[#191619] px-4 py-4 shadow-[6px_8px_0_rgba(0,0,0,0.9)]">
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runSearch()
                }
              }}
              placeholder="搜索对话 / 文档，例如 onboarding, Donovan, architecture"
              className="flex-1 border-[3px] border-black bg-[#120f13] px-4 py-3 text-[14px] text-[#e7dfd3] placeholder-[#4a4048] focus:outline-none"
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={searching}
              className="border-[3px] border-black bg-[#1a2535] px-5 py-3 text-[12px] uppercase tracking-[0.08em] text-[#6bc5e8] hover:bg-[#243548] disabled:opacity-40"
            >
              {searching ? 'searching...' : 'search'}
            </button>
          </div>
          <div className="text-[11px] text-[#6a6068] mt-3">
            {results.query
              ? `messages ${results.messages.length} · docs ${results.docs.length}`
              : '至少输入 2 个字符。'}
          </div>
          {error && (
            <div className="mt-3 border-[2px] border-[#c0392b] bg-[#2a1116] px-3 py-2 text-[11px] text-[#f3b0b0]">
              {error}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 grid grid-cols-1 gap-5 xl:grid-cols-[460px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-auto border-[3px] border-black bg-[#161218] shadow-[6px_8px_0_rgba(0,0,0,0.85)]">
            <div className="border-b-[3px] border-black px-4 py-3 bg-[#1d1820]">
              <div className="text-[11px] uppercase tracking-[0.12em] text-[#6bc5e8]">results</div>
            </div>

            <div className="p-4 space-y-5">
              <section>
                <div className="text-[11px] uppercase tracking-[0.12em] text-[#c0392b] mb-3">
                  messages · {results.messages.length}
                </div>
                {results.messages.length === 0 ? (
                  <div className="border-[2px] border-[#2a2228] bg-[#120f13] px-3 py-3 text-[11px] text-[#6a6068]">
                    {results.query ? '没有找到匹配的对话。' : '搜索后这里会列出对话结果。'}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {results.messages.map(message => (
                      <div key={message.id} className="border-[2px] border-[#2a2228] bg-[#120f13] px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[11px] uppercase text-[#6bc5e8]">
                              {message.channel_name} · {message.sender_name}
                            </div>
                            <div className="text-[10px] text-[#6a6068] mt-1">
                              {new Date(message.created_at).toLocaleString()}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onOpenChannel(message.channel_id)}
                            className="border-[2px] border-black bg-[#1a2535] px-2 py-1 text-[10px] uppercase text-[#6bc5e8] hover:bg-[#243548]"
                          >
                            open channel
                          </button>
                        </div>
                        <div className="text-[12px] leading-6 text-[#d8cec3] mt-3 whitespace-pre-wrap break-words">
                          {message.snippet}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <div className="text-[11px] uppercase tracking-[0.12em] text-[#3abfa0] mb-3">
                  docs · {results.docs.length}
                </div>
                {results.docs.length === 0 ? (
                  <div className="border-[2px] border-[#2a2228] bg-[#120f13] px-3 py-3 text-[11px] text-[#6a6068]">
                    {results.query ? '没有找到匹配的文档。' : '搜索后这里会列出文档结果。'}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {results.docs.map(doc => {
                      const active = doc.path === selectedDocPath
                      return (
                        <button
                          key={doc.path}
                          type="button"
                          onClick={() => setSelectedDocPath(doc.path)}
                          className="w-full text-left border-[2px] px-3 py-3 transition-colors"
                          style={{
                            borderColor: active ? '#3abfa0' : '#2a2228',
                            background: active ? '#10231f' : '#120f13',
                          }}
                        >
                          <div className="text-[12px] text-[#e7dfd3]">{doc.title}</div>
                          <div className="text-[10px] text-[#6bc5e8] mt-1 break-all">{doc.path}</div>
                          <div className="text-[11px] text-[#b9aca4] mt-3 leading-5">{doc.snippet}</div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>

          <div className="min-h-0 overflow-hidden border-[3px] border-black bg-[#161218] shadow-[6px_8px_0_rgba(0,0,0,0.85)]">
            {selectedDocPath ? (
              <DocumentViewer filePath={selectedDocPath} embedded onNavigate={setSelectedDocPath} />
            ) : (
              <div className="h-full flex items-center justify-center px-6 text-center text-[12px] text-[#6a6068]">
                选中文档结果后，这里会直接预览对应内容。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
