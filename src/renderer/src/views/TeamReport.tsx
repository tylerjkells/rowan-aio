import { useEffect, useMemo, useRef, useState } from 'react'
import type { TeamDesk, TeamTicket } from '../../../shared/types'
import { UpdateDialog } from './Tickets'

// ---------------------------------------------------------------------------
// Team service report: KPIs for every incident assigned to the RO Operations
// group, for a week, a month, month to date, or the last 12 months, each set
// against the period before it.
// ---------------------------------------------------------------------------

const SN = 'https://support.rowan.edu'
const GROUP = 'e7070a7e1b3256906556edb0604bcb22'
const G = `assignment_group%3D${GROUP}`
/**
 * the group's open queue, plus everything opened or closed in the last 12
 * months. The JSONv2 export sends every field whatever sysparm_fields asks
 * for, so the link doesn't list them; the app keeps only what it reports on.
 */
const TEAM_URL =
  `${SN}/incident_list.do?JSONv2&displayvalue=true` +
  `&sysparm_query=${G}%5Eactive%3Dtrue%5ENQ${G}%5Eopened_at%3E%3Djavascript:gs.beginningOfLast12Months()%5ENQ${G}%5Eclosed_at%3E%3Djavascript:gs.beginningOfLast12Months()%5EORDERBYDESCopened_at`

const CLOSED_RE = /resolved|closed|cancel/i

type PeriodKey = 'week' | 'month' | 'mtd' | 'year'
const PERIODS: { id: PeriodKey; label: string }[] = [
  { id: 'week', label: 'Last week' },
  { id: 'month', label: 'Last month' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'year', label: 'Last 12 months' }
]

interface Range {
  start: Date
  end: Date
}
interface Period extends Range {
  prev: Range
  buckets: 'day' | 'week' | 'month'
  label: string
  vs: string
}

// ---- dates ------------------------------------------------------------------

const day0 = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1)
const fmt = (d: Date, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string =>
  d.toLocaleDateString(undefined, o)
const at = (iso: string): Date | null => (iso ? new Date(iso) : null)
const inRange = (d: Date | null, r: Range): boolean => !!d && d >= r.start && d < r.end
const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 864e5

/** "Kells, Tyler" -> "Tyler Kells" */
const person = (name: string): string =>
  name.includes(',')
    ? name
        .split(',')
        .map((x) => x.trim())
        .reverse()
        .join(' ')
    : name

function periodOf(key: PeriodKey, now = new Date()): Period {
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

function bucketsOf(p: Period): (Range & { label: string })[] {
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

const isDone = (t: TeamTicket): boolean =>
  !t.gone && (!t.active || CLOSED_RE.test(t.state)) && !!(t.resolvedAt || t.closedAt)
const isOpen = (t: TeamTicket): boolean => !t.gone && t.active && !CLOSED_RE.test(t.state)
/**
 * when the work was finished: the day it was resolved. ServiceNow closes a
 * ticket three days after that on its own, so closed_at would add three days
 * to every ticket; it's only the fallback (cancellations, older data).
 */
const doneAt = (t: TeamTicket): string => t.resolvedAt || t.closedAt
const resolveDays = (t: TeamTicket): number => daysBetween(t.openedAt, doneAt(t))
const replyHours = (t: TeamTicket): number | null =>
  t.firstReplyAt ? (Date.parse(t.firstReplyAt) - Date.parse(t.openedAt)) / 36e5 : null

function median(sorted: number[]): number | null {
  if (!sorted.length) return null
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** nearest-rank quantile of a sorted list */
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

const sorted = (xs: (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b)

function statsFor(tickets: TeamTicket[], r: Range) {
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
function openAt(tickets: TeamTicket[], when: number): number {
  return tickets.filter(
    (t) =>
      !t.gone &&
      Date.parse(t.openedAt) < when &&
      (isOpen(t) || (isDone(t) && Date.parse(doneAt(t)) >= when))
  ).length
}

function countBy<T>(list: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const t of list) {
    const k = key(t)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const trim0 = (s: string): string => s.replace(/\.0$/, '')
const days = (v: number | null): string =>
  v === null ? 'n/a' : v < 1 ? '<1' : v < 10 ? trim0(v.toFixed(1)) : String(Math.round(v))

/** a span of hours as [number, unit], in minutes, hours or days as it suits */
function hrsParts(h: number): [string, string] {
  if (h < 1) return [String(Math.max(1, Math.round(h * 60))), 'min']
  if (h < 48) {
    const v = h < 10 ? trim0(h.toFixed(1)) : String(Math.round(h))
    return [v, v === '1' ? 'hr' : 'hrs']
  }
  const d = h / 24
  return [d < 10 ? trim0(d.toFixed(1)) : String(Math.round(d)), 'days']
}
const hrs = (h: number | null): string => (h === null ? 'n/a' : hrsParts(h).join(' '))

// ---- filters ------------------------------------------------------------------
// Clicking a bar filters the whole page to it. Each chart is drawn from the
// data under every other filter but its own, so it keeps showing the choice
// it offers, with the picked bar lit.

type Band = [string, number, number]
const SPEED: Band[] = [
  ['Under a day', 0, 1],
  ['1 to 7 days', 1, 7],
  ['1 to 4 weeks', 7, 30],
  ['1 to 3 months', 30, 90],
  ['Over 3 months', 90, Infinity]
]
const AGE: Band[] = [
  ['Under 1 week', 0, 7],
  ['1 to 4 weeks', 7, 30],
  ['1 to 3 months', 30, 90],
  ['3 to 6 months', 90, 182],
  ['Over 6 months', 182, Infinity]
]
const bandOf = (bands: Band[], v: number): string => bands.find(([, a, b]) => v >= a && v < b)?.[0] ?? bands[0][0]

function outcomeOf(t: TeamTicket): string {
  if (/cancel/i.test(t.state)) return 'Canceled'
  const code = t.closeCode ?? ''
  if (/no response/i.test(code)) return 'No reply from requester'
  return code || 'Resolved'
}

type Dim = 'person' | 'requester' | 'type' | 'speed' | 'outcome' | 'age' | 'status'
const DIM_LABEL: Record<Dim, string> = {
  person: 'Team member',
  requester: 'Requester',
  type: 'Request type',
  speed: 'Time to resolve',
  outcome: 'Outcome',
  age: 'Open for',
  status: 'Status'
}
type Filters = Partial<Record<Dim, string>>
interface Ctx {
  now: number
  useType: boolean
}

const who = (t: TeamTicket): string => person(t.assignee) || 'Unassigned'

/** a ticket's value in one dimension; null when the dimension doesn't apply to it */
function keyOf(dim: Dim, t: TeamTicket, ctx: Ctx): string | null {
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

function applyFilters(tickets: TeamTicket[], f: Filters, ctx: Ctx, except?: Dim): TeamTicket[] {
  const on = (Object.keys(f) as Dim[]).filter((d) => d !== except && f[d] !== undefined)
  if (!on.length) return tickets
  return tickets.filter((t) => on.every((d) => keyOf(d, t, ctx) === f[d]))
}

// ---- pieces -------------------------------------------------------------------

interface BarItem {
  label: string
  value: number
  sub?: string
}

interface Pick {
  /** what the bars filter by, for the button labels */
  what: string
  selected?: string
  onPick: (label: string) => void
}

/** one series of horizontal bars, every value labelled at the bar's end; with a pick, each bar filters the page */
function HBars({
  items,
  series,
  pick,
  empty = 'Nothing in this period.'
}: {
  items: BarItem[]
  series: 'opened' | 'closed'
  pick?: Pick
  empty?: string
}): React.JSX.Element {
  if (!items.length) return <p className="tkr-none">{empty}</p>
  const max = Math.max(...items.map((i) => i.value))
  return (
    <div className={`tkr-hbars ${pick?.selected ? 'has-pick' : ''}`}>
      {items.map((i) => {
        const body = (
          <>
            <span className="tkr-hbar-name">{i.label}</span>
            <span className="tkr-hbar-track">
              <span className={`tkr-hbar-fill tkr-${series}`} style={{ width: `${(i.value / max) * 100}%` }} />
            </span>
            <span className="tkr-hbar-v">
              {i.value}
              {i.sub && <small> {i.sub}</small>}
            </span>
          </>
        )
        const tip = `${i.label}: ${i.value}${i.sub ? ` (${i.sub})` : ''}`
        if (!pick) {
          return (
            <div className="tkr-hbar" key={i.label} title={tip}>
              {body}
            </div>
          )
        }
        const on = pick.selected === i.label
        return (
          <button
            type="button"
            key={i.label}
            className={`tkr-hbar pick ${on ? 'on' : ''}`}
            aria-pressed={on}
            title={on ? `${tip}. Click to clear the ${pick.what.toLowerCase()} filter.` : `${tip}. Click to filter the page to this.`}
            onClick={() => pick.onPick(i.label)}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}

function niceStep(max: number): number {
  const raw = max / 4
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const n = raw / p
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p)
}

/** a column with a 4px rounded data end and a square foot on the baseline */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** opened vs resolved per bucket: two series side by side, one tooltip per bucket */
function OpenedClosed({
  buckets,
  opened,
  closed
}: {
  buckets: { label: string }[]
  opened: number[]
  closed: number[]
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const W = 760
  const H = 250
  const L = 36
  const R = 8
  const T = 18
  const B = 28
  const iw = W - L - R
  const ih = H - T - B
  const max = Math.max(1, ...opened, ...closed)
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const band = iw / buckets.length
  const w = Math.min(24, (band - 12) / 2)
  const pair = w * 2 + 2
  const y = (v: number): number => T + ih - (v / top) * ih
  const labelCaps = buckets.length <= 7
  const ticks: number[] = []
  for (let v = 0; v <= top; v += step) ticks.push(v)

  const legend = (
    <div className="tkr-legend">
      <span>
        <i className="tkr-key tkr-opened" /> Opened
      </span>
      <span>
        <i className="tkr-key tkr-closed" /> Resolved
      </span>
      <button className="link-btn tkr-table-toggle" onClick={() => setAsTable(!asTable)}>
        {asTable ? 'Show chart' : 'Show table'}
      </button>
    </div>
  )

  if (asTable) {
    return (
      <>
        {legend}
        <table className="tkr-table tkr-table-compact">
          <thead>
            <tr>
              <th />
              <th className="num">Opened</th>
              <th className="num">Resolved</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={i}>
                <td>{b.label}</td>
                <td className="num">{opened[i]}</td>
                <td className="num">{closed[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )
  }

  return (
    <>
      {legend}
      <div className="tkr-chart">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Tickets opened and resolved over the period">
          {ticks.map((v) => (
            <g key={v}>
              <line className="tkr-gridline" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
              <text className="tkr-axis" x={L - 8} y={y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x0 = L + i * band + (band - pair) / 2
            return (
              <g key={i}>
                {hover === i && <rect className="tkr-band" x={L + i * band} y={T} width={band} height={ih} />}
                <path className="tkr-col tkr-opened" d={columnPath(x0, y(opened[i]), w, T + ih - y(opened[i]))} />
                <path className="tkr-col tkr-closed" d={columnPath(x0 + w + 2, y(closed[i]), w, T + ih - y(closed[i]))} />
                {labelCaps && opened[i] > 0 && (
                  <text className="tkr-cap" x={x0 + w / 2} y={y(opened[i]) - 5} textAnchor="middle">
                    {opened[i]}
                  </text>
                )}
                {labelCaps && closed[i] > 0 && (
                  <text className="tkr-cap strong" x={x0 + w * 1.5 + 2} y={y(closed[i]) - 5} textAnchor="middle">
                    {closed[i]}
                  </text>
                )}
                <text className="tkr-axis" x={L + i * band + band / 2} y={H - 8} textAnchor="middle">
                  {b.label}
                </text>
                {/* the whole band is the hit target, so nobody has to aim at a bar */}
                <rect
                  className="tkr-hit"
                  x={L + i * band}
                  y={T}
                  width={band}
                  height={ih + B}
                  tabIndex={0}
                  aria-label={`${b.label}: ${opened[i]} opened, ${closed[i]} resolved`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                />
              </g>
            )
          })}
          <line className="tkr-baseline" x1={L} x2={W - R} y1={T + ih} y2={T + ih} />
        </svg>
        {hover !== null && (
          <div
            className="tkr-tip"
            style={{
              left: `${((L + hover * band + band / 2) / W) * 100}%`,
              top: `${(Math.min(y(Math.max(opened[hover], closed[hover])), T + ih - 20) / H) * 100}%`
            }}
          >
            <div className="tkr-tip-head">{buckets[hover].label}</div>
            <div className="tkr-tip-row">
              <i className="tkr-tip-key tkr-opened" />
              <b>{opened[hover]}</b> opened
            </div>
            <div className="tkr-tip-row">
              <i className="tkr-tip-key tkr-closed" />
              <b>{closed[hover]}</b> resolved
            </div>
          </div>
        )}
      </div>
    </>
  )
}


/** the open queue's size at the end of each bucket: one line, the latest value labelled */
function QueueLine({ points }: { points: { label: string; value: number }[] }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const W = 360
  const H = 250
  const L = 32
  const R = 22
  const T = 22
  const B = 28
  const iw = W - L - R
  const ih = H - T - B
  const n = points.length
  const max = Math.max(1, ...points.map((p) => p.value))
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const x = (i: number): number => L + (n <= 1 ? iw / 2 : (i * iw) / (n - 1))
  const y = (v: number): number => T + ih - (v / top) * ih
  const ticks: number[] = []
  for (let v = 0; v <= top; v += step) ticks.push(v)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('')
  const area = n ? `${line}L${x(n - 1)},${T + ih}L${x(0)},${T + ih}Z` : ''
  // a label on every other point once they crowd
  const every = n > 8 ? 2 : 1
  const last = n - 1
  const half = n > 1 ? iw / (n - 1) / 2 : iw / 2

  const toggle = (
    <div className="tkr-legend">
      <button className="link-btn tkr-table-toggle" onClick={() => setAsTable(!asTable)}>
        {asTable ? 'Show chart' : 'Show table'}
      </button>
    </div>
  )
  if (asTable) {
    return (
      <>
        {toggle}
        <table className="tkr-table tkr-table-compact">
          <thead>
            <tr>
              <th />
              <th className="num">Open at the end</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <td>{p.label}</td>
                <td className="num">{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )
  }
  return (
    <>
      {toggle}
      <div className="tkr-chart tkr-opened">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Open tickets at the end of each part of the period">
          {ticks.map((v) => (
            <g key={v}>
              <line className="tkr-gridline" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
              <text className="tkr-axis" x={L - 8} y={y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            (last - i) % every === 0 ? (
              <text key={i} className="tkr-axis" x={x(i)} y={H - 8} textAnchor="middle">
                {p.label}
              </text>
            ) : null
          )}
          {hover !== null && <line className="tkr-cross" x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} />}
          <path className="tkr-area" d={area} />
          <path className="tkr-line" d={line} />
          <line className="tkr-baseline" x1={L} x2={W - R} y1={T + ih} y2={T + ih} />
          {n > 0 && (
            <>
              <circle className="tkr-dot" cx={x(last)} cy={y(points[last].value)} r={4} />
              <text className="tkr-cap strong" x={x(last)} y={y(points[last].value) - 10} textAnchor="middle">
                {points[last].value}
              </text>
            </>
          )}
          {hover !== null && hover !== last && <circle className="tkr-dot" cx={x(hover)} cy={y(points[hover].value)} r={4} />}
          {points.map((p, i) => (
            <rect
              key={i}
              className="tkr-hit"
              x={x(i) - half}
              y={T}
              width={half * 2}
              height={ih + B}
              tabIndex={0}
              aria-label={`${p.label}: ${p.value} open`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            // at either end the tip hangs inward, so it stays inside the card
            className={`tkr-tip ${hover === 0 && n > 1 ? 'from-left' : hover === last && n > 1 ? 'from-right' : ''}`}
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${(Math.min(y(points[hover].value), T + ih - 20) / H) * 100}%`
            }}
          >
            <div className="tkr-tip-head">{points[hover].label}</div>
            <div className="tkr-tip-row">
              <i className="tkr-tip-key tkr-opened" />
              <b>{points[hover].value}</b> open at the end
            </div>
          </div>
        )}
      </div>
    </>
  )
}

interface TeamRow {
  label: string
  resolved: number
  median: number | null
  reply: number | null
  open: number
}

/** each team member's period: what they resolved, how fast, first replies, and what's on their plate */
function TeamTable({ rows, pick, showReply }: { rows: TeamRow[]; pick: Pick; showReply: boolean }): React.JSX.Element {
  if (!rows.length) return <p className="tkr-none">Nothing in this period.</p>
  const maxRes = Math.max(1, ...rows.map((r) => r.resolved))
  const maxOpen = Math.max(1, ...rows.map((r) => r.open))
  return (
    <div className="tkr-table-wrap">
      <table className={`tkr-table tkr-team ${pick.selected ? 'has-pick' : ''}`}>
        <thead>
          <tr>
            <th>Team member</th>
            <th>Resolved</th>
            <th className="num">Median to resolve</th>
            {showReply && <th className="num">Median first reply</th>}
            <th>Open now</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = pick.selected === r.label
            return (
              <tr key={r.label} className={on ? 'on' : ''}>
                <td>
                  <button
                    type="button"
                    className="tkr-pick-name"
                    aria-pressed={on}
                    title={on ? 'Click to clear the team member filter.' : `Filter the page to ${r.label}.`}
                    onClick={() => pick.onPick(r.label)}
                  >
                    {r.label}
                  </button>
                </td>
                <td className="tkr-inbar-cell">
                  <span className="tkr-inbar">
                    {r.resolved > 0 && <i className="tkr-closed" style={{ width: `${(r.resolved / maxRes) * 100}%` }} />}
                  </span>
                  <b>{r.resolved}</b>
                </td>
                <td className="num">{r.median === null ? '–' : `${days(r.median)} d`}</td>
                {showReply && <td className="num">{r.reply === null ? '–' : hrs(r.reply)}</td>}
                <td className="tkr-inbar-cell">
                  <span className="tkr-inbar">
                    {r.open > 0 && <i className="tkr-opened" style={{ width: `${(r.open / maxOpen) * 100}%` }} />}
                  </span>
                  <b>{r.open}</b>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const link = (t: TeamTicket): React.JSX.Element =>
  t.sysId ? (
    <a href={`${SN}/nav_to.do?uri=${encodeURIComponent('/incident.do?sys_id=' + t.sysId)}`} target="_blank" rel="noreferrer">
      {t.number}
    </a>
  ) : (
    <>{t.number}</>
  )
const short = (iso: string): string => fmt(new Date(iso), { month: 'short', day: 'numeric', year: '2-digit' })

/** why an open ticket wants a look, if it does */
function attentionOf(t: TeamTicket, now: number): string[] {
  const out: string[] = []
  if (!t.assignee) out.push('Unassigned')
  const idle = (now - Date.parse(t.updatedAt)) / 864e5
  if (idle >= 14) out.push(`No update in ${Math.floor(idle)} days`)
  if (t.firstReplyAt === '' && now - Date.parse(t.openedAt) >= 2 * 864e5) out.push('No reply to requester yet')
  if ((t.inquiries ?? 0) > 0) out.push(t.inquiries === 1 ? 'Requester asked for an update' : `Requester asked for updates ${t.inquiries}×`)
  return out
}

// ---- the view -------------------------------------------------------------------

export function TeamReport({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [desk, setDesk] = useState<TeamDesk | null>(null)
  const [period, setPeriod] = useState<PeriodKey>(
    () => (localStorage.getItem('teamPeriod') as PeriodKey | null) ?? 'month'
  )
  const [filters, setFilters] = useState<Filters>({})
  const [queueView, setQueueView] = useState<'attention' | 'oldest'>('attention')
  const [queueAll, setQueueAll] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [presenting, setPresenting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.scribe.team.get().then(setDesk)
  }, [])

  // presenting hides the app's chrome and goes full screen; leaving full
  // screen (Esc) ends it
  useEffect(() => {
    document.documentElement.classList.toggle('tkr-presenting', presenting)
    if (!presenting) return
    const onChange = (): void => {
      if (!document.fullscreenElement) setPresenting(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [presenting])
  useEffect(() => () => document.documentElement.classList.remove('tkr-presenting'), [])

  function present(): void {
    setPresenting(true)
    document.documentElement.requestFullscreen?.().catch(() => {})
  }

  function stopPresenting(): void {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    setPresenting(false)
  }

  function changePeriod(p: PeriodKey): void {
    setPeriod(p)
    localStorage.setItem('teamPeriod', p)
  }

  /** click a bar to filter to it; click it again to let go */
  function pickFor(dim: Dim): Pick {
    return {
      what: DIM_LABEL[dim],
      selected: filters[dim],
      onPick: (label) =>
        setFilters((f) => {
          const next = { ...f }
          if (next[dim] === label) delete next[dim]
          else next[dim] = label
          return next
        })
    }
  }

  const tickets = desk?.tickets ?? []
  const p = useMemo(() => periodOf(period), [period])
  const coverage = desk?.coverageStart ? new Date(desk.coverageStart) : null
  const covered = (r: Range): boolean => !!coverage && coverage <= r.start

  const report = useMemo(() => {
    if (!tickets.length) return null
    const now = Date.now()
    // request type when enough tickets carry one, otherwise how they came in;
    // decided on all the data so a filter on it holds across periods
    const typed = tickets.filter((t) => t.type && t.type !== 'None').length
    const ctx: Ctx = { now, useType: typed / tickets.length >= 0.3 }
    const except = (dim?: Dim): TeamTicket[] => applyFilters(tickets, filters, ctx, dim)
    const all = except()
    const cur = statsFor(all, p)
    const prev = statsFor(all, p.prev)
    const open = all.filter(isOpen)
    const buckets = bucketsOf(p)

    // team members: each chart below leaves its own filter out
    const tp = except('person')
    const tpCur = statsFor(tp, p)
    const tpOpen = tp.filter(isOpen)
    const team: TeamRow[] = [...new Set([...tpCur.resolved, ...tpOpen].map(who))]
      .map((label) => ({
        label,
        resolved: tpCur.resolved.filter((t) => who(t) === label).length,
        median: median(sorted(tpCur.resolved.filter((t) => who(t) === label).map(resolveDays))),
        reply: median(sorted(tpCur.opened.filter((t) => who(t) === label).map(replyHours))),
        open: tpOpen.filter((t) => who(t) === label).length
      }))
      .sort((a, b) => b.resolved - a.resolved || b.open - a.open || a.label.localeCompare(b.label))

    const rq = statsFor(except('requester'), p).opened
    const byRequester = countBy(rq, (t) => keyOf('requester', t, ctx)!)
    const top = byRequester.slice(0, 8)

    const ty = statsFor(except('type'), p)
    const typeOf = (t: TeamTicket): string => keyOf('type', t, ctx)!
    const byType = countBy(ty.opened, typeOf)
      .slice(0, 8)
      .map(([label, value]) => {
        const md = median(sorted(ty.resolved.filter((t) => typeOf(t) === label).map(resolveDays)))
        return { label, value, sub: md === null ? undefined : `median ${days(md)}d` }
      })

    const sp = statsFor(except('speed'), p)
    const byTime = SPEED.map(([label]) => ({
      label,
      value: sp.resolved.filter((t) => keyOf('speed', t, ctx) === label).length
    })).filter((x) => x.value)

    const oc = statsFor(except('outcome'), p).resolved
    const byOutcome = countBy(oc, (t) => keyOf('outcome', t, ctx)!).map(([label, value]) => ({
      label,
      value,
      sub: `${Math.round((value / oc.length) * 100)}%`
    }))

    const ag = except('age').filter(isOpen)
    const byAge = AGE.map(([label]) => ({ label, value: ag.filter((t) => keyOf('age', t, ctx) === label).length })).filter(
      (x) => x.value
    )
    const byState = countBy(except('status').filter(isOpen), (t) => t.state || 'Unknown').map(([label, value]) => ({
      label,
      value
    }))

    const ageOf = (t: TeamTicket): number => (now - Date.parse(t.openedAt)) / 864e5
    const queue = open
      .map((t) => ({ t, age: ageOf(t), idle: (now - Date.parse(t.updatedAt)) / 864e5, why: attentionOf(t, now) }))
      .sort((a, b) => b.age - a.age)

    return {
      ctx,
      cur,
      prev,
      open,
      openAtStart: openAt(all, p.start.getTime()),
      buckets,
      openedSeries: buckets.map((b) => all.filter((t) => inRange(at(t.openedAt), b)).length),
      closedSeries: buckets.map((b) => all.filter((t) => isDone(t) && inRange(at(doneAt(t)), b)).length),
      queueSeries: buckets.map((b) => ({ label: b.label, value: openAt(all, Math.min(b.end.getTime(), now)) })),
      team,
      byRequester: top.map(([label, value]) => ({ label, value })),
      topShare: rq.length ? top.reduce((a, [, v]) => a + v, 0) / rq.length : null,
      requesterCount: byRequester.length,
      useType: ctx.useType,
      byType,
      byTime,
      speed: sp,
      byOutcome,
      reopened: cur.resolved.filter((t) => (t.reopens ?? 0) > 0).length,
      reassigned: cur.resolved.filter((t) => (t.reassignments ?? 0) > 0).length,
      chased: cur.opened.filter((t) => (t.inquiries ?? 0) > 0).length,
      byAge,
      byState,
      attention: queue.filter((x) => x.why.length),
      oldest: queue,
      hasReplies: tickets.some((t) => t.firstReplyAt !== undefined),
      hasResolved: tickets.some((t) => t.resolvedAt !== undefined)
    }
  }, [tickets, p, filters])

  /** change vs an earlier figure, coloured by whether that direction is good */
  function delta(
    cur: number | null,
    prev: number | null,
    opts: { goodUp?: boolean; unit?: string; pct?: boolean; dec?: number; fmt?: (abs: number) => string; vs?: string; cover?: Range } = {}
  ): React.JSX.Element {
    const { goodUp = true, unit = '', pct = false, dec = 0, fmt: fmtAbs, vs = p.vs, cover = p.prev } = opts
    if (!covered(cover) || cur === null || prev === null) return <span className="tkr-delta">No prior data yet</span>
    const diff = cur - prev
    const abs = Math.abs(diff)
    const zero = fmtAbs ? abs < 1 / 60 : pct ? Math.round(abs * 100) === 0 : Number(abs.toFixed(dec)) === 0
    if (zero) return <span className="tkr-delta">Same as before</span>
    const good = goodUp ? diff > 0 : diff < 0
    const size = fmtAbs ? fmtAbs(abs) : pct ? `${Math.round(abs * 100)} pts` : `${abs.toFixed(dec)}${unit}`
    return (
      <span className={`tkr-delta ${good ? 'good' : 'bad'}`}>
        {diff > 0 ? '▲' : '▼'} {size} {vs}
      </span>
    )
  }

  const toolbar = (
    <div className="cuc-toolbar tkr-toolbar">
      {!presenting && (
        <button className="btn btn-ghost tkr-back" onClick={onBack}>
          ‹ My tickets
        </button>
      )}
      <h2 className="cuc-title">RO Operations service report</h2>
      <div className="mode-toggle view-toggle tkr-periods" role="radiogroup" aria-label="Period">
        {PERIODS.map((x) => (
          <button
            key={x.id}
            className={period === x.id ? 'active' : ''}
            role="radio"
            aria-checked={period === x.id}
            onClick={() => changePeriod(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <span className="mailc-read-bar-gap" />
      {presenting ? (
        <button className="btn" onClick={stopPresenting}>
          Exit present
        </button>
      ) : (
        <>
          {tickets.length > 0 && (
            <button className="btn btn-ghost" onClick={present} title="Full screen, without the app's sidebar">
              Present
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => setUpdating(true)}
            title="Bring in the group's latest tickets from ServiceNow"
          >
            Update
          </button>
        </>
      )}
    </div>
  )

  const dialog = updating && (
    <UpdateDialog
      title="Update team data from ServiceNow"
      link={TEAM_URL}
      linkLabel="Open RO Operations tickets in ServiceNow"
      hint="Each update adds to the history already here, so trends build up over time."
      runUpdate={(text) => (text ? window.scribe.team.apply(text) : window.scribe.team.applyClipboard())}
      onClose={() => setUpdating(false)}
      onApplied={(r) => {
        setDesk(r.desk)
        setUpdating(false)
        const s = r.summary
        setBanner(
          `Updated from ${s.count} tickets: ${s.added} new, ${s.changed} changed${s.left ? `, ${s.left} no longer in the group's queue` : ''}.`
        )
      }}
    />
  )

  if (!desk) {
    return (
      <div className="tkr" ref={rootRef}>
        {toolbar}
        <p className="cuc-empty">Loading…</p>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="tkr" ref={rootRef}>
        {toolbar}
        <div className="empty-state">
          <h2>No team data yet</h2>
          <p>
            The service report counts every incident assigned to the RO Operations group: what came
            in, what got resolved and how fast, how quickly requesters heard back, who did the work,
            and what&apos;s still waiting. Load the group&apos;s tickets from ServiceNow to start.
          </p>
          <button className="btn btn-primary" onClick={() => setUpdating(true)}>
            Update team data
          </button>
        </div>
        {dialog}
      </div>
    )
  }

  const { cur, prev, open } = report
  const bucketWord = p.buckets === 'day' ? 'By day' : p.buckets === 'week' ? 'By week' : 'By month'
  const endWord = p.buckets === 'day' ? 'day' : p.buckets === 'week' ? 'week' : 'month'
  const chips = (Object.keys(filters) as Dim[]).filter((d) => filters[d] !== undefined)
  const pctOf = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`)
  const [replyNum, replyUnit] = cur.replyMedian === null ? ['n/a', ''] : hrsParts(cur.replyMedian)
  const queueRows = queueView === 'attention' ? report.attention : report.oldest
  const sp = report.speed

  return (
    <div className={`tkr ${presenting ? 'presenting' : ''}`} ref={rootRef}>
      {toolbar}
      <div className="tkr-scroll">
        {banner && !presenting && (
          <div className="tk-banner tkr-banner" role="status">
            <span>{banner}</span>
            <button className="mailc-ic" onClick={() => setBanner(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {!report.hasResolved && !presenting && (
          <div className="tk-banner tkr-banner" role="note">
            <span>
              Update once more to bring in resolve dates, first replies and outcomes. Until then,
              times run to when ServiceNow closed each ticket, three days after it was resolved.
            </span>
          </div>
        )}
        <p className="tkr-range">
          <b>{p.label}</b>
          {!covered(p) && coverage && (
            <span> (data starts {fmt(coverage)}, so this period is only partly covered)</span>
          )}
          {desk.syncedAt && (
            <span className="tkr-asof">
              Data as of{' '}
              {new Date(desk.syncedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}
            </span>
          )}
          {!presenting && chips.length === 0 && <span className="tkr-hint">Click a bar or a name to filter the page</span>}
        </p>
        {chips.length > 0 && (
          <div className="tkr-filters" role="group" aria-label="Filters">
            <span className="tkr-filters-label">Filtered to</span>
            {chips.map((d) => (
              <button
                key={d}
                type="button"
                className="tkr-chip"
                onClick={() => pickFor(d).onPick(filters[d]!)}
                aria-label={`Remove the filter ${DIM_LABEL[d]}: ${filters[d]}`}
              >
                <span className="tkr-chip-dim">{DIM_LABEL[d]}</span>
                {filters[d]}
                <span className="tkr-chip-x" aria-hidden="true">
                  ×
                </span>
              </button>
            ))}
            {chips.length > 1 && (
              <button type="button" className="link-btn tkr-clear" onClick={() => setFilters({})}>
                Clear all
              </button>
            )}
          </div>
        )}

        <section className="tkr-kpis" aria-label="Key numbers">
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Tickets opened</span>
            <span className="tkr-kpi-value">{cur.opened.length}</span>
            {delta(cur.opened.length, prev.opened.length, { goodUp: false })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Tickets resolved</span>
            <span className="tkr-kpi-value">{cur.resolved.length}</span>
            {delta(cur.resolved.length, prev.resolved.length)}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Median time to resolve</span>
            <span className="tkr-kpi-value">
              {days(cur.median)}
              {cur.median !== null && <small> {days(cur.median) === '<1' || days(cur.median) === '1' ? 'day' : 'days'}</small>}
            </span>
            {delta(cur.median, prev.median, { goodUp: false, unit: ' days', dec: 1 })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Median first reply</span>
            <span className="tkr-kpi-value">
              {report.hasReplies ? replyNum : 'n/a'}
              {report.hasReplies && replyUnit && <small> {replyUnit}</small>}
            </span>
            {report.hasReplies ? (
              delta(cur.replyMedian, prev.replyMedian, { goodUp: false, fmt: hrs })
            ) : (
              <span className="tkr-delta">Fills in on the next update</span>
            )}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Resolved within 14 days</span>
            <span className="tkr-kpi-value">{pctOf(cur.within[14])}</span>
            {delta(cur.within[14], prev.within[14], { pct: true })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Open right now</span>
            <span className="tkr-kpi-value">{open.length}</span>
            {delta(open.length, report.openAtStart, {
              goodUp: false,
              vs: `since ${fmt(p.start, { month: 'short', day: 'numeric' })}`,
              cover: p
            })}
          </div>
        </section>

        <div className="tkr-grid">
          <section className="tkr-card span-8">
            <h3>Opened vs resolved</h3>
            <p className="tkr-note">{bucketWord}. Resolved bars taller than opened means the queue is shrinking.</p>
            <OpenedClosed buckets={report.buckets} opened={report.openedSeries} closed={report.closedSeries} />
          </section>
          <section className="tkr-card span-4">
            <h3>Open queue</h3>
            <p className="tkr-note">Tickets open at the end of each {endWord}.</p>
            <QueueLine points={report.queueSeries} />
          </section>

          {/* ahead of Team members so it pairs with Open queue when the page narrows */}
          <section className="tkr-card span-4">
            <h3>How tickets ended</h3>
            <p className="tkr-note">Tickets resolved this period.</p>
            <HBars items={report.byOutcome} series="closed" pick={pickFor('outcome')} />
            {(report.chased > 0 || report.reopened > 0 || report.reassigned > 0) && (
              <ul className="tkr-facts">
                {report.chased > 0 && (
                  <li>
                    <b>{report.chased}</b> opened this period had the requester ask for an update
                  </li>
                )}
                {report.reopened > 0 && (
                  <li>
                    <b>{report.reopened}</b> reopened after being resolved
                  </li>
                )}
                {report.reassigned > 0 && (
                  <li>
                    <b>{report.reassigned}</b> moved between assignment groups
                  </li>
                )}
              </ul>
            )}
          </section>
          <section className="tkr-card span-8">
            <h3>Team members</h3>
            <p className="tkr-note">
              Resolved this period and open now, by who each ticket is assigned to. Click a name to
              filter the page to them.
            </p>
            <TeamTable rows={report.team} pick={pickFor('person')} showReply={report.hasReplies} />
          </section>

          <section className="tkr-card span-4">
            <h3>Time to resolve</h3>
            <p className="tkr-note">How long this period&apos;s resolved tickets were open.</p>
            <HBars items={report.byTime} series="closed" pick={pickFor('speed')} />
            {sp.durations.length > 0 && (
              <p className="tkr-stats">
                Within 3 days <b>{pctOf(sp.within[3])}</b> · 7 days <b>{pctOf(sp.within[7])}</b> · 30 days{' '}
                <b>{pctOf(sp.within[30])}</b>
                <br />9 in 10 resolved within <b>{days(sp.p90)} days</b>
              </p>
            )}
          </section>
          <section className="tkr-card span-4">
            <h3>{report.useType ? 'Request types' : 'How requests came in'}</h3>
            <p className="tkr-note">
              Opened this period, {report.useType ? 'by request type' : 'by channel'}, with the median days to
              resolve each.
            </p>
            <HBars items={report.byType} series="opened" pick={pickFor('type')} />
          </section>
          <section className="tkr-card span-4">
            <h3>Top requesters</h3>
            <p className="tkr-note">
              {report.topShare !== null && report.requesterCount > report.byRequester.length
                ? `These ${report.byRequester.length} opened ${pctOf(report.topShare)} of this period's tickets.`
                : 'Who opened the most tickets this period.'}
            </p>
            <HBars items={report.byRequester} series="opened" pick={pickFor('requester')} />
          </section>

          <section className="tkr-card span-6">
            <h3>Open queue by age</h3>
            <p className="tkr-note">Everything open right now, whatever the period.</p>
            <HBars items={report.byAge} series="opened" pick={pickFor('age')} empty="Nothing open." />
          </section>
          <section className="tkr-card span-6 md-12">
            <h3>Open queue by status</h3>
            <p className="tkr-note">Everything open right now, whatever the period.</p>
            <HBars items={report.byState} series="opened" pick={pickFor('status')} empty="Nothing open." />
          </section>

          <section className="tkr-card span-12">
            <div className="tkr-card-head">
              <h3>{queueView === 'attention' ? `Needs attention (${report.attention.length})` : `Oldest open (${open.length})`}</h3>
              <div className="mode-toggle view-toggle tkr-periods" role="radiogroup" aria-label="Which open tickets">
                <button
                  className={queueView === 'attention' ? 'active' : ''}
                  role="radio"
                  aria-checked={queueView === 'attention'}
                  onClick={() => setQueueView('attention')}
                >
                  Needs attention
                </button>
                <button
                  className={queueView === 'oldest' ? 'active' : ''}
                  role="radio"
                  aria-checked={queueView === 'oldest'}
                  onClick={() => setQueueView('oldest')}
                >
                  Oldest open
                </button>
              </div>
            </div>
            <p className="tkr-note">
              {queueView === 'attention'
                ? 'Open tickets that are unassigned, quiet for 14 days or more, still waiting on a first reply, or chased by the requester. Oldest first.'
                : 'Everything open right now, oldest first.'}
            </p>
            {queueRows.length === 0 ? (
              <p className="tkr-none">{queueView === 'attention' ? 'Nothing needs attention.' : 'The queue is clear.'}</p>
            ) : (
              <div className="tkr-table-wrap">
                <table className="tkr-table">
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Request</th>
                      <th>Requester</th>
                      <th>Assigned to</th>
                      <th className="num">Open</th>
                      <th className="num">Last update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(queueAll ? queueRows : queueRows.slice(0, 10)).map(({ t, age, idle, why }) => (
                      <tr key={t.number}>
                        <td>{link(t)}</td>
                        <td>
                          {t.title}
                          {why.length > 0 && (
                            <span className="tkr-tags">
                              {why.map((w) => (
                                <span className="tkr-tag" key={w}>
                                  {w}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td>{person(t.caller)}</td>
                        <td>{person(t.assignee) || 'Unassigned'}</td>
                        <td className="num">{Math.floor(age)} d</td>
                        <td className="num">{idle < 1 ? 'Today' : `${Math.floor(idle)} d ago`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queueRows.length > 10 && (
                  <button className="link-btn tkr-more" onClick={() => setQueueAll(!queueAll)}>
                    {queueAll ? 'Show the first 10' : `Show all ${queueRows.length}`}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="tkr-card span-12">
            <h3>Tickets resolved this period ({cur.resolved.length})</h3>
            <p className="tkr-note">Newest first.</p>
            {cur.resolved.length === 0 ? (
              <p className="tkr-none">No tickets resolved in this period.</p>
            ) : (
              <div className="tkr-table-wrap">
                <table className="tkr-table">
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Request</th>
                      <th>Requester</th>
                      <th>Assigned to</th>
                      <th className="num">Opened</th>
                      <th className="num">Resolved</th>
                      <th className="num">Days</th>
                      {report.hasReplies && <th className="num">First reply</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {cur.resolved
                      .slice()
                      .sort((a, b) => Date.parse(doneAt(b)) - Date.parse(doneAt(a)))
                      .map((t) => {
                        const outcome = outcomeOf(t)
                        const by = t.resolvedBy && t.resolvedBy !== t.assignee ? person(t.resolvedBy) : ''
                        const reply = replyHours(t)
                        return (
                          <tr key={t.number}>
                            <td>{link(t)}</td>
                            <td>
                              {t.title}
                              {outcome !== 'Resolved' && (
                                <span className="tkr-tags">
                                  <span className="tkr-tag">{outcome}</span>
                                </span>
                              )}
                            </td>
                            <td>{person(t.caller)}</td>
                            <td>
                              {person(t.assignee) || 'Unassigned'}
                              {by && <span className="tkr-sub">Resolved by {by}</span>}
                            </td>
                            <td className="num">{short(t.openedAt)}</td>
                            <td className="num">{short(doneAt(t))}</td>
                            <td className="num">{days(Math.max(0, resolveDays(t)))}</td>
                            {report.hasReplies && <td className="num">{reply === null ? '–' : hrs(reply)}</td>}
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <p className="tkr-foot">
          Source: support.rowan.edu, RO Operations assignment group. Resolve times run from when a
          ticket was opened to when it was marked resolved. First reply is the team&apos;s first
          comment the requester could see.
          {coverage && ` History from ${fmt(coverage, { month: 'long', year: 'numeric' })}.`}
        </p>
      </div>
      {dialog}
    </div>
  )
}
