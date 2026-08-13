import { getClickupToken, setClickupToken } from './settings'
import type {
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
  status: { status: string; color: string | null }
  due_date: string | null
  url: string
  list: { id: string; name: string }
  folder: { name: string; hidden?: boolean } | null
  priority: { priority: string } | null
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

/** Open tasks assigned to the token's user, ordered by due date. */
export async function myClickupTasks(): Promise<ClickupTask[]> {
  const { user } = await req<{ user: { id: number } }>('/user')
  const t = await team()
  const out: ClickupTask[] = []
  for (let page = 0; page < 10; page++) {
    const r = await req<{ tasks: RawTask[]; last_page?: boolean }>(
      `/team/${t.id}/task?page=${page}&assignees[]=${user.id}&include_closed=false&subtasks=true&order_by=due_date`
    )
    for (const raw of r.tasks) {
      out.push({
        id: raw.id,
        name: raw.name,
        status: raw.status.status,
        statusColor: raw.status.color,
        dueDate: toIsoDate(raw.due_date),
        url: raw.url,
        listName: raw.list.name,
        folderName: raw.folder && !raw.folder.hidden ? raw.folder.name : null,
        priority: raw.priority?.priority ?? null
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
    return { ok: true, url: task.url, assignedTo: assignee?.username ?? assignee?.email }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
