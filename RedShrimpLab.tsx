// Red Shrimp Lab — 红虾俱乐部
// Pixel-art cyberpunk document console
// Style: VA-11 Hall-A × Notion × Pixel terminal
// Shadows: cyberpunk blue-green (no gold/amber)

export default function RedShrimpLab() {
  const sidebarItems = [
    { label: 'home',     icon: '⌂', active: false },
    { label: 'docs',     icon: '▣', active: true  },
    { label: 'tasks',    icon: '▤', active: false },
    { label: 'agents',   icon: '◈', active: false },
    { label: 'machines', icon: '◫', active: false },
  ];

  const docs = [
    { title: 'product_vision.md',                   tag: 'brief', active: true  },
    { title: 'android_information_architecture.md', tag: 'spec',  active: false },
    { title: 'milestone_week1.md',                  tag: 'plan',  active: false },
    { title: 'task_to_doc_mapping.md',              tag: 'ops',   active: false },
  ];

  const taskCards = [
    { id: 'T-01', name: '定义 Android companion MVP',   status: 'done',  doc: 'product_vision.md'                   },
    { id: 'T-02', name: '整理信息架构与页面流',         status: 'doing', doc: 'android_information_architecture.md' },
    { id: 'T-03', name: '补充 agent 到文档的映射',      status: 'todo',  doc: 'task_to_doc_mapping.md'              },
  ];

  const docBlocks = [
    { type: 'h1',    text: 'Android Companion — Information Architecture' },
    { type: 'meta',  text: 'workspace / jwtvault / docs / current sprint' },
    { type: 'p',     text: '这个版本尝试把 Notion 式文档阅读体验和赛博朋克像素终端结合起来。中间主区以文档为核心，任务输出可以直接跳转到对应文档块。' },
    { type: 'h2',    text: 'Core Layout' },
    { type: 'bullet',text: '左侧保留低密度导航：docs / tasks / agents / machines。' },
    { type: 'bullet',text: '中间主体改成文档阅读区，而不是纯聊天区。' },
    { type: 'bullet',text: '右侧显示任务卡、文档链接、最近输出和状态。' },
    { type: 'h2',    text: 'Task → Document' },
    { type: 'p',     text: '每一个任务卡片都带有 doc anchor。点击任务后，文档区自动定位到对应章节，例如 #android-nav, #task-mapping, #release-plan。' },
    { type: 'quote', text: '风格关键词：Notion 的可读性 + VA-11 Hall-A 的轻微手绘边框 + 低亮度像素赛博朋克。' },
    { type: 'h2',    text: 'Visual Rules' },
    { type: 'bullet',text: '不要霓虹光晕阴影，只要黑色描边和纸片式叠层。' },
    { type: 'bullet',text: '只保留非常轻微的倾斜，让界面保持稳定可读。' },
    { type: 'bullet',text: '像素感主要通过字体、图标、边缘和间距来表达。' },
  ];

  const statusStyle = (status: string) => {
    if (status === 'done')  return { bg: '#1e2e26', text: '#7ecfa8', label: 'done'  };
    if (status === 'doing') return { bg: '#1a2535', text: '#6bc5e8', label: 'doing' };
    return                         { bg: '#2a2622', text: '#c9bfaf', label: 'todo'  };
  };

  // Pixel shrimp logo (ASCII-style SVG)
  const PixelLogo = () => (
    <svg width="52" height="52" viewBox="0 0 13 13" style={{ imageRendering: 'pixelated' }}>
      {/* Body — red shrimp silhouette in pixel grid */}
      {[
        [5,1],[6,1],
        [4,2],[5,2],[6,2],[7,2],
        [3,3],[4,3],[5,3],[6,3],[7,3],
        [3,4],[4,4],[5,4],[6,4],
        [4,5],[5,5],[6,5],[7,5],
        [5,6],[6,6],[7,6],[8,6],
        [6,7],[7,7],[8,7],
        [7,8],[8,8],
        // tail
        [3,6],[2,7],[1,8],[1,9],[2,9],
        // antennae
        [7,0],[8,0],[9,0],
        [6,0],
      ].map(([x,y], i) => (
        <rect key={i} x={x} y={y} width={1} height={1} fill="#c0392b" />
      ))}
      {/* Eye */}
      <rect x={6} y={2} width={1} height={1} fill="#f0e8e8" />
      {/* Legs */}
      {[[3,5],[2,6],[2,5],[1,6]].map(([x,y],i) => (
        <rect key={`l${i}`} x={x} y={y} width={1} height={1} fill="#8b1a2a" />
      ))}
    </svg>
  );

  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-4"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.20) 0%, transparent 55%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      <div
        className="mx-auto border-[3px] border-black bg-[#191619]"
        style={{
          maxWidth: 1600,
          boxShadow:
            '0 0 0 2px rgba(0,0,0,0.7), ' +
            '0 8px 40px rgba(50,120,220,0.22), ' +
            '0 4px 20px rgba(30,180,120,0.10)',
        }}
      >
        {/* ── TOP BAR ── */}
        <header
          className="border-b-[3px] border-black flex items-center gap-3 px-4 py-2 bg-[#130f14]"
        >
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div
              className="w-[52px] h-[52px] border-[3px] border-black bg-[#1a0f0f] flex items-center justify-center"
              style={{ transform: 'rotate(-0.5deg)' }}
            >
              <PixelLogo />
            </div>
            <div>
              <div className="text-[11px] text-[#6bc5e8] uppercase tracking-[0.12em]">The Red Shrimp Lab</div>
              <div className="text-[20px] leading-none text-[#e7dfd3]">红虾俱乐部</div>
            </div>
          </div>

          <div className="flex-1" />

          {/* Status pills */}
          <div className="flex gap-2 text-[12px]">
            {['agents: 3 online', 'tasks: 2 active', 'docs: 4'].map((s) => (
              <span
                key={s}
                className="border-[3px] border-black px-3 py-1 bg-[#1a2535] text-[#6bc5e8]"
                style={{ transform: 'rotate(-0.2deg)' }}
              >
                {s}
              </span>
            ))}
          </div>
        </header>

        {/* ── MAIN GRID ── */}
        {/*  col-1: icon rail (64px)
             col-2: doc tree (240px)
             col-3: document viewer (flex 1)
             col-4: linked tasks (300px)          */}
        <div className="grid min-h-[820px]" style={{ gridTemplateColumns: '64px 240px 1fr 300px' }}>

          {/* ── COL 1: Icon rail ── */}
          <aside className="border-r-[3px] border-black bg-[#120f13] flex flex-col items-center py-4 gap-2">
            {sidebarItems.map((item, i) => (
              <div
                key={item.label}
                className={`w-12 h-12 border-[3px] border-black flex flex-col items-center justify-center text-[10px] leading-none cursor-pointer select-none
                  ${item.active
                    ? 'bg-[#c0392b] text-black'
                    : 'bg-[#231e25] text-[#c5bdb0] hover:bg-[#2e2830] hover:text-[#6bc5e8]'
                  }`}
                style={{ transform: `rotate(${i % 2 === 0 ? '-0.4deg' : '0.3deg'})` }}
              >
                <span className="text-[16px] mb-[2px]">{item.icon}</span>
                <span>{item.label}</span>
              </div>
            ))}
            <div className="mt-auto w-12 h-4 border-[3px] border-black bg-[#1e1a20]" />
          </aside>

          {/* ── COL 2: Doc tree ── */}
          <aside className="border-r-[3px] border-black bg-[#1a161b] flex flex-col p-3 gap-3">
            {/* Vault header */}
            <div
              className="border-[3px] border-black bg-[#c0392b] text-black px-3 py-2"
              style={{ transform: 'rotate(-0.3deg)' }}
            >
              <div className="text-[11px] uppercase tracking-[0.08em] opacity-70">jwtvault</div>
              <div className="text-[22px] leading-tight mt-1">docs index</div>
            </div>

            {/* Current path */}
            <div
              className="border-[3px] border-black bg-[#141018] px-3 py-2"
              style={{
                boxShadow: '2px 3px 0 rgba(0,0,0,0.8), 0 0 8px rgba(50,120,220,0.15)',
                transform: 'rotate(0.2deg)',
              }}
            >
              <div className="text-[11px] text-[#6bc5e8] uppercase mb-1">current folder</div>
              <div className="text-[13px] text-[#e0d8d0] break-all leading-5">
                ~/JwtVault/<br />projects/slock/
              </div>
            </div>

            {/* Doc list */}
            <div className="flex flex-col gap-2 flex-1">
              {docs.map((doc, i) => (
                <div
                  key={doc.title}
                  className={`border-[3px] border-black px-3 py-2 cursor-pointer
                    ${doc.active
                      ? 'bg-[#7e2530] text-[#f4ebe0]'
                      : 'bg-[#231e25] text-[#c5bdb0] hover:bg-[#2e2830]'
                    }`}
                  style={{
                    transform: `rotate(${i % 2 === 0 ? '-0.25deg' : '0.25deg'})`,
                    boxShadow: doc.active
                      ? '3px 4px 0 rgba(0,0,0,0.9), 0 0 12px rgba(50,120,220,0.18)'
                      : '2px 3px 0 rgba(0,0,0,0.7)',
                  }}
                >
                  <div className="text-[11px] uppercase opacity-60">{doc.tag}</div>
                  <div className="text-[13px] mt-1 leading-5 break-words">{doc.title}</div>
                </div>
              ))}
            </div>

            {/* Agent activity strip */}
            <div className="border-[3px] border-black bg-[#0f1a18] px-3 py-2">
              <div className="text-[11px] text-[#3abfa0] uppercase mb-1">agents</div>
              {['Alice — working', 'Atlas — idle', 'Astra — thinking'].map((a, i) => (
                <div key={i} className="text-[12px] text-[#a8c8bf] leading-6">
                  <span
                    className="inline-block w-2 h-2 border border-black mr-2"
                    style={{
                      background: i === 0 ? '#c0392b' : i === 2 ? '#6bc5e8' : '#3a3535',
                    }}
                  />
                  {a}
                </div>
              ))}
            </div>
          </aside>

          {/* ── COL 3: Document viewer ── */}
          <main className="bg-[#161318] p-5 flex flex-col">
            <div
              className="flex-1 border-[3px] border-black bg-[#d8d0bf] text-black flex flex-col overflow-hidden"
              style={{
                transform: 'rotate(-0.12deg)',
                boxShadow:
                  '5px 7px 0 rgba(0,0,0,0.85), ' +
                  '0 10px 30px rgba(50,120,220,0.18), ' +
                  '0 4px 16px rgba(30,180,120,0.10)',
              }}
            >
              {/* Doc header */}
              <div className="border-b-[3px] border-black px-6 py-3 bg-[#ccc4b2] flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.06em] opacity-60">document viewer</div>
                  <div
                    className="text-[22px] leading-tight mt-1 truncate"
                    style={{ fontFamily: '"Share Tech Mono", monospace' }}
                  >
                    android_information_architecture.md
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {['outline', 'linked tasks', 'raw'].map((t) => (
                    <button
                      key={t}
                      className="border-[3px] border-black px-3 py-1 bg-[#e8e0d0] text-[13px] uppercase hover:bg-[#c0392b] hover:text-white transition-colors"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Doc body */}
              <div
                className="flex-1 overflow-auto px-8 py-5 space-y-4"
                style={{ lineHeight: 1.7 }}
              >
                {docBlocks.map((block, idx) => {
                  if (block.type === 'h1')
                    return (
                      <div key={idx} style={{ fontSize: 30, lineHeight: 1.2, fontFamily: 'Share Tech Mono, monospace' }}>
                        {block.text}
                      </div>
                    );
                  if (block.type === 'meta')
                    return (
                      <div key={idx} style={{ fontSize: 12, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {block.text}
                      </div>
                    );
                  if (block.type === 'h2')
                    return (
                      <div
                        key={idx}
                        style={{ fontSize: 22, borderTop: '3px solid rgba(0,0,0,0.5)', paddingTop: 12, marginTop: 20 }}
                      >
                        {block.text}
                      </div>
                    );
                  if (block.type === 'quote')
                    return (
                      <div
                        key={idx}
                        style={{
                          border: '3px solid black',
                          background: '#e8e0d0',
                          padding: '10px 16px',
                          fontSize: 18,
                          transform: 'rotate(-0.2deg)',
                          boxShadow: '2px 3px 0 rgba(0,0,0,0.6), 0 0 8px rgba(50,120,220,0.1)',
                        }}
                      >
                        {block.text}
                      </div>
                    );
                  if (block.type === 'bullet')
                    return (
                      <div key={idx} style={{ fontSize: 18, paddingLeft: 8 }}>
                        • {block.text}
                      </div>
                    );
                  return (
                    <div key={idx} style={{ fontSize: 18 }}>
                      {block.text}
                    </div>
                  );
                })}
              </div>
            </div>
          </main>

          {/* ── COL 4: Linked tasks / right panel ── */}
          <aside className="border-l-[3px] border-black bg-[#191519] flex flex-col p-3 gap-3">
            {/* Panel title */}
            <div
              className="border-[3px] border-black bg-[#c0392b] text-black px-3 py-2"
              style={{
                transform: 'rotate(0.3deg)',
                boxShadow: '3px 4px 0 rgba(0,0,0,0.85)',
              }}
            >
              <div className="text-[11px] uppercase opacity-70">task output</div>
              <div className="text-[22px] leading-tight mt-1">linked docs</div>
            </div>

            {/* Task cards */}
            {taskCards.map((task, i) => {
              const s = statusStyle(task.status);
              return (
                <div
                  key={task.id}
                  className="border-[3px] border-black bg-[#d4ccbc] text-black"
                  style={{
                    transform: `rotate(${i % 2 === 0 ? '-0.3deg' : '0.3deg'})`,
                    boxShadow:
                      '3px 4px 0 rgba(0,0,0,0.85), ' +
                      '0 0 12px rgba(50,120,220,0.12)',
                  }}
                >
                  <div className="border-b-[3px] border-black px-3 py-2 flex items-start justify-between gap-2 bg-[#cac2b2]">
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase opacity-60">{task.id}</div>
                      <div className="text-[15px] leading-tight mt-1">{task.name}</div>
                    </div>
                    <span
                      className="border-[3px] border-black px-2 py-0.5 text-[11px] uppercase shrink-0"
                      style={{ background: s.bg, color: s.text }}
                    >
                      {s.label}
                    </span>
                  </div>
                  <div className="px-3 py-2 bg-[#120f13] text-[#6bc5e8] text-[12px]">
                    ↳ {task.doc}
                  </div>
                </div>
              );
            })}

            {/* Recent outputs */}
            <div
              className="border-[3px] border-black bg-[#0f1a18] p-3 text-[#a8c8bf]"
              style={{ boxShadow: '2px 3px 0 rgba(0,0,0,0.7), 0 0 8px rgba(30,180,120,0.10)' }}
            >
              <div className="text-[11px] text-[#3abfa0] uppercase mb-2">recent outputs</div>
              <div className="text-[13px] space-y-1 leading-6">
                <div>Astra 更新了文档结构</div>
                <div>Alice 提交 API 约束说明</div>
                <div>Atlas 新建 smoke test note</div>
              </div>
            </div>

            {/* Style notes */}
            <div
              className="border-[3px] border-black bg-[#1a1520] p-3 text-[#b8b0d0] mt-auto"
              style={{ boxShadow: '2px 3px 0 rgba(0,0,0,0.7)' }}
            >
              <div className="text-[11px] text-[#6bc5e8] uppercase mb-2">style notes</div>
              <div className="text-[12px] space-y-1 leading-6">
                <div>• Notion 式文档中心</div>
                <div>• 黑色描边，蓝绿阴影</div>
                <div>• 轻微手绘感，不影响阅读</div>
                <div>• VA-11 Hall-A 情绪感</div>
              </div>
            </div>
          </aside>

        </div>
      </div>
    </div>
  );
}
