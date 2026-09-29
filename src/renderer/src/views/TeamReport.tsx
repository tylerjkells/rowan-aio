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
/** the group's open queue, plus everything opened or closed in the last 12 months */
const TEAM_URL =
  `${SN}/incident_list.do?JSONv2&displayvalue=true` +
  '&sysparm_fields=number,sys_id,short_description,caller_id,assigned_to,state,active,opened_at,closed_at,resolved_at,sys_updated_on,u_incident_item,contact_type' +
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

const isDone = (t: TeamTicket): boolean => !t.gone && (!t.active || CLOSED_RE.test(t.state)) && !!t.closedAt
const isOpen = (t: TeamTicket): boolean => !t.gone && t.active && !CLOSED_RE.test(t.state)

function median(sorted: number[]): number | null {
  if (!sorted.length) return null
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

function statsFor(tickets: TeamTicket[], r: Range) {
  const opened = tickets.filter((t) => inRange(at(t.openedAt), r))
  const closed = tickets.filter((t) => isDone(t) && inRange(at(t.closedAt), r))
  const durations = closed
    .map((t) => daysBetween(t.openedAt, t.closedAt))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b)
  return {
    opened,
    closed,
    durations,
    median: median(durations),
    within14: durations.length ? durations.filter((x) => x <= 14).length / durations.length : null
  }
}

function countBy<T>(list: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const t of list) {
    const k = key(t)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const days = (v: number | null): string => (v === null ? 'n/a' : v < 1 ? '<1' : v < 10 ? v.toFixed(1) : String(Math.round(v)))

// ---- pieces -------------------------------------------------------------------

interface BarItem {
  label: string
  value: number
  sub?: string
}

/** one series of horizontal bars, every value labelled at the bar's end */
function HBars({ items, series }: { items: BarItem[]; series: 'opened' | 'closed' }): React.JSX.Element {
  if (!items.length) return <p className="tkr-none">Nothing in this period.</p>
  const max = Math.max(...items.map((i) => i.value))
  return (
    <div className="tkr-hbars">
      {items.map((i) => (
        <div className="tkr-hbar" key={i.label} title={`${i.label}: ${i.value}${i.sub ? ` (${i.sub})` : ''}`}>
          <span className="tkr-hbar-name">{i.label}</span>
          <span className="tkr-hbar-track">
            <span className={`tkr-hbar-fill tkr-${series}`} style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="tkr-hbar-v">
            {i.value}
            {i.sub && <small> {i.sub}</small>}
          </span>
        </div>
      ))}
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

/** opened vs closed per bucket: two series side by side, one tooltip per bucket */
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
        <i className="tkr-key tkr-closed" /> Closed
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
              <th className="num">Closed</th>
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
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Tickets opened and closed over the period">
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
                  aria-label={`${b.label}: ${opened[i]} opened, ${closed[i]} closed`}
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
              <b>{closed[hover]}</b> closed
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ---- the view -------------------------------------------------------------------

export function TeamReport({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [desk, setDesk] = useState<TeamDesk | null>(null)
  const [period, setPeriod] = useState<PeriodKey>(
    () => (localStorage.getItem('teamPeriod') as PeriodKey | null) ?? 'month'
  )
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

  const tickets = desk?.tickets ?? []
  const p = useMemo(() => periodOf(period), [period])
  const coverage = desk?.coverageStart ? new Date(desk.coverageStart) : null
  const covered = (r: Range): boolean => !!coverage && coverage <= r.start

  const report = useMemo(() => {
    if (!tickets.length) return null
    const cur = statsFor(tickets, p)
    const prev = statsFor(tickets, p.prev)
    const open = tickets.filter(isOpen)
    const now = Date.now()
    const ages = open.map((t) => (now - Date.parse(t.openedAt)) / 864e5).filter((x) => Number.isFinite(x))
    const buckets = bucketsOf(p)
    const byAssignee = countBy(cur.closed, (t) => person(t.assignee) || 'Unassigned').map(([label, value]) => {
      const d = cur.closed
        .filter((t) => (person(t.assignee) || 'Unassigned') === label)
        .map((t) => daysBetween(t.openedAt, t.closedAt))
        .sort((a, b) => a - b)
      const md = median(d)
      return { label, value, sub: md === null ? undefined : `median ${md < 1 ? '<1' : Math.round(md)}d` }
    })
    // request type when enough tickets carry one, otherwise how they came in
    const typed = cur.opened.filter((t) => t.type).length
    const useType = cur.opened.length > 0 && typed / cur.opened.length >= 0.3
    const bin = (values: number[], edges: [string, number, number][]): BarItem[] =>
      edges.map(([label, a, b]) => ({ label, value: values.filter((x) => x >= a && x < b).length })).filter((x) => x.value)
    return {
      cur,
      prev,
      open,
      ages,
      buckets,
      openedSeries: buckets.map((b) => tickets.filter((t) => inRange(at(t.openedAt), b)).length),
      closedSeries: buckets.map((b) => tickets.filter((t) => isDone(t) && inRange(at(t.closedAt), b)).length),
      byAssignee,
      byRequester: countBy(cur.opened, (t) => person(t.caller) || 'Unknown')
        .slice(0, 8)
        .map(([label, value]) => ({ label, value })),
      useType,
      byType: countBy(cur.opened, (t) => (useType ? t.type : t.channel) || 'Not specified')
        .slice(0, 8)
        .map(([label, value]) => ({ label, value })),
      byAge: bin(ages, [
        ['Under 1 week', 0, 7],
        ['1 to 4 weeks', 7, 30],
        ['1 to 3 months', 30, 90],
        ['3 to 6 months', 90, 182],
        ['Over 6 months', 182, Infinity]
      ]),
      byTime: bin(cur.durations, [
        ['Same day', 0, 1],
        ['1 to 7 days', 1, 7],
        ['8 to 30 days', 7, 30],
        ['31 to 90 days', 30, 90],
        ['Over 90 days', 90, Infinity]
      ]),
      byState: countBy(open, (t) => t.state || 'Unknown').map(([label, value]) => ({ label, value }))
    }
  }, [tickets, p])

  /** change vs the previous period, coloured by whether that direction is good */
  function delta(
    cur: number | null,
    prev: number | null,
    opts: { goodUp?: boolean; unit?: string; pct?: boolean; dec?: number } = {}
  ): React.JSX.Element {
    const { goodUp = true, unit = '', pct = false, dec = 0 } = opts
    if (!covered(p.prev) || cur === null || prev === null) return <span className="tkr-delta">No prior data yet</span>
    const diff = cur - prev
    const shown = pct ? Math.round(Math.abs(diff) * 100) : Number(Math.abs(diff).toFixed(dec))
    if (shown === 0) return <span className="tkr-delta">Same as before</span>
    const good = goodUp ? diff > 0 : diff < 0
    const size = pct ? `${shown} pts` : `${Math.abs(diff).toFixed(dec)}${unit}`
    return (
      <span className={`tkr-delta ${good ? 'good' : 'bad'}`}>
        {diff > 0 ? '▲' : '▼'} {size} {p.vs}
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
            in, what got closed and how fast, who closed it, and what&apos;s still waiting. Load the
            group&apos;s tickets from ServiceNow to start.
          </p>
          <button className="btn btn-primary" onClick={() => setUpdating(true)}>
            Update team data
          </button>
        </div>
        {dialog}
      </div>
    )
  }

  const { cur, prev, open, ages } = report
  const med = cur.median
  const bucketWord = p.buckets === 'day' ? 'By day' : p.buckets === 'week' ? 'By week' : 'By month'

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
        </p>

        <section className="tkr-kpis" aria-label="Key numbers">
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Tickets opened</span>
            <span className="tkr-kpi-value">{cur.opened.length}</span>
            {delta(cur.opened.length, prev.opened.length, { goodUp: false })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Tickets closed</span>
            <span className="tkr-kpi-value">{cur.closed.length}</span>
            {delta(cur.closed.length, prev.closed.length)}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Median time to close</span>
            <span className="tkr-kpi-value">
              {days(med)}
              {med !== null && <small> days</small>}
            </span>
            {delta(med, prev.median, { goodUp: false, unit: ' days', dec: 1 })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Closed within 14 days</span>
            <span className="tkr-kpi-value">{cur.within14 === null ? 'n/a' : `${Math.round(cur.within14 * 100)}%`}</span>
            {delta(cur.within14, prev.within14, { pct: true })}
          </div>
          <div className="tkr-kpi">
            <span className="tkr-kpi-label">Open right now</span>
            <span className="tkr-kpi-value">{open.length}</span>
            <span className="tkr-delta">
              {ages.length ? `Oldest open ${Math.round(Math.max(...ages))} days` : 'Queue is clear'}
            </span>
          </div>
        </section>

        <div className="tkr-grid">
          <section className="tkr-card span-8">
            <h3>Opened vs closed</h3>
            <p className="tkr-note">{bucketWord}. Closed bars taller than opened means the queue is shrinking.</p>
            <OpenedClosed buckets={report.buckets} opened={report.openedSeries} closed={report.closedSeries} />
          </section>
          <section className="tkr-card span-4">
            <h3>Closed by team member</h3>
            <p className="tkr-note">Tickets closed this period, with each person&apos;s median days to close.</p>
            <HBars items={report.byAssignee} series="closed" />
          </section>
          <section className="tkr-card span-4">
            <h3>Time to close</h3>
            <p className="tkr-note">How long this period&apos;s closed tickets were open.</p>
            <HBars items={report.byTime} series="closed" />
          </section>
          <section className="tkr-card span-4">
            <h3>Top requesters</h3>
            <p className="tkr-note">Who opened the most tickets this period.</p>
            <HBars items={report.byRequester} series="opened" />
          </section>
          <section className="tkr-card span-4">
            <h3>{report.useType ? 'Request types' : 'How requests came in'}</h3>
            <p className="tkr-note">Tickets opened this period, {report.useType ? 'by request type' : 'by channel'}.</p>
            <HBars items={report.byType} series="opened" />
          </section>
          <section className="tkr-card span-6">
            <h3>Open queue by age</h3>
            <p className="tkr-note">Everything open right now, whatever the period.</p>
            <HBars items={report.byAge} series="opened" />
          </section>
          <section className="tkr-card span-6">
            <h3>Open queue by status</h3>
            <p className="tkr-note">Everything open right now, whatever the period.</p>
            <HBars items={report.byState} series="opened" />
          </section>
          <section className="tkr-card span-12">
            <h3>Tickets closed this period ({cur.closed.length})</h3>
            <p className="tkr-note">Newest first.</p>
            {cur.closed.length === 0 ? (
              <p className="tkr-none">No tickets closed in this period.</p>
            ) : (
              <div className="tkr-table-wrap">
                <table className="tkr-table">
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Request</th>
                      <th>Requester</th>
                      <th>Closed by</th>
                      <th className="num">Opened</th>
                      <th className="num">Closed</th>
                      <th className="num">Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.closed
                      .slice()
                      .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
                      .map((t) => (
                        <tr key={t.number}>
                          <td>
                            {t.sysId ? (
                              <a
                                href={`${SN}/nav_to.do?uri=${encodeURIComponent('/incident.do?sys_id=' + t.sysId)}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {t.number}
                              </a>
                            ) : (
                              t.number
                            )}
                          </td>
                          <td>{t.title}</td>
                          <td>{person(t.caller)}</td>
                          <td>{person(t.assignee) || 'Unassigned'}</td>
                          <td className="num">{fmt(new Date(t.openedAt), { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                          <td className="num">{fmt(new Date(t.closedAt), { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                          <td className="num">{Math.max(0, Math.round(daysBetween(t.openedAt, t.closedAt)))}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <p className="tkr-foot">
          Source: support.rowan.edu, RO Operations assignment group.
          {coverage && ` History from ${fmt(coverage, { month: 'long', year: 'numeric' })}.`}
        </p>
      </div>
      {dialog}
    </div>
  )
}
