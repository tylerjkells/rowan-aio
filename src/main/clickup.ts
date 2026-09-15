import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getClickupToken, setClickupToken } from './settings'
import type {
  ClickupActivityEvent,
  ClickupComment,
  ClickupDropdownField,
  ClickupList,
  ClickupMember,
  ClickupRefreshResult,
  ClickupStatusOption,
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
interface RawCustomField {
  id: string
  name: string
  type: string
  value?: unknown
  type_config?: { options?: { id: string; name: string; orderindex?: number }[] }
}
interface RawTask {
  id: string
  name: string
  text_content?: string | null
  status: { status: string; color: string | null; type?: string }
  due_date: string | null
  date_updated?: string | null
  date_done?: string | null
  date_closed?: string | null
  url: string
  list: { id: string; name: string }
  folder: { name: string; hidden?: boolean } | null
  priority: { priority: string } | null
  parent?: string | null
  assignees?: { id: number; username: string | null; email: string }[]
  custom_fields?: RawCustomField[]
}

/** The "Requestor" dropdown's chosen option name, if the task's list has one. */
function requestorOf(fields: RawCustomField[] | undefined): string | null {
  const f = fields?.find((x) => x.type === 'drop_down' && x.name.trim().toLowerCase() === 'requestor')
  if (!f || f.value === null || f.value === undefined || f.value === '') return null
  const options = f.type_config?.options ?? []
  // ClickUp reports a dropdown's value as the option's orderindex; be
  // lenient and accept an option id or name too
  const match =
    typeof f.value === 'number'
      ? options.find((o) => o.orderindex === f.value)
      : options.find((o) => o.id === f.value || o.name === f.value)
  return match?.name ?? null
}

const DESCRIPTION_MAX = 4000

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

/** ClickUp pages 100 tasks at a time; beyond this many pages we stop and say so. */
const MAX_PAGES = 30

/** parent-task names for subtasks whose parent isn't in the fetched set */
const parentNames = new Map<string, string>()

interface FetchedTasks {
  tasks: ClickupTask[]
  /** assignee ids per task, for deriving "mine" from an everyone fetch */
  assigneeIds: Map<string, number[]>
  userId: number
  truncated: boolean
}

/** page through a team task query, stopping (and saying so) at the cap */
async function fetchRaw(query: string): Promise<{ raws: RawTask[]; truncated: boolean }> {
  const t = await team()
  const raws: RawTask[] = []
  let truncated = false
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      truncated = true
      break
    }
    const r = await req<{ tasks: RawTask[]; last_page?: boolean }>(
      `/team/${t.id}/task?page=${page}${query}&subtasks=true`
    )
    raws.push(...r.tasks)
    if (r.last_page || r.tasks.length === 0) break
  }
  return { raws, truncated }
}

/** name the parents of subtasks whose parent isn't in the fetched set, a few per fetch */
async function nameParents(raws: RawTask[]): Promise<Map<string, string>> {
  const known = new Map(raws.map((r) => [r.id, r.name]))
  let lookups = 15
  for (const raw of raws) {
    const p = raw.parent
    if (!p || known.has(p) || parentNames.has(p) || lookups <= 0) continue
    lookups--
    try {
      const parent = await req<{ name: string }>(`/task/${p}`)
      parentNames.set(p, parent.name)
    } catch {
      // deleted or inaccessible parent: leave it unnamed
    }
  }
  return known
}

function toTask(raw: RawTask, known: Map<string, string>): ClickupTask {
  const desc = raw.text_content?.trim() ?? ''
  const doneMs = raw.date_done ?? raw.date_closed ?? null
  return {
    id: raw.id,
    name: raw.name,
    parentName: raw.parent ? (known.get(raw.parent) ?? parentNames.get(raw.parent) ?? null) : null,
    requestor: requestorOf(raw.custom_fields),
    description: desc
      ? desc.length > DESCRIPTION_MAX
        ? `${desc.slice(0, DESCRIPTION_MAX).trimEnd()} …`
        : desc
      : null,
    status: raw.status.status,
    statusColor: raw.status.color,
    dueDate: toIsoDate(raw.due_date),
    url: raw.url,
    listId: raw.list.id,
    listName: raw.list.name,
    folderName: raw.folder && !raw.folder.hidden ? raw.folder.name : null,
    priority: raw.priority?.priority ?? null,
    dateUpdated: raw.date_updated ?? null,
    assignees: (raw.assignees ?? []).map((a) => a.username ?? a.email),
    dateDone: doneMs && !isNaN(Number(doneMs)) ? new Date(Number(doneMs)).toISOString() : null
  }
}

/** Open tasks ordered by due date: the token user's, or everyone's. */
async function fetchTasks(scope: 'mine' | 'all'): Promise<FetchedTasks> {
  const { user } = await req<{ user: { id: number } }>('/user')
  const filter = scope === 'mine' ? `&assignees[]=${user.id}` : ''
  const { raws, truncated } = await fetchRaw(`${filter}&include_closed=false&order_by=due_date`)
  const known = await nameParents(raws)

  const tasks: ClickupTask[] = []
  const assigneeIds = new Map<string, number[]>()
  for (const raw of raws) {
    // a done-type status (e.g. "Complete") is finished work even though
    // ClickUp doesn't count it as closed — without this, tasks marked done
    // linger in the open list and reappear in the changelog as "new"
    if (raw.status.type === 'done' || raw.status.type === 'closed') continue
    assigneeIds.set(
      raw.id,
      (raw.assignees ?? []).map((a) => a.id)
    )
    tasks.push(toTask(raw, known))
  }
  return { tasks, assigneeIds, userId: user.id, truncated }
}

/** how far back the Done view reaches */
const DONE_WINDOW_MS = 30 * 86_400_000

/** Tasks finished in the last month, newest first: the token user's, or everyone's. */
export async function fetchClickupDone(scope: 'mine' | 'all'): Promise<ClickupTask[]> {
  const { user } = await req<{ user: { id: number } }>('/user')
  const filter = scope === 'mine' ? `&assignees[]=${user.id}` : ''
  const since = Date.now() - DONE_WINDOW_MS
  const { raws } = await fetchRaw(
    `${filter}&include_closed=true&date_done_gt=${since}&order_by=updated&reverse=true`
  )
  const done = raws.filter((r) => r.status.type === 'done' || r.status.type === 'closed')
  const known = await nameParents(done)
  return done
    .map((r) => toTask(r, known))
    .sort((a, b) => (b.dateDone ?? '').localeCompare(a.dateDone ?? ''))
}

export async function fetchClickupTasks(scope: 'mine' | 'all'): Promise<ClickupTask[]> {
  return (await fetchTasks(scope)).tasks
}

/** Everyone in the workspace, for reassigning tasks. */
export async function clickupMembers(): Promise<ClickupMember[]> {
  const t = await team()
  return t.members
    .map((m) => ({ id: m.user.id, name: m.user.username ?? m.user.email, email: m.user.email }))
    .sort((a, b) => a.name.localeCompare(b.name))
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

interface RawField {
  id: string
  name: string
  type: string
  type_config?: {
    options?: { id: string; name: string; color?: string | null; orderindex?: number }[]
  }
}

const listFieldsCache = new Map<string, { at: number; fields: ClickupDropdownField[] }>()

/**
 * Dropdown custom fields available on a list — ClickUp includes the ones
 * inherited from the folder/space/workspace, so a folder-level "Requestor"
 * shows up here for every list in that folder. Cached briefly per list.
 */
export async function clickupListFields(listId: string): Promise<ClickupDropdownField[]> {
  const cached = listFieldsCache.get(listId)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.fields
  const { fields } = await req<{ fields?: RawField[] }>(`/list/${listId}/field`)
  const dropdowns: ClickupDropdownField[] = (fields ?? [])
    .filter((f) => f.type === 'drop_down')
    .map((f) => ({
      id: f.id,
      name: f.name,
      options: [...(f.type_config?.options ?? [])]
        .sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))
        .map((o) => ({ id: o.id, name: o.name, color: o.color ?? null }))
    }))
  listFieldsCache.set(listId, { at: Date.now(), fields: dropdowns })
  return dropdowns
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
 * task list follows the requested scope. One fetch serves both: in the
 * everyone scope "mine" is derived from the full set rather than fetched
 * again.
 */
export async function refreshClickup(scope: 'mine' | 'all' = 'mine'): Promise<ClickupRefreshResult> {
  const fetched = await fetchTasks(scope)
  // a capped everyone fetch can't be trusted to contain all of yours, and a
  // missing task would be logged as "gone" — fetch yours directly in that case
  const tasks =
    scope === 'all'
      ? fetched.truncated
        ? (await fetchTasks('mine')).tasks
        : fetched.tasks.filter((t) => fetched.assigneeIds.get(t.id)?.includes(fetched.userId))
      : fetched.tasks
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
  return { tasks: fetched.tasks, events: store.events, truncated: fetched.truncated }
}

/** The newest comments on a task's thread, oldest first. */
export async function clickupComments(taskId: string, limit = 8): Promise<ClickupComment[]> {
  const { comments } = await req<{ comments: RawComment[] }>(`/task/${taskId}/comment`)
  return comments
    .slice(0, limit)
    .reverse()
    .map((c) => ({
      id: c.id,
      author: c.user?.username ?? 'Someone',
      text: (c.comment_text ?? '').trim(),
      at: new Date(Number(c.date)).toISOString()
    }))
}

/** ClickUp's priority ids, as the API wants them on a PUT. */
const PRIORITY_ID: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }

export async function setClickupTaskPriority(
  taskId: string,
  priority: string | null,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const id = priority ? PRIORITY_ID[priority.toLowerCase()] : null
    if (priority && !id) return { ok: false, error: `Unknown priority "${priority}"` }
    await req(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ priority: id }) })
    recordLocalEvent(
      makeEvent(
        'you',
        taskName,
        priority ? `You set the priority to ${priority}` : 'You cleared the priority',
        url
      )
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function renameClickupTask(
  taskId: string,
  name: string,
  url?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: 'A task needs a name' }
    await req(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ name: trimmed }) })
    recordLocalEvent(makeEvent('you', trimmed, 'You renamed it', url), (snapshot) => {
      if (snapshot[taskId]) snapshot[taskId].name = trimmed
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Hand a task to one person: the named member replaces the current
 * assignees. An empty name unassigns it.
 */
export async function setClickupTaskAssignee(
  taskId: string,
  assignee: string,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; assignedTo?: string; error?: string }> {
  try {
    const member = assignee.trim() ? await resolveAssignee(assignee) : null
    if (assignee.trim() && !member) {
      return { ok: false, error: `No workspace member matches "${assignee.trim()}"` }
    }
    const current = await req<{ assignees?: { id: number }[] }>(`/task/${taskId}`)
    const rem = (current.assignees ?? []).map((a) => a.id).filter((id) => id !== member?.id)
    const add = member && !(current.assignees ?? []).some((a) => a.id === member.id) ? [member.id] : []
    await req(`/task/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ assignees: { add, rem } })
    })
    const who = member ? (member.username ?? member.email) : null
    recordLocalEvent(
      makeEvent('you', taskName, who ? `You assigned it to ${who}` : 'You unassigned it', url)
    )
    return { ok: true, assignedTo: who ?? undefined }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface RawStatus {
  status: string
  color?: string | null
  type: 'open' | 'custom' | 'done' | 'closed'
}

const listStatusCache = new Map<string, RawStatus[]>()

async function statusesFor(listId: string): Promise<RawStatus[]> {
  const cached = listStatusCache.get(listId)
  if (cached) return cached
  const list = await req<{ statuses?: RawStatus[] }>(`/list/${listId}`)
  const statuses = list.statuses ?? []
  listStatusCache.set(listId, statuses)
  return statuses
}

/** The columns a task on this list can sit in, in board order. */
export async function clickupListStatuses(listId: string): Promise<ClickupStatusOption[]> {
  try {
    return (await statusesFor(listId)).map((s) => ({
      status: s.status,
      color: s.color ?? null,
      type: s.type
    }))
  } catch {
    return []
  }
}

/** The status that counts as finished on a list: its done status, else closed. */
async function doneStatusFor(listId: string): Promise<string | null> {
  const statuses = await statusesFor(listId)
  const done =
    statuses.find((s) => s.type === 'done') ?? statuses.find((s) => s.type === 'closed') ?? null
  return done?.status ?? null
}

/** Move a task to any status on its list ("in progress", "cancelled", …). */
export async function setClickupTaskStatus(
  taskId: string,
  listId: string,
  status: string,
  taskName: string,
  url?: string
): Promise<{ ok: boolean; finished?: boolean; error?: string }> {
  try {
    await req(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ status }) })
    const type = (await statusesFor(listId)).find((s) => s.status === status)?.type
    const finished = type === 'done' || type === 'closed'
    recordLocalEvent(makeEvent('you', taskName, `You set it to ${status}`, url), (snapshot) => {
      if (finished) delete snapshot[taskId]
      else if (snapshot[taskId]) snapshot[taskId].status = status
    })
    return { ok: true, finished }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      due_date: input.dueDate ? Date.parse(`${input.dueDate}T12:00:00`) : undefined,
      custom_fields: input.customFields?.length ? input.customFields : undefined
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
