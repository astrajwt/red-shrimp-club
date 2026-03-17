// sync-skills-local.ts
// 在本地机器上创建 vault skills 的 symlink，供本地 Claude/Codex CLI 使用
// 用法: npx tsx backend-src/scripts/sync-skills-local.ts

import { access, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'

const OBSIDIAN_ROOT = process.env.OBSIDIAN_ROOT?.trim() || join(homedir(), 'JwtVault')
const skillsRoot = join(OBSIDIAN_ROOT, '00_hub', 'skills')

const runtimeTargets = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
]

async function pathExists(p: string) {
  try { await access(p); return true } catch { return false }
}

async function discoverSkills(root: string): Promise<Array<{ name: string; path: string }>> {
  const skills: Array<{ name: string; path: string }> = []

  // builtins/
  const builtins = join(root, 'builtins')
  if (await pathExists(builtins)) {
    for (const entry of await readdir(builtins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(builtins, entry.name)
      if (await pathExists(join(skillDir, 'SKILL.md'))) {
        skills.push({ name: entry.name, path: skillDir })
      }
    }
  }

  // top-level skill dirs (e.g. 00_hub/skills/paper-daily/)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['builtins', 'repos', 'docs'].includes(entry.name)) continue
    const skillDir = join(root, entry.name)
    if (await pathExists(join(skillDir, 'SKILL.md'))) {
      skills.push({ name: entry.name, path: skillDir })
    }
  }

  return skills
}

async function linkSkill(skillName: string, skillDir: string, targetDir: string) {
  await mkdir(targetDir, { recursive: true })
  const linkPath = join(targetDir, skillName)
  const resolvedSkillDir = resolve(skillDir)

  if (await pathExists(linkPath)) {
    const stats = await lstat(linkPath)
    if (stats.isSymbolicLink()) {
      const existing = await realpath(resolve(targetDir, await readlink(linkPath))).catch(() => '')
      if (existing === resolvedSkillDir) return // already correct
      await rm(linkPath, { recursive: true, force: true })
    } else {
      console.warn(`  ⚠ ${linkPath} exists and is not a symlink, skipping`)
      return
    }
  }

  await symlink(resolvedSkillDir, linkPath, 'dir')
}

async function main() {
  if (!(await pathExists(skillsRoot))) {
    console.error(`Vault skills root not found: ${skillsRoot}`)
    process.exit(1)
  }

  const skills = await discoverSkills(skillsRoot)
  console.log(`Found ${skills.length} skills in ${skillsRoot}`)

  for (const { name, path: skillPath } of skills) {
    for (const targetDir of runtimeTargets) {
      await linkSkill(name, skillPath, targetDir)
    }
    console.log(`  ✓ ${name}`)
  }

  console.log('\nDone. Symlinks created in:')
  for (const t of runtimeTargets) console.log(`  ${t}`)
}

main().catch(err => { console.error(err); process.exit(1) })
