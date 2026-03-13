/**
 * @file DocumentViewer.tsx — Obsidian 文档查看器（只读）
 * @description 用于查看 Obsidian vault 中 markdown 文档的全屏浏览器，包含：
 *   1. 面包屑导航 — 显示文件路径层级
 *   2. 左侧大纲栏 — 从 markdown 标题提取的文档大纲 + 关联任务列表
 *   3. 主内容区 — markdown 渲染（仿纸张效果），支持标题/代码块/引用/列表/行内格式
 *
 * @props filePath — Obsidian vault 内的文件路径
 * @props onClose — 关闭按钮回调（可选）
 *
 * 组件结构：
 *   - DocumentViewer — 主组件（数据加载 + 布局）
 *   - MarkdownRenderer — 简易 markdown 渲染器（逐行解析，非 AST）
 */

import { useEffect, useState } from 'react'
import { obsidianApi, tasksApi, type Task } from '../lib/api'

/** 组件 Props */
interface Props {
  filePath: string     // Obsidian vault 中的文件路径
  onClose?: () => void // 关闭回调
}

export default function DocumentViewer({ filePath, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)  // 文件内容
  const [loading, setLoading] = useState(true)                 // 加载中标志
  const [error, setError] = useState<string | null>(null)      // 加载错误信息
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([])   // 关联此文档的任务列表

  // 文件路径变更时重新加载内容和关联任务
  useEffect(() => {
    setLoading(true)
    setError(null)
    // 加载文档内容
    obsidianApi.file(filePath)
      .then(({ content: c }) => setContent(c))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))

    // 查找关联此文档路径的任务（精确匹配或后缀匹配）
    tasksApi.list().then(({ tasks }) => {
      const linked = tasks.filter(t =>
        t.docs?.some(d => d.doc_path === filePath || d.doc_path.endsWith(filePath))
      )
      setLinkedTasks(linked)
    }).catch(() => {})
  }, [filePath])

  // 解析文件名和路径层级（用于面包屑显示）
  const fileName = filePath.split('/').pop() ?? filePath
  const pathParts = filePath.split('/').slice(0, -1)

  // 从 markdown 内容提取 h1-h3 标题，构建文档大纲
  const outline = content
    ? content.split('\n')
        .filter(l => /^#{1,3} /.test(l))
        .map(l => {
          const level = (l.match(/^(#+)/)?.[1].length ?? 1)  // 标题层级（1-3）
          const text = l.replace(/^#+\s+/, '')                // 标题文本
          return { level, text }
        })
    : []

  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] flex flex-col"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* Breadcrumb */}
      <div className="border-b-[3px] border-black bg-[#141018] px-5 py-2 flex items-center gap-2 text-[12px] text-[#4a4048]">
        {pathParts.map((part, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-[#6bc5e8]">{part}</span>
            <span>/</span>
          </span>
        ))}
        <span className="text-[#e7dfd3]">{fileName}</span>
        <div className="ml-auto flex gap-2">
          <span className="border-[2px] border-black bg-[#0f1a18] text-[#3abfa0] px-2 py-0.5 uppercase text-[10px]">
            read-only
          </span>
          <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] px-2 py-0.5 uppercase text-[10px]">
            obsidian
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="border-[2px] border-black bg-[#3a1520] text-[#c0392b] px-2 py-0.5 text-[10px] hover:bg-[#c0392b] hover:text-black"
            >
              ✕ close
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Outline sidebar */}
        <aside className="w-[200px] border-r-[3px] border-black bg-[#141018] flex flex-col overflow-auto">
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

          {/* Linked tasks */}
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

        {/* Main document */}
        <main className="flex-1 overflow-auto bg-[#161318] p-6">
          {loading && (
            <div className="text-[#4a4048] text-[14px] text-center pt-16">loading...</div>
          )}
          {error && (
            <div className="text-[#c0392b] text-[14px] text-center pt-16">
              ✕ {error}
            </div>
          )}
          {!loading && !error && content !== null && (
            <div
              className="max-w-[780px] mx-auto border-[3px] border-black bg-[#d8d0bf] text-black"
              style={{
                transform: 'rotate(-0.1deg)',
                boxShadow:
                  '6px 8px 0 rgba(0,0,0,0.85), ' +
                  '0 10px 30px rgba(50,120,220,0.14), ' +
                  '0 4px 16px rgba(30,180,120,0.08)',
              }}
            >
              {/* Doc toolbar */}
              <div className="border-b-[3px] border-black px-6 py-3 bg-[#ccc4b2] flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-[0.06em] opacity-60">obsidian document</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigator.clipboard.writeText(filePath)}
                    className="border-[2px] border-black px-2 py-0.5 bg-[#ece4d4] text-[11px] uppercase hover:bg-[#c0392b] hover:text-white hover:border-[#c0392b] transition-colors"
                  >
                    copy path
                  </button>
                </div>
              </div>

              {/* Markdown content — minimal renderer */}
              <div className="px-8 py-6" style={{ lineHeight: 1.75 }}>
                <MarkdownRenderer content={content} />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ─── 简易 Markdown 渲染器 ─────────────────────────────────────────────────────

/**
 * MarkdownRenderer — 逐行解析的简易 markdown 渲染器
 * @param content - 原始 markdown 文本
 *
 * 支持的语法：
 *   - h1/h2/h3 标题
 *   - 围栏代码块（带语言标签）
 *   - 引用（> 开头）
 *   - 无序/有序列表
 *   - 行内格式：**粗体**、`代码`、_斜体_
 *   - 空行间距
 *
 * 注意：这是简化实现，不支持嵌套列表、表格、图片等复杂语法。
 * 行内格式使用 dangerouslySetInnerHTML（仅用于受信任的 agent 生成内容）。
 */
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── h1 标题 ──
    if (/^# /.test(line)) {
      elements.push(<h1 key={i} style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1.2, marginTop: 8, marginBottom: 4 }}>{line.slice(2)}</h1>)
    } else if (/^## /.test(line)) {
      elements.push(<h2 key={i} style={{ fontSize: 20, borderTop: '3px solid rgba(0,0,0,0.3)', paddingTop: 12, marginTop: 20 }}>{line.slice(3)}</h2>)
    } else if (/^### /.test(line)) {
      elements.push(<h3 key={i} style={{ fontSize: 16, marginTop: 12 }}>{line.slice(4)}</h3>)
    } else if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      elements.push(
        <div key={i} className="border-[3px] border-black bg-[#0e0c10] text-[#3abfa0] px-4 py-3 my-2" style={{ fontSize: 12 }}>
          {lang && <div style={{ opacity: 0.4, marginBottom: 4, fontSize: 10, textTransform: 'uppercase' }}>{lang}</div>}
          {codeLines.map((l, j) => <div key={j}>{l || ' '}</div>)}
        </div>
      )
    } else if (/^> /.test(line)) {
      elements.push(
        <div key={i} className="border-l-[4px] border-black bg-[#e8e0d0] px-4 py-2 my-2" style={{ fontSize: 14 }}>
          {line.slice(2)}
        </div>
      )
    } else if (/^[-*] /.test(line)) {
      elements.push(<div key={i} style={{ fontSize: 15, paddingLeft: 12 }}>• {line.slice(2)}</div>)
    } else if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\./)?.[1]
      elements.push(<div key={i} style={{ fontSize: 15, paddingLeft: 12 }}>{num}. {line.replace(/^\d+\. /, '')}</div>)
    } else if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 8 }} />)
    } else {
      // Plain paragraph — inline formatting: **bold**, `code`, _italic_
      const html = line
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code style="background:rgba(0,0,0,0.1);padding:0 3px;font-family:inherit">$1</code>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
      elements.push(
        <p key={i} style={{ fontSize: 15, margin: '4px 0' }} dangerouslySetInnerHTML={{ __html: html }} />
      )
    }
    i++
  }

  return <>{elements}</>
}
