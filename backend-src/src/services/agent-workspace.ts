import { resolve, join, relative } from 'path'
import { homedir } from 'os'

export function agentWorkspaceSlug(name: string): string {
  return name.trim().replace(/[\\/]+/g, '-')
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function resolveAgentsBaseDir(): string {
  const explicit = process.env.AGENTS_WORKSPACE_DIR?.trim()
  if (explicit) return resolve(expandHome(explicit))

  const vaultRoot = process.env.OBSIDIAN_ROOT?.trim() || join(homedir(), 'JwtVault')
  return join(resolve(expandHome(vaultRoot)), '00_hub', 'agents')
}

export function resolveAgentWorkspacePath(name: string): string {
  return join(resolveAgentsBaseDir(), agentWorkspaceSlug(name))
}

export function isWorkspaceInsideAgentsBase(workspacePath: string, baseDir = resolveAgentsBaseDir()): boolean {
  const rel = relative(resolve(baseDir), resolve(workspacePath))
  return rel === '' || (!rel.startsWith('..') && rel !== '..')
}
