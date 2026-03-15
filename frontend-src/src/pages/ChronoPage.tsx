import { CronSection } from './SettingsPage'

export default function ChronoPage() {
  return (
    <div
      className="h-full overflow-auto bg-[#0e0c10] text-[#e7dfd3] px-6 py-5"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 20% 0%, rgba(30,60,120,0.18) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 80% 100%, rgba(20,100,80,0.12) 0%, transparent 50%)',
      }}
    >
      <div className="max-w-[900px] mx-auto">
        <div className="mb-6">
          <div className="text-[11px] text-[#6bc5e8] uppercase tracking-widest mb-1">scheduler</div>
          <div className="text-[32px] leading-none border-b-[3px] border-[#c0392b] pb-2">chrono</div>
        </div>

        <CronSection />
      </div>
    </div>
  )
}
