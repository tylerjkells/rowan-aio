import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  Ticket,
  TicketDesk,
  TicketEntry,
  TicketNote,
  TicketPlan,
  TicketSyncResult,
  TicketSyncSummary
} from '../shared/types'

// ---------------------------------------------------------------------------
// Ticket desk: ServiceNow incidents assigned to you, pasted in from the
// JSONv2 list view, plus your own plans and notes, in userData/tickets.json.
// ServiceNow is never written to; the paste is the only way data comes in.
// ---------------------------------------------------------------------------

interface DeskFile {
  tickets: Record<string, Ticket>
  notes: Record<string, TicketNote>
  me: string | null
  syncedAt: string | null
}

const CLOSED_RE = /resolved|closed|cancel/i
const PLANS: TicketPlan[] = ['now', 'next', 'later', 'waiting', '']
const EMPTY_NOTE: TicketNote = { plan: '', next: '', notes: '', seen: '' }

function file(): string {
  return join(app.getPath('userData'), 'tickets.json')
}

let cache: DeskFile | null = null

function load(): DeskFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    cache = {
      tickets: raw.tickets ?? {},
      notes: raw.notes ?? {},
      me: raw.me ?? null,
      syncedAt: raw.syncedAt ?? null
    }
  } catch {
    cache = { tickets: {}, notes: {}, me: null, syncedAt: null }
  }
  return cache
}

function persist(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(cache))
}

export function readDesk(): TicketDesk {
  const d = load()
  return { tickets: Object.values(d.tickets), notes: d.notes, me: d.me, syncedAt: d.syncedAt }
}

export function setTicketNote(number: string, patch: Partial<TicketNote>): TicketNote {
  const d = load()
  const cur = { ...EMPTY_NOTE, ...d.notes[number] }
  if (patch.plan !== undefined && PLANS.includes(patch.plan)) cur.plan = patch.plan
  if (typeof patch.next === 'string') cur.next = patch.next.slice(0, 500)
  if (typeof patch.notes === 'string') cur.notes = patch.notes.slice(0, 20000)
  if (typeof patch.seen === 'string') cur.seen = patch.seen
  d.notes[number] = cur
  persist()
  return cur
}

// ---- ServiceNow values ------------------------------------------------------

/** a field as a string, whether the list sent display values or {display_value, value} pairs */
function str(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object' && 'display_value' in v) return String((v as { display_value: unknown }).display_value ?? '')
  return String(v)
}

/** ServiceNow's "MM/DD/YY hh:mm:ss AM" display time (the user's zone) to ISO */
export function snDate(value: unknown): string {
  const s = str(value).trim()
  if (!s) return ''
  const m = /^(\d\d)\/(\d\d)\/(\d\d(?:\d\d)?) (\d\d):(\d\d):(\d\d)(?: ([AP]M))?$/.exec(s)
  if (m) {
    let h = +m[4]
    if (m[7]) h = (h % 12) + (m[7] === 'PM' ? 12 : 0)
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return new Date(y, +m[1] - 1, +m[2], h, +m[5], +m[6]).toISOString()
  }
  const t = Date.parse(s.replace(' ', 'T'))
  return isNaN(t) ? '' : new Date(t).toISOString()
}

// ---- cleaning pasted email text --------------------------------------------

function safelinkTarget(u: string): string {
  try {
    return new URL(u).searchParams.get('url') ?? ''
  } catch {
    return ''
  }
}

/** Tableau links carry long view-state query strings; the bare view is enough */
function tidyUrl(t: string): string {
  return t.replace(/(https:\/\/tableau\.rowan\.edu\/(?:#\/)?[^\s?#\]]*)[^\s\]]*/g, '$1')
}

const SIGNATURE_LINES = [
  /^(Message:|reply from:)/i,
  /^[\w.+-]+@rowan\.edu$/i,
  /^Student First and Data Driven$/i,
  /High Street West/i,
  /Rowan Blvd/i,
  /^(Phone|Email)\s*:/i,
  /^Visit\b/i,
  /^Rowan University$/i,
  /^Rowan Online$/i,
  /^Rowan Online\s*\W+\s*Online Operations$/i,
  /^(Rowan )?Online Operations$/i,
  /^Enterprise Center/i,
  /^(?=[A-Z])[\w .,'&-]*\b(Specialist|Director|Coordinator|Manager|Dean|Analyst)\b[^.?!]*$/
]

/** Strip mail-client noise: safelinks, mailto/cid tags, and the author's signature block. */
function clean(text: string, author = ''): string {
  if (!text) return ''
  let t = text.replace(/\r/g, '')
  t = t.replace(/(\S*)\s*[[<](https?:\/\/[^\]>\s]*safelinks[^\]>\s]*)[\]>]/g, (_m, prev: string, u: string) => {
    if (/^https?:/.test(prev)) return prev
    const target = safelinkTarget(u)
    return prev + (target ? ' ' + target : '')
  })
  // a safelink standing on its own becomes the address it wraps
  t = t.replace(/https?:\/\/[^\s\]>]*safelinks[^\s\]>]*/g, (u) => safelinkTarget(u) || u)
  t = t
    .replace(/\[mailto:[^\]]*\]/g, '')
    .replace(/<mailto:[^>]*>/g, '')
    .replace(/\[cid:[^\]]*\]/g, '[image]')
  t = tidyUrl(t)
  let first = ''
  let full = ''
  if (author.includes(',')) {
    const [last, given] = author.split(',').map((x) => x.trim())
    first = given
    full = `${given} ${last}`
  }
  const lines = t
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => {
      if (SIGNATURE_LINES.some((r) => r.test(x))) return false
      if (full && (x === first || x === full || x.startsWith(full + ','))) return false
      return true
    })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const HEAD_RE =
  /^(\d\d\/\d\d\/\d{2,4} \d\d:\d\d:\d\d(?: [AP]M)?) - (.+?) \((Comments \(Customer Visible\)|Additional comments|Work [Nn]otes)\)$/gm

function parseThread(raw: string): TicketEntry[] {
  if (!raw) return []
  const text = raw.replace(/\r/g, '')
  const heads: { i: number; end: number; at: string; who: string; kind: TicketEntry['kind'] }[] = []
  let m: RegExpExecArray | null
  HEAD_RE.lastIndex = 0
  while ((m = HEAD_RE.exec(text))) {
    heads.push({
      i: m.index,
      end: HEAD_RE.lastIndex,
      at: m[1],
      who: m[2],
      kind: /^work/i.test(m[3]) ? 'worknote' : 'comment'
    })
  }
  return heads.map((h, k) => ({
    at: snDate(h.at),
    who: h.who,
    kind: h.kind,
    text: clean(text.slice(h.end, k + 1 < heads.length ? heads[k + 1].i : text.length), h.who)
  }))
}

type SnRecord = Record<string, unknown>

function fromRecord(r: SnRecord): Ticket {
  const thread = parseThread(str(r.comments_and_work_notes))
  const caller = str(r.caller_id)
  if (!thread.length && str(r.description)) {
    thread.push({ at: snDate(r.opened_at), who: caller, kind: 'comment', text: clean(str(r.description), caller) })
  }
  const state = str(r.state) || str(r.incident_state)
  const closed = !(str(r.active) === 'true' && !CLOSED_RE.test(state))
  return {
    number: str(r.number),
    sysId: str(r.sys_id),
    title: str(r.short_description) || '(no title)',
    caller,
    state,
    openedAt: snDate(r.opened_at),
    updatedAt: snDate(r.sys_updated_on),
    closed,
    closedAt: closed ? snDate(r.closed_at) || snDate(r.resolved_at) || snDate(r.sys_updated_on) : '',
    closeNotes: clean(str(r.close_notes)),
    thread
  }
}

// ---- applying a paste -------------------------------------------------------

/** the Ticket Desk artifact's plans and notes, exported for the move into the app */
interface ArtifactNote {
  bucket?: string
  next?: string
  notes?: string
  seenU?: string
}

function extractJson(text: string): unknown {
  const i = text.search(/[[{]/)
  if (i < 0) {
    throw new Error('That doesn’t look like JSON. Copy the whole page from the ServiceNow link.')
  }
  const j = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  try {
    return JSON.parse(text.slice(i, j + 1))
  } catch {
    throw new Error(
      'The JSON is incomplete. Make sure you selected the whole page with Ctrl+A before copying.'
    )
  }
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  let n = 0
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c]
  return best
}

function importNotes(incoming: Record<string, ArtifactNote>): number {
  const d = load()
  let count = 0
  for (const [number, n] of Object.entries(incoming)) {
    if (!/^[A-Z]+\d+$/.test(number) || !n || typeof n !== 'object') continue
    const cur = { ...EMPTY_NOTE, ...d.notes[number] }
    const plan = PLANS.includes(n.bucket as TicketPlan) ? (n.bucket as TicketPlan) : ''
    // fill only what is still blank here, so a second import never clobbers edits
    const before = cur.plan + cur.next + cur.notes
    if (!cur.plan) cur.plan = plan
    if (!cur.next && n.next) cur.next = String(n.next)
    if (!cur.notes && n.notes) cur.notes = String(n.notes)
    if (!cur.seen && n.seenU) cur.seen = snDate(n.seenU)
    d.notes[number] = cur
    if (cur.plan + cur.next + cur.notes !== before) count++
  }
  return count
}

export function applyTicketPaste(text: string): TicketSyncResult {
  let parsed: unknown
  try {
    parsed = extractJson(text ?? '')
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const d = load()
  const summary: TicketSyncSummary = {
    open: 0,
    added: [],
    updated: [],
    closed: [],
    archived: 0,
    notesImported: 0
  }

  const obj = parsed as { records?: unknown; ticketDeskNotes?: Record<string, ArtifactNote> }
  if (obj && typeof obj === 'object' && obj.ticketDeskNotes && typeof obj.ticketDeskNotes === 'object') {
    summary.notesImported = importNotes(obj.ticketDeskNotes)
    persist()
    return { ok: true, desk: readDesk(), summary }
  }

  const recs = Array.isArray(parsed) ? parsed : obj?.records
  if (!Array.isArray(recs)) return { ok: false, error: 'No records found. Use the JSONv2 link.' }
  const records = recs.filter((r): r is SnRecord => !!r && typeof r === 'object' && !!str((r as SnRecord).number))
  if (records.length && /^[0-9a-f]{32}$/.test(str(records[0].caller_id))) {
    return {
      ok: false,
      error: 'Names came through as IDs. Add &displayvalue=true to the link and copy again.'
    }
  }

  const incoming = records.map(fromRecord)
  const inMap = new Map(incoming.map((t) => [t.number, t]))
  const hasOpen = incoming.some((t) => !t.closed)
  const now = new Date().toISOString()

  for (const t of incoming) {
    const old = d.tickets[t.number]
    if (!old) {
      if (!t.closed) summary.added.push(t.number)
      else summary.archived++
    } else if (!old.closed && t.closed) {
      summary.closed.push({ number: t.number, title: t.title })
    } else if (old.updatedAt !== t.updatedAt && !t.closed) {
      summary.updated.push(t.number)
    }
    d.tickets[t.number] = t
    if (!old && !t.closed && !d.notes[t.number]) {
      d.notes[t.number] = { ...EMPTY_NOTE, plan: t.state === 'On Hold' ? 'waiting' : '' }
    }
  }
  // an open ticket missing from a paste that has open tickets left your queue
  // (reassigned or closed by someone else): file it under Closed
  if (hasOpen) {
    for (const t of Object.values(d.tickets)) {
      if (t.closed || inMap.has(t.number)) continue
      summary.closed.push({ number: t.number, title: t.title })
      d.tickets[t.number] = {
        ...t,
        closed: true,
        closedAt: t.closedAt || now,
        state: CLOSED_RE.test(t.state) ? t.state : 'Closed (left your queue)'
      }
    }
  }

  summary.open = incoming.filter((t) => !t.closed).length
  d.me = mostCommon(records.map((r) => str(r.assigned_to))) ?? d.me
  d.syncedAt = now
  persist()
  return { ok: true, desk: readDesk(), summary }
}
