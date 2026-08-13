import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getClickupToken, setClickupToken } from './settings'
import type {
  ClickupActivityEvent,
  ClickupList,
  ClickupPushInput,
  ClickupPushResult,
  ClickupStatus,
  ClickupTask
} from '../shared/types'

// ---------------------------------------------------------------------------
// ClickUp companion: a thin client over the ClickUp REST API (v2) using a
// personal API token stored encrypted in settings. ClickUp stays the source
// of truth — the app reads the user's tasks and creates tasks from meeting
// action items; nothing is mirrored locally.
// ---------------------------------------------------------------------------

const API = 'https://api.clickup.com/api/v2'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getClickupToken()
  if (!token) throw new Error('ClickUp is not connected')
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { err?: string }).err ?? ''
    } catch {
      // non-JSON error body
    }
    throw new Error(`ClickUp ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

interface RawMember {
  user: { id: number; username: string | null; email: string }
}
interface RawTeam {
  id: string
  name: string
  members: RawMember[]
}
interface RawTask {
  id: string
  name: string
  text_content?: string | null
  status: { status: string; color: string | null; type?: string }
  due_date: string | null
  date_updated?: string | null
  url: string
  list: { id: string; name: string }
  folder: { name: string; hidden?: boolean } | null
  priority: { priority: string } | null
  assignees?: { username: string | null; email: string }[]
}

let teamCache: RawTeam | null = null
async function team(): Promise<RawTeam> {
  if (teamCache) return teamCache
  const { teams } = await req<{ teams: RawTeam[] }>('/team')
  if (!teams.length) throw new Error('No ClickUp workspace on this token')
  teamCache = teams[0]
  return teamCache
}

export async function clickupStatus(): Promise<ClickupStatus> {
  if (!getClickupToken()) return { connected: false }
  try {
    const { user } = await req<{ user: { username: string | null; email: string } }>('/user')
    const t = await team()
    return {
      connected: true,
      userName: user.username ?? user.email,
      userEmail: user.email,
      teamName: t.name
    }
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Save the token only if it actually works. */
export async function connectClickup(token: string): Promise<ClickupStatus> {
  teamCache = null
  setClickupToken(token)
  const status = await clickupStatus()
  if (!status.connected) setClickupToken(null)
  return status
}

export function disconnectClickup(): void {
  teamCache = null
  setClickupToken(null)
}

function toIsoDate(ms: string | null): string | null {
  if (!ms) return null
  const d = new Date(Number(ms))
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Open tasks ordered by due date: the token user's, or everyone's. */
export async function fetchClickupTasks(scope: 'mine' | 'all'): Promise<ClickupTask[]> {
  const { user } = await req<{ user: { id: number } }>('/user')
  const t = await team()
  const filter = scope === 'mine' ? `&assignees[]=${user.id}` : ''
  const out: ClickupTask[] = []
  for (let page = 0; page < 10; page++) {
    const r = await req<{ tasks: RawTask[]; last_page?: boolean }>(
      `/team/${t.id}/task?page=${page}${filter}&include_closed=false&subtasks=true&order_by=due_date`
    )
    for (const raw of r.tasks) {
      // a done-type status (e.g. "Complete") is finished work even though
      // ClickUp doesn't count it as closed — without this, tasks marked done
      // linger in the open list and reappear in the changelog as "new"
      if (raw.status.type === 'done' || raw.status.type === 'closed') continue
      out.push({
        id: raw.id,
        name: raw.name,
        description: raw.text_content?.trim() ? raw.text_content.trim().slice(0, 2000) : null,
        status: raw.status.status,
        statusColor: raw.status.color,
        dueDate: toIsoDate(raw.due_date),
        url: raw.url,
        listId: raw.list.id,
        listName: raw.list.name,
        folderName: raw.folder && !raw.folder.hidden ? raw.folder.name : null,
        priority: raw.priority?.priority ?? null,
        dateUpdated: raw.date_updated ?? null,
        assignees: (raw.assignees ?? []).map((a) => a.username ?? a.email)
      })
    }
    if (r.last_page || r.tasks.length === 0) break
  }
  return out
}

interface RawList {
  id: string
  name: string
}
interface RawFolder {
  id: string
  name: string
  lists: RawList[]
}

let listsCache: { at: number; lists: ClickupList[] } | null = null

/** Every list in the workspace, cached briefly so the push picker is snappy. */
export async function clickupLists(): Promise<ClickupList[]> {
  if (listsCache && Date.now() - listsCache.at < 5 * 60_000) return listsCache.lists
  const t = await team()
  const { spaces } = await req<{ spaces: { id: string; name: string }[] }>(
    `/team/${t.id}/space?archived=false`
  )
  const lists: ClickupList[] = []
  for (const space of spaces) {
    const { folders } = await req<{ folders: RawFolder[] }>(`/space/${space.id}/folder?archived=false`)
    for (const folder of folders) {
      for (const list of folder.lists ?? []) {
        lists.push({ id: list.id, name: list.name, folder: folder.name, space: space.name })
      }
    }
    const folderless = await req<{ lists: RawList[] }>(`/space/${space.id}/list?archived=false`)
    for (const list of folderless.lists) {
      lists.push({ id: list.id, name: list.name, folder: null, space: space.name })
    }
  }
  listsCache = { at: Date.now(), lists }
  return lists
}

/** Match an owner name/email from the app to a workspace member. */
async function resolveAssignee(assignee: string): Promise<RawMember['user'] | null> {
  const t = await team()
  const needle = assignee.trim().toLowerCase()
  if (!needle) return null
  const users = t.members.map((m) => m.user)
  return (
    users.find((u) => u.email.toLowerCase() === needle) ??
    users.find((u) => (u.username ?? '').toLowerCase() === needle) ??
    // "Carol" matches "Carol Primas-Young" only if no one else starts with it
    singleOrNull(users.filter((u) => (u.username ?? '').toLowerCase().startsWith(needle)))
  )
}

function singleOrNull<T>(arr: T[]): T | null {
  return arr.length === 1 ? arr[0] : null
}

// ---------------------------------------------------------------------------
// Local changelog: ClickUp's public API has no activity feed, so the app
// keeps a snapshot of the user's tasks and diffs it on every refresh — new
// assignments, status changes, due-date moves, completions, and (for tasks
// whose modified stamp changed) new comments. Actions taken from the app are
// logged immediately. Stored in userData/clickup-activity.json.
// ---------------------------------------------------------------------------

interface SnapshotEntry {
  name: string
  status: string
  dueDate: string | null
  dateUpdated: string
  /** ms timestamp of the newest comment already seen */
  lastCommentDate: number
}

interface StoredActivity {
  snapshot: Record<string, SnapshotEntry>
  events: ClickupActivityEvent[]
}

function activityFile(): string {
  return join(app.getPath('userData'), 'clickup-activity.json')
}

function readActivity(): StoredActivity {
  try {
    return JSON.parse(readFileSync(activityFile(), 'utf8'))
  } catch {
    return { snapshot: {}, events: [] }
  }
}

function writeActivity(a: StoredActivity): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(activityFile(), JSON.stringify(a, null, 2))
}

const MAX_EVENTS = 200

function makeEvent(
  kind: ClickupActivityEvent['kind'],
  taskName: string,
  detail?: string,
  url?: string
): ClickupActivityEvent {
  return { id: randomUUID(), at: new Date().toISOString(), kind, taskName, detail, url }
}

/** Log something the user just did from the app, and keep the snapshot in step. */
function recordLocalEvent(
  event: ClickupActivityEvent,
  patchSnapshot?: (snapshot: Record<string, SnapshotEntry>) => void
): void {
  const a = readActivity()
  a.events = [event, ...a.events].slice(0, MAX_EVENTS)
  patchSnapshot?.(a.snapshot)
  writeActivity(a)
}

interface RawComment {
  id: string
  comment_text?: string
  user?: { username?: string | null }
  date: string
}

/**
 * Fetch tasks and turn the differences since last refresh into changelog
 * events. The changelog always tracks the user's own tasks; the returned
 * task list follows the requested scope.
 */
export async function refreshClickup(scope: 'mine' | 'all' = 'mine'): Promise<{
  tasks: ClickupTask[]
  events: ClickupActivityEvent[]
}> {
  const tasks = await fetchClickupTasks('mine')
  const store = readActivity()
  const prev = store.snapshot
  const firstRun = Object.keys(prev).length === 0
  const next: Record<string, SnapshotEntry> = {}
  const fresh: ClickupActivityEvent[] = []
  // per-refresh cap on per-task detail calls (comments, vanished-task lookups)
  let detailBudget = 12

  for (const t of tasks) {
    const p = prev[t.id]
    next[t.id] = {
      name: t.name,
      status: t.status,
      dueDate: t.dueDate,
      dateUpdated: t.dateUpdated ?? '',
      lastCommentDate: p?.lastCommentDate ?? Date.now()
    }
    if (!p) {
      if (!firstRun) fresh.push(makeEvent('new', t.name, `Assigned to you · ${t.listName}`, t.url))
      continue
    }
    if (p.status !== t.status) {
      fresh.push(makeEvent('status', t.name, `${p.status} → ${t.status}`, t.url))
    }
    if ((p.dueDate ?? null) !== (t.dueDate ?? null)) {
      fresh.push(makeEvent('due', t.name, t.dueDate ? `Due ${t.dueDate}` : 'Due date cleared', t.url))
    }
    if (p.dateUpdated !== (t.dateUpdated ?? '') && detailBudget > 0) {
      detailBudget--
      try {
        const { comments } = await req<{ comments: RawComment[] }>(`/task/${t.id}/comment`)
        const unseen = comments.filter((c) => Number(c.date) > p.lastCommentDate)
        if (comments[0]) next[t.id].lastCommentDate = Number(comments[0].date)
        for (const c of unseen.slice(0, 3).reverse()) {
          fresh.push(
            makeEvent(
              'comment',
              t.name,
              `${c.user?.username ?? 'Someone'}: ${(c.comment_text ?? '').trim().slice(0, 140)}`,
              t.url
            )
          )
        }
      } catch {
        // comments unavailable: skip quietly
      }
    }
  }

  // tasks that were assigned to you last time and are gone now
  for (const [id, p] of Object.entries(prev)) {
    if (next[id]) continue
    if (detailBudget > 0) {
      detailBudget--
      try {
        const task = await req<{
          status?: { status: string; type?: string }
          date_done?: string | null
          url?: string
        }>(`/task/${id}`)
        const finished =
          task.date_done || task.status?.type === 'done' || task.status?.type === 'closed'
        fresh.push(
          finished
            ? makeEvent('done', p.name, `Marked ${task.status?.status ?? 'done'}`, task.url)
            : makeEvent('removed', p.name, 'No longer assigned to you', task.url)
        )
        continue
      } catch {
        // deleted or inaccessible
      }
    }
    fresh.push(makeEvent('removed', p.name, 'Gone from your list'))
  }

  store.snapshot = next
  store.events = [...fresh, ...store.events].slice(0, MAX_EVENTS)
  writeActivity(store)
  return { tasks: scope === 'all' ? await fetchClickupTasks('all') : tasks, events: store.events }
}

interface RawStatus {
  status: string
  type: 'open' | 'custom' | 'done' | 'closed'
}

const doneStatusCache = new Map<string, string | null>()

/** The status that counts as finished on a list: its done status, else closed. */
async function doneStatusFor(listId: string): Promise<string | null> {
  if (doneStatusCache.has(listId)) return doneStatusCache.get(listId)!
  const list = await req<{ statuses?: RawStatus[] }>(`/list/${listId}`)
  const statuses = list.statuses ?? []
  const done =
    statuses.find((s) => s.type === 'done') ?? statuses.find((s) => s.type === 'closed') ?? null
  doneStatusCache.set(listId, done?.status ?? null)
  return done?.status ?? null
}

export async function completeClickupTask(
  taskId: string,
  listId: string,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const status = await doneStatusFor(listId)
    if (!status) return { ok: false, error: 'This list has no done/closed status' }
    await req(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ status }) })
    recordLocalEvent(makeEvent('you', taskName, `You marked it ${status}`, url), (snapshot) => {
      delete snapshot[taskId]
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function setClickupTaskDue(
  taskId: string,
  isoDate: string | null,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await req(`/task/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ due_date: isoDate ? Date.parse(`${isoDate}T12:00:00`) : null })
    })
    recordLocalEvent(
      makeEvent('you', taskName, isoDate ? `You set the due date to ${isoDate}` : 'You cleared the due date', url),
      (snapshot) => {
        if (snapshot[taskId]) snapshot[taskId].dueDate = isoDate
      }
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function commentClickupTask(
  taskId: string,
  text: string,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await req(`/task/${taskId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ comment_text: text })
    })
    recordLocalEvent(
      makeEvent('you', taskName, `You commented: ${text.slice(0, 140)}`, url),
      (snapshot) => {
        if (snapshot[taskId]) snapshot[taskId].lastCommentDate = Date.now()
      }
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function pushClickupTask(input: ClickupPushInput): Promise<ClickupPushResult> {
  try {
    const assignee = input.assignee ? await resolveAssignee(input.assignee) : null
    const body: Record<string, unknown> = {
      name: input.name,
      description: input.description || undefined,
      assignees: assignee ? [assignee.id] : undefined,
      due_date: input.dueDate ? Date.parse(`${input.dueDate}T12:00:00`) : undefined
    }
    const task = await req<{ id: string; url: string }>(`/list/${input.listId}/task`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
    recordLocalEvent(
      makeEvent(
        'you',
        input.name,
        `You created it${assignee ? ` for ${assignee.username ?? assignee.email}` : ''}`,
        task.url
      )
    )
    return { ok: true, url: task.url, assignedTo: assignee?.username ?? assignee?.email }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
