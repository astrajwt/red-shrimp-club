// Red Shrimp Lab — Agents Management Page
// 红虾俱乐部 Agent 管理页

const agents = [
  {
    id: '01', name: 'Alice', role: 'Developer',
    model: 'claude-sonnet-4-6', provider: 'anthropic',
    activity: 'working', activityDetail: '正在设计前端页面组件',
    workspace: '~/JwtVault/slock-clone/',
    tokensUsed: 142000, tokensLimit: 200000,
    lastSeen: '09:34',
  },
  {
    id: '02', name: 'Astra', role: 'Product Manager',
    model: 'claude-sonnet-4-6', provider: 'anthropic',
    activity: 'idle', activityDetail: '等待需求确认',
    workspace: '~/JwtVault/slock-clone/',
    tokensUsed: 88000, tokensLimit: 200000,
    lastSeen: '09:32',
  },
  {
    id: '03', name: 'Atlas', role: 'QA Engineer',
    model: 'claude-sonnet-4-6', provider: 'anthropic',
    activity: 'idle', activityDetail: '等待开发完成',
    workspace: '~/JwtVault/slock-clone/tests/',
    tokensUsed: 45000, tokensLimit: 200000,
    lastSeen: '09:31',
  },
];

const activityColor = (a: string) => {
  if (a === 'working')  return { dot: '#c0392b', text: '#e04050', label: 'working'  };
  if (a === 'thinking') return { dot: '#6bc5e8', text: '#6bc5e8', label: 'thinking' };
  if (a === 'writing')  return { dot: '#3abfa0', text: '#3abfa0', label: 'writing'  };
  return                       { dot: '#3a3535', text: '#6a5858', label: 'idle'     };
};

export default function AgentsPage() {
  return (
    <div
      className="min-h-screen bg-[#0e0c10] text-[#e7dfd3] p-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      {/* Page header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">management</div>
          <div
            className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1"
          >
            agents
          </div>
        </div>
        <button
          className="border-[3px] border-black bg-[#c0392b] text-black px-5 py-2 text-[13px] uppercase hover:bg-[#e04050]"
          style={{ transform: 'rotate(0.2deg)' }}
        >
          + spawn agent
        </button>
      </div>

      {/* Agent cards grid */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))' }}>
        {agents.map((agent, i) => {
          const ac = activityColor(agent.activity);
          const tokenPct = Math.round((agent.tokensUsed / agent.tokensLimit) * 100);
          return (
            <div
              key={agent.id}
              className="border-[3px] border-black bg-[#191619]"
              style={{
                transform: `rotate(${i % 2 === 0 ? '-0.2deg' : '0.2deg'})`,
                boxShadow:
                  '4px 5px 0 rgba(0,0,0,0.9), ' +
                  '0 8px 24px rgba(50,120,220,0.14), ' +
                  '0 4px 12px rgba(30,180,120,0.08)',
              }}
            >
              {/* Card header */}
              <div className="border-b-[3px] border-black px-4 py-3 bg-[#1e1a20] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div
                    className="w-10 h-10 border-[3px] border-black flex items-center justify-center text-[16px]"
                    style={{ background: '#3a1520', color: '#c0392b' }}
                  >
                    {agent.name[0]}
                  </div>
                  <div>
                    <div className="text-[16px]">{agent.name}</div>
                    <div className="text-[11px] text-[#6bc5e8] uppercase">{agent.role}</div>
                  </div>
                </div>
                {/* Activity badge */}
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 border border-black"
                    style={{
                      background: ac.dot,
                      animation: agent.activity === 'working' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                    }}
                  />
                  <span className="text-[12px] uppercase" style={{ color: ac.text }}>{ac.label}</span>
                </div>
              </div>

              {/* Activity detail */}
              <div className="px-4 py-2 text-[13px] text-[#9a8888] border-b-[3px] border-black bg-[#120f13]">
                {agent.activityDetail}
              </div>

              {/* Meta */}
              <div className="px-4 py-3 space-y-2">
                <MetaRow label="model"     value={agent.model} />
                <MetaRow label="provider"  value={agent.provider} />
                <MetaRow label="workspace" value={agent.workspace} small />
                <MetaRow label="last seen" value={agent.lastSeen} />

                {/* Token meter */}
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#4a4048] uppercase">context usage</span>
                    <span style={{ color: tokenPct > 80 ? '#c0392b' : '#6bc5e8' }}>
                      {tokenPct}%
                    </span>
                  </div>
                  <div className="border-[2px] border-black bg-[#120f13] h-3">
                    <div
                      className="h-full"
                      style={{
                        width: `${tokenPct}%`,
                        background: tokenPct > 80 ? '#c0392b' : tokenPct > 50 ? '#6bc5e8' : '#3abfa0',
                        boxShadow: tokenPct > 80 ? '0 0 6px rgba(192,57,43,0.5)' : 'none',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="border-t-[3px] border-black grid grid-cols-3">
                {['view logs', 'dm agent', 'configure'].map((action) => (
                  <button
                    key={action}
                    className="border-r-[3px] last:border-r-0 border-black py-2 text-[11px] text-[#9a8888] uppercase hover:bg-[#2a2535] hover:text-[#6bc5e8] transition-colors"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Spawn config panel */}
      <div
        className="mt-5 border-[3px] border-black bg-[#141118]"
        style={{
          boxShadow: '4px 5px 0 rgba(0,0,0,0.9), 0 0 16px rgba(50,120,220,0.10)',
          transform: 'rotate(-0.1deg)',
        }}
      >
        <div className="border-b-[3px] border-black bg-[#1e1a20] px-5 py-3">
          <div className="text-[11px] text-[#3abfa0] uppercase tracking-widest">model registry</div>
          <div className="text-[18px] mt-1">available providers</div>
        </div>
        <div className="grid grid-cols-3 divide-x-[3px] divide-black">
          {[
            { name: 'Anthropic Claude', models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'], color: '#c0392b' },
            { name: 'Moonshot Kimi',    models: ['kimi-k2', 'kimi-k1-8k', 'kimi-k1-32k'],                  color: '#6bc5e8' },
            { name: 'OpenAI Codex',     models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],                       color: '#3abfa0' },
          ].map((p) => (
            <div key={p.name} className="px-5 py-4">
              <div className="text-[13px] mb-2" style={{ color: p.color }}>{p.name}</div>
              {p.models.map((m) => (
                <div key={m} className="text-[12px] text-[#6a5858] leading-6 pl-2 border-l-[2px] border-[#2a2228]">
                  {m}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="text-[11px] text-[#4a4048] uppercase w-[80px] shrink-0">{label}</span>
      <span className={`${small ? 'text-[11px]' : 'text-[13px]'} text-[#c8bdb8] truncate`}>{value}</span>
    </div>
  );
}
