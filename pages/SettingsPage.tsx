// Red Shrimp Lab — Settings Page
// 红虾俱乐部 设置页

export default function SettingsPage() {
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
      <div className="max-w-[860px] mx-auto space-y-4">
        {/* Header */}
        <div className="mb-5">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">configuration</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-1">settings</div>
        </div>

        {/* Profile */}
        <Section title="profile" color="#c0392b">
          <Row label="display name" value="Jwt2077" />
          <Row label="email" value="jwt2077@example.com" />
          <Row label="role" value="owner" dimValue />
          <RowAction label="change password" action="update →" />
        </Section>

        {/* Workspace */}
        <Section title="obsidian workspace" color="#6bc5e8">
          <Row label="vault path" value="~/JwtVault/" mono />
          <Row label="sync method" value="git (obsidian-git plugin)" />
          <Row label="auto commit" value="every 5 minutes" />
          <RowToggle label="auto push to remote" enabled={true} />
          <RowAction label="sync now" action="push ↑" />
        </Section>

        {/* LLM Providers */}
        <Section title="model providers" color="#3abfa0">
          <ProviderRow name="Anthropic Claude" keyRef="ANTHROPIC_API_KEY" connected={true}  />
          <ProviderRow name="Moonshot Kimi"    keyRef="MOONSHOT_API_KEY"  connected={false} />
          <ProviderRow name="OpenAI / Codex"   keyRef="OPENAI_API_KEY"    connected={false} />
        </Section>

        {/* Scheduler */}
        <Section title="scheduler & heartbeat" color="#6bc5e8">
          <Row label="heartbeat interval" value="30 minutes" />
          <Row label="handoff threshold" value="90% context usage" />
          <RowToggle label="enable scheduler" enabled={true} />
          <RowToggle label="auto obsidian sync cron" enabled={true} />
          <Row label="cron expression" value="*/5 * * * *" mono />
        </Section>

        {/* Notifications */}
        <Section title="notifications" color="#9a8888">
          <RowToggle label="task completed by agent" enabled={true}  />
          <RowToggle label="agent offline alert"     enabled={true}  />
          <RowToggle label="context usage warning"   enabled={true}  />
          <RowToggle label="new document created"    enabled={false} />
        </Section>

        {/* Danger zone */}
        <Section title="danger zone" color="#c0392b" danger>
          <RowAction label="clear all agent logs"    action="clear ×" danger />
          <RowAction label="reset task board"        action="reset ×" danger />
          <RowAction label="delete workspace binding"action="remove ×" danger />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, color, danger, children }: {
  title: string; color: string; danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border-[3px] border-black bg-[#191619]"
      style={{
        boxShadow: danger
          ? '4px 5px 0 rgba(0,0,0,0.85), 0 0 16px rgba(192,57,43,0.12)'
          : '4px 5px 0 rgba(0,0,0,0.85), 0 0 12px rgba(50,120,220,0.08)',
      }}
    >
      <div
        className="border-b-[3px] border-black px-4 py-2"
        style={{ background: danger ? '#3a1520' : '#1e1a20' }}
      >
        <div className="text-[13px] uppercase" style={{ color }}>
          {danger && '⚠ '}{title}
        </div>
      </div>
      <div className="divide-y-[3px] divide-black">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, mono, dimValue }: {
  label: string; value: string; mono?: boolean; dimValue?: boolean;
}) {
  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className="text-[12px] text-[#4a4048] uppercase w-[200px] shrink-0">{label}</div>
      <div
        className={`text-[13px] flex-1 ${dimValue ? 'text-[#6a5858]' : 'text-[#c8bdb8]'} ${mono ? 'text-[#3abfa0]' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

function RowToggle({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className="text-[12px] text-[#4a4048] uppercase w-[200px] shrink-0">{label}</div>
      <div className="flex-1">
        <div
          className="border-[3px] border-black w-[52px] h-[22px] relative cursor-pointer"
          style={{ background: enabled ? '#1e2e26' : '#2a2228' }}
        >
          <div
            className="absolute top-0 bottom-0 w-[20px] border-[2px] border-black"
            style={{
              left: enabled ? 28 : 0,
              background: enabled ? '#3abfa0' : '#4a4048',
              transition: 'left 0.15s',
            }}
          />
        </div>
      </div>
      <span className={`text-[11px] uppercase ${enabled ? 'text-[#3abfa0]' : 'text-[#4a4048]'}`}>
        {enabled ? 'on' : 'off'}
      </span>
    </div>
  );
}

function RowAction({ label, action, danger }: { label: string; action: string; danger?: boolean }) {
  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className="text-[12px] text-[#4a4048] uppercase w-[200px] shrink-0">{label}</div>
      <button
        className={`border-[3px] border-black text-[12px] uppercase px-4 py-1
          ${danger
            ? 'bg-[#3a1520] text-[#c0392b] hover:bg-[#c0392b] hover:text-black'
            : 'bg-[#1a2535] text-[#6bc5e8] hover:bg-[#243548]'
          } transition-colors`}
      >
        {action}
      </button>
    </div>
  );
}

function ProviderRow({ name, keyRef, connected }: { name: string; keyRef: string; connected: boolean }) {
  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className="flex-1">
        <div className="text-[13px] text-[#c8bdb8]">{name}</div>
        <div className="text-[11px] text-[#4a4048]">{keyRef}</div>
      </div>
      <div
        className="border-[3px] border-black px-3 py-1 text-[11px] uppercase"
        style={{
          background: connected ? '#1e2e26' : '#2a2228',
          color: connected ? '#3abfa0' : '#6a5858',
        }}
      >
        {connected ? '● connected' : '○ not set'}
      </div>
      <button className="border-[3px] border-black bg-[#1a2535] text-[#6bc5e8] text-[11px] uppercase px-3 py-1 hover:bg-[#243548]">
        {connected ? 'update' : 'add key'}
      </button>
    </div>
  );
}
