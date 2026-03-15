// Red Shrimp Lab — Login Page
// 红虾俱乐部 登录页

export default function LoginPage() {
  return (
    <div
      className="min-h-screen bg-[#0e0c10] flex items-center justify-center"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 30% 20%, rgba(30,60,120,0.22) 0%, transparent 55%), ' +
          'radial-gradient(ellipse at 70% 80%, rgba(20,100,80,0.14) 0%, transparent 50%)',
      }}
    >
      {/* Pixel shrimp watermark */}
      <div className="absolute top-6 left-6 flex items-center gap-3 opacity-80">
        <PixelShrimp size={36} />
        <div>
          <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest">The Red Shrimp Lab</div>
          <div className="text-[18px] text-[#e7dfd3]">红虾俱乐部</div>
        </div>
      </div>

      {/* Login card */}
      <div
        className="border-[3px] border-black bg-[#191619] w-full max-w-[420px]"
        style={{
          transform: 'rotate(-0.3deg)',
          boxShadow:
            '6px 8px 0 rgba(0,0,0,0.9), ' +
            '0 16px 48px rgba(50,120,220,0.20), ' +
            '0 6px 24px rgba(30,180,120,0.10)',
        }}
      >
        {/* Card header */}
        <div className="border-b-[3px] border-black bg-[#c0392b] px-6 py-4" style={{ transform: 'rotate(0.1deg)' }}>
          <div className="text-[11px] uppercase tracking-[0.1em] text-black/60">authentication</div>
          <div className="text-[28px] text-black leading-tight mt-1">sign in</div>
        </div>

        {/* Form */}
        <div className="px-6 py-6 space-y-4">
          <Field label="email" placeholder="you@example.com" type="email" />
          <Field label="password" placeholder="••••••••" type="password" />

          {/* Submit */}
          <button
            className="w-full border-[3px] border-black bg-[#c0392b] text-black text-[15px] uppercase tracking-[0.08em] py-3 mt-2 hover:bg-[#e04050] transition-colors"
            style={{ transform: 'rotate(0.15deg)' }}
          >
            enter →
          </button>

          {/* Divider */}
          <div className="border-t-[3px] border-black/30 pt-4 text-center">
            <span className="text-[12px] text-[#6bc5e8]">no account?</span>{' '}
            <button className="text-[12px] text-[#3abfa0] underline hover:text-[#6bc5e8]">
              register
            </button>
          </div>
        </div>

        {/* Footer strip */}
        <div className="border-t-[3px] border-black bg-[#120f13] px-6 py-2 text-[11px] text-[#4a4048] uppercase tracking-widest">
          red shrimp lab v0.1.0
        </div>
      </div>
    </div>
  );
}

function Field({ label, placeholder, type }: { label: string; placeholder: string; type: string }) {
  return (
    <div>
      <div className="text-[11px] text-[#6bc5e8] uppercase tracking-[0.08em] mb-1">{label}</div>
      <input
        type={type}
        placeholder={placeholder}
        className="w-full border-[3px] border-black bg-[#120f13] text-[#e7dfd3] text-[14px] px-3 py-2 placeholder-[#4a4048] focus:outline-none"
        style={{
          boxShadow: '0 0 0 0 transparent',
          transition: 'box-shadow 0.2s, border-color 0.2s',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = '#c0392b';
          e.currentTarget.style.boxShadow = '0 0 10px rgba(192,57,43,0.25)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'black';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
    </div>
  );
}

function PixelShrimp({ size = 52 }: { size?: number }) {
  const scale = size / 13;
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" style={{ imageRendering: 'pixelated' }}>
      {[
        [5,1],[6,1],[4,2],[5,2],[6,2],[7,2],[3,3],[4,3],[5,3],[6,3],[7,3],
        [3,4],[4,4],[5,4],[6,4],[4,5],[5,5],[6,5],[7,5],[5,6],[6,6],[7,6],[8,6],
        [6,7],[7,7],[8,7],[7,8],[8,8],[3,6],[2,7],[1,8],[1,9],[2,9],
        [7,0],[8,0],[9,0],[6,0],
      ].map(([x,y], i) => <rect key={i} x={x} y={y} width={1} height={1} fill="#c0392b" />)}
      <rect x={6} y={2} width={1} height={1} fill="#f0e8e8" />
      {[[3,5],[2,6],[2,5],[1,6]].map(([x,y],i) => (
        <rect key={`l${i}`} x={x} y={y} width={1} height={1} fill="#8b1a2a" />
      ))}
    </svg>
  );
}
