// vault-git.ts — Auto-commit vault changes after agent writes
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

function getVaultRoot(): string {
  return process.env.OBSIDIAN_ROOT?.trim() || join(homedir(), 'JwtVault')
}

let commitTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 5_000 // batch commits within 5s window

/**
 * Schedule a git commit in the vault directory.
 * Debounced so multiple rapid writes only produce one commit.
 */
export function scheduleVaultCommit(agentName: string, description?: string): void {
  if (commitTimer) clearTimeout(commitTimer)
  commitTimer = setTimeout(() => {
    commitTimer = null
    doVaultCommit(agentName, description).catch(err =>
      console.error('[vault-git] commit failed:', err.message)
    )
  }, DEBOUNCE_MS)
}

async function doVaultCommit(agentName: string, description?: string): Promise<void> {
  const cwd = getVaultRoot()
  const msg = description
    ? `[${agentName}] ${description}`
    : `[${agentName}] auto-commit vault changes`

  await run('git', ['add', '-A'], cwd)
  // Check if there are staged changes
  const diffResult = await run('git', ['diff', '--cached', '--quiet'], cwd).catch(() => 'dirty')
  if (diffResult !== 'dirty') return // nothing to commit
  await run('git', ['commit', '-m', msg, '--no-gpg-sign'], cwd)
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
