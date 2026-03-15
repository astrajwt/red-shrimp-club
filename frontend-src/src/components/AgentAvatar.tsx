import type { CSSProperties } from 'react'

type PixelGrid = (string | 0)[][]

const BK = '#080608'

const JD = '#200808', JP = '#c0281a', JA = '#e04030', JW = '#5090d0', JH = '#3070c0'
const RD = '#1a0818', RP = '#c060a0', RA = '#e090c0', RH = '#4090d0'
const DD = '#060c06', DP = '#1a6030', DA = '#30a050', DW = '#60d870', DH = '#90ff80'

const DONOVAN_GRID: PixelGrid = [
  [0, JA, 0, 0, BK, BK, BK, 0, 0, JA, 0, 0, 0, 0],
  [JA, 0, 0, BK, JP, JP, JP, BK, 0, 0, JA, 0, 0, 0],
  [0, 0, 0, 0, BK, BK, BK, BK, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, BK, JP, JA, JA, JP, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, JD, JW, JD, JD, JW, JD, BK, 0, 0, 0, 0],
  [0, 0, BK, JP, JA, JP, JP, JA, JP, BK, 0, 0, 0, 0],
  [0, 0, BK, JP, JD, JH, JH, JD, JP, BK, 0, 0, 0, 0],
  [0, BK, JA, JH, JA, JA, JA, JA, JH, JA, BK, 0, 0, 0],
  [0, 0, BK, JP, JA, JW, JW, JA, JP, BK, 0, 0, 0, 0],
  [0, 0, 0, BK, JP, JP, JP, JP, BK, 0, 0, 0, 0, 0],
  [0, 0, 0, BK, JA, JD, JD, JA, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, JH, BK, JA, JA, BK, JH, BK, 0, 0, 0, 0],
  [0, BK, JA, 0, 0, BK, BK, 0, 0, JA, BK, 0, 0, 0],
  [BK, JA, 0, 0, 0, 0, 0, 0, 0, 0, JA, BK, 0, 0],
]

const AKARA_GRID: PixelGrid = [
  [0, RH, 0, 0, 0, 0, 0, 0, 0, RH, 0, 0, 0, 0],
  [RH, 0, RH, 0, 0, 0, 0, 0, RH, 0, RH, 0, 0, 0],
  [0, 0, 0, BK, BK, BK, BK, BK, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, RD, RD, RD, RD, RD, RD, BK, 0, 0, 0, 0],
  [0, 0, BK, RD, RD, RH, RH, RD, RD, BK, 0, 0, 0, 0],
  [0, 0, BK, RD, RP, RA, RA, RP, RD, BK, 0, 0, 0, 0],
  [0, 0, BK, RD, RP, RD, RD, RP, RD, BK, 0, 0, 0, 0],
  [0, BK, RA, RP, RA, RP, RA, RP, RA, RP, BK, 0, 0, 0],
  [0, 0, BK, RP, RA, RA, RA, RA, RP, BK, 0, 0, 0, 0],
  [0, 0, 0, BK, RP, RA, RA, RP, BK, 0, 0, 0, 0, 0],
  [0, 0, 0, BK, RA, RD, RD, RA, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, RH, BK, RA, RA, BK, RH, BK, 0, 0, 0, 0],
  [0, BK, RA, 0, 0, BK, BK, 0, 0, RA, BK, 0, 0, 0],
  [BK, RA, 0, 0, 0, 0, 0, 0, 0, 0, RA, BK, 0, 0],
]

const BRANDEIS_GRID: PixelGrid = [
  [0, DA, 0, 0, 0, 0, 0, 0, 0, DA, 0, 0, 0, 0],
  [DA, 0, DA, 0, 0, 0, 0, 0, DA, 0, DA, 0, 0, 0],
  [0, 0, 0, BK, BK, BK, BK, BK, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, DP, BK, DP, DP, BK, DP, BK, 0, 0, 0, 0],
  [0, 0, BK, DD, DH, DD, DD, DH, DD, BK, 0, 0, 0, 0],
  [0, 0, BK, DD, DA, DD, DD, DA, DD, BK, 0, 0, 0, 0],
  [0, 0, BK, DD, DD, DP, DP, DD, DD, BK, 0, 0, 0, 0],
  [0, BK, DA, DA, DA, DA, DA, DA, DA, DA, BK, 0, 0, 0],
  [0, 0, BK, DP, DA, DW, DW, DA, DP, BK, 0, 0, 0, 0],
  [0, 0, 0, BK, DA, DA, DA, DA, BK, 0, 0, 0, 0, 0],
  [0, 0, 0, BK, DA, DD, DD, DA, BK, 0, 0, 0, 0, 0],
  [0, 0, BK, DH, BK, DA, DA, BK, DH, BK, 0, 0, 0, 0],
  [0, BK, DA, 0, 0, BK, BK, 0, 0, DA, BK, 0, 0, 0],
  [BK, DA, 0, 0, 0, 0, 0, 0, 0, 0, DA, BK, 0, 0],
]

function PixelAvatar({ grid, px = 4, style }: { grid: PixelGrid; px?: number; style?: CSSProperties }) {
  const h = grid.length
  const w = grid[0].length
  return (
    <svg
      width={w * px}
      height={h * px}
      style={{ imageRendering: 'pixelated', display: 'block', ...style }}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w * px} ${h * px}`}
    >
      {grid.flatMap((row, y) =>
        row.map((c, x) =>
          c !== 0 ? <rect key={`${x}-${y}`} x={x * px} y={y * px} width={px} height={px} fill={c} /> : null
        )
      )}
    </svg>
  )
}

function fallbackPalette(name: string) {
  const palettes = [
    { bg: '#1a2535', fg: '#6bc5e8' },
    { bg: '#3a1520', fg: '#f0e8e8' },
    { bg: '#0f1a18', fg: '#3abfa0' },
  ]
  const sum = [...name].reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return palettes[sum % palettes.length]
}

export function AgentAvatar({
  name,
  role,
  size = 32,
  className = '',
}: {
  name: string
  role?: string
  size?: number
  className?: string
}) {
  const normalized = name.trim().toLowerCase()
  const px = Math.max(2, Math.floor(size / 14))

  if (normalized === 'donovan' || role === 'coordinator') return <PixelAvatar grid={DONOVAN_GRID} px={px} style={{ width: size, height: size }} />
  if (normalized === 'akara' || role === 'ops') return <PixelAvatar grid={AKARA_GRID} px={px} style={{ width: size, height: size }} />
  if (normalized === 'brandeis' || role === 'tech-lead') return <PixelAvatar grid={BRANDEIS_GRID} px={px} style={{ width: size, height: size }} />

  const palette = fallbackPalette(name)
  return (
    <div
      className={`border-[2px] border-black flex items-center justify-center text-[11px] shrink-0 ${className}`}
      style={{ width: size, height: size, background: palette.bg, color: palette.fg }}
    >
      {name[0]?.toUpperCase() ?? 'A'}
    </div>
  )
}
