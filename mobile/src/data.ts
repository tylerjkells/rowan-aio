import { parseDueDate } from '../../src/shared/dates'
import type {
  ActionItem,
  BrandData,
  DashboardEntry,
  LinkEntry,
  Meeting,
  PersonDetails,
  PlanItem,
  PlanStatus,
  Ticket,
  TicketNote,
  TicketPlan,
  ToolboxData
} from '../../src/shared/types'
import { deviceId, type Hub } from './api'

// ---------------------------------------------------------------------------
// What the phone reads and changes in the hub. Reads ask the database for
// just the fields a screen shows. Every change is an operation applied to
// the hub's current copy and pushed with its revision; if another device got
// there first the operation is simply replayed on the newer copy, and the
// PCs' sync merges it in like any other edit.
// ---------------------------------------------------------------------------

export interface Doc<T> {
  rev: number
  body: T
  deleted: boolean
  updated_at: string
}

interface PushResult {
  ok: boolean
  rev: number
  updated_at: string
}

export interface MeetingRow {
  id: string
  title: string
  createdAt: string
  durationMs: number | null
  stage: string
  tldr: string | null
  notes: string | null
  source: string | null
  claimedBy: string | null
  tags: string[] | null
  attendees: string[] | null
}

export interface OpenAction {
  meetingId: string
  meetingTitle: string
  index: number
  item: ActionItem
  /** YYYY-MM-DD when known */
  due: string | null
}

export type PlannerFile = { items: PlanItem[] }

// ---- offline copies of what was last loaded ---------------------------------

function cacheGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(`rowan.cache.${key}`)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(`rowan.cache.${key}`, JSON.stringify(value))
  } catch {
    // full or private: the screen just won't work offline
  }
}

export function clearCache(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('rowan.cache.')) localStorage.removeItem(k)
  } catch {
    // nothing to clear
  }
}

/** network first; the last good copy when offline */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  try {
    const value = await load()
    cacheSet(key, value)
    return { value, stale: false }
  } catch (err) {
    const old = cacheGet<T>(key)
    if (old !== null) return { value: old, stale: true }
    throw err
  }
}

export function peek<T>(key: string): T | null {
  return cacheGet<T>(key)
}

// ---- documents --------------------------------------------------------------

export async function getDoc<T>(hub: Hub, collection: string, id: string): Promise<Doc<T> | null> {
  const rows = await hub.rpc<Doc<T>[]>('sync_get', { refs: [{ collection, doc_id: id }] })
  const d = rows?.[0]
  return d && !d.deleted ? d : null
}

/**
 * Apply `change` to the hub's current copy and save it. `change` returns null
 * when there is nothing to do. A document that doesn't exist yet starts from
 * `empty` when one is given.
 */
export async function updateDoc<T>(
  hub: Hub,
  collection: string,
  id: string,
  change: (body: T) => T | null,
  empty?: T
): Promise<Doc<T>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getDoc<T>(hub, collection, id)
    if (!cur && empty === undefined) throw new Error('This was deleted on another device.')
    const base = cur ? cur.body : structuredClone(empty as T)
    const next = change(structuredClone(base))
    if (next === null) return cur ?? { rev: 0, body: base, deleted: false, updated_at: '' }
    const [r] = await hub.rpc<PushResult[]>('sync_push', {
      docs: [{ collection, doc_id: id, body: next, deleted: false, base_rev: cur ? cur.rev : null }],
      device: deviceId()
    })
    if (r?.ok) return { rev: r.rev, body: next, deleted: false, updated_at: r.updated_at }
  }
  throw new Error('Another device kept changing this at the same time. Try again.')
}

export async function pushNew(hub: Hub, collection: string, id: string, body: unknown): Promise<void> {
  const [r] = await hub.rpc<PushResult[]>('sync_push', {
    docs: [{ collection, doc_id: id, body, deleted: false, base_rev: null }],
    device: deviceId()
  })
  if (!r?.ok) throw new Error('That already exists in the hub.')
}

// ---- meetings ---------------------------------------------------------------

const MEETING_FIELDS = [
  'id:doc_id',
  'title:body->>title',
  'createdAt:body->>createdAt',
  'durationMs:body->durationMs',
  'stage:body->>stage',
  'tldr:body->summary->>tldr',
  'notes:body->>notes',
  'source:body->>source',
  'claimedBy:body->>claimedBy',
  'tags:body->tags',
  'attendees:body->attendees'
].join(',')

export function listMeetings(hub: Hub): Promise<{ value: MeetingRow[]; stale: boolean }> {
  return cached('meetings', async () => {
    const rows = await hub.rows<MeetingRow>(`select=${MEETING_FIELDS}&collection=eq.meeting&deleted=is.false`)
    return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  })
}

export function loadMeeting(hub: Hub, id: string): Promise<{ value: Meeting | null; stale: boolean }> {
  return cached(`meeting.${id}`, async () => (await getDoc<Meeting>(hub, 'meeting', id))?.body ?? null)
}

export async function updateMeeting(hub: Hub, id: string, change: (m: Meeting) => Meeting | null): Promise<Meeting> {
  const d = await updateDoc<Meeting>(hub, 'meeting', id, change)
  cacheSet(`meeting.${id}`, d.body)
  return d.body
}

/** find an action item again on a fresher copy: same place and wording, or same wording */
function findItem(m: Meeting, index: number, task: string): ActionItem | null {
  const items = m.summary?.actionItems ?? []
  if (items[index]?.task === task) return items[index]
  return items.find((i) => i.task === task) ?? null
}

export function setActionDone(hub: Hub, meetingId: string, index: number, task: string, done: boolean): Promise<Meeting> {
  return updateMeeting(hub, meetingId, (m) => {
    const item = findItem(m, index, task)
    if (!item || !!item.done === done) return null
    item.done = done
    return m
  })
}

export function setNotes(hub: Hub, meetingId: string, notes: string): Promise<Meeting> {
  return updateMeeting(hub, meetingId, (m) => {
    const next = notes.trim() ? notes : undefined
    if ((m.notes ?? undefined) === next) return null
    if (next === undefined) delete m.notes
    else m.notes = next
    return m
  })
}

export function renameMeeting(hub: Hub, meetingId: string, title: string): Promise<Meeting> {
  return updateMeeting(hub, meetingId, (m) => {
    const t = title.trim()
    if (!t || t === m.title) return null
    m.title = t
    return m
  })
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function openActions(hub: Hub): Promise<{ value: OpenAction[]; stale: boolean }> {
  return cached('actions', async () => {
    const rows = await hub.rows<{ id: string; title: string; createdAt: string; items: ActionItem[] | null }>(
      'select=id:doc_id,title:body->>title,createdAt:body->>createdAt,items:body->summary->actionItems&collection=eq.meeting&deleted=is.false'
    )
    const now = today()
    const out: OpenAction[] = []
    for (const r of rows) {
      ;(r.items ?? []).forEach((item, index) => {
        if (item.done || item.dismissed) return
        if (item.snoozedUntil && item.snoozedUntil > now) return
        out.push({
          meetingId: r.id,
          meetingTitle: r.title,
          index,
          item,
          due: item.dueDate ?? parseDueDate(item.due, r.createdAt)
        })
      })
    }
    return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  })
}

// ---- recordings in the hub ------------------------------------------------------

/** a playable address for a meeting's recording, when the hub has it */
export async function recordingUrl(hub: Hub, meetingId: string): Promise<string | null> {
  const doc = await getDoc<{ ext?: string }>(hub, 'audio', meetingId)
  if (!doc) return null
  const ext = ['.webm', '.wav', '.m4a'].includes(String(doc.body.ext)) ? String(doc.body.ext) : '.webm'
  const blob = await hub.download(`${hub.userId}/audio/${meetingId}${ext}`)
  return URL.createObjectURL(blob)
}

// ---- planner ---------------------------------------------------------------------

export const PLAN_STATUSES: { id: PlanStatus; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'next', label: 'Next' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'later', label: 'Later' },
  { id: 'done', label: 'Done' }
]

const EMPTY_PLANNER: PlannerFile = { items: [] }

export function loadPlanner(hub: Hub): Promise<{ value: PlanItem[]; stale: boolean }> {
  return cached('planner', async () => (await getDoc<PlannerFile>(hub, 'file', 'planner.json'))?.body.items ?? [])
}

/** the same ordering rule as the desktop: end of the column, top of Done */
function edgeOrder(items: PlanItem[], status: PlanStatus): number {
  const orders = items.filter((i) => i.status === status).map((i) => i.order)
  if (orders.length === 0) return 0
  return status === 'done' ? Math.min(...orders) - 1 : Math.max(...orders) + 1
}

async function changePlanner(hub: Hub, change: (items: PlanItem[]) => boolean): Promise<PlanItem[]> {
  const d = await updateDoc<PlannerFile>(
    hub,
    'file',
    'planner.json',
    (f) => {
      const items = Array.isArray(f.items) ? f.items : []
      return change(items) ? { ...f, items } : null
    },
    EMPTY_PLANNER
  )
  cacheSet('planner', d.body.items)
  return d.body.items
}

export function setPlanStatus(hub: Hub, itemId: string, status: PlanStatus): Promise<PlanItem[]> {
  return changePlanner(hub, (items) => {
    const item = items.find((i) => i.id === itemId)
    if (!item || item.status === status) return false
    const now = new Date().toISOString()
    item.order = edgeOrder(items, status)
    item.status = status
    item.doneAt = status === 'done' ? now : ''
    item.updatedAt = now
    return true
  })
}

export function togglePlanStep(hub: Hub, itemId: string, stepId: string): Promise<PlanItem[]> {
  return changePlanner(hub, (items) => {
    const step = items.find((i) => i.id === itemId)?.steps.find((s) => s.id === stepId)
    if (!step) return false
    step.done = !step.done
    items.find((i) => i.id === itemId)!.updatedAt = new Date().toISOString()
    return true
  })
}

export function addPlanItem(hub: Hub, title: string, status: PlanStatus): Promise<PlanItem[]> {
  return changePlanner(hub, (items) => {
    const now = new Date().toISOString()
    items.push({
      id: crypto.randomUUID(),
      title: title.trim() || 'Untitled',
      status,
      requester: '',
      project: '',
      due: '',
      notes: '',
      steps: [],
      links: [],
      updates: [],
      createdAt: now,
      updatedAt: now,
      doneAt: status === 'done' ? now : '',
      order: edgeOrder(items, status)
    })
    return true
  })
}

export function addPlanUpdate(hub: Hub, itemId: string, text: string): Promise<PlanItem[]> {
  return changePlanner(hub, (items) => {
    const item = items.find((i) => i.id === itemId)
    if (!item || !text.trim()) return false
    const now = new Date().toISOString()
    item.updates = [...(item.updates ?? []), { id: crypto.randomUUID(), at: now, text: text.trim() }]
    item.updatedAt = now
    return true
  })
}

// ---- settings ----------------------------------------------------------------------

export interface PhoneSettings {
  theme: string
  yourName: string
  /** the team directory's names, as spelled on the PC */
  people: string[]
  /** desktop sections switched off in Settings; the phone hides them too */
  hiddenTabs: string[]
}

export function loadSettings(hub: Hub): Promise<{ value: PhoneSettings; stale: boolean }> {
  return cached('settings', async () => {
    const d = await getDoc<Record<string, unknown>>(hub, 'settings', 'portable')
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return {
      theme: typeof d?.body.theme === 'string' ? d.body.theme : 'studio',
      yourName: typeof d?.body.yourName === 'string' ? d.body.yourName : '',
      people: list(d?.body.people),
      hiddenTabs: list(d?.body.hiddenTabs)
    }
  })
}

// ---- workspace: people, tickets, links, dashboards, toolbox, brand ---------------

export function loadDirectory(hub: Hub): Promise<{ value: Record<string, PersonDetails>; stale: boolean }> {
  return cached('directory', async () => (await getDoc<Record<string, PersonDetails>>(hub, 'file', 'directory.json'))?.body ?? {})
}

/** tickets.json as the PC stores it: tickets and your notes keyed by INC number */
export interface TicketFile {
  tickets: Record<string, Ticket>
  notes: Record<string, TicketNote>
  me: string | null
  syncedAt: string | null
}

const EMPTY_TICKETS: TicketFile = { tickets: {}, notes: {}, me: null, syncedAt: null }

export function loadTickets(hub: Hub): Promise<{ value: TicketFile; stale: boolean }> {
  return cached('tickets', async () => {
    const f = (await getDoc<TicketFile>(hub, 'file', 'tickets.json'))?.body
    return { ...EMPTY_TICKETS, ...(f ?? {}) }
  })
}

const EMPTY_NOTE: TicketNote = { plan: '', next: '', notes: '', seen: '' }

export async function setTicketNote(
  hub: Hub,
  number: string,
  patch: Partial<Pick<TicketNote, 'plan' | 'next' | 'notes'>>
): Promise<TicketFile> {
  const d = await updateDoc<TicketFile>(
    hub,
    'file',
    'tickets.json',
    (f) => {
      const notes = f.notes ?? {}
      const cur = { ...EMPTY_NOTE, ...(notes[number] ?? {}) }
      const next = { ...cur, ...patch }
      if (cur.plan === next.plan && cur.next === next.next && cur.notes === next.notes) return null
      return { ...f, notes: { ...notes, [number]: next } }
    },
    EMPTY_TICKETS
  )
  cacheSet('tickets', d.body)
  return d.body
}

export const TICKET_PLANS: { id: TicketPlan; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'next', label: 'Next' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'later', label: 'Later' }
]

export function loadLinks(hub: Hub): Promise<{ value: LinkEntry[]; stale: boolean }> {
  return cached('links', async () => (await getDoc<LinkEntry[]>(hub, 'file', 'links.json'))?.body ?? [])
}

export function loadDashboards(hub: Hub): Promise<{ value: DashboardEntry[]; stale: boolean }> {
  return cached('dashboards', async () => (await getDoc<DashboardEntry[]>(hub, 'file', 'dashboards.json'))?.body ?? [])
}

export function loadToolbox(hub: Hub): Promise<{ value: ToolboxData; stale: boolean }> {
  return cached('toolbox', async () => {
    const t = (await getDoc<Partial<ToolboxData>>(hub, 'file', 'toolbox/toolbox.json'))?.body ?? {}
    return { guides: t.guides ?? [], images: t.images ?? [], files: t.files ?? [], queries: t.queries ?? [] }
  })
}

export function loadBrand(hub: Hub): Promise<{ value: BrandData | null; stale: boolean }> {
  return cached('brand', async () => (await getDoc<BrandData>(hub, 'file', 'brand.json'))?.body ?? null)
}

/**
 * An attachment the PCs synced (a toolbox image or file, a guide's page, a
 * link thumbnail), by its path in the library. Null when it isn't in the hub.
 */
export async function attachment(hub: Hub, rel: string): Promise<Blob | null> {
  const doc = await getDoc<{ hash?: string }>(hub, 'blob', rel)
  if (!doc?.body.hash) return null
  return hub.download(`${hub.userId}/files/${doc.body.hash}`)
}
