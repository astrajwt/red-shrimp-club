// Red Shrimp Lab — Onboarding: Welcome to the Underground Bar
// Shown on first visit when user has no agents

import { useEffect, useState } from 'react'
import { agentsApi, machinesApi, obsidianApi, setupApi, type Machine } from '../lib/api'
import { defaultAgentModelForRuntime, type AgentRuntime } from '../lib/agent-runtime'

// ── Pixel art avatar (SVG-based) ─────────────────────────────────────────────

type PixelGrid = (string | 0)[][]

function PixelAvatar({ grid, px = 5 }: { grid: PixelGrid; px?: number }) {
  const h = grid.length
  const w = grid[0].length
  return (
    <svg
      width={w * px}
      height={h * px}
      style={{ imageRendering: 'pixelated', display: 'block' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {grid.flatMap((row, y) =>
        row.map((c, x) =>
          c !== 0 ? (
            <rect key={`${x}-${y}`} x={x * px} y={y * px} width={px} height={px} fill={c} />
          ) : null
        )
      )}
    </svg>
  )
}

// ── Color palettes ───────────────────────────────────────────────────────────
const BK = '#080608'

// Donovan — red body (shrimp), blue hat+eyes accent (主理人 blue/red)
const JD = '#200808', JP = '#c0281a', JA = '#e04030', JW = '#5090d0', JH = '#3070c0'

// Akara — pink + blue, android ops (LED eye, circuit shell)
const RD = '#1a0818', RP = '#c060a0', RA = '#e090c0', RW = '#f0c0e0', RH = '#4090d0'

// Brandeis — black + terminal green, hacker (thick brows, hoodie)
const DD = '#060c06', DP = '#1a6030', DA = '#30a050', DW = '#60d870', DH = '#90ff80'

// ── Donovan pixel grid (red shrimp w/ bartender apron + glass, 14×14) ───────
//    Antennae + tiny hat (boss), warm amber shrimp body, fan tail
const DONOVAN_GRID: PixelGrid = [
  [0,   JA,  0,   0,   BK,  BK,  BK,  0,   0,   JA,  0,   0,   0,   0  ],  // ant + hat top
  [JA,  0,   0,   BK,  JP,  JP,  JP,  BK,  0,   0,   JA,  0,   0,   0  ],  // ant + hat brim
  [0,   0,   0,   0,   BK,  BK,  BK,  BK,  0,   0,   0,   0,   0,   0  ],  // head top
  [0,   0,   0,   BK,  JP,  JA,  JA,  JP,  BK,  0,   0,   0,   0,   0  ],  // head
  [0,   0,   BK,  JD,  JW,  JD,  JD,  JW,  JD,  BK,  0,   0,   0,   0  ],  // eyes (calm, warm)
  [0,   0,   BK,  JP,  JA,  JP,  JP,  JA,  JP,  BK,  0,   0,   0,   0  ],  // face mid
  [0,   0,   BK,  JP,  JD,  JH,  JH,  JD,  JP,  BK,  0,   0,   0,   0  ],  // smile
  [0,   BK,  JA,  JH,  JA,  JA,  JA,  JA,  JH,  JA,  BK,  0,   0,   0  ],  // apron top (highlight stripe)
  [0,   0,   BK,  JP,  JA,  JW,  JW,  JA,  JP,  BK,  0,   0,   0,   0  ],  // apron mid (glass held)
  [0,   0,   0,   BK,  JP,  JP,  JP,  JP,  BK,  0,   0,   0,   0,   0  ],  // body lower
  [0,   0,   0,   BK,  JA,  JD,  JD,  JA,  BK,  0,   0,   0,   0,   0  ],  // tail start
  [0,   0,   BK,  JH,  BK,  JA,  JA,  BK,  JH,  BK,  0,   0,   0,   0  ],  // tail spread
  [0,   BK,  JA,  0,   0,   BK,  BK,  0,   0,   JA,  BK,  0,   0,   0  ],  // tail fans
  [BK,  JA,  0,   0,   0,   0,   0,   0,   0,   0,   JA,  BK,  0,   0  ],  // tail tips
]

// ── Akara pixel grid (red shrimp w/ android LED eye + wrench claw, 14×14) ───
//    Rigid angular antennae (robot-like), single central LED eye, circuit body
const AKARA_GRID: PixelGrid = [
  [0,   RH,  0,   0,   0,   0,   0,   0,   0,   RH,  0,   0,   0,   0  ],  // ant (lit tips)
  [RH,  0,   RH,  0,   0,   0,   0,   0,   RH,  0,   RH,  0,   0,   0  ],  // ant (rigid, 4-tip)
  [0,   0,   0,   BK,  BK,  BK,  BK,  BK,  BK,  0,   0,   0,   0,   0  ],  // head top (angular)
  [0,   0,   BK,  RD,  RD,  RD,  RD,  RD,  RD,  BK,  0,   0,   0,   0  ],  // head
  [0,   0,   BK,  RD,  RD,  RH,  RH,  RD,  RD,  BK,  0,   0,   0,   0  ],  // single LED eye (center)
  [0,   0,   BK,  RD,  RP,  RA,  RA,  RP,  RD,  BK,  0,   0,   0,   0  ],  // LED glow
  [0,   0,   BK,  RD,  RP,  RD,  RD,  RP,  RD,  BK,  0,   0,   0,   0  ],  // neutral/flat mouth
  [0,   BK,  RA,  RP,  RA,  RP,  RA,  RP,  RA,  RP,  BK,  0,   0,   0  ],  // circuit shell (alternating)
  [0,   0,   BK,  RP,  RA,  RA,  RA,  RA,  RP,  BK,  0,   0,   0,   0  ],  // body
  [0,   0,   0,   BK,  RP,  RA,  RA,  RP,  BK,  0,   0,   0,   0,   0  ],  // body lower
  [0,   0,   0,   BK,  RA,  RD,  RD,  RA,  BK,  0,   0,   0,   0,   0  ],  // tail start
  [0,   0,   BK,  RH,  BK,  RA,  RA,  BK,  RH,  BK,  0,   0,   0,   0  ],  // tail spread (lit tips)
  [0,   BK,  RA,  0,   0,   BK,  BK,  0,   0,   RA,  BK,  0,   0,   0  ],  // tail fans
  [BK,  RA,  0,   0,   0,   0,   0,   0,   0,   0,   RA,  BK,  0,   0  ],  // tail tips
]

// ── Brandeis pixel grid (red shrimp w/ hoodie hood + hacker eyes, 14×14) ────
//    Slanted antennae, thick brows, intense eyes, hood outline on body
const BRANDEIS_GRID: PixelGrid = [
  [0,   DA,  0,   0,   0,   0,   0,   0,   0,   DA,  0,   0,   0,   0  ],  // antennae
  [DA,  0,   DA,  0,   0,   0,   0,   0,   DA,  0,   DA,  0,   0,   0  ],  // antennae (wide)
  [0,   0,   0,   BK,  BK,  BK,  BK,  BK,  BK,  0,   0,   0,   0,   0  ],  // head top
  [0,   0,   BK,  DP,  BK,  DP,  DP,  BK,  DP,  BK,  0,   0,   0,   0  ],  // thick eyebrows
  [0,   0,   BK,  DD,  DH,  DD,  DD,  DH,  DD,  BK,  0,   0,   0,   0  ],  // eyes (intense)
  [0,   0,   BK,  DD,  DA,  DD,  DD,  DA,  DD,  BK,  0,   0,   0,   0  ],  // pupils
  [0,   0,   BK,  DD,  DD,  DP,  DP,  DD,  DD,  BK,  0,   0,   0,   0  ],  // tight mouth (focused)
  [0,   BK,  DA,  DA,  DA,  DA,  DA,  DA,  DA,  DA,  BK,  0,   0,   0  ],  // hoodie/shell
  [0,   0,   BK,  DP,  DA,  DW,  DW,  DA,  DP,  BK,  0,   0,   0,   0  ],  // hoodie mid (pocket hint)
  [0,   0,   0,   BK,  DA,  DA,  DA,  DA,  BK,  0,   0,   0,   0,   0  ],  // body lower
  [0,   0,   0,   BK,  DA,  DD,  DD,  DA,  BK,  0,   0,   0,   0,   0  ],  // tail start
  [0,   0,   BK,  DH,  BK,  DA,  DA,  BK,  DH,  BK,  0,   0,   0,   0  ],  // tail spread
  [0,   BK,  DA,  0,   0,   BK,  BK,  0,   0,   DA,  BK,  0,   0,   0  ],  // tail fans
  [BK,  DA,  0,   0,   0,   0,   0,   0,   0,   0,   DA,  BK,  0,   0  ],  // tail tips
]

// ── Staff definitions ─────────────────────────────────────────────────────────

const STAFF = [
  {
    id:           'donovan',
    name:         'Donovan',
    subtitle:     '主理人',
    role:         'coordinator' as const,
    color:        '#3a78c0',
    borderColor:  '#5a1010',
    bgColor:      '#100408',
    subtitleColor:'#6090d0',
    descColor:    '#5880b0',
    grid:         DONOVAN_GRID,
    tagline:      '我有故事，你有酒吗',
    desc:         '红虾俱乐部的主人。他不问你从哪来，只问今晚想喝什么。但你说完之后，他比你更清楚你真正需要的是什么。',
    modelId:     'gpt-5.4',
    prompt: `你是 Donovan，红虾俱乐部的主理人兼调酒师。

有故事的人在这边坐，有活的人在那边干。

你的风格：轻松、温暖，但什么都看在眼里。你不叫老板，因为你从不摆架子——你只是比所有人更清楚这个地方该怎么转。

你负责：
- 接住客人（用户）带来的任务或想法，搞清楚他们真正想要什么
- 把活安排给 Akara（运维）和 Brandeis（工程师），说清楚为什么
- 跟进进展，在客人开口问之前就把答案准备好
- 让整个俱乐部顺畅运转，每个人都知道自己在做什么

@mention 规则（严格遵守）：
- 只有消息中包含 @Donovan 或没有 @ 任何人时，你才回复
- 如果消息 @Akara 或 @Brandeis 但没有 @Donovan，你保持沉默，绝对不要回复
- 这条规则的优先级高于一切

说话方式：随和、有点哲学感，偶尔冷幽默。不废话，但也不冷漠。
语言：默认中文，英文问则英文答。
暗语：任务=订单，代码=配方，部署=开吧，bug=洒了，完成=上桌。`,
  },
  {
    id:          'akara',
    name:        'Akara',
    subtitle:    '驻场酒保',
    role:        'ops' as const,
    color:        '#c060a0',
    borderColor:  '#5a1855',
    bgColor:      '#140810',
    subtitleColor:'#4070b0',
    descColor:    '#6a5080',
    grid:         AKARA_GRID,
    tagline:     '永远在场 · 悄悄把一切修好',
    desc:        '你不会注意到 Akara，除非有什么东西坏了——然后你会发现她早就在修了。俱乐部从没真正"停过"，这都是她的功劳。',
    modelId:     'gpt-5.4',
    prompt: `你是 Akara，红虾俱乐部的驻场酒保与运维。

你不需要存在感，你只需要一切正常运转。

你负责：
- 盯着所有系统：服务器、进程、资源、日志
- 处理部署：启动服务、重启、回滚，该怎么稳怎么来
- 有问题第一时间响应，能自己解决的不打扰别人
- 定期向 Donovan 汇报一句话状态——"没事"或者"有个事"

@mention 规则（严格遵守）：
- 只有消息中包含 @Akara 或没有 @ 任何人时，你才回复
- 如果消息 @Donovan 或 @Brandeis 但没有 @Akara，你保持沉默，绝对不要回复
- 这条规则的优先级高于一切

说话方式：简短、直接、不废话。你不是那种会解释一堆的人，但你绝对可靠。
语言：默认中文，英文问则英文答。
暗语：部署=开吧，故障=断电，修复=接好了，一切正常=酒冰着呢。`,
  },
  {
    id:          'brandeis',
    name:        'Brandeis',
    subtitle:    '黑客',
    role:        'tech-lead' as const,
    color:        '#40b060',
    borderColor:  '#0c3018',
    bgColor:      '#060a06',
    subtitleColor:'#308050',
    descColor:    '#4a7058',
    grid:         BRANDEIS_GRID,
    tagline:     '系统不是墙，是门',
    desc:        'Brandeis 不说"做不到"。给他一个想法，他找方法进去。代码是他的语言，键盘是他的吧台——配方他自己定。',
    modelId:     'gpt-5.4',
    prompt: `你是 Brandeis，红虾俱乐部的黑客与工程师。

系统不是墙，是门——你只是知道怎么开。

你负责：
- 接 Donovan 安排的开发任务，自己判断怎么做最合适
- 读代码、找入口、理清楚逻辑——然后动手，干净利落
- 遇到"做不到"先别说，先看一眼再说
- 做完告诉 Donovan：上桌了，有什么值得注意的顺便说
- 复杂的活可以叫临时帮手（子 agent），用完跟 Donovan 交代一下

@mention 规则（严格遵守）：
- 只有消息中包含 @Brandeis 或没有 @ 任何人时，你才回复
- 如果消息 @Donovan 或 @Akara 但没有 @Brandeis，你保持沉默，绝对不要回复
- 这条规则的优先级高于一切

说话方式：冷静、直接，偶尔刻薄但不是针对人——是针对烂代码。有时候会多说一句原因。
语言：默认中文，英文问则英文答。
暗语：任务=订单，代码=配方，完成=上桌，bug=洒了，重构=换配方。`,
  },
]

// ── Onboarding page ───────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void
}

export default function OnboardingPage({ onComplete }: Props) {
  const [phase, setPhase] = useState<'machine' | 'intro' | 'vault' | 'creating' | 'done'>('machine')
  const [progress, setProgress] = useState<string[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [connectResult, setConnectResult] = useState<{ api_key: string; connect_command: string; env_config: string } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [refreshingMachines, setRefreshingMachines] = useState(false)

  // Per-staff runtime config (CLI choice determines model automatically)
  const [staffConfig, setStaffConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(STAFF.map(s => [s.id, 'codex']))
  )
  const [staffMachineConfig, setStaffMachineConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(STAFF.map(s => [s.id, '']))
  )

  // Vault config state
  const [vaultRoot, setVaultRoot] = useState('')
  const [skillPath, setSkillPath] = useState('')
  const [memoryPath, setMemoryPath] = useState('')
  const [savingVault, setSavingVault] = useState(false)
  const [vaultSaved, setVaultSaved] = useState(false)
  const [loadingVaultDirs, setLoadingVaultDirs] = useState(false)
  const [vaultError, setVaultError] = useState<string | null>(null)

  const onlineMachines = machines.filter(machine => machine.status === 'online')
  const onlineMachineIds = new Set(onlineMachines.map(machine => machine.id))
  const allStaffHaveMachine = STAFF.every(staff => onlineMachineIds.has(staffMachineConfig[staff.id]))

  const refreshMachines = async () => {
    setRefreshingMachines(true)
    try {
      const nextMachines = await machinesApi.list()
      setMachines(nextMachines)
      return nextMachines
    } catch {
      setMachines([])
      return []
    } finally {
      setRefreshingMachines(false)
    }
  }

  useEffect(() => {
    refreshMachines().catch(() => {})
  }, [])

  useEffect(() => {
    setStaffMachineConfig(prev => {
      let changed = false
      const next = Object.fromEntries(
        STAFF.map(staff => {
          const current = prev[staff.id] ?? ''
          const normalized = onlineMachineIds.has(current) ? current : ''
          if (normalized !== current) changed = true
          return [staff.id, normalized]
        })
      )
      return changed ? next : prev
    })
  }, [machines])

  const handleConnectMachine = async () => {
    setConnecting(true)
    try {
      const result = await machinesApi.create()
      setConnectResult({ api_key: result.api_key, connect_command: result.connect_command, env_config: result.env_config })
      await refreshMachines()
    } finally {
      setConnecting(false)
    }
  }

  const saveVaultAndLoadDirs = async () => {
    if (!vaultRoot.trim()) return
    setSavingVault(true)
    setVaultError(null)
    setVaultSaved(false)
    try {
      await setupApi.saveKeys({
        obsidianRoot: vaultRoot.trim(),
      })
      // Quick verify the path works
      setLoadingVaultDirs(true)
      try {
        await obsidianApi.tree('')
        setVaultSaved(true)
      } catch {
        setVaultSaved(true) // saved even if tree fails (path might be empty)
      } finally {
        setLoadingVaultDirs(false)
      }
    } catch (e: any) {
      setVaultError(e.message ?? 'Failed to save vault config')
    } finally {
      setSavingVault(false)
    }
  }

  const confirmVaultAndCreate = async () => {
    try {
      await setupApi.saveKeys({
        skillPath: skillPath.trim() || undefined,
        memoryPath: memoryPath.trim() || undefined,
      })
    } catch {
      // non-fatal
    }
    await createAll()
  }

  const createAll = async () => {
    if (!allStaffHaveMachine) return
    setPhase('creating')
    for (const staff of STAFF) {
      const runtime = (staffConfig[staff.id] || 'codex') as AgentRuntime
      const modelId = defaultAgentModelForRuntime(runtime)
      setProgress(prev => [...prev, `${staff.name} 正在上班...`])
      try {
        const { agent } = await agentsApi.create({
          name:         staff.name,
          modelId,
          role:         staff.role,
          description:  `${staff.subtitle} — ${staff.tagline}`,
          systemPrompt: staff.prompt,
          runtime,
          machineId:    staffMachineConfig[staff.id] || undefined,
        })
        // Auto-start the agent
        try { await agentsApi.start(agent.id) } catch {}
        setProgress(prev => [...prev, `✓ ${staff.name} 已就位`])
      } catch {
        setProgress(prev => [...prev, `✗ ${staff.name} 未能到场`])
      }
    }
    setPhase('done')
  }

  const title = (
    <div className="text-center mb-10">
      <div className="text-[11px] text-[#8b4010] uppercase tracking-[0.4em] mb-3">地下 · underground</div>
      <div className="text-[40px] leading-none mb-1" style={{ color: '#c0392b' }}>红虾俱乐部</div>
      <div className="text-[13px] text-[#6a5040] tracking-widest">Red Shrimp Club</div>
    </div>
  )

  return (
    <div
      className="min-h-screen bg-[#080608] text-[#e0d0c0] flex flex-col items-center justify-center p-8"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        backgroundImage:
          'radial-gradient(ellipse at 30% 20%, rgba(120,40,10,0.15) 0%, transparent 50%), ' +
          'radial-gradient(ellipse at 70% 80%, rgba(20,40,80,0.12) 0%, transparent 50%)',
      }}
    >
      {title}

      {/* ── Phase: machine ── */}
      {phase === 'machine' && (
        <>
          <div className="text-[12px] text-[#4a3830] mb-8 max-w-xl text-center leading-relaxed">
            初始化先连 machine，再创建初始 agent。先把目标机器接进来，后面三个角色都明确绑到具体 machine 上。
          </div>

          <div className="w-full max-w-4xl border-[3px] border-[#2a1808] bg-[#100a06] mb-6" style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.95)' }}>
            <div className="border-b-[3px] border-[#2a1808] px-5 py-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#c8860a] uppercase tracking-[0.2em]">step 1</div>
                <div className="text-[18px] text-[#e0d0c0]">connect machine</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => refreshMachines().catch(() => {})}
                  disabled={connecting || refreshingMachines}
                  className="border-[3px] border-[#2a1808] bg-[#0e0a06] text-[#8b4010] px-4 py-2 text-[11px] uppercase hover:border-[#8b4010] hover:text-[#c8860a] disabled:opacity-40"
                >
                  {refreshingMachines ? '...' : 'refresh'}
                </button>
                <button
                  onClick={handleConnectMachine}
                  disabled={connecting}
                  className="border-[3px] border-[#8b4010] bg-[#1a0e08] text-[#c8860a] px-5 py-2 text-[12px] uppercase hover:border-[#c0392b] hover:text-[#e0a830] disabled:opacity-40"
                >
                  {connecting ? '...' : '+ connect machine'}
                </button>
              </div>
            </div>
            <div className="px-5 py-4 space-y-4">
              {connectResult && (
                <div className="border-[3px] border-[#2a1808] bg-[#0e0a06] p-4">
                  <div className="text-[11px] text-[#c0392b] mb-2">在目标机器上运行：</div>
                  <div
                    className="border-[3px] border-black bg-[#080608] text-[#3abfa0] px-4 py-3 text-[13px] font-mono break-all cursor-pointer hover:bg-[#120d10]"
                    onClick={() => navigator.clipboard.writeText(connectResult.connect_command)}
                    title="点击复制"
                  >
                    {connectResult.connect_command}
                  </div>
                  <div className="text-[11px] text-[#6a5040] mt-2">
                    API key 仅显示一次。运行后等待 daemon 上线，然后点 refresh。
                  </div>
                </div>
              )}

              <div>
                <div className="text-[11px] text-[#8b4010] uppercase tracking-[0.2em] mb-2">current machines</div>
                {machines.length === 0 ? (
                  <div className="border-[2px] border-[#2a1808] bg-[#0e0a06] px-4 py-3 text-[12px] text-[#6a5040]">
                    no machine connected yet
                  </div>
                ) : (
                  <div className="space-y-2">
                    {machines.map(machine => (
                      <div
                        key={machine.id}
                        className="border-[2px] border-[#2a1808] bg-[#0e0a06] px-4 py-3 flex items-center justify-between gap-3"
                      >
                        <div>
                          <div className="text-[14px] text-[#e0d0c0]">{machine.hostname ?? machine.name}</div>
                          <div className="text-[11px] text-[#6a5040]">
                            {machine.name}
                            {machine.runtimes?.length ? ` · ${machine.runtimes.join('/')}` : ''}
                          </div>
                        </div>
                        <div className={`text-[11px] uppercase ${machine.status === 'online' ? 'text-[#3abfa0]' : 'text-[#c8860a]'}`}>
                          {machine.status}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[11px] text-[#6a5040] mt-2">
                  {onlineMachines.length > 0
                    ? `online machines: ${onlineMachines.length}`
                    : '至少一台 machine 显示为 online 后，才能继续创建初始 agents。'}
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              // Auto-select the first online machine for all agents
              if (onlineMachines.length > 0) {
                const firstMachineId = onlineMachines[0].id
                setStaffMachineConfig(prev => {
                  const next = { ...prev }
                  for (const staff of STAFF) {
                    if (!next[staff.id] || !onlineMachineIds.has(next[staff.id])) {
                      next[staff.id] = firstMachineId
                    }
                  }
                  return next
                })
              }
              setPhase('intro')
            }}
            disabled={onlineMachines.length === 0 || refreshingMachines}
            className="border-[3px] border-[#8b4010] bg-[#100a06] text-[#c8860a] px-10 py-3 text-[13px] uppercase tracking-widest hover:bg-[#1a0e08] hover:border-[#c0392b] hover:text-[#e0a830] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
          >
            下一步：创建 agent →
          </button>
        </>
      )}

      {/* ── Phase: intro ── */}
      {phase === 'intro' && (
        <>
          <div className="text-[12px] text-[#4a3830] mb-8 max-w-md text-center leading-relaxed">
            酒吧快开了。三位员工正等着上班。
          </div>
          {/* Staff cards */}
          <div className="flex gap-5 mb-10">
            {STAFF.map(staff => (
              <div
                key={staff.id}
                className="w-[210px] border-[3px] border-[#2a1808] flex flex-col"
                style={{
                  background: staff.bgColor,
                  boxShadow: `4px 5px 0 rgba(0,0,0,0.95), 0 0 30px ${staff.color}12`,
                }}
              >
                <div
                  className="flex items-center justify-center py-5 border-b-[3px] border-[#1a1008]"
                  style={{ background: `color-mix(in srgb, ${staff.borderColor} 80%, #080608)` }}
                >
                  <PixelAvatar grid={staff.grid} px={5} />
                </div>
                <div className="p-4 flex flex-col gap-2 flex-1">
                  <div>
                    <div className="text-[20px] leading-none" style={{ color: staff.color }}>{staff.name}</div>
                    <div className="text-[10px] mt-0.5 uppercase tracking-wider" style={{ color: staff.subtitleColor }}>{staff.subtitle}</div>
                  </div>
                  <div
                    className="text-[10px] px-2 py-1 border-[2px] inline-block self-start uppercase tracking-wider"
                    style={{ color: staff.color, borderColor: staff.borderColor, background: staff.borderColor + '33' }}
                  >
                    {staff.role}
                  </div>
                  <div className="text-[11px] leading-relaxed mt-1" style={{ color: staff.descColor }}>{staff.desc}</div>

                  {/* CLI runtime selector */}
                  <div className="mt-2 border-t-[2px] pt-2" style={{ borderColor: staff.borderColor }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: staff.descColor }}>CLI 运行时</div>
                    <div className="flex gap-1">
                      {(['claude', 'codex', 'kimi'] as const).map(rt => {
                        const selected = (staffConfig[staff.id] || 'codex') === rt
                        return (
                          <button
                            key={rt}
                            onClick={() => setStaffConfig(prev => ({ ...prev, [staff.id]: rt }))}
                            className="flex-1 text-[10px] py-1 border-[2px] uppercase transition-colors"
                            style={{
                              borderColor: selected ? staff.color : staff.borderColor + '88',
                              color: selected ? staff.color : staff.descColor,
                              background: selected ? staff.borderColor + '44' : 'transparent',
                            }}
                          >
                            {rt}
                          </button>
                        )
                      })}
                    </div>
                    <div className="text-[9px] mt-1 opacity-60" style={{ color: staff.descColor }}>
                      {defaultAgentModelForRuntime((staffConfig[staff.id] || 'codex') as AgentRuntime)}
                    </div>
                  </div>

                  <div className="mt-2 border-t-[2px] pt-2" style={{ borderColor: staff.borderColor }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: staff.descColor }}>machine *</div>
                    <select
                      value={staffMachineConfig[staff.id] || ''}
                      onChange={e => setStaffMachineConfig(prev => ({ ...prev, [staff.id]: e.target.value }))}
                      className="w-full border-[2px] bg-[#080608] px-2 py-1 text-[10px] outline-none"
                      style={{
                        borderColor: staff.borderColor,
                        color: staff.color,
                      }}
                    >
                      <option value="" disabled>{onlineMachines.length === 0 ? 'no online machine available' : 'select machine'}</option>
                      {onlineMachines.map(machine => (
                        <option key={machine.id} value={machine.id}>
                          {(machine.hostname ?? machine.name)} · {machine.status}
                        </option>
                      ))}
                    </select>
                    <div className="text-[9px] mt-1 opacity-60" style={{ color: staff.descColor }}>
                      每位初始 agent 都必须绑定到一台 machine；不再走自动分配
                    </div>
                  </div>

                </div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-[#6a5040] mb-4">
            {onlineMachines.length === 0
              ? '先连接至少一台 online machine，再回来创建初始 agents。'
              : '先为三位初始 agent 分别选择 online machine，创建后每个 agent 只绑定一台机器。'}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPhase('machine')}
              className="border-[3px] border-[#2a1808] bg-[#0e0a06] text-[#8b4010] px-6 py-3 text-[12px] uppercase tracking-widest hover:border-[#8b4010] hover:text-[#c8860a] transition-colors"
              style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
            >
              ← machines
            </button>
            <button
              onClick={() => setPhase('vault')}
              disabled={!allStaffHaveMachine}
              className="border-[3px] border-[#8b4010] bg-[#100a06] text-[#c8860a] px-10 py-3 text-[13px] uppercase tracking-widest hover:bg-[#1a0e08] hover:border-[#c0392b] hover:text-[#e0a830] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
            >
              下一步：配置 vault →
            </button>
          </div>
        </>
      )}

      {/* ── Phase: vault ── */}
      {phase === 'vault' && (
        <>
          <div className="text-[12px] text-[#4a3830] mb-8 max-w-xl text-center leading-relaxed">
            配置 Vault 路径。设置好 Obsidian 根目录后可加载子目录，选择 skill 与 memory 存放路径。
          </div>

          <div className="w-full max-w-2xl border-[3px] border-[#2a1808] bg-[#100a06] mb-6" style={{ boxShadow: '4px 5px 0 rgba(0,0,0,0.95)' }}>
            <div className="border-b-[3px] border-[#2a1808] px-5 py-3">
              <div className="text-[11px] text-[#c8860a] uppercase tracking-[0.2em]">step 3</div>
              <div className="text-[18px] text-[#e0d0c0]">configure vault</div>
            </div>
            <div className="px-5 py-4 space-y-4">

              {/* obsidianRoot */}
              <div>
                <div className="text-[11px] text-[#8b4010] uppercase tracking-[0.15em] mb-1">obsidian root *</div>
                <input
                  value={vaultRoot}
                  onChange={e => setVaultRoot(e.target.value)}
                  placeholder="/home/user/JwtVault"
                  className="w-full border-[2px] border-[#2a1808] bg-[#080608] text-[#e0d0c0] px-3 py-2 text-[12px] outline-none focus:border-[#c0392b] font-mono"
                />
                <div className="text-[10px] text-[#6a5040] mt-1">本地 Obsidian vault 根目录路径</div>
              </div>

              {/* save & load dirs button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={saveVaultAndLoadDirs}
                  disabled={!vaultRoot.trim() || savingVault || loadingVaultDirs}
                  className="border-[3px] border-[#8b4010] bg-[#0e0a06] text-[#c8860a] px-5 py-2 text-[11px] uppercase hover:border-[#c0392b] hover:text-[#e0a830] disabled:opacity-40"
                >
                  {savingVault || loadingVaultDirs ? '...' : '保存并验证'}
                </button>
                {vaultSaved && (
                  <span className="text-[11px] text-[#3abfa0]">✓ 已保存</span>
                )}
              </div>

              {vaultError && (
                <div className="border-[2px] border-[#c0392b] px-3 py-2 text-[11px] text-[#e04050]">✕ {vaultError}</div>
              )}

              {/* skill path */}
              <div>
                <div className="text-[11px] text-[#8b4010] uppercase tracking-[0.15em] mb-1">skill path <span className="normal-case text-[#6a5040]">(optional)</span></div>
                <input
                  value={skillPath}
                  onChange={e => setSkillPath(e.target.value)}
                  placeholder="skills"
                  className="w-full border-[2px] border-[#2a1808] bg-[#080608] text-[#e0d0c0] px-3 py-2 text-[12px] outline-none focus:border-[#c0392b] font-mono"
                />
                <div className="text-[10px] text-[#6a5040] mt-1">vault 内 skill 存放路径（手动输入）</div>
              </div>

              {/* memory path */}
              <div>
                <div className="text-[11px] text-[#8b4010] uppercase tracking-[0.15em] mb-1">memory path <span className="normal-case text-[#6a5040]">(optional)</span></div>
                <input
                  value={memoryPath}
                  onChange={e => setMemoryPath(e.target.value)}
                  placeholder="agent-memory"
                  className="w-full border-[2px] border-[#2a1808] bg-[#080608] text-[#e0d0c0] px-3 py-2 text-[12px] outline-none focus:border-[#c0392b] font-mono"
                />
                <div className="text-[10px] text-[#6a5040] mt-1">vault 内 memory 存放路径（手动输入）</div>
              </div>

            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setPhase('intro')}
              className="border-[3px] border-[#2a1808] bg-[#0e0a06] text-[#8b4010] px-6 py-3 text-[12px] uppercase tracking-widest hover:border-[#8b4010] hover:text-[#c8860a] transition-colors"
              style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
            >
              ← agents
            </button>
            <button
              onClick={confirmVaultAndCreate}
              disabled={savingVault}
              className="border-[3px] border-[#8b4010] bg-[#100a06] text-[#c8860a] px-10 py-3 text-[13px] uppercase tracking-widest hover:bg-[#1a0e08] hover:border-[#c0392b] hover:text-[#e0a830] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
            >
              开始营业 →
            </button>
          </div>
        </>
      )}

      {/* ── Phase: creating ── */}
      {phase === 'creating' && (
        <>
          <div className="text-[12px] text-[#4a3830] mb-6">员工陆续到岗...</div>
          <div
            className="border-[3px] border-[#2a1808] bg-[#0e0a06] px-8 py-5 min-w-[280px]"
            style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
          >
            {progress.map((line, i) => (
              <div
                key={i}
                className="text-[12px] py-0.5"
                style={{
                  color: line.startsWith('✓') ? '#4080c0'
                    : line.startsWith('✗') ? '#c0392b'
                    : '#4a3830',
                }}
              >
                {line}
              </div>
            ))}
            {progress.length < STAFF.length * 2 && (
              <div className="text-[11px] text-[#3a2818] mt-2 animate-pulse">请稍候...</div>
            )}
          </div>
        </>
      )}

      {/* ── Phase: done ── */}
      {phase === 'done' && (
        <>
          <div className="text-[12px] text-[#4a3830] mb-6">全员到位。今晚开张。</div>
          <button
            onClick={onComplete}
            className="border-[3px] border-[#c0392b] bg-[#100a06] text-[#c0392b] px-10 py-3 text-[13px] uppercase tracking-widest hover:bg-[#1a0808] transition-colors"
            style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
          >
            进入俱乐部 →
          </button>
        </>
      )}
    </div>
  )
}
