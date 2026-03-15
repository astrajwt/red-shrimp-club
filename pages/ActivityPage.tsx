// Red Shrimp Lab — Activity / Agent Logs Page
// 红虾俱乐部 Agent 活动日志页

const logs = [
  { time: '09:34:12', agent: 'Alice',  level: 'ACTION', content: '认领任务 #T-03 "设计前端页面组件"',        runId: 'run-003', parentRunId: null },
  { time: '09:34:15', agent: 'Alice',  level: 'INFO',   content: '开始拆分任务为子任务',                     runId: 'run-003', parentRunId: null },
  { time: '09:34:17', agent: 'Alice',  level: 'SPAWN',  content: '派生子 Agent: SubAgent-Alice-1',          runId: 'run-003', parentRunId: null },
  { time: '09:34:18', agent: 'Alice',  level: 'SPAWN',  content: '派生子 Agent: SubAgent-Alice-2',          runId: 'run-003', parentRunId: null },
  { time: '09:34:18', agent: 'Alice',  level: 'FILE',   content: '写入 pages/LoginPage.tsx',               runId: 'run-004', parentRunId: 'run-003' },
  { time: '09:34:22', agent: 'Alice',  level: 'FILE',   content: '写入 pages/ChannelsView.tsx',            runId: 'run-004', parentRunId: 'run-003' },
  { time: '09:34:30', agent: 'Alice',  level: 'FILE',   content: '写入 pages/AgentsPage.tsx',              runId: 'run-005', parentRunId: 'run-003' },
  { time: '09:34:38', agent: 'Alice',  level: 'FILE',   content: '写入 pages/TasksBoard.tsx',              runId: 'run-005', parentRunId: 'run-003' },
  { time: '09:33:01', agent: 'Astra',  level: 'INFO',   content: 'PRD v0.3 更新完成',                      runId: 'run-002', parentRunId: null },
  { time: '09:33:05', agent: 'Astra',  level: 'FILE',   content: '写入 PRD-前端设计规范.md',               runId: 'run-002', parentRunId: null },
  { time: '09:31:44', agent: 'Atlas',  level: 'INFO',   content: '测试计划已同步，等待开发完成',            runId: 'run-001', parentRunId: null },
  { time: '09:30:00', agent: 'Alice',  level: 'WARN',   content: 'context 使用率已达 71%，注意转派阈值',   runId: 'run-003', parentRunId: null },
];

const levelStyle = (level: string) => {
  if (level === 'ACTION') return { bg: '#3a1520', text: '#e04050', border: '#c0392b' };
  if (level === 'FILE')   return { bg: '#0f1a18', text: '#3abfa0', border: '#1e3d30' };
  if (level === 'SPAWN')  return { bg: '#1a2535', text: '#6bc5e8', border: '#1e3d55' };
  if (level === 'WARN')   return { bg: '#2a2010', text: '#d4a017', border: '#4a3010' };
  if (level === 'ERROR')  return { bg: '#3a1010', text: '#ff4444', border: '#6a1010' };
  return                         { bg: '#1e1a20', text: '#9a8888', border: '#2a2228' };
};

const agentColor = (agent: string) => {
  if (agent === 'Alice') return '#c0392b';
  if (agent === 'Astra') return '#6bc5e8';
  if (agent === 'Atlas') return '#3abfa0';
  return '#9a8888';
};

export default function ActivityPage() {
  const agents = ['All', 'Alice', 'Astra', 'Atlas'];

  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 15% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 85% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">real-time</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">activity log</div>
        </div>
        {/* Agent filter */}
        <div className="flex gap-2">
          {agents.map((a, i) => (
            <button
              key={a}
              className={`border-[3px] border-black px-3 py-1 text-[12px] uppercase
                ${i === 0 ? 'bg-[#c0392b] text-black' : 'bg-[#1e1a20] text-[#9a8888] hover:bg-[#2a2228]'}`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      {/* Two columns: log stream + tree view */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 320px' }}>

        {/* ── Log stream ── */}
        <div
          className="border-[3px] border-black bg-[#141018]"
          style={{
            boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 16px rgba(50,120,220,0.10)',
          }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20] flex items-center gap-3">
            <span className="text-[13px] uppercase text-[#4a4048]">log stream</span>
            <span className="w-2 h-2 bg-[#c0392b] border border-black" style={{ animation: 'pulse 1s ease-in-out infinite' }} />
            <span className="text-[11px] text-[#c0392b]">live</span>
          </div>

          <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
            {logs.map((log, i) => {
              const s = levelStyle(log.level);
              const isChild = !!log.parentRunId;
              return (
                <div
                  key={i}
                  className="border-b-[3px] border-black flex gap-0"
                  style={{ background: i % 2 === 0 ? '#141018' : '#100e13' }}
                >
                  {/* Indent for child agents */}
                  {isChild && <div className="w-6 shrink-0 border-r-[2px] border-[#1a2535]" />}

                  {/* Time */}
                  <div className="px-3 py-2 text-[11px] text-[#4a4048] w-[85px] shrink-0 border-r-[3px] border-black">
                    {log.time}
                  </div>

                  {/* Agent */}
                  <div className="px-3 py-2 w-[80px] shrink-0 border-r-[3px] border-black">
                    <span className="text-[11px] font-bold" style={{ color: agentColor(log.agent) }}>
                      {log.agent}
                    </span>
                    {isChild && (
                      <div className="text-[9px] text-[#4a4048] mt-0.5">sub</div>
                    )}
                  </div>

                  {/* Level badge */}
                  <div className="px-2 py-2 w-[70px] shrink-0 border-r-[3px] border-black flex items-start">
                    <span
                      className="text-[10px] uppercase px-1 border-[2px]"
                      style={{ background: s.bg, color: s.text, borderColor: s.border }}
                    >
                      {log.level}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="px-3 py-2 text-[13px] text-[#c8bdb8] flex-1">
                    {log.content}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Sub-agent tree ── */}
        <div
          className="border-[3px] border-black bg-[#141018]"
          style={{
            boxShadow: '4px 5px 0 rgba(0,0,0,0.85), 0 0 12px rgba(30,180,120,0.08)',
            alignSelf: 'start',
          }}
        >
          <div className="border-b-[3px] border-black px-4 py-2 bg-[#1e1a20]">
            <div className="text-[13px] uppercase text-[#4a4048]">agent tree</div>
          </div>

          <div className="px-3 py-3 space-y-2">
            {/* Alice parent */}
            <TreeNode
              name="Alice"
              role="Developer"
              runId="run-003"
              status="working"
              tokenPct={71}
              children={[
                { name: 'SubAgent-Alice-1', runId: 'run-004', status: 'done',    detail: 'LoginPage + ChannelsView' },
                { name: 'SubAgent-Alice-2', runId: 'run-005', status: 'working', detail: 'AgentsPage + TasksBoard' },
              ]}
            />
            {/* Astra parent */}
            <TreeNode
              name="Astra"
              role="PM"
              runId="run-002"
              status="idle"
              tokenPct={44}
              children={[]}
            />
            {/* Atlas parent */}
            <TreeNode
              name="Atlas"
              role="QA"
              runId="run-001"
              status="idle"
              tokenPct={22}
              children={[]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeNode({
  name, role, runId, status, tokenPct, children,
}: {
  name: string; role: string; runId: string; status: string; tokenPct: number;
  children: { name: string; runId: string; status: string; detail: string }[];
}) {
  const ac = status === 'working' ? '#c0392b' : status === 'idle' ? '#3a3535' : '#3abfa0';

  return (
    <div className="border-[3px] border-black bg-[#1e1a20]">
      {/* Parent header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b-[3px] border-black bg-[#2a2228]">
        <span className="w-3 h-3 border border-black shrink-0" style={{ background: ac }} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px]">{name}</div>
          <div className="text-[10px] text-[#4a4048] uppercase">{role} · {runId}</div>
        </div>
        <div className="text-[10px] text-right">
          <div style={{ color: tokenPct > 80 ? '#c0392b' : '#6bc5e8' }}>{tokenPct}%</div>
          <div className="text-[#4a4048]">ctx</div>
        </div>
      </div>

      {/* Children */}
      {children.map((child, i) => {
        const cc = child.status === 'done' ? '#3abfa0' : child.status === 'working' ? '#6bc5e8' : '#3a3535';
        return (
          <div key={child.runId} className={`flex gap-2 px-3 py-2 ${i < children.length - 1 ? 'border-b-[2px] border-[#2a2228]' : ''}`}>
            <div className="flex flex-col items-center w-4 shrink-0">
              <div className="w-[2px] flex-1 bg-[#2a2228]" />
              <span className="w-2 h-2 border border-black" style={{ background: cc }} />
              <div className="w-[2px] flex-1 bg-[#2a2228]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-[#c8bdb8]">{child.name}</div>
              <div className="text-[10px] text-[#4a4048] truncate">{child.detail}</div>
            </div>
            <div className="text-[10px]" style={{ color: cc }}>
              {child.status}
            </div>
          </div>
        );
      })}
    </div>
  );
}
