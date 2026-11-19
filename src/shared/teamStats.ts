import type { TeamTicket } from './types'

// ---------------------------------------------------------------------------
// The service report's arithmetic: periods and their buckets, what counts as
// opened, resolved and open, medians, and the snapshot's title and headline.
// The desktop's full report and the phone's snapshot both count with these,
// so the two always agree.
// ---------------------------------------------------------------------------

export const CLOSED_RE = /resolved|closed|cancel/i

export type PeriodKey = 'week' | 'month' | 'mtd' | 'year'
export const PERIODS: { id: PeriodKey; label: string }[] = [
  { id: 'week', label: 'Last week' },
  { id: 'month', label: 'Last month' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'year', label: 'Last 12 months' }
]

export interface Range {
  start: Date
  end: Date
}
export interface Period extends Range {
  prev: Range
  buckets: 'day' | 'week' | 'month'
  label: string
  vs: string
}

// ---- dates ------------------------------------------------------------------

export const day0 = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1)
export const fmt = (d: Date, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string =>
  d.toLocaleDateString(undefined, o)
export const at = (iso: string): Date | null => (iso ? new Date(iso) : null)
export const inRange = (d: Date | null, r: Range): boolean => !!d && d >= r.start && d < r.end
export const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 864e5

/** "Kells, Tyler" -> "Tyler Kells" */
export const person = (name: string): string =>
  name.includes(',')
    ? name
        .split(',')
        .map((x) => x.trim())
        .reverse()
        .join(' ')
    : name

export function periodOf(key: PeriodKey, now = new Date()): Period {
  const today = day0(now)
  const tomorrow = addDays(today, 1)
  if (key === 'week') {
    // the last full Monday-to-Sunday week
    const dow = (today.getDay() + 6) % 7
    const start = addDays(today, -dow - 7)
    const end = addDays(start, 7)
    return {
      start,
      end,
      prev: { start: addDays(start, -7), end: start },
      buckets: 'day',
      label: `${fmt(start)} to ${fmt(addDays(end, -1))}`,
      vs: 'vs the week before'
    }
  }
  if (key === 'month') {
    const start = addMonths(today, -1)
    const end = addMonths(today, 0)
    return {
      start,
      end,
      prev: { start: addMonths(today, -2), end: start },
      buckets: 'week',
      label: fmt(start, { month: 'long', year: 'numeric' }),
      vs: 'vs the month before'
    }
  }
  if (key === 'mtd') {
    const start = addMonths(today, 0)
    const span = Math.round((tomorrow.getTime() - start.getTime()) / 864e5)
    const prevStart = addMonths(today, -1)
    return {
      start,
      end: tomorrow,
      prev: { start: prevStart, end: addDays(prevStart, span) },
      buckets: 'week',
      label: `${fmt(start)} to ${fmt(today)}`,
      vs: 'vs the same days last month'
    }
  }
  const start = addMonths(today, -11)
  return {
    start,
    end: tomorrow,
    prev: { start: addMonths(today, -23), end: start },
    buckets: 'month',
    label: `${fmt(start, { month: 'long', year: 'numeric' })} to ${fmt(today)}`,
    vs: 'vs the prior 12 months'
  }
}

export function bucketsOf(p: Period): (Range & { label: string })[] {
  const out: (Range & { label: string })[] = []
  let d = new Date(p.start)
  while (d < p.end) {
    const next = p.buckets === 'day' ? addDays(d, 1) : p.buckets === 'week' ? addDays(d, 7) : addMonths(d, 1)
    const end = next < p.end ? next : p.end
    const label =
      p.buckets === 'day'
        ? d.toLocaleDateString(undefined, { weekday: 'short' })
        : p.buckets === 'week'
          ? fmt(d, { month: 'short', day: 'numeric' })
          : d.toLocaleDateString(undefined, { month: 'short' })
    out.push({ start: d, end, label })
    d = next
  }
  return out
}

// ---- counting ---------------------------------------------------------------

export const isDone = (t: TeamTicket): boolean =>
  !t.gone && (!t.active || CLOSED_RE.test(t.state)) && !!(t.resolvedAt || t.closedAt)
export const isOpen = (t: TeamTicket): boolean => !t.gone && t.active && !CLOSED_RE.test(t.state)
/**
 * when the work was finished: the day it was resolved. ServiceNow closes a
 * ticket three days after that on its own, so closed_at would add three days
 * to every ticket; it's only the fallback (cancellations, older data).
 */
export const doneAt = (t: TeamTicket): string => t.resolvedAt || t.closedAt
export const resolveDays = (t: TeamTicket): number => daysBetween(t.openedAt, doneAt(t))
export const replyHours = (t: TeamTicket): number | null =>
  t.firstReplyAt ? (Date.parse(t.firstReplyAt) - Date.parse(t.openedAt)) / 36e5 : null

export function median(sorted: number[]): number | null {
  if (!sorted.length) return null
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** nearest-rank quantile of a sorted list */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

export const sorted = (xs: (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b)

export function statsFor(tickets: TeamTicket[], r: Range) {
  const opened = tickets.filter((t) => inRange(at(t.openedAt), r))
  const resolved = tickets.filter((t) => isDone(t) && inRange(at(doneAt(t)), r))
  const durations = sorted(resolved.map(resolveDays))
  const replies = sorted(opened.map(replyHours))
  const share = (d: number): number | null =>
    durations.length ? durations.filter((x) => x <= d).length / durations.length : null
  return {
    opened,
    resolved,
    durations,
    median: median(durations),
    p90: quantile(durations, 0.9),
    within: { 3: share(3), 7: share(7), 14: share(14), 30: share(30) },
    replyMedian: median(replies),
    /** opened this period, still open, and nobody on the team has answered */
    awaitingReply: opened.filter((t) => t.firstReplyAt === '' && isOpen(t)).length
  }
}

/** how many tickets were open at a moment, from when each opened and was resolved */
export function openAt(tickets: TeamTicket[], when: number): number {
  return tickets.filter(
    (t) =>
      !t.gone &&
      Date.parse(t.openedAt) < when &&
      (isOpen(t) || (isDone(t) && Date.parse(doneAt(t)) >= when))
  ).length
}

export function countBy<T>(list: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const t of list) {
    const k = key(t)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export const trim0 = (s: string): string => s.replace(/\.0$/, '')
export const days = (v: number | null): string =>
  v === null ? 'n/a' : v < 1 ? '<1' : v < 10 ? trim0(v.toFixed(1)) : String(Math.round(v))

/** a span of hours as [number, unit], in minutes, hours or days as it suits */
export function hrsParts(h: number): [string, string] {
  if (h < 1) return [String(Math.max(1, Math.round(h * 60))), 'min']
  if (h < 48) {
    const v = h < 10 ? trim0(h.toFixed(1)) : String(Math.round(h))
    return [v, v === '1' ? 'hr' : 'hrs']
  }
  const d = h / 24
  return [d < 10 ? trim0(d.toFixed(1)) : String(Math.round(d)), 'days']
}
export const hrs = (h: number | null): string => (h === null ? 'n/a' : hrsParts(h).join(' '))

// ---- filters ------------------------------------------------------------------
// Clicking a bar filters the whole page to it. Each chart is drawn from the
// data under every other filter but its own, so it keeps showing the choice
// it offers, with the picked bar lit.

export type Band = [string, number, number]
export const SPEED: Band[] = [
  ['Under a day', 0, 1],
  ['1 to 7 days', 1, 7],
  ['1 to 4 weeks', 7, 30],
  ['1 to 3 months', 30, 90],
  ['Over 3 months', 90, Infinity]
]
export const AGE: Band[] = [
  ['Under 1 week', 0, 7],
  ['1 to 4 weeks', 7, 30],
  ['1 to 3 months', 30, 90],
  ['3 to 6 months', 90, 182],
  ['Over 6 months', 182, Infinity]
]
export const bandOf = (bands: Band[], v: number): string => bands.find(([, a, b]) => v >= a && v < b)?.[0] ?? bands[0][0]

export function outcomeOf(t: TeamTicket): string {
  if (/cancel/i.test(t.state)) return 'Canceled'
  const code = t.closeCode ?? ''
  if (/no response/i.test(code)) return 'No reply from requester'
  return code || 'Resolved'
}

export type Dim = 'person' | 'requester' | 'type' | 'speed' | 'outcome' | 'age' | 'status'
export const DIM_LABEL: Record<Dim, string> = {
  person: 'Team member',
  requester: 'Requester',
  type: 'Request type',
  speed: 'Time to resolve',
  outcome: 'Outcome',
  age: 'Open for',
  status: 'Status'
}
export type Filters = Partial<Record<Dim, string>>
export interface Ctx {
  now: number
  useType: boolean
}

export const who = (t: TeamTicket): string => person(t.assignee) || 'Unassigned'

/** a ticket's value in one dimension; null when the dimension doesn't apply to it */
export function keyOf(dim: Dim, t: TeamTicket, ctx: Ctx): string | null {
  switch (dim) {
    case 'person':
      return who(t)
    case 'requester':
      return person(t.caller) || 'Unknown'
    case 'type': {
      const v = ctx.useType ? t.type : t.channel
      return v && v !== 'None' ? v : 'Not specified'
    }
    case 'speed':
      return isDone(t) ? bandOf(SPEED, resolveDays(t)) : null
    case 'outcome':
      return isDone(t) ? outcomeOf(t) : null
    case 'age':
      return isOpen(t) ? bandOf(AGE, (ctx.now - Date.parse(t.openedAt)) / 864e5) : null
    case 'status':
      return isOpen(t) ? t.state || 'Unknown' : null
  }
}

export function applyFilters(tickets: TeamTicket[], f: Filters, ctx: Ctx, except?: Dim): TeamTicket[] {
  const on = (Object.keys(f) as Dim[]).filter((d) => d !== except && f[d] !== undefined)
  if (!on.length) return tickets
  return tickets.filter((t) => on.every((d) => keyOf(d, t, ctx) === f[d]))
}

/** why an open ticket wants a look, if it does */
export function attentionOf(t: TeamTicket, now: number): string[] {
  const out: string[] = []
  if (!t.assignee) out.push('Unassigned')
  const idle = (now - Date.parse(t.updatedAt)) / 864e5
  if (idle >= 14) out.push(`No update in ${Math.floor(idle)} days`)
  if (t.firstReplyAt === '' && now - Date.parse(t.openedAt) >= 2 * 864e5) out.push('No reply to requester yet')
  if ((t.inquiries ?? 0) > 0) out.push(t.inquiries === 1 ? 'Requester asked for an update' : `Requester asked for updates ${t.inquiries}×`)
  return out
}

export const span = (a: Date, b: Date, o: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, o).formatRange(a, b)

export function snapshotTitle(key: PeriodKey, p: Period): string {
  const last = addDays(p.end, -1)
  if (key === 'week') return `Week of ${span(p.start, last, { month: 'short', day: 'numeric', year: 'numeric' })}`
  if (key === 'month') return fmt(p.start, { month: 'long', year: 'numeric' })
  if (key === 'mtd') return `${fmt(p.start, { month: 'long', year: 'numeric' })} to date`
  return `Last 12 months, ${span(p.start, last, { month: 'short', year: 'numeric' })}`
}

/** the period in a sentence or two, to open the snapshot */
export function headlineOf(key: PeriodKey, p: Period, opened: number, resolved: number, queue: [number, number] | null): string {
  const when =
    key === 'week'
      ? 'Last week'
      : key === 'month'
        ? `In ${fmt(p.start, { month: 'long' })}`
        : key === 'mtd'
          ? 'So far this month'
          : 'Over the last 12 months'
  const came = opened === 0 ? 'no new tickets came in' : `${opened} ${opened === 1 ? 'ticket' : 'tickets'} came in`
  const out = `${when}, ${came} and the team resolved ${resolved === 0 ? 'none' : resolved}.`
  if (!queue) return out
  const [before, now] = queue
  const since = fmt(p.start, { month: 'short', day: 'numeric' })
  const move =
    now === before
      ? `is holding at ${now} since ${since}`
      : `is ${now > before ? 'up' : 'down'} ${Math.abs(now - before)} since ${since}, to ${now}`
  return `${out} The open queue ${move}.`
}
