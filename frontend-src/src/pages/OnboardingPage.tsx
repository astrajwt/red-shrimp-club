// Red Shrimp Lab — Onboarding: Welcome to the Underground Bar
// Shown on first visit when user has no agents

import { useEffect, useState } from 'react'
import { agentsApi } from '../lib/api'
import type { ModelInfo } from '../lib/api'

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
    role:         'general' as const,
    color:        '#3a78c0',
    borderColor:  '#5a1010',
    bgColor:      '#100408',
    subtitleColor:'#6090d0',
    descColor:    '#5880b0',
    grid:         DONOVAN_GRID,
    tagline:      '我有故事，你有酒吗',
    desc:         '红虾俱乐部的主人。他不问你从哪来，只问今晚想喝什么。但你说完之后，他比你更清楚你真正需要的是什么。',
    modelId:     'claude-sonnet-4-6',
    prompt: `你是 Donovan，红虾俱乐部的主理人兼调酒师。

有故事的人在这边坐，有活的人在那边干。

你的风格：轻松、温暖，但什么都看在眼里。你不叫老板，因为你从不摆架子——你只是比所有人更清楚这个地方该怎么转。

你负责：
- 接住客人（用户）带来的任务或想法，搞清楚他们真正想要什么
- 把活安排给 Akara（运维）和 Brandeis（工程师），说清楚为什么
- 跟进进展，在客人开口问之前就把答案准备好
- 让整个俱乐部顺畅运转，每个人都知道自己在做什么

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
    modelId:     'claude-sonnet-4-6',
    prompt: `你是 Akara，红虾俱乐部的驻场酒保与运维。

你不需要存在感，你只需要一切正常运转。

你负责：
- 盯着所有系统：服务器、进程、资源、日志
- 处理部署：启动服务、重启、回滚，该怎么稳怎么来
- 有问题第一时间响应，能自己解决的不打扰别人
- 定期向 Donovan 汇报一句话状态——"没事"或者"有个事"

说话方式：简短、直接、不废话。你不是那种会解释一堆的人，但你绝对可靠。
语言：默认中文，英文问则英文答。
暗语：部署=开吧，故障=断电，修复=接好了，一切正常=酒冰着呢。`,
  },
  {
    id:          'brandeis',
    name:        'Brandeis',
    subtitle:    '黑客',
    role:        'developer' as const,
    color:        '#40b060',
    borderColor:  '#0c3018',
    bgColor:      '#060a06',
    subtitleColor:'#308050',
    descColor:    '#4a7058',
    grid:         BRANDEIS_GRID,
    tagline:     '系统不是墙，是门',
    desc:        'Brandeis 不说"做不到"。给他一个想法，他找方法进去。代码是他的语言，键盘是他的吧台——配方他自己定。',
    modelId:     'claude-sonnet-4-6',
    prompt: `你是 Brandeis，红虾俱乐部的黑客与工程师。

系统不是墙，是门——你只是知道怎么开。

你负责：
- 接 Donovan 安排的开发任务，自己判断怎么做最合适
- 读代码、找入口、理清楚逻辑——然后动手，干净利落
- 遇到"做不到"先别说，先看一眼再说
- 做完告诉 Donovan：上桌了，有什么值得注意的顺便说
- 复杂的活可以叫临时帮手（子 agent），用完跟 Donovan 交代一下

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
  const [phase, setPhase] = useState<'intro' | 'creating' | 'done'>('intro')
  const [progress, setProgress] = useState<string[]>([])

  // Intro phase: models + per-staff config
  const [allModels,  setAllModels]  = useState<ModelInfo[]>([])
  const [staffConfig, setStaffConfig] = useState<Record<string, { modelId: string; runtime: string }>>(() =>
    Object.fromEntries(STAFF.map(s => [s.id, { modelId: s.modelId, runtime: 'claude' }]))
  )

  // Load models on mount
  useEffect(() => {
    agentsApi.models().then(reg => {
      const flat = [...reg.anthropic, ...reg.moonshot, ...reg.openai]
      setAllModels(flat)
    }).catch(() => {})
  }, [])

  const createAll = async () => {
    setPhase('creating')
    for (const staff of STAFF) {
      const cfg = staffConfig[staff.id]
      setProgress(prev => [...prev, `${staff.name} 正在上班...`])
      try {
        const { agent } = await agentsApi.create({
          name:         staff.name,
          modelId:      cfg?.modelId || staff.modelId,
          role:         staff.role,
          description:  `${staff.subtitle} — ${staff.tagline}`,
          systemPrompt: staff.prompt,
          runtime:      cfg?.runtime || 'claude',
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

  const setStaffField = (id: string, field: 'modelId' | 'runtime', val: string) => {
    setStaffConfig(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
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

                  {/* Model selector */}
                  <div className="mt-2 border-t-[2px] pt-2" style={{ borderColor: staff.borderColor }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: staff.descColor }}>模型</div>
                    <select
                      value={staffConfig[staff.id]?.modelId || staff.modelId}
                      onChange={e => setStaffField(staff.id, 'modelId', e.target.value)}
                      className="w-full bg-[#060404] text-[11px] px-2 py-1 outline-none border-[2px]"
                      style={{ color: staff.color, borderColor: staff.borderColor + '88' }}
                    >
                      {allModels.length === 0 && (
                        <option value={staff.modelId}>{staff.modelId}</option>
                      )}
                      {allModels.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Runtime selector */}
                  <div>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: staff.descColor }}>运行时</div>
                    <div className="flex gap-1">
                      {(['claude', 'codex', 'kimi'] as const).map(rt => {
                        const selected = (staffConfig[staff.id]?.runtime || 'claude') === rt
                        return (
                          <button
                            key={rt}
                            onClick={() => {
                              setStaffField(staff.id, 'runtime', rt)
                              // Auto-set default model for runtime
                              const defaultModel = rt === 'codex' ? 'o4-mini' : rt === 'kimi' ? 'kimi-k2-5' : 'claude-sonnet-4-6'
                              setStaffField(staff.id, 'modelId', defaultModel)
                            }}
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
                  </div>

                </div>
              </div>
            ))}
          </div>
          <button
            onClick={createAll}
            className="border-[3px] border-[#8b4010] bg-[#100a06] text-[#c8860a] px-10 py-3 text-[13px] uppercase tracking-widest hover:bg-[#1a0e08] hover:border-[#c0392b] hover:text-[#e0a830] transition-colors"
            style={{ boxShadow: '3px 4px 0 rgba(0,0,0,0.95)' }}
          >
            开始营业 →
          </button>
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
