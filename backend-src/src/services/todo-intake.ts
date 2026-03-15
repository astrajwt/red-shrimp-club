import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { emitTaskCreated, emitTaskDocAdded } from '../daemon/events.js'
import { query, queryOne } from '../db/client.js'
import { reserveTaskNumbers } from './task-sequence.js'

export interface TodoSubtaskInput {
  title: string
  assigneeAgentId?: string
}

interface ResolvedTodoSubtask {
  title: string
  assigneeAgentId: string
  assigneeName: string
}

export interface TodoIntakeInput {
  actorId: string
  channelId: string
  title: string
  summary?: string
  ownerAgentId?: string
  reviewerName?: string
  cleanLevel?: string
  dueDate?: string
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

async function ensureTaskRootDoc(input: { actorId: string; taskId: string }) {
  const existing = await queryOne<{ doc_path: string }>(
    'SELECT doc_path FROM task_documents WHERE task_id = $1 ORDER BY created_at ASC LIMIT 1',
    [input.taskId]
  )
  if (existing?.doc_path) return existing.doc_path

  const task = await queryOne<{ title: string; number: number }>(
    'SELECT title, number FROM tasks WHERE id = $1',
    [input.taskId]
  )
  if (!task) throw new Error('Task not found')

  const vaultRoot = await ensureVaultRoot()
  const date = new Date().toISOString().slice(0, 10)
  const dirPath = path.posix.join('memory', 'todos', `${date}-t${task.number}-${slugify(task.title)}`)
  const docName = 'index.md'
  const docPath = path.posix.join(dirPath, docName)
  const absDir = path.join(vaultRoot, ...dirPath.split('/'))
  const absPath = path.join(absDir, docName)

  await mkdir(absDir, { recursive: true })
  await writeFile(
    absPath,
    `# ${task.title}

## Meta

- Task: #t${task.number}
- Auto-created: true

## Summary

This task did not have a root memory note yet. The system created this file automatically when the first derived task document was written.
`,
    'utf8'
  )

  await query(
    `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
     VALUES ($1, $2, $3, 'unread')`,
    [input.taskId, docPath, docName]
  )
  emitTaskDocAdded(input.actorId, input.taskId, docPath)
  return docPath
}

async function getRequiredAgentName(agentId: string): Promise<string> {
  const row = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])
  if (!row?.name) throw new Error(`Assignee agent not found: ${agentId}`)
  return row.name
}

function buildTodoMarkdown(input: TodoIntakeInput & { ownerName: string; subtasks: ResolvedTodoSubtask[] }): string {
  const today = new Date().toISOString().slice(0, 10)
  const subtasks = input.subtasks.length > 0
    ? input.subtasks
      .map((item, index) => `- [ ] ${index + 1}. ${item.title} (@${item.assigneeName})`)
      .join('\n')
    : `- [ ] 待 ${input.ownerName} 补充拆解`

  return `# ${input.title}

## Meta

- 日期: ${today}
- 记录人: Donovan
- 主负责人: ${input.ownerName}
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
  ownerAgentId: string
  ownerName: string
  dueDate?: string
}) {
  const [task] = await query(
    `INSERT INTO tasks (
       channel_id, title, number, status, claimed_by_id, claimed_by_type, claimed_by_name, claimed_at, due_date
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
     RETURNING *`,
    [
      params.channelId,
      params.title,
      params.number,
      'claimed',
      params.ownerAgentId,
      'agent',
      params.ownerName,
      params.dueDate ?? null,
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
  const ownerAgentId = input.ownerAgentId?.trim()
  if (!ownerAgentId) throw new Error('ownerAgentId is required for todo intake')

  const ownerName = await getRequiredAgentName(ownerAgentId)
  const subtasks = (input.subtasks ?? [])
    .map(item => ({
      title: item.title.trim(),
      assigneeAgentId: item.assigneeAgentId?.trim() || ownerAgentId,
    }))
    .filter(item => item.title)
  const resolvedSubtasks = await Promise.all(
    subtasks.map(async item => ({
      ...item,
      assigneeName: await getRequiredAgentName(item.assigneeAgentId),
    }))
  )

  await mkdir(absDir, { recursive: true })
  await writeFile(
    absPath,
    buildTodoMarkdown({ ...input, ownerAgentId, ownerName, subtasks: resolvedSubtasks }),
    'utf8'
  )

  const reserved = await reserveTaskNumbers(input.channelId, 1 + resolvedSubtasks.length)
  const parentTaskNumber = reserved.first
  const parentTask = await insertTask({
    channelId: input.channelId,
    title: input.title,
    number: parentTaskNumber,
    ownerAgentId,
    ownerName,
    dueDate: input.dueDate,
  })
  emitTaskCreated(input.actorId, parentTask.id, input.channelId)

  const [doc] = await query(
    `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
     VALUES ($1, $2, $3, 'unread') RETURNING *`,
    [parentTask.id, docPath, docName]
  )
  emitTaskDocAdded(input.actorId, parentTask.id, doc.doc_path)

  const subtaskNumbers: number[] = []
  for (const [index, subtask] of resolvedSubtasks.entries()) {
    const subtaskNumber = reserved.first + index + 1
    const created = await insertTask({
      channelId: input.channelId,
      title: subtask.title,
      number: subtaskNumber,
      ownerAgentId: subtask.assigneeAgentId,
      ownerName: subtask.assigneeName,
      dueDate: input.dueDate,
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
  const rootDocPath = await ensureTaskRootDoc({ actorId: input.actorId, taskId: input.taskId })

  const todoDir = path.posix.dirname(rootDocPath)
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
