const BASE_NAMES = [
  'Aster', 'Briar', 'Calla', 'Corin', 'Dorian', 'Eira', 'Elio', 'Esme',
  'Iris', 'Juno', 'Kael', 'Kara', 'Kestrel', 'Lina', 'Lyra', 'Maren',
  'Mira', 'Nadia', 'Nova', 'Orin', 'Petra', 'Quill', 'Rhea', 'Sable',
  'Selene', 'Silas', 'Tarin', 'Tessa', 'Vega', 'Vera', 'Wren', 'Zora',
] as const

const PREFIXES = ['Al', 'Bel', 'Cor', 'Dar', 'El', 'Fen', 'Gal', 'Ivo', 'Ka', 'Lu', 'Mar', 'Nor', 'Or', 'Ra', 'Sol', 'Va']
const SUFFIXES = ['a', 'an', 'en', 'ia', 'iel', 'in', 'is', 'or', 'ra', 'ren', 'ric', 'ros', 'thea', 'us', 'wen', 'yx']

function normalizeName(value: string) {
  return value.trim().toLowerCase()
}

export function rollAgentName(existingNames: string[] = []): string {
  const taken = new Set(existingNames.map(normalizeName).filter(Boolean))
  const availableBaseNames = BASE_NAMES.filter(name => !taken.has(normalizeName(name)))

  if (availableBaseNames.length > 0) {
    return availableBaseNames[Math.floor(Math.random() * availableBaseNames.length)] ?? 'Agent'
  }

  for (let attempt = 0; attempt < 64; attempt += 1) {
    const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)] ?? 'Agent'
    const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)] ?? ''
    const candidate = `${prefix}${suffix}`
    if (!taken.has(normalizeName(candidate))) {
      return candidate
    }
  }

  return `Agent${Math.floor(100 + Math.random() * 900)}`
}
