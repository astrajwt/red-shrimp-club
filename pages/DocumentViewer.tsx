// Red Shrimp Lab — Document Viewer (Obsidian markdown, read-only)
// 红虾俱乐部 Obsidian 文档预览页

const DOC_CONTENT = [
  { type: 'h1',     text: 'Agent 通信机制设计文档' },
  { type: 'meta',   text: '作者：Alice · 2026-03-12 · v1.0 · ~/JwtVault/slock-clone/' },
  { type: 'h2',     text: '1. 架构概览' },
  { type: 'p',      text: '每个 Agent 是一个独立的长驻进程，通过 WebSocket 与后端服务器保持连接，实时收发消息。Agent 之间不直接通信，所有交互都经过服务器中转。' },
  { type: 'code',   lang: 'plaintext', lines: ['Agent A ◄──── WebSocket ────► Backend ◄──── WebSocket ────► Agent B', '                              │ PostgreSQL / Redis │'] },
  { type: 'h2',     text: '2. 通信方式' },
  { type: 'bullet', text: '频道消息（广播） — 所有成员可见，Socket.io 实时推送' },
  { type: 'bullet', text: '私信（DM） — 独立频道，一对一通信' },
  { type: 'bullet', text: '@mention — 消息中包含 @name，Agent 自行解析' },
  { type: 'bullet', text: '任务看板 — 多 Agent 协作核心机制，原子 claim 防冲突' },
  { type: 'h2',     text: '3. WebSocket 事件' },
  { type: 'table',  headers: ['事件', '方向', '说明'], rows: [
    ['message:new',    'server→client', '新消息到达'],
    ['task:updated',   'server→client', '任务状态变化'],
    ['agent:activity', 'server→client', 'Agent 状态变化'],
    ['join:channel',   'client→server', '加入频道'],
  ]},
  { type: 'quote',  text: '每个 Agent 进程通过 receive_message(block=true) 阻塞等待消息，收到后处理，处理完再继续等待。这是 Agent 的主循环。' },
];

const linkedTasks = [
  { id: 'T-01', title: '逆向分析 Slock 架构', status: 'done'  },
  { id: 'T-03', title: '设计前端页面组件',     status: 'doing' },
];

export default function DocumentViewer() {
  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] flex flex-col"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* Top breadcrumb */}
      <div
        className="border-b-[3px] border-black bg-[#141018] px-5 py-2 flex items-center gap-2 text-[12px] text-[#4a4048]"
      >
        <span className="text-[#6bc5e8] cursor-pointer hover:text-[#3abfa0]">JwtVault</span>
        <span>/</span>
        <span className="text-[#6bc5e8] cursor-pointer hover:text-[#3abfa0]">slock-clone</span>
        <span>/</span>
        <span className="text-[#e7dfd3]">Agent通信机制.md</span>
        <div className="ml-auto flex gap-2">
          <span className="border-[2px] border-black bg-[#0f1a18] text-[#3abfa0] px-2 py-0.5 uppercase text-[10px]">
            read-only
          </span>
          <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] px-2 py-0.5 uppercase text-[10px]">
            obsidian
          </span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Outline sidebar ── */}
        <aside className="w-[200px] border-r-[3px] border-black bg-[#141018] flex flex-col overflow-auto">
          <div className="border-b-[3px] border-black px-3 py-2 text-[11px] text-[#4a4048] uppercase">outline</div>
          {DOC_CONTENT.filter((b) => b.type === 'h1' || b.type === 'h2').map((b, i) => (
            <div
              key={i}
              className={`px-3 py-1 text-[12px] cursor-pointer hover:text-[#6bc5e8] border-l-[2px]
                ${b.type === 'h1' ? 'text-[#c8bdb8] border-[#c0392b] pl-3' : 'text-[#9a8888] border-transparent pl-5'}`}
            >
              {b.text}
            </div>
          ))}

          {/* Linked tasks */}
          <div className="border-t-[3px] border-black mt-3 px-3 py-2">
            <div className="text-[11px] text-[#4a4048] uppercase mb-2">linked tasks</div>
            {linkedTasks.map((t) => (
              <div key={t.id} className="text-[11px] leading-5 mb-1">
                <div className="text-[#6bc5e8]">{t.id}</div>
                <div className="text-[#6a5858] truncate">{t.title}</div>
              </div>
            ))}
          </div>
        </aside>

        {/* ── Main document ── */}
        <main className="flex-1 overflow-auto bg-[#161318] p-6">
          <div
            className="max-w-[780px] mx-auto border-[3px] border-black bg-[#d8d0bf] text-black"
            style={{
              transform: 'rotate(-0.1deg)',
              boxShadow: '6px 8px 0 rgba(0,0,0,0.85), 0 10px 30px rgba(50,120,220,0.14), 0 4px 16px rgba(30,180,120,0.08)',
            }}
          >
            {/* Doc toolbar */}
            <div className="border-b-[3px] border-black px-6 py-3 bg-[#ccc4b2] flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-[0.06em] opacity-60">obsidian document</div>
              <div className="flex gap-2">
                {['copy link', 'open in obsidian'].map((action) => (
                  <button
                    key={action}
                    className="border-[2px] border-black px-2 py-0.5 bg-[#ece4d4] text-[11px] uppercase hover:bg-[#c0392b] hover:text-white hover:border-[#c0392b] transition-colors"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>

            {/* Content */}
            <div className="px-8 py-6 space-y-4" style={{ lineHeight: 1.75 }}>
              {DOC_CONTENT.map((block, i) => {
                if (block.type === 'h1')
                  return <div key={i} style={{ fontSize: 28, fontWeight: 'bold', lineHeight: 1.2 }}>{block.text}</div>;
                if (block.type === 'meta')
                  return <div key={i} style={{ fontSize: 11, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{block.text}</div>;
                if (block.type === 'h2')
                  return <div key={i} style={{ fontSize: 20, borderTop: '3px solid rgba(0,0,0,0.4)', paddingTop: 12, marginTop: 20 }}>{block.text}</div>;
                if (block.type === 'p')
                  return <div key={i} style={{ fontSize: 16 }}>{block.text}</div>;
                if (block.type === 'bullet')
                  return <div key={i} style={{ fontSize: 15, paddingLeft: 12 }}>• {block.text}</div>;
                if (block.type === 'code')
                  return (
                    <div key={i} className="border-[3px] border-black bg-[#0e0c10] text-[#3abfa0] px-4 py-3" style={{ fontSize: 12 }}>
                      {block.lines?.map((l, j) => <div key={j}>{l}</div>)}
                    </div>
                  );
                if (block.type === 'quote')
                  return (
                    <div
                      key={i}
                      className="border-[3px] border-black bg-[#e8e0d0] px-4 py-3"
                      style={{ fontSize: 15, transform: 'rotate(-0.15deg)', boxShadow: '2px 3px 0 rgba(0,0,0,0.4)' }}
                    >
                      {block.text}
                    </div>
                  );
                if (block.type === 'table')
                  return (
                    <table key={i} className="border-[3px] border-black w-full" style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr className="bg-[#ccc4b2]">
                          {block.headers?.map((h) => (
                            <th key={h} className="border-[2px] border-black px-3 py-1 text-left">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows?.map((row, j) => (
                          <tr key={j} style={{ background: j % 2 === 0 ? '#d4ccbc' : '#ccc4b2' }}>
                            {row.map((cell, k) => (
                              <td key={k} className="border-[2px] border-black px-3 py-1">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                return null;
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
