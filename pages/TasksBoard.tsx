// Red Shrimp Lab — Tasks Board
// 红虾俱乐部 任务看板

const tasks = [
  {
    id: 'T-01', title: '逆向分析 Slock 技术架构', status: 'done',
    agent: 'Alice', channel: 'all',
    docs: [
      { name: 'Agent通信机制.md',    status: 'read'    },
      { name: 'Scheduler设计.md',    status: 'read'    },
    ],
    skills: ['reverse-engineering', 'architecture'],
  },
  {
    id: 'T-02', title: '撰写产品需求文档 PRD v0.3', status: 'done',
    agent: 'Astra', channel: 'all',
    docs: [
      { name: 'PRD-产品需求文档.md',  status: 'unread'  },
      { name: 'PRD-交互设计.md',      status: 'unread'  },
      { name: 'PRD-前端设计规范.md',  status: 'writing' },
    ],
    skills: ['product-management', 'documentation'],
  },
  {
    id: 'T-03', title: '设计前端页面组件（红虾风格）', status: 'doing',
    agent: 'Alice', channel: 'all',
    docs: [
      { name: '前端设计规范-红弦风格.md', status: 'writing' },
    ],
    skills: ['frontend', 'react', 'design'],
  },
  {
    id: 'T-04', title: '搭建 Node.js 后端脚手架', status: 'todo',
    agent: null, channel: 'dev',
    docs: [],
    skills: ['backend', 'nodejs'],
  },
  {
    id: 'T-05', title: '设计 PostgreSQL 数据库 Schema', status: 'todo',
    agent: null, channel: 'dev',
    docs: [],
    skills: ['database', 'postgresql'],
  },
  {
    id: 'T-06', title: '实现 WebSocket 实时消息', status: 'todo',
    agent: null, channel: 'dev',
    docs: [],
    skills: ['backend', 'websocket', 'socketio'],
  },
];

const columns = [
  { key: 'todo',  label: 'To Do',  color: '#2a2622', textColor: '#9a8888' },
  { key: 'doing', label: 'Doing',  color: '#1a2535', textColor: '#6bc5e8' },
  { key: 'done',  label: 'Done',   color: '#1e2e26', textColor: '#7ecfa8' },
];

export default function TasksBoard() {
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
          const colTasks = tasks.filter((t) => t.status === col.key);
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
                <TaskCard key={task.id} task={task} rotate={i % 2 === 0 ? '-0.25deg' : '0.25deg'} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ task, rotate }: { task: typeof tasks[0]; rotate: string }) {
  return (
    <div
      className="border-[3px] border-black bg-[#191619]"
      style={{
        transform: `rotate(${rotate})`,
        boxShadow:
          '3px 4px 0 rgba(0,0,0,0.85), ' +
          '0 0 10px rgba(50,120,220,0.10)',
      }}
    >
      {/* Title bar */}
      <div className="border-b-[3px] border-black px-3 py-2 bg-[#1e1a20]">
        <div className="text-[10px] text-[#4a4048] uppercase mb-1">{task.id} · #{task.channel}</div>
        <div className="text-[14px] leading-5">{task.title}</div>
      </div>

      {/* Agent */}
      {task.agent ? (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13] flex items-center gap-2">
          <span className="w-2 h-2 bg-[#c0392b] border border-black" />
          <span className="text-[12px] text-[#6bc5e8]">@ {task.agent}</span>
        </div>
      ) : (
        <div className="border-b-[3px] border-black px-3 py-1 bg-[#120f13]">
          <span className="text-[12px] text-[#4a4048]">unclaimed</span>
        </div>
      )}

      {/* Linked docs */}
      {task.docs.length > 0 && (
        <div className="border-b-[3px] border-black px-3 py-2 bg-[#160f14] space-y-1">
          <div className="text-[10px] text-[#4a4048] uppercase mb-1">linked docs</div>
          {task.docs.map((doc) => (
            <div key={doc.name} className="flex items-center gap-2">
              <DocStatusDot status={doc.status} />
              <span className="text-[11px] text-[#c8bdb8] truncate">{doc.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {task.skills.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1">
          {task.skills.map((skill) => (
            <span
              key={skill}
              className="border-[2px] border-black text-[10px] px-2 py-0.5 bg-[#0f1a18] text-[#3abfa0]"
            >
              {skill}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DocStatusDot({ status }: { status: string }) {
  if (status === 'writing') {
    return (
      <span
        className="w-2 h-2 border border-black shrink-0"
        style={{
          background: '#D4A017',
          animation: 'pulse 1.2s ease-in-out infinite',
        }}
      />
    );
  }
  if (status === 'unread') {
    return <span className="w-2 h-2 border border-black bg-[#4A90D9] shrink-0 cursor-pointer" />;
  }
  return <span className="w-2 h-2 border border-black bg-[#2a2622] shrink-0" />;
}
