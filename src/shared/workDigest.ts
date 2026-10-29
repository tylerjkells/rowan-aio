import type { StatusUpdateData, TeamTicket, Ticket, TicketNote } from './types'

// ---------------------------------------------------------------------------
// Work digests: your ServiceNow tickets, the team's queue and the monthly
// status update as compact text for an AI to read. Ask (in the app) and the
// MCP server (for Claude Desktop) both use these. Plain data in, text out,
// and forgiving of missing fields: the MCP server reads the files raw.
// The counting matches the service report: a ticket is done on the day it
// was resolved, and belongs to whoever it's assigned to.
// ---------------------------------------------------------------------------

const CLOSED_RE = /resolved|closed|cancel/i
const DAY = 864e5

const day = (iso: string | undefined | null): string => (iso ? iso.slice(0, 10) : '')
const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const daysSince = (iso: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY))

/** "Kells, Tyler" -> "Tyler Kells" */
function person(name: string | undefined): string {
  const n = (name ?? '').trim()
  return n.includes(',')
    ? n
        .split(',')
        .map((x) => x.trim())
        .reverse()
        .join(' ')
    : n
}

function counts(values: string[]): string {
  const by = new Map<string, number>()
  for (const v of values) by.set(v, (by.get(v) ?? 0) + 1)
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
}

function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---- your tickets ---------------------------------------------------------------

export interface DeskData {
  tickets: Ticket[]
  notes: Record<string, TicketNote>
  me: string | null
  syncedAt: string | null
}

const PLAN_LABEL: Record<string, string> = {
  now: 'Now',
  next: 'Next',
  later: 'Later',
  waiting: 'Waiting',
  '': 'Untriaged'
}

/** your name as ServiceNow shows it, in either order, or the bare login (surname plus an initial) */
function isMeOf(me: string | null): (who: string) => boolean {
  const key = (s: string): string => s.toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(' ')
  const mine = me ? key(me) : ''
  const last = me ? (me.includes(',') ? me.split(',')[0] : (me.trim().split(/\s+/).pop() ?? '')).trim().toLowerCase() : ''
  return (who) => {
    if (!who || !me) return false
    if (key(who) === mine) return true
    const w = who.trim().toLowerCase()
    return !!last && /^[a-z]+$/.test(w) && w.startsWith(last) && w.length <= last.length + 2
  }
}

/** your open tickets in full, then what you closed, newest first */
export function ticketsDigest(d: DeskData, now = Date.now()): string {
  const tickets = d.tickets ?? []
  if (!tickets.length) return ''
  const notes = d.notes ?? {}
  const isMe = isMeOf(d.me)
  const open = tickets.filter((t) => !t.closed).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  const closed = tickets
    .filter((t) => t.closed)
    .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''))
  const closedWithin = (days: number): number =>
    closed.filter((t) => t.closedAt && now - Date.parse(t.closedAt) <= days * DAY).length

  const lines: string[] = [
    `As of the user's last ticket update${d.syncedAt ? `, ${d.syncedAt.slice(0, 16).replace('T', ' ')}` : ''}. Not live: anything since then isn't here.`,
    `Open: ${open.length}` +
      (open.length
        ? ` (by plan: ${counts(open.map((t) => PLAN_LABEL[notes[t.number]?.plan ?? ''] ?? 'Untriaged'))}; by state: ${counts(open.map((t) => t.state || 'Unknown'))})`
        : ''),
    `Closed: ${closedWithin(30)} in the last 30 days, ${closedWithin(365)} in the last 12 months.`,
    ''
  ]

  if (open.length) lines.push('OPEN TICKETS')
  for (const t of open) {
    const n = notes[t.number]
    const thread = t.thread ?? []
    const mine = thread.some((e) => isMe(e.who))
    const latest = thread[0]
    const flags: string[] = []
    if (!mine && t.state !== 'On Hold') flags.push('the user has not replied yet')
    else if (mine && latest && !isMe(latest.who)) flags.push('the last word is not the user’s')
    if (t.updatedAt && daysSince(t.updatedAt, now) > 30) flags.push('quiet 30+ days')
    const bits = [
      `${t.number}: ${oneLine(t.title)}`,
      `caller ${person(t.caller) || 'unknown'}`,
      `state ${t.state || 'unknown'}`,
      `plan ${PLAN_LABEL[n?.plan ?? ''] ?? 'Untriaged'}`,
      t.type ? `type ${t.type}` : '',
      n?.topic?.trim() ? `topic ${n.topic.trim()}` : '',
      `opened ${day(t.openedAt)} (${daysSince(t.openedAt, now)} days ago)`,
      latest ? `last activity ${day(latest.at)} by ${person(latest.who)}` : `last updated ${day(t.updatedAt)}`,
      flags.length ? `flags: ${flags.join(', ')}` : '',
      n?.next?.trim() ? `next step: ${clip(oneLine(n.next), 200)}` : '',
      n?.notes?.trim() ? `the user's notes: ${clip(oneLine(n.notes), 300)}` : ''
    ]
    lines.push('- ' + bits.filter(Boolean).join(' | '))
  }

  if (closed.length) {
    lines.push('', `CLOSED TICKETS (newest first${closed.length > 150 ? ', the latest 150' : ''})`)
    for (const t of closed.slice(0, 150)) {
      const took = t.closedAt && t.openedAt ? Math.round((Date.parse(t.closedAt) - Date.parse(t.openedAt)) / DAY) : null
      lines.push(
        `- ${t.number}: ${oneLine(t.title)} | caller ${person(t.caller) || 'unknown'} | opened ${day(t.openedAt)} | closed ${day(t.closedAt)}${took !== null ? ` (${took} days)` : ''}`
      )
    }
  }
  return lines.join('\n')
}

// ---- the team -------------------------------------------------------------------

export interface TeamData {
  tickets: TeamTicket[]
  syncedAt: string | null
  coverageStart: string | null
}

const teamOpen = (t: TeamTicket): boolean => !t.gone && t.active && !CLOSED_RE.test(t.state)
const teamDone = (t: TeamTicket): boolean =>
  !t.gone && (!t.active || CLOSED_RE.test(t.state)) && !!(t.resolvedAt || t.closedAt)
const doneAt = (t: TeamTicket): string => t.resolvedAt || t.closedAt
const who = (t: TeamTicket): string => person(t.assignee) || 'Unassigned'

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** YYYY-MM-DD in local time */
const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * The RO Operations group: the open queue in full, opened and resolved by
 * week and by month with who resolved them, and the last 60 days of resolved
 * tickets one by one.
 */
export function teamDigest(d: TeamData, now = Date.now()): string {
  const all = d.tickets ?? []
  if (!all.length) return ''
  const open = all.filter(teamOpen).sort((a, b) => a.openedAt.localeCompare(b.openedAt))
  const done = all.filter(teamDone)
  const inRange = (iso: string, from: number, to: number): boolean => {
    const t = Date.parse(iso)
    return t >= from && t < to
  }
  const period = (label: string, from: number, to: number): string => {
    const opened = all.filter((t) => t.openedAt && inRange(t.openedAt, from, to)).length
    const resolved = done.filter((t) => inRange(doneAt(t), from, to))
    const md = median(resolved.map((t) => (Date.parse(doneAt(t)) - Date.parse(t.openedAt)) / DAY))
    return (
      `- ${label}: opened ${opened}, resolved ${resolved.length}` +
      (md !== null ? `, median ${md.toFixed(1)} days to resolve` : '') +
      (resolved.length ? `; resolved by ${counts(resolved.map(who))}` : '')
    )
  }

  const lines: string[] = [
    `As of the user's last team update${d.syncedAt ? `, ${d.syncedAt.slice(0, 16).replace('T', ' ')}` : ''}` +
      `${d.coverageStart ? `; history from ${day(d.coverageStart)}` : ''}. Not live. Tickets count toward whoever they're assigned to; a ticket is done the day it was resolved.`,
    `Open now: ${open.length}` +
      (open.length
        ? ` (by person: ${counts(open.map(who))}; by state: ${counts(open.map((t) => t.state || 'Unknown'))})`
        : ''),
    ''
  ]

  // weeks run Monday to Sunday, the service report's Last week
  const today = startOfDay(new Date(now))
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7))
  lines.push('BY WEEK (Monday to Sunday; the first is this week so far)')
  for (let i = 0; i < 8; i++) {
    const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i)
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7)
    lines.push(period(`week of ${localDay(from)}`, from.getTime(), to.getTime()))
  }
  lines.push('', 'BY MONTH (the first is this month so far)')
  for (let i = 0; i < 12; i++) {
    const from = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const to = new Date(today.getFullYear(), today.getMonth() - i + 1, 1)
    const label = from.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    lines.push(period(label, from.getTime(), to.getTime()))
  }

  if (open.length) {
    lines.push('', 'OPEN QUEUE (oldest first)')
    for (const t of open) {
      lines.push(
        `- ${t.number}: ${oneLine(t.title)} | assigned to ${who(t)} | requester ${person(t.caller) || 'unknown'} | state ${t.state || 'unknown'}` +
          `${t.type ? ` | type ${t.type}` : ''} | opened ${day(t.openedAt)} (${daysSince(t.openedAt, now)} days) | last updated ${day(t.updatedAt)}`
      )
    }
  }

  const recent = done
    .filter((t) => now - Date.parse(doneAt(t)) <= 60 * DAY)
    .sort((a, b) => doneAt(b).localeCompare(doneAt(a)))
  if (recent.length) {
    lines.push('', 'RESOLVED IN THE LAST 60 DAYS (newest first)')
    for (const t of recent) {
      const took = Math.max(0, Math.round((Date.parse(doneAt(t)) - Date.parse(t.openedAt)) / DAY))
      lines.push(
        `- ${t.number}: ${oneLine(t.title)} | assigned to ${who(t)} | requester ${person(t.caller) || 'unknown'}` +
          `${t.type ? ` | type ${t.type}` : ''} | opened ${day(t.openedAt)} | resolved ${day(doneAt(t))} (${took} days)` +
          `${t.closeCode && !/^(solved|resolved)/i.test(t.closeCode) ? ` | ended: ${t.closeCode}` : ''}`
      )
    }
  }
  return lines.join('\n')
}

// ---- the status update ------------------------------------------------------------

const SECTION_LABEL: Record<string, string> = {
  completed: 'COMPLETED',
  progress: 'IN PROGRESS',
  new: 'NEW REQUESTS'
}

/** the month's status update email as it stands: every item by section and area */
export function statusUpdateDigest(d: Partial<StatusUpdateData>): string {
  const items = d.items ?? []
  const meta = d.meta
  if (!items.length && !(d.issues ?? []).length) return ''
  const hidden = meta?.hidden ?? []
  const lines: string[] = [
    `The RO Ops monthly status update being drafted for ${meta?.month || 'this month'}.` +
      (hidden.length ? ` Left out of the email this month: ${hidden.map((h) => SECTION_LABEL[h] ?? h).join(', ')}.` : '')
  ]
  for (const key of ['completed', 'progress', 'new']) {
    const list = items
      .filter((i) => (i.section || 'progress') === key)
      .sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || (a.order ?? 0) - (b.order ?? 0))
    if (!list.length) continue
    lines.push('', `${SECTION_LABEL[key]} (${list.length})`)
    for (const i of list) {
      const bits = [
        `${i.area ? `[${i.area}] ` : ''}${oneLine(i.name) || '(no name)'}`,
        key === 'progress' && i.status ? `status ${i.status}` : '',
        i.launched ? `new dashboard${i.link ? ` ${i.link}` : ''}` : '',
        i.target?.trim() ? `target ${i.target.trim()}` : '',
        i.requestedBy?.trim() ? `requested by ${i.requestedBy.trim()}` : '',
        i.note?.trim() ? clip(oneLine(i.note), 400) : ''
      ]
      lines.push('- ' + bits.filter(Boolean).join(' | '))
    }
  }
  if (meta?.spotOn && (meta.spotTitle || meta.spotBody)) {
    lines.push('', `SPOTLIGHT: ${oneLine(meta.spotTitle)}${meta.spotBody ? ` — ${clip(oneLine(meta.spotBody), 300)}` : ''}`)
  }
  const issues = d.issues ?? []
  if (issues.length) lines.push('', `Past issues saved: ${issues.map((x) => x.month).join(', ')}.`)
  return lines.join('\n')
}
