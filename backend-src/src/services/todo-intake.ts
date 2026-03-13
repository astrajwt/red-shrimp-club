import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { emitTaskCreated, emitTaskDocAdded } from '../daemon/events.js'
import { query, queryOne } from '../db/client.js'

export interface TodoSubtaskInput {
  title: string
  assigneeAgentId?: string
}

export interface TodoIntakeInput {
  actorId: string
  channelId: string
  title: string
  summary?: string
  ownerAgentId?: string
  reviewerName?: string
  cleanLevel?: string
  subtasks?: TodoSubtaskInput[]
}

export interface TodoBundleResult {
  todoDir: string
  docPath: string
  docName: string
  parentTaskId: string
  parentTaskNumber: number
  subtaskNumbers: number[]
}

export interface TodoNoteInput {
  actorId: string
  taskId: string
  title: string
  content: string
}

export interface TodoNoteResult {
  todoDir: string
  docPath: string
  docName: string
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'todo'
}

async function ensureVaultRoot(): Promise<string> {
  const root = process.env.OBSIDIAN_ROOT
  if (!root) throw new Error('OBSIDIAN_ROOT not configured')
  await mkdir(path.join(root, 'memory', 'todos'), { recursive: true })
  return root
}

function buildTodoDir(title: string) {
  const date = new Date().toISOString().slice(0, 10)
  const dirName = `${date}-${slugify(title)}`
  const dirPath = path.posix.join('memory', 'todos', dirName)
  return { dirName, dirPath }
}

async function getNextTaskNumber(channelId: string): Promise<number> {
  const row = await queryOne<{ max: string }>(
    'SELECT COALESCE(MAX(number), 0) AS max FROM tasks WHERE channel_id = $1',
    [channelId]
  )
  return Number(row?.max ?? 0) + 1
}

async function getAgentName(agentId?: string): Promise<string | null> {
  if (!agentId) return null
  const row = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])
  return row?.name ?? null
}

function buildTodoMarkdown(input: TodoIntakeInput & { ownerName: string | null; subtasks: TodoSubtaskInput[] }): string {
  const today = new Date().toISOString().slice(0, 10)
  const subtasks = input.subtasks.length > 0
    ? input.subtasks.map((item, index) => `- [ ] ${index + 1}. ${item.title}`).join('\n')
    : '- [ ] 待 Donovan 补充拆解'

  return `# ${input.title}

## Meta

- 日期: ${today}
- 记录人: Donovan
- 主负责人: ${input.ownerName ?? 'Donovan'}
- Reviewer: ${input.reviewerName ?? 'Jwt2077'}
- Memory Clean 标准: ${input.cleanLevel ?? '待与用户确认'}

## Summary

${input.summary?.trim() || input.title}

## Subtasks

${subtasks}

## Review Standard

- 执行完成后先进入 reviewing
- 只有人类 reviewer 确认后才能 completed
- review 不通过时由 Donovan 协调继续收敛

## Skill Follow-up

- 可复用的阅读笔记、流程经验、代码理解继续提炼为 skill
- Donovan 需要继续询问用户是否满意当前产物与 memory clean 程度
`
}

async function insertTask(params: {
  channelId: string
  title: string
  number: number
  ownerAgentId?: string
  ownerName?: string | null
}) {
  const status = params.ownerAgentId ? 'claimed' : 'open'
  const [task] = await query(
    `INSERT INTO tasks (
       channel_id, title, number, status, claimed_by_id, claimed_by_type, claimed_by_name, claimed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 IS NULL THEN NULL ELSE NOW() END)
     RETURNING *`,
    [
      params.channelId,
      params.title,
      params.number,
      status,
      params.ownerAgentId ?? null,
      params.ownerAgentId ? 'agent' : null,
      params.ownerName ?? null,
    ]
  )
  return task
}

export async function createTodoBundle(input: TodoIntakeInput): Promise<TodoBundleResult> {
  const vaultRoot = await ensureVaultRoot()
  const { dirPath } = buildTodoDir(input.title)
  const docName = 'index.md'
  const docPath = path.posix.join(dirPath, docName)
  const absDir = path.join(vaultRoot, ...dirPath.split('/'))
  const absPath = path.join(absDir, docName)
  const ownerName = await getAgentName(input.ownerAgentId)
  const subtasks = (input.subtasks ?? [])
    .map(item => ({ title: item.title.trim(), assigneeAgentId: item.assigneeAgentId }))
    .filter(item => item.title)

  await mkdir(absDir, { recursive: true })
  await writeFile(absPath, buildTodoMarkdown({ ...input, ownerName, subtasks }), 'utf8')

  const parentTaskNumber = await getNextTaskNumber(input.channelId)
  const parentTask = await insertTask({
    channelId: input.channelId,
    title: input.title,
    number: parentTaskNumber,
    ownerAgentId: input.ownerAgentId,
    ownerName,
  })
  emitTaskCreated(input.actorId, parentTask.id, input.channelId)

  const [doc] = await query(
    `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
     VALUES ($1, $2, $3, 'unread') RETURNING *`,
    [parentTask.id, docPath, docName]
  )
  emitTaskDocAdded(input.actorId, parentTask.id, doc.doc_path)

  const subtaskNumbers: number[] = []
  for (const subtask of subtasks) {
    const subtaskNumber = await getNextTaskNumber(input.channelId)
    const subtaskOwnerName = await getAgentName(subtask.assigneeAgentId)
    const created = await insertTask({
      channelId: input.channelId,
      title: subtask.title,
      number: subtaskNumber,
      ownerAgentId: subtask.assigneeAgentId,
      ownerName: subtaskOwnerName,
    })
    emitTaskCreated(input.actorId, created.id, input.channelId)
    await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, 'unread')`,
      [created.id, docPath, docName]
    )
    emitTaskDocAdded(input.actorId, created.id, docPath)
    subtaskNumbers.push(subtaskNumber)
  }

  return {
    todoDir: dirPath,
    docPath,
    docName,
    parentTaskId: parentTask.id,
    parentTaskNumber,
    subtaskNumbers,
  }
}

function buildNoteFileName(title: string): string {
  return `${slugify(title)}.md`
}

export async function appendTodoNote(input: TodoNoteInput): Promise<TodoNoteResult> {
  const vaultRoot = await ensureVaultRoot()
  const firstDoc = await queryOne<{ doc_path: string }>(
    'SELECT doc_path FROM task_documents WHERE task_id = $1 ORDER BY created_at ASC LIMIT 1',
    [input.taskId]
  )
  if (!firstDoc?.doc_path) throw new Error('Todo has no linked memory root')

  const todoDir = path.posix.dirname(firstDoc.doc_path)
  const docName = buildNoteFileName(input.title)
  const docPath = path.posix.join(todoDir, docName)
  const absPath = path.join(vaultRoot, ...docPath.split('/'))

  await writeFile(absPath, `# ${input.title}\n\n${input.content.trim()}\n`, 'utf8')

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM task_documents WHERE task_id = $1 AND doc_path = $2',
    [input.taskId, docPath]
  )
  if (!existing) {
    await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, 'unread')`,
      [input.taskId, docPath, docName]
    )
    emitTaskDocAdded(input.actorId, input.taskId, docPath)
  }

  return { todoDir, docPath, docName }
}
