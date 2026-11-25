import { useEffect, useMemo, useState } from 'react'
import type { ReportKey, StatusItem, StatusLabel, StatusUpdateData, TeamDesk, Ticket } from '../../../src/shared/types'
import {
  AGE,
  bandOf,
  countBy,
  days,
  fmt,
  headlineOf,
  isOpen,
  openAt,
  periodOf,
  snapshotTitle,
  statsFor,
  bucketsOf,
  at,
  inRange,
  isDone,
  doneAt,
  who,
  type PeriodKey,
  type Range
} from '../../../src/shared/teamStats'
import {
  AGENDA_BY,
  DEFAULT_AGENDA_OPTS,
  agendaLines,
  agendaText,
  monthKey,
  monthLabel,
  person,
  recapGroups,
  recapItems,
  recapMonths,
  type AgendaBy,
  type AgendaOpts
} from '../../../src/shared/ticketReports'
import { chipColors, countsOf, filled, isHidden, isHold, isUrl, label, sectionItems, statusDef } from '../../../src/shared/statusItems'
import { useApp } from '../App'
import { loadStatusUpdate, loadTeam, loadTickets, peek, type TicketFile } from '../data'
import { BackIcon, ChevronIcon, Problem, Stale } from '../ui'

// ---------------------------------------------------------------------------
// The Tickets reports, read on the phone: the service report's snapshot, this
// month's status update, the agenda summary and the monthly recap. They're
// built from the same synced files and the same shared code as on the PC, so
// the numbers match; updating and editing stay on the PC.
// ---------------------------------------------------------------------------

export const REPORTS: { key: ReportKey; name: string; sub: string }[] = [
  { key: 'service', name: 'Service report', sub: 'The group’s tickets: opened, resolved, the queue' },
  { key: 'status', name: 'Status update', sub: 'This month’s dashboard status update' },
  { key: 'agenda', name: 'Agenda summary', sub: 'Your open tickets, summed up for a meeting' },
  { key: 'recap', name: 'Monthly recap', sub: 'The tickets you closed in a month' }
]

export const isReport = (id: string): id is ReportKey => REPORTS.some((r) => r.key === id)

/** a report's name: yours if you renamed it on the PC */
export function reportName(names: Partial<Record<ReportKey, string>> | undefined, key: ReportKey): string {
  return names?.[key]?.trim() || REPORTS.find((r) => r.key === key)!.name
}

/** a synced file, kept fresh as the app comes back to the foreground */
function useLoad<T>(key: string, load: () => Promise<{ value: T; stale: boolean }>): {
  value: T | null
  /** loaded, from the hub or the offline copy: a null value then means there's none */
  loaded: boolean
  stale: boolean
  error: string | null
} {
  const { hub, fail, tick } = useApp()
  const [value, setValue] = useState<T | null>(() => peek(key))
  const [loaded, setLoaded] = useState(() => peek(key) !== null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    load()
      .then((r) => {
        if (!live) return
        setValue(r.value)
        setLoaded(true)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])
  return { value, loaded, stale, error }
}

export function ReportView({ id }: { id: ReportKey }): React.JSX.Element {
  const { back, settings } = useApp()
  return (
    <>
      <nav className="navbar">
        <button className="nav-back" onClick={() => back('/tickets')}>
          <BackIcon size={22} /> Tickets
        </button>
      </nav>
      {id === 'service' ? (
        <ServiceReport title={reportName(settings?.reportNames, 'service')} />
      ) : id === 'status' ? (
        <StatusReport />
      ) : id === 'agenda' ? (
        <AgendaReport title={reportName(settings?.reportNames, 'agenda')} />
      ) : (
        <RecapReport title={reportName(settings?.reportNames, 'recap')} />
      )}
    </>
  )
}

// ---- service report ----------------------------------------------------------------

const PERIODS: { id: PeriodKey; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'mtd', label: 'To date' },
  { id: 'year', label: '12 mo' }
]

function readPeriod(): PeriodKey {
  try {
    const v = localStorage.getItem('rowan.reportPeriod')
    return v === 'week' || v === 'month' || v === 'mtd' || v === 'year' ? v : 'month'
  } catch {
    return 'month'
  }
}

/** change against the period before, coloured by whether that direction is good */
function Delta({
  cur,
  prev,
  goodUp = true,
  unit = '',
  dec = 0,
  vs,
  known
}: {
  cur: number | null
  prev: number | null
  goodUp?: boolean
  unit?: string
  dec?: number
  vs: string
  known: boolean
}): React.JSX.Element {
  if (!known || cur === null || prev === null) return <span className="kpi-delta">No prior data yet</span>
  const diff = cur - prev
  const abs = Math.abs(diff)
  if (Number(abs.toFixed(dec)) === 0) return <span className="kpi-delta">Same as before</span>
  const good = goodUp ? diff > 0 : diff < 0
  return (
    <span className={`kpi-delta ${good ? 'good' : 'bad'}`}>
      {diff > 0 ? '▲' : '▼'} {abs.toFixed(dec)}
      {unit} {vs}
    </span>
  )
}

/** opened and resolved side by side for each part of the period */
function Columns({ labels, opened, resolved }: { labels: string[]; opened: number[]; resolved: number[] }): React.JSX.Element {
  const max = Math.max(1, ...opened, ...resolved)
  const n = labels.length
  const W = 320
  const H = 140
  const slot = W / n
  const bar = Math.max(2, Math.min(14, slot * 0.36))
  const every = n > 8 ? Math.ceil(n / 6) : 1
  const h = (v: number): number => (v / max) * (H - 18)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Opened and resolved over the period">
      <line x1="0" x2={W} y1={H} y2={H} className="chart-axis" />
      {labels.map((l, i) => {
        const x = i * slot + slot / 2
        return (
          <g key={i}>
            <rect className="bar-opened" x={x - bar - 1} y={H - h(opened[i])} width={bar} height={h(opened[i])} rx="2" />
            <rect className="bar-closed" x={x + 1} y={H - h(resolved[i])} width={bar} height={h(resolved[i])} rx="2" />
            {n <= 8 && opened[i] > 0 && (
              <text className="chart-val" x={x - bar / 2 - 1} y={H - h(opened[i]) - 3} textAnchor="middle">
                {opened[i]}
              </text>
            )}
            {n <= 8 && resolved[i] > 0 && (
              <text className="chart-val" x={x + bar / 2 + 1} y={H - h(resolved[i]) - 3} textAnchor="middle">
                {resolved[i]}
              </text>
            )}
            {i % every === 0 && (
              <text className="chart-label" x={x} y={H + 14} textAnchor="middle">
                {l}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** the open queue at the end of each part of the period */
function QueueLine({ points }: { points: { label: string; value: number }[] }): React.JSX.Element {
  const W = 320
  const H = 110
  const max = Math.max(1, ...points.map((p) => p.value))
  const n = points.length
  const x = (i: number): number => (n === 1 ? W / 2 : 14 + (i * (W - 28)) / (n - 1))
  const y = (v: number): number => H - 8 - (v / max) * (H - 30)
  const every = n > 8 ? Math.ceil(n / 6) : 1
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Open queue over the period">
      <line x1="0" x2={W} y1={H} y2={H} className="chart-axis" />
      <path d={d} className="queue-line" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.value)} r="3" className="queue-dot" />
          {(i === n - 1 || (n <= 8 && i % every === 0)) && (
            <text className="chart-val" x={x(i)} y={y(p.value) - 7} textAnchor="middle">
              {p.value}
            </text>
          )}
          {i % every === 0 && (
            <text className="chart-label" x={x(i)} y={H + 14} textAnchor="middle">
              {p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

function Bars({ items, series, empty }: { items: { label: string; value: number }[]; series: 'opened' | 'closed'; empty: string }): React.JSX.Element {
  if (!items.length) return <p className="fine left">{empty}</p>
  const max = Math.max(...items.map((i) => i.value))
  return (
    <div className="hbars">
      {items.map((i) => (
        <div key={i.label} className="hbar">
          <span className="hbar-label">{i.label}</span>
          <span className="hbar-track">
            <span className={`hbar-fill ${series}`} style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="hbar-value">{i.value}</span>
        </div>
      ))}
    </div>
  )
}

function ServiceReport({ title }: { title: string }): React.JSX.Element {
  const { hub } = useApp()
  const { value: desk, stale, error } = useLoad<TeamDesk>('team', () => loadTeam(hub))
  const [period, setPeriod] = useState<PeriodKey>(readPeriod)

  function choose(p: PeriodKey): void {
    setPeriod(p)
    try {
      localStorage.setItem('rowan.reportPeriod', p)
    } catch {
      // the choice just won't be remembered
    }
  }

  const p = useMemo(() => periodOf(period), [period])
  const coverage = desk?.coverageStart ? new Date(desk.coverageStart) : null
  const covered = (r: Range): boolean => !!coverage && coverage <= r.start

  // the snapshot's numbers, counted the way the PC's report counts them
  const r = useMemo(() => {
    const all = desk?.tickets ?? []
    if (!all.length) return null
    const now = Date.now()
    const buckets = bucketsOf(p)
    const open = all.filter(isOpen)
    const cur = statsFor(all, p)
    return {
      cur,
      prev: statsFor(all, p.prev),
      open,
      openAtStart: openAt(all, p.start.getTime()),
      labels: buckets.map((b) => b.label),
      opened: buckets.map((b) => all.filter((t) => inRange(at(t.openedAt), b)).length),
      resolved: buckets.map((b) => all.filter((t) => isDone(t) && inRange(at(doneAt(t)), b)).length),
      queue: buckets.map((b) => ({ label: b.label, value: openAt(all, Math.min(b.end.getTime(), now)) })),
      resolvedBy: countBy(cur.resolved, who).map(([label, value]) => ({ label, value })),
      byAge: AGE.map(([label]) => ({
        label,
        value: open.filter((t) => bandOf(AGE, (now - Date.parse(t.openedAt)) / 864e5) === label).length
      })).filter((x) => x.value),
      byState: countBy(open, (t) => t.state || 'Unknown').map(([label, value]) => ({ label, value })),
      oldest: open.reduce((m, t) => Math.max(m, (now - Date.parse(t.openedAt)) / 864e5), 0)
    }
  }, [desk, p])

  const vs = period === 'week' ? 'vs week before' : period === 'year' ? 'vs prior year' : 'vs month before'
  const bucketWord = p.buckets === 'day' ? 'By day' : p.buckets === 'week' ? 'By week' : 'By month'
  const endWord = p.buckets === 'day' ? 'day' : p.buckets === 'week' ? 'week' : 'month'

  return (
    <article className="report">
      <header className="page-head">
        <p className="eyebrow">RO Operations · {title}</p>
        <h1 className="large-title">{snapshotTitle(period, p)}</h1>
        {desk?.syncedAt && (
          <p className="meta">
            Data as of {new Date(desk.syncedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
        <div className="segmented" role="radiogroup" aria-label="Period">
          {PERIODS.map((x) => (
            <button key={x.id} role="radio" aria-checked={period === x.id} className={period === x.id ? 'on' : ''} onClick={() => choose(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {desk === null ? (
        <div className="group skeleton tall" />
      ) : !r ? (
        <p className="empty">No team data yet. Update the service report in Rowan on your PC.</p>
      ) : (
        <>
          <p className="lead">
            {headlineOf(period, p, r.cur.opened.length, r.cur.resolved.length, covered(p) ? [r.openAtStart, r.open.length] : null)}
          </p>

          <div className="kpis">
            <div className="kpi">
              <span className="kpi-label">Opened</span>
              <span className="kpi-value">{r.cur.opened.length}</span>
              <Delta cur={r.cur.opened.length} prev={r.prev.opened.length} goodUp={false} vs={vs} known={covered(p.prev)} />
            </div>
            <div className="kpi">
              <span className="kpi-label">Resolved</span>
              <span className="kpi-value">{r.cur.resolved.length}</span>
              <Delta cur={r.cur.resolved.length} prev={r.prev.resolved.length} vs={vs} known={covered(p.prev)} />
            </div>
            <div className="kpi">
              <span className="kpi-label">Median to resolve</span>
              <span className="kpi-value">
                {days(r.cur.median)}
                {r.cur.median !== null && <small> {days(r.cur.median) === '<1' || days(r.cur.median) === '1' ? 'day' : 'days'}</small>}
              </span>
              <Delta cur={r.cur.median} prev={r.prev.median} goodUp={false} unit=" days" dec={1} vs={vs} known={covered(p.prev)} />
            </div>
            <div className="kpi">
              <span className="kpi-label">Open now</span>
              <span className="kpi-value">{r.open.length}</span>
              <Delta
                cur={r.open.length}
                prev={r.openAtStart}
                goodUp={false}
                vs={`since ${fmt(p.start, { month: 'short', day: 'numeric' })}`}
                known={covered(p)}
              />
            </div>
          </div>

          <section>
            <div className="section-head">
              <h2 className="section-title">Opened vs resolved</h2>
              <span className="legend">
                <i className="key opened" /> Opened <i className="key closed" /> Resolved
              </span>
            </div>
            <div className="card">
              <p className="fine left">{bucketWord}. Resolved bars taller than opened means the queue is shrinking.</p>
              <Columns labels={r.labels} opened={r.opened} resolved={r.resolved} />
            </div>
          </section>

          <section>
            <h2 className="section-title">Open queue</h2>
            <div className="card">
              <p className="fine left">Tickets open at the end of each {endWord}.</p>
              <QueueLine points={r.queue} />
            </div>
          </section>

          <section>
            <h2 className="section-title">Resolved by</h2>
            <div className="card">
              <Bars items={r.resolvedBy.slice(0, 6)} series="closed" empty="Nothing resolved." />
            </div>
          </section>

          <section>
            <h2 className="section-title">Open by age</h2>
            <div className="card">
              <p className="fine left">{r.open.length ? `The oldest has been open ${Math.floor(r.oldest)} days.` : 'Everything open right now.'}</p>
              <Bars items={r.byAge} series="opened" empty="Nothing open." />
            </div>
          </section>

          <section>
            <h2 className="section-title">Open by status</h2>
            <div className="card">
              <Bars items={r.byState.slice(0, 6)} series="opened" empty="Nothing open." />
            </div>
          </section>

          <p className="fine report-foot">
            ServiceNow, RO Operations assignment group. Time to resolve runs from opened to resolved. Update the data and see
            the full report in Rowan on your PC.
          </p>
        </>
      )}
    </article>
  )
}

// ---- status update -----------------------------------------------------------------

function StatusChip({ d, it }: { d: StatusUpdateData; it: StatusItem }): React.JSX.Element {
  const c = chipColors(statusDef(d, it.status))
  return (
    <span className="status-chip" style={{ '--c-bg': c.bg, '--c-fg': c.fg, '--c-dbg': c.dbg, '--c-dfg': c.dfg } as React.CSSProperties}>
      {it.status || 'In Development'}
    </span>
  )
}

function ItemRows({
  d,
  items,
  render
}: {
  d: StatusUpdateData
  items: StatusItem[]
  render: (it: StatusItem) => React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group">
      {items.map((it) => (
        <div key={it.id} className="row">
          <span className="row-main">
            <span className="row-title">{it.name || 'Untitled'}</span>
            {(it.area || it.requestedBy?.trim()) && (
              <span className="row-sub">{[it.area, it.requestedBy?.trim() && `${label(d, 'requestedBy')} ${it.requestedBy.trim()}`].filter(Boolean).join(' · ')}</span>
            )}
            {render(it)}
          </span>
        </div>
      ))}
    </div>
  )
}

function StatusReport(): React.JSX.Element {
  const { hub } = useApp()
  const { value: d, loaded, stale, error } = useLoad<StatusUpdateData | null>('statusUpdate', () => loadStatusUpdate(hub))

  const note = (it: StatusItem): React.ReactNode => (it.note.trim() ? <span className="row-text">{it.note}</span> : null)
  const withLink = (it: StatusItem): React.ReactNode => (
    <>
      {note(it)}
      {d && isUrl(it.link) && (
        <a className="link inline" href={it.link!.trim()} target="_blank" rel="noopener noreferrer">
          {label(d, 'openDashboard')}
        </a>
      )}
    </>
  )

  if (!d) {
    return (
      <article className="report">
        <header className="page-head">
          <h1 className="large-title">Status update</h1>
        </header>
        <Stale show={stale} />
        <Problem error={error} />
        {loaded ? (
          <p className="empty">No status update yet. Start one in Rowan on your PC.</p>
        ) : (
          !error && <div className="group skeleton tall" />
        )}
      </article>
    )
  }

  const m = d.meta
  const counts = countsOf(d)
  const completed = isHidden(d, 'completed') ? [] : filled(sectionItems(d.items, 'completed'))
  const progress = isHidden(d, 'progress') ? [] : filled(sectionItems(d.items, 'progress'))
  const going = progress.filter((i) => !isHold(d, i))
  const held = progress.filter((i) => isHold(d, i))
  const fresh = isHidden(d, 'new') ? [] : filled(sectionItems(d.items, 'new'))
  const launched = completed.filter((i) => i.launched)
  const updates = completed.filter((i) => !i.launched)
  const L = (key: StatusLabel): string => label(d, key)
  const tiles: [string, number][] = [
    ...(isHidden(d, 'completed') ? [] : ([[L('completed'), counts.completed]] as [string, number][])),
    ...(isHidden(d, 'progress')
      ? []
      : ([
          [L('progress'), counts.progress],
          [L('hold'), counts.hold]
        ] as [string, number][])),
    ...(isHidden(d, 'new') ? [] : ([[L('new'), counts.fresh]] as [string, number][]))
  ]

  return (
    <article className="report">
      <header className="page-head">
        <p className="eyebrow">{L('team')}</p>
        <h1 className="large-title">
          {m.month} {L('title')}
        </h1>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {m.intro.trim() && <p className="lead">{m.intro}</p>}
      {m.scope.trim() && <p className="fine left">{m.scope}</p>}

      {tiles.length > 0 && (
        <div className="kpis">
          {tiles.map(([label, n]) => (
            <div key={label} className="kpi">
              <span className="kpi-label">{label}</span>
              <span className="kpi-value">{n}</span>
            </div>
          ))}
        </div>
      )}

      {m.spotOn && (m.spotTitle.trim() || m.spotBody.trim()) && (
        <section>
          <h2 className="section-title">{L('spotlight')}</h2>
          <div className="card spotlight">
            {m.spotTitle.trim() && <h3 className="spot-title">{m.spotTitle}</h3>}
            {d.spotImg?.data && <img className="spot-img" src={d.spotImg.data} alt="" />}
            {m.spotBody.trim() && <p className="row-text">{m.spotBody}</p>}
            {isUrl(m.spotLink) && (
              <a className="link inline" href={m.spotLink.trim()} target="_blank" rel="noopener noreferrer">
                {L('spotButton')}
              </a>
            )}
          </div>
        </section>
      )}

      {launched.length > 0 && (
        <section>
          <h2 className="section-title">
            {L('completed')} · {L('newDashboards')}
          </h2>
          <ItemRows d={d} items={launched} render={withLink} />
        </section>
      )}
      {updates.length > 0 && (
        <section>
          <h2 className="section-title">
            {L('completed')} · {L('updates')}
          </h2>
          <ItemRows d={d} items={updates} render={withLink} />
        </section>
      )}
      {going.length > 0 && (
        <section>
          <h2 className="section-title">
            {L('progress')} · {going.length}
          </h2>
          <ItemRows d={d} items={going} render={(it) => <StatusChip d={d} it={it} />} />
        </section>
      )}
      {held.length > 0 && (
        <section>
          <h2 className="section-title">
            {L('hold')} · {held.length}
          </h2>
          <ItemRows d={d} items={held} render={note} />
        </section>
      )}
      {fresh.length > 0 && (
        <section>
          <h2 className="section-title">
            {L('new')} · {fresh.length}
          </h2>
          <ItemRows d={d} items={fresh} render={note} />
        </section>
      )}

      <p className="fine report-foot">
        {isUrl(m.pastLink) && (
          <>
            <a className="link" href={m.pastLink.trim()} target="_blank" rel="noopener noreferrer">
              Past monthly updates
            </a>
            {' · '}
          </>
        )}
        Edit it and copy it for Outlook in Rowan on your PC.
      </p>
    </article>
  )
}

// ---- agenda summary ----------------------------------------------------------------

function readAgendaOpts(): AgendaOpts {
  try {
    return { ...DEFAULT_AGENDA_OPTS, ...JSON.parse(localStorage.getItem('rowan.agendaOpts') ?? '{}') }
  } catch {
    return { ...DEFAULT_AGENDA_OPTS }
  }
}

/** your tickets file, as the Tickets screens load it */
function useTicketFile(): { file: TicketFile | null; stale: boolean; error: string | null } {
  const { hub } = useApp()
  const { value, stale, error } = useLoad<TicketFile>('tickets', () => loadTickets(hub))
  return { file: value, stale, error }
}

function useCopy(): [string | null, (text: string, what: string) => void] {
  const [done, setDone] = useState<string | null>(null)
  function copy(text: string, what: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => setDone(what))
      .catch(() => setDone('Couldn’t copy'))
    setTimeout(() => setDone(null), 1600)
  }
  return [done, copy]
}

function AgendaReport({ title }: { title: string }): React.JSX.Element {
  const { file, stale, error } = useTicketFile()
  const [opts, setOpts] = useState<AgendaOpts>(readAgendaOpts)
  const [copied, copy] = useCopy()

  const tickets = useMemo(() => Object.values(file?.tickets ?? {}), [file])
  const lines = useMemo(() => agendaLines(tickets, file?.notes ?? {}, opts), [tickets, file, opts])

  function change(p: Partial<AgendaOpts>): void {
    const next = { ...opts, ...p }
    setOpts(next)
    try {
      localStorage.setItem('rowan.agendaOpts', JSON.stringify(next))
    } catch {
      // the choice just won't be remembered
    }
  }

  const toggles: [keyof Omit<AgendaOpts, 'by'>, string][] = [
    ['names', 'Ticket names'],
    ['steps', 'Next steps'],
    ['closed', 'Closed this week']
  ]

  return (
    <article className="report">
      <header className="page-head">
        <h1 className="large-title">{title}</h1>
        <p className="meta">Your open tickets, summed up for a meeting agenda.</p>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      <div className="report-controls">
        <label className="select-row">
          <span>Group by</span>
          <select className="field-input" value={opts.by} onChange={(e) => change({ by: e.target.value as AgendaBy })}>
            {AGENDA_BY.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <div className="chips">
          {toggles.map(([k, label]) => (
            <button
              key={k}
              className={`chip ${opts[k] ? 'chip-done' : ''}`}
              aria-pressed={opts[k]}
              onClick={() => change({ [k]: !opts[k] } as Partial<AgendaOpts>)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {file === null ? (
        <div className="group skeleton tall" />
      ) : (
        <>
          <div className="card agenda">
            {lines.map((l, i) =>
              l.level === 0 ? (
                <p key={i} className="agenda-top">
                  {l.text}
                </p>
              ) : (
                <p key={i} className={`agenda-item level-${l.level}`}>
                  {l.text}
                </p>
              )
            )}
          </div>
          <button className="btn-secondary report-copy" onClick={() => copy(agendaText(lines), 'Copied')}>
            {copied ?? 'Copy as text'}
          </button>
        </>
      )}
    </article>
  )
}

// ---- monthly recap -----------------------------------------------------------------

function RecapReport({ title }: { title: string }): React.JSX.Element {
  const { go } = useApp()
  const { file, stale, error } = useTicketFile()
  const tickets = useMemo(() => Object.values(file?.tickets ?? {}), [file])
  const months = useMemo(() => recapMonths(tickets), [tickets])
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [group, setGroup] = useState(false)
  const [copied, copy] = useCopy()

  const items = useMemo(() => recapItems(tickets, month), [tickets, month])
  const groups = useMemo(() => recapGroups(items), [items])

  const line = (t: Ticket): string => `${t.number}: ${t.title}${group ? '' : ` (${person(t.caller)})`}`
  const text = group
    ? groups.map(([p, ts]) => `${p} (${ts.length})\n${ts.map((t) => '- ' + line(t)).join('\n')}`).join('\n\n')
    : items.map((t) => '- ' + line(t)).join('\n')

  const row = (t: Ticket): React.JSX.Element => (
    <button key={t.number} className="row" onClick={() => go(`/ticket/${encodeURIComponent(t.number)}`)}>
      <span className="row-main">
        <span className="row-title clamp-2">{t.title}</span>
        <span className="row-sub">{[t.number, !group && person(t.caller)].filter(Boolean).join(' · ')}</span>
      </span>
      <ChevronIcon size={18} />
    </button>
  )

  return (
    <article className="report">
      <header className="page-head">
        <h1 className="large-title">{title}</h1>
        <p className="meta">The tickets you closed in a month, for your recap email.</p>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      <div className="report-controls">
        <label className="select-row">
          <span>Month</span>
          <select className="field-input" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((k) => (
              <option key={k} value={k}>
                {monthLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <div className="chips">
          <button className={`chip ${group ? 'chip-done' : ''}`} aria-pressed={group} onClick={() => setGroup((g) => !g)}>
            By requester
          </button>
        </div>
      </div>
      {file === null ? (
        <div className="group skeleton tall" />
      ) : items.length === 0 ? (
        <p className="empty">Nothing closed in {monthLabel(month)}.</p>
      ) : (
        <>
          <p className="fine left">
            {items.length} ticket{items.length === 1 ? '' : 's'} closed in {monthLabel(month)}.
          </p>
          {group ? (
            groups.map(([p, ts]) => (
              <section key={p}>
                <h2 className="section-title">
                  {p} · {ts.length}
                </h2>
                <div className="group">{ts.map(row)}</div>
              </section>
            ))
          ) : (
            <div className="group">{items.map(row)}</div>
          )}
          <button className="btn-secondary report-copy" onClick={() => copy(text, 'Copied')}>
            {copied ?? 'Copy as text'}
          </button>
        </>
      )}
    </article>
  )
}
