import type { Ticket, TicketNote, TicketPlan } from './types'

// ---------------------------------------------------------------------------
// Reports from your own tickets: the monthly recap (what you closed in a
// month) and the agenda summary (your open tickets summed up for a meeting).
// The desktop's dialogs and the phone's Reports both build them from these.
// ---------------------------------------------------------------------------

export const ms = (iso: string): number => (iso ? Date.parse(iso) : NaN)

/** "Kells, Tyler" -> "Tyler Kells" */
export const person = (name: string): string =>
  name.includes(',')
    ? name
        .split(',')
        .map((x) => x.trim())
        .reverse()
        .join(' ')
    : name || 'Unknown'

export const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

export const monthLabel = (key: string): string => {
  const [y, m] = key.split('-')
  return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** the months you closed tickets in, newest first, always including this one */
export function recapMonths(tickets: Ticket[], thisMonth = monthKey(new Date())): string[] {
  const keys = new Set([thisMonth])
  for (const t of tickets) if (t.closed && t.closedAt) keys.add(monthKey(new Date(t.closedAt)))
  return [...keys].sort().reverse()
}

/** the tickets you closed in a month, in the order you closed them */
export function recapItems(tickets: Ticket[], month: string): Ticket[] {
  return tickets
    .filter((t) => t.closed && t.closedAt && monthKey(new Date(t.closedAt)) === month)
    .sort((a, b) => ms(a.closedAt) - ms(b.closedAt))
}

/** those tickets by who asked, the busiest requester first */
export function recapGroups(items: Ticket[]): [string, Ticket[]][] {
  const by = new Map<string, Ticket[]>()
  for (const t of items) {
    const p = person(t.caller)
    by.set(p, [...(by.get(p) ?? []), t])
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

// ---- agenda summary ---------------------------------------------------------------
// Open tickets summed up for a meeting agenda: a count, then groups naming
// their tickets, with next steps under them.

export type AgendaBy = 'type' | 'plan' | 'status' | 'requester'
export interface AgendaOpts {
  by: AgendaBy
  names: boolean
  steps: boolean
  closed: boolean
}
export interface AgendaLine {
  level: 0 | 1 | 2
  text: string
}

export const AGENDA_BY: { id: AgendaBy; label: string }[] = [
  { id: 'type', label: 'Request type' },
  { id: 'plan', label: 'Your plan' },
  { id: 'status', label: 'ServiceNow status' },
  { id: 'requester', label: 'Requester' }
]
export const PLAN_PHRASE: Record<TicketPlan, string> = {
  now: 'in progress',
  next: 'up next',
  waiting: 'waiting on someone else',
  later: 'for later',
  '': 'not triaged yet'
}
export const PLAN_ORDER: TicketPlan[] = ['now', 'next', 'waiting', 'later', '']
export const DEFAULT_AGENDA_OPTS: AgendaOpts = { by: 'type', names: true, steps: true, closed: true }

/** the bullets an agenda already uses, one per level */
export const BULLET = ['', '● ', '    ○ ']

/** topics match whatever their case or spacing */
export const topicKey = (topic: string): string => topic.trim().replace(/\s+/g, ' ').toLowerCase()

/** a ticket title trimmed for a list in parentheses */
export function shortTitle(title: string): string {
  const s = title.replace(/^\s*(\[external\]\s*)?((re|fwd?)\s*:\s*)*/i, '').trim()
  return s.length > 48 ? s.slice(0, 46).trimEnd() + '…' : s
}

/** "Data Request" reads "Data Requests" when there are several */
export const pluralize = (label: string, n: number): string =>
  n === 1 ? label : label.replace(/\b(Request|Issue|Question|Report|Ticket|Update|Change|Problem|Error)$/i, '$1s')

export const waitingOnSomeone = (t: Ticket, plan: TicketPlan): boolean =>
  plan === 'waiting' || /await|pending|on hold/i.test(t.state)

export function agendaLines(tickets: Ticket[], notes: Record<string, TicketNote>, o: AgendaOpts): AgendaLine[] {
  const open = tickets.filter((t) => !t.closed).sort((a, b) => ms(a.openedAt) - ms(b.openedAt))
  const planOf = (t: Ticket): TicketPlan => notes[t.number]?.plan ?? ''
  const names = (ts: Ticket[]): string => (o.names ? ` (${ts.map((t) => shortTitle(t.title)).join(', ')})` : '')
  const out: AgendaLine[] = [{ level: 0, text: `${open.length} open ticket${open.length === 1 ? '' : 's'}` }]

  // each group's key, its place in the order, and how it reads with its count
  const WAITING = '\u0001waiting'
  const OTHER = '\u0002other'
  const TOPIC = '\u0003topic:'
  const topicOf = (t: Ticket): string => notes[t.number]?.topic?.trim() ?? ''
  // each topic reads as its most common spelling, spacing tidied
  const spellings = new Map<string, Map<string, number>>()
  for (const t of open) {
    const x = topicOf(t).replace(/\s+/g, ' ')
    if (!x) continue
    const m = spellings.get(topicKey(x)) ?? new Map<string, number>()
    m.set(x, (m.get(x) ?? 0) + 1)
    spellings.set(topicKey(x), m)
  }
  const topicLabel = new Map(
    [...spellings].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]] as const)
  )
  const keyOf = (t: Ticket): { key: string; rank: number } => {
    // a topic you gave tickets keeps them together, whatever the grouping
    const x = topicOf(t)
    if (x) return { key: TOPIC + topicKey(x), rank: o.by === 'type' ? 1 : -1 }
    switch (o.by) {
      case 'plan':
        return { key: planOf(t), rank: PLAN_ORDER.indexOf(planOf(t)) }
      case 'status':
        return { key: t.state || 'No status', rank: 0 }
      case 'requester':
        return { key: person(t.caller) || 'Unknown', rank: 0 }
      default:
        // waiting tickets are their own agenda item, whatever they are
        if (waitingOnSomeone(t, planOf(t))) return { key: WAITING, rank: 2 }
        return t.type ? { key: t.type, rank: 1 } : { key: OTHER, rank: 3 }
    }
  }
  const labelOf = (key: string, ts: Ticket[]): string => {
    const n = ts.length
    if (key.startsWith(TOPIC)) return `regarding ${topicLabel.get(key.slice(TOPIC.length))}`
    if (o.by === 'plan') return PLAN_PHRASE[key as TicketPlan]
    if (o.by === 'requester') return `from ${key}`
    if (o.by === 'status') return key
    if (key === OTHER) return n === 1 ? 'other ticket' : 'other tickets'
    if (key === WAITING) {
      const types = new Set(ts.map((t) => t.type ?? ''))
      const only = types.size === 1 ? [...types][0] : ''
      return only ? `${pluralize(only, n)} waiting on a response` : 'waiting on a response'
    }
    return pluralize(key, n)
  }

  const groups = new Map<string, { rank: number; tickets: Ticket[] }>()
  for (const t of open) {
    const { key, rank } = keyOf(t)
    const g = groups.get(key) ?? { rank, tickets: [] }
    g.tickets.push(t)
    groups.set(key, g)
  }
  const ordered = [...groups.entries()].sort(
    ([ka, a], [kb, b]) => a.rank - b.rank || b.tickets.length - a.tickets.length || ka.localeCompare(kb)
  )
  for (const [key, g] of ordered) {
    out.push({ level: 1, text: `${g.tickets.length} ${labelOf(key, g.tickets)}${names(g.tickets)}` })
    if (o.steps) {
      const steps = new Set(g.tickets.map((t) => (notes[t.number]?.next ?? '').trim()).filter(Boolean))
      for (const step of steps) out.push({ level: 2, text: step })
    }
  }

  if (o.closed) {
    const since = Date.now() - 7 * 864e5
    const done = tickets.filter((t) => t.closed && ms(t.closedAt) >= since)
    if (done.length) out.push({ level: 0, text: `${done.length} closed in the last week${names(done)}` })
  }
  return out
}

export const agendaText = (lines: AgendaLine[]): string => lines.map((l) => BULLET[l.level] + l.text).join('\n')
