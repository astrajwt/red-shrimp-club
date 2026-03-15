import { execFile } from 'child_process'
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, relative, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const obsidianRoot = process.env.OBSIDIAN_ROOT?.trim()

const sharedSkillsRoot = process.env.REDSHRIMP_SHARED_SKILLS_DIR
  ? resolve(process.env.REDSHRIMP_SHARED_SKILLS_DIR)
  : obsidianRoot
    ? join(resolve(obsidianRoot), '00_hub', 'skills')
    : join(homedir(), 'JwtVault', '00_hub', 'skills')

const reposRoot = join(sharedSkillsRoot, 'repos')
const builtinsRoot = join(sharedSkillsRoot, 'builtins')
const manifestPath = join(sharedSkillsRoot, 'manifest.json')

const runtimeTargets = [
  { runtime: 'codex', dir: join(homedir(), '.codex', 'skills') },
  { runtime: 'claude', dir: join(homedir(), '.claude', 'skills') },
] as const

type RuntimeName = typeof runtimeTargets[number]['runtime']

interface SkillManifestSource {
  name: string
  repoUrl: string
  branch: string
  skillPath: string | null
  repoPath: string
  skills: string[]
  skillEntries: Array<{ name: string; relativePath: string }>
  head: string | null
  lastSyncAt: string
}

interface SkillManifest {
  version: number
  sources: Record<string, SkillManifestSource>
}

export interface SharedSkillSource {
  name: string
  repoUrl: string
  branch: string
  skillPath: string | null
  repoPath: string
  skills: string[]
  skillEntries: Array<{ name: string; relativePath: string }>
  head: string | null
  lastSyncAt: string
}

export interface SharedSkill {
  name: string
  description: string | null
  sourceName: string
  repoUrl: string | null
  path: string
  runtimes: RuntimeName[]
}

export interface SharedSkillRegistrySnapshot {
  root: string
  sources: SharedSkillSource[]
  skills: SharedSkill[]
}

export interface ImportSkillRepoInput {
  name?: string
  repoUrl?: string
  branch?: string
  skillPath?: string
  valuePath?: string
  localPath?: string  // read directly from a local directory (no git clone)
}

const BUILTIN_RECIPE_SKILL = `---
name: recipe
description: Use when you need the Red Shrimp shared skill registry layout or want to extend the git-backed shared skill workflow for all agents.
---

# Recipe

Use this skill when the task is about Red Shrimp shared skills rather than a single agent workspace.

## What exists

- Shared skills are mounted into \`~/.codex/skills\` and \`~/.claude/skills\`.
- Git-backed sources are cloned under \`~/.redshrimp/shared-skills/repos/<source>\`.
- The backend exposes a shared registry API that imports skill folders from git repositories and re-links them for every agent on the machine.

## Working rules

- Prefer repositories that store skills as \`skills/<skill-name>/SKILL.md\`.
- A repo root that directly contains \`SKILL.md\` is also valid and is treated as a single skill.
- Do not overwrite an unrelated local skill with the same name; rename the source or resolve the collision first.

## When extending the system

- Keep shared skills runtime-agnostic when possible so Codex and Claude agents can both use them.
- Put reusable instructions in \`SKILL.md\`; keep large references or scripts beside it instead of bloating the file.
- If you add a new sync rule, verify the links in both \`~/.codex/skills\` and \`~/.claude/skills\`.
`

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function deriveSourceName(repoUrl: string): string {
  const cleaned = repoUrl
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const raw = cleaned.split('/').filter(Boolean).pop() ?? 'recipe'
  return slugify(raw) || 'recipe'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function loadManifest(): Promise<SkillManifest> {
  await ensureDir(sharedSkillsRoot)
  if (!(await pathExists(manifestPath))) {
    return { version: 1, sources: {} }
  }

  try {
    const raw = await readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as SkillManifest
    return {
      version: parsed.version ?? 1,
      sources: Object.fromEntries(
        Object.entries(parsed.sources ?? {}).map(([name, source]) => [
          name,
          {
            ...source,
            skillEntries: source.skillEntries ?? (source.skills ?? []).map(skillName => ({
              name: skillName,
              relativePath: join(source.skillPath ?? 'skills', skillName),
            })),
          },
        ])
      ),
    }
  } catch {
    return { version: 1, sources: {} }
  }
}

async function saveManifest(manifest: SkillManifest): Promise<void> {
  await ensureDir(sharedSkillsRoot)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function ensureBuiltinRecipeSkill(): Promise<string> {
  const recipeDir = join(builtinsRoot, 'recipe')
  const agentsDir = join(recipeDir, 'agents')
  await ensureDir(agentsDir)
  await writeFile(join(recipeDir, 'SKILL.md'), BUILTIN_RECIPE_SKILL, 'utf-8')
  await writeFile(
    join(agentsDir, 'openai.yaml'),
    [
      'display_name: Recipe',
      'short_description: Shared git-backed skill registry guidance for Red Shrimp agents.',
      'default_prompt: Use this skill when working on the shared skill registry or git-backed skill imports.',
      '',
    ].join('\n'),
    'utf-8'
  )
  await ensureSkillLinked('recipe', recipeDir)
  return recipeDir
}

async function discoverSkillDirs(repoPath: string, skillPath?: string | null): Promise<Array<{ name: string; path: string; relativePath: string }>> {
  const explicitBase = skillPath?.trim()
    ? resolve(repoPath, skillPath.trim())
    : null

  const candidates = explicitBase
    ? [explicitBase]
    : [join(repoPath, 'skills'), repoPath]

  const skills = new Map<string, string>()

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue

    if (await pathExists(join(candidate, 'SKILL.md'))) {
      const skillName = basename(candidate)
      skills.set(skillName, candidate)
      continue
    }

    const entries = await readdir(candidate, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const skillDir = join(candidate, entry.name)
      if (await pathExists(join(skillDir, 'SKILL.md'))) {
        skills.set(entry.name, skillDir)
      }
    }
  }

  return [...skills.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, path]) => ({ name, path, relativePath: relative(repoPath, path) }))
}

async function readSkillDescription(skillDir: string): Promise<string | null> {
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
    const match = content.match(/^description:\s*(.+)$/m)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

async function ensureSkillLinked(skillName: string, targetDir: string): Promise<RuntimeName[]> {
  const linked: RuntimeName[] = []
  const resolvedTarget = await realpath(targetDir)

  for (const runtime of runtimeTargets) {
    await ensureDir(runtime.dir)
    const linkPath = join(runtime.dir, skillName)

    if (await pathExists(linkPath)) {
      const stats = await lstat(linkPath)
      if (!stats.isSymbolicLink()) {
        throw new Error(`Skill "${skillName}" already exists in ${runtime.dir} and is not managed by Recipe`)
      }

      const existingTarget = await realpath(resolve(runtime.dir, await readlink(linkPath)))
      if (existingTarget !== resolvedTarget) {
        await rm(linkPath, { recursive: true, force: true })
      }
    }

    if (!(await pathExists(linkPath))) {
      await symlink(targetDir, linkPath, 'dir')
    }

    linked.push(runtime.runtime)
  }

  return linked
}

async function removeSkillLinks(skillName: string): Promise<void> {
  for (const runtime of runtimeTargets) {
    const linkPath = join(runtime.dir, skillName)
    if (await pathExists(linkPath)) {
      await rm(linkPath, { recursive: true, force: true })
    }
  }
}

async function syncRepo(repoPath: string, repoUrl: string, branch: string): Promise<string | null> {
  await ensureDir(reposRoot)

  if (await pathExists(join(repoPath, '.git'))) {
    await runGit(['fetch', '--depth', '1', 'origin', branch], repoPath)
    await runGit(['checkout', branch], repoPath)
    await runGit(['pull', '--ff-only', 'origin', branch], repoPath)
  } else {
    if (await pathExists(repoPath)) {
      await rm(repoPath, { recursive: true, force: true })
    }
    await runGit(['clone', '--depth', '1', '--branch', branch, repoUrl, repoPath])
  }

  try {
    return await runGit(['rev-parse', 'HEAD'], repoPath)
  } catch {
    return null
  }
}

async function buildSkillSnapshot(sourceName: string, repoUrl: string | null, skillName: string, skillDir: string): Promise<SharedSkill> {
  const runtimes = await ensureSkillLinked(skillName, skillDir)
  return {
    name: skillName,
    description: await readSkillDescription(skillDir),
    sourceName,
    repoUrl,
    path: skillDir,
    runtimes,
  }
}

export async function listSharedSkills(): Promise<SharedSkillRegistrySnapshot> {
  const manifest = await loadManifest()
  const skills: SharedSkill[] = []

  const recipeDir = await ensureBuiltinRecipeSkill()
  skills.push(await buildSkillSnapshot('builtin', null, 'recipe', recipeDir))

  const sources = Object.values(manifest.sources).sort((left, right) => left.name.localeCompare(right.name))
  for (const source of sources) {
    for (const entry of source.skillEntries) {
      const resolvedDir = join(source.repoPath, entry.relativePath)
      if (!(await pathExists(join(resolvedDir, 'SKILL.md')))) continue
      skills.push(await buildSkillSnapshot(source.name, source.repoUrl, entry.name, resolvedDir))
    }
  }

  return {
    root: sharedSkillsRoot,
    sources,
    skills,
  }
}

export async function importSkillRepo(input: ImportSkillRepoInput): Promise<{ source: SharedSkillSource; skills: SharedSkill[] }> {
  // Local path mode: read directly from a local directory (no git clone)
  const localPath = input.localPath?.trim()
    || process.env.OBSIDIAN_ROOT?.trim()
    || null

  if (localPath) {
    return importFromLocalPath(input, localPath)
  }

  const repoUrl = input.repoUrl?.trim() || process.env.VAULT_GIT_URL?.trim()
  if (!repoUrl) {
    throw new Error('vault git url is not configured and no local path available')
  }

  const branch = input.branch?.trim() || 'main'
  const usingVaultSource = !input.repoUrl?.trim()
  const name = slugify(input.name || (usingVaultSource ? 'vault' : deriveSourceName(repoUrl))) || 'recipe'
  const repoPath = join(reposRoot, name)
  const manifest = await loadManifest()
  const previous = manifest.sources[name]
  const previousSkillNames = new Set(previous?.skills ?? [])

  const head = await syncRepo(repoPath, repoUrl, branch)
  const configuredSkillPath = input.valuePath?.trim() || input.skillPath?.trim() || previous?.skillPath || null
  const discovered = await discoverSkillDirs(repoPath, configuredSkillPath)

  if (discovered.length === 0) {
    throw new Error('No SKILL.md folders found in repo. Expected skills/<skill-name>/SKILL.md or a repo root SKILL.md.')
  }

  const skills: SharedSkill[] = []
  for (const skill of discovered) {
    previousSkillNames.delete(skill.name)
    skills.push(await buildSkillSnapshot(name, repoUrl, skill.name, skill.path))
  }

  for (const staleSkill of previousSkillNames) {
    await removeSkillLinks(staleSkill)
  }

  const source: SharedSkillSource = {
    name,
    repoUrl,
    branch,
    skillPath: configuredSkillPath,
    repoPath,
    skills: skills.map(skill => skill.name),
    skillEntries: discovered.map(skill => ({
      name: skill.name,
      relativePath: skill.relativePath,
    })),
    head,
    lastSyncAt: new Date().toISOString(),
  }

  manifest.sources[name] = source
  await saveManifest(manifest)

  return { source, skills }
}

async function importFromLocalPath(
  input: ImportSkillRepoInput,
  basePath: string,
): Promise<{ source: SharedSkillSource; skills: SharedSkill[] }> {
  const resolvedBase = resolve(basePath)
  if (!(await pathExists(resolvedBase))) {
    throw new Error(`Local vault path does not exist: ${resolvedBase}`)
  }

  const name = slugify(input.name || 'vault') || 'vault'
  const manifest = await loadManifest()
  const previous = manifest.sources[name]
  const previousSkillNames = new Set(previous?.skills ?? [])

  const configuredSkillPath = input.valuePath?.trim() || input.skillPath?.trim() || previous?.skillPath || null
  const discovered = await discoverSkillDirs(resolvedBase, configuredSkillPath)

  if (discovered.length === 0) {
    throw new Error(`No SKILL.md folders found in ${resolvedBase}. Expected skills/<skill-name>/SKILL.md or a root SKILL.md.`)
  }

  const skills: SharedSkill[] = []
  for (const skill of discovered) {
    previousSkillNames.delete(skill.name)
    skills.push(await buildSkillSnapshot(name, null, skill.name, skill.path))
  }

  for (const staleSkill of previousSkillNames) {
    await removeSkillLinks(staleSkill)
  }

  // Get git HEAD if the local path is a git repo
  let head: string | null = null
  try {
    head = await runGit(['rev-parse', 'HEAD'], resolvedBase)
  } catch { /* not a git repo, that's fine */ }

  const source: SharedSkillSource = {
    name,
    repoUrl: `local://${resolvedBase}`,
    branch: 'local',
    skillPath: configuredSkillPath,
    repoPath: resolvedBase,
    skills: skills.map(skill => skill.name),
    skillEntries: discovered.map(skill => ({
      name: skill.name,
      relativePath: skill.relativePath,
    })),
    head,
    lastSyncAt: new Date().toISOString(),
  }

  manifest.sources[name] = source
  await saveManifest(manifest)

  return { source, skills }
}
