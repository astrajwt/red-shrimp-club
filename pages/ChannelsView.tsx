// Red Shrimp Lab — Channels View (Chat + Tasks sidebar)
// 红虾俱乐部 频道聊天页

const messages = [
  { id: 1, sender: 'Jwt2077',  type: 'human', time: '09:28', content: '为我设计前端，要类似红弦俱乐部的感觉。' },
  { id: 2, sender: 'Alice',    type: 'agent', time: '09:30', content: '收到！正在设计红虾俱乐部风格的前端，使用蓝绿阴影 + 像素赛博朋克风格。', activity: 'working' },
  { id: 3, sender: 'Astra',    type: 'agent', time: '09:31', content: 'PRD 交互设计已更新，覆盖全部8个页面的布局规范。', activity: 'idle' },
  { id: 4, sender: 'Atlas',    type: 'agent', time: '09:32', content: '测试计划已同步更新，等前端页面完成后开始 E2E 测试。', activity: 'idle' },
  { id: 5, sender: 'Jwt2077',  type: 'human', time: '09:34', content: '几个页面都写一下吧。' },
];

const tasks = [
  { id: 'T-01', title: '逆向分析 Slock 架构',      status: 'done',   agent: 'Alice' },
  { id: 'T-02', title: '撰写 PRD 需求文档',         status: 'done',   agent: 'Astra' },
  { id: 'T-03', title: '设计前端页面组件',          status: 'doing',  agent: 'Alice' },
  { id: 'T-04', title: '设计 Scheduler 机制',       status: 'done',   agent: 'Alice' },
  { id: 'T-05', title: '搭建后端项目脚手架',        status: 'todo',   agent: null    },
];

const channels = [
  { name: 'all',    unread: 0, active: true  },
  { name: 'dev',    unread: 3, active: false },
  { name: 'design', unread: 1, active: false },
  { name: 'qa',     unread: 0, active: false },
];

const dms = [
  { name: 'Jwt2077', online: true  },
  { name: 'Astra',   online: true  },
  { name: 'Atlas',   online: false },
];

export default function ChannelsView() {
  return (
    <div
      className="flex h-screen bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {/* ── Channel List ── */}
      <aside
        className="w-[200px] border-r-[3px] border-black bg-[#141118] flex flex-col"
      >
        <div className="border-b-[3px] border-black px-3 py-3 bg-[#1a161b]">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">workspace</div>
          <div className="text-[16px]">red-shrimp-lab</div>
        </div>

        {/* Channels */}
        <div className="px-3 pt-3">
          <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">channels</div>
          {channels.map((ch) => (
            <div
              key={ch.name}
              className={`flex items-center justify-between px-2 py-1 mb-1 cursor-pointer border-l-[3px]
                ${ch.active
                  ? 'border-[#c0392b] bg-[#3a1520] text-[#f0e8e8]'
                  : 'border-transparent text-[#9a8888] hover:text-[#c8bdb8] hover:border-[#3a1520]'
                }`}
            >
              <span className="text-[13px]"># {ch.name}</span>
              {ch.unread > 0 && (
                <span className="text-[10px] bg-[#c0392b] text-black px-1">{ch.unread}</span>
              )}
            </div>
          ))}
        </div>

        {/* DMs */}
        <div className="px-3 pt-4">
          <div className="text-[10px] text-[#4a4048] uppercase tracking-[0.1em] mb-2">direct messages</div>
          {dms.map((dm) => (
            <div
              key={dm.name}
              className="flex items-center gap-2 px-2 py-1 mb-1 cursor-pointer text-[#9a8888] hover:text-[#c8bdb8]"
            >
              <span
                className="w-2 h-2 border border-black"
                style={{ background: dm.online ? '#6bc5e8' : '#3a3535' }}
              />
              <span className="text-[13px]">@ {dm.name}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Message Area ── */}
      <main className="flex-1 flex flex-col border-r-[3px] border-black">
        {/* Channel header */}
        <div className="border-b-[3px] border-black bg-[#141118] px-5 py-3 flex items-center gap-3">
          <span className="text-[22px] text-[#c0392b]">#</span>
          <div>
            <div className="text-[16px]">all</div>
            <div className="text-[11px] text-[#6bc5e8]">General channel for all members</div>
          </div>
          <div className="ml-auto flex gap-2">
            <Chip>3 agents</Chip>
            <Chip>5 tasks</Chip>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3 group">
              {/* Avatar */}
              <div
                className="w-8 h-8 border-[2px] border-black flex items-center justify-center text-[11px] shrink-0 mt-1"
                style={{
                  background: msg.type === 'agent' ? '#1a2535' : '#3a1520',
                  color: msg.type === 'agent' ? '#6bc5e8' : '#f0e8e8',
                }}
              >
                {msg.sender[0].toUpperCase()}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className={`text-[13px] ${msg.type === 'agent' ? 'text-[#6bc5e8]' : 'text-[#c0392b]'}`}>
                    {msg.type === 'agent' ? '(agent) ' : ''}{msg.sender}
                  </span>
                  <span className="text-[11px] text-[#4a4048]">{msg.time}</span>
                  {msg.activity && (
                    <span className="text-[10px] text-[#3abfa0] uppercase">{msg.activity}</span>
                  )}
                </div>
                <div
                  className="text-[14px] text-[#e0d8d0] leading-6 pl-2 border-l-[2px]"
                  style={{ borderColor: msg.type === 'agent' ? '#6bc5e8' : '#c0392b' }}
                >
                  {msg.content}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="border-t-[3px] border-black px-4 py-3 bg-[#120f13]">
          <div className="flex items-center gap-3 border-[3px] border-black bg-[#191619] px-3 py-2"
            style={{ boxShadow: '0 0 12px rgba(50,120,220,0.10)' }}>
            <span className="text-[#4a4048] text-[13px]">message #all</span>
            <input
              className="flex-1 bg-transparent text-[14px] text-[#e7dfd3] outline-none placeholder-[#4a4048]"
              placeholder=""
            />
            <button className="border-[2px] border-black bg-[#c0392b] text-black px-3 py-1 text-[12px] uppercase hover:bg-[#e04050]">
              send ↑
            </button>
          </div>
        </div>
      </main>

      {/* ── Task Sidebar ── */}
      <aside className="w-[260px] bg-[#141118] flex flex-col">
        <div className="border-b-[3px] border-black px-3 py-3 bg-[#c0392b]" style={{ transform: 'rotate(0deg)' }}>
          <div className="text-[11px] text-black/60 uppercase">task board</div>
          <div className="text-[20px] text-black"># all</div>
        </div>

        <div className="flex-1 overflow-auto px-3 py-3 space-y-2">
          {tasks.map((task, i) => {
            const s = taskStatus(task.status);
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
                  <span className="text-[11px] text-[#4a4048] shrink-0 mt-0.5">{task.id}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] leading-5">{task.title}</div>
                    {task.agent && (
                      <div className="text-[11px] text-[#6bc5e8] mt-1">@ {task.agent}</div>
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
            );
          })}
        </div>

        <div className="border-t-[3px] border-black px-3 py-2">
          <button className="w-full border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] text-[12px] uppercase py-2 hover:bg-[#243548]">
            + new task
          </button>
        </div>
      </aside>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-[2px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] px-2 py-0.5 uppercase">
      {children}
    </span>
  );
}

function taskStatus(status: string) {
  if (status === 'done')  return { bg: '#1e2e26', text: '#7ecfa8', label: '✓ done'  };
  if (status === 'doing') return { bg: '#1a2535', text: '#6bc5e8', label: '▶ doing' };
  return                         { bg: '#2a2622', text: '#9a8888', label: '○ todo'  };
}
