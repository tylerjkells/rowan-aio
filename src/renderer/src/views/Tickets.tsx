import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Ticket,
  TicketDesk,
  TicketNote,
  TicketPlan,
  TicketSyncSummary
} from '../../../shared/types'
import { Avatar } from '../ui'
import { TeamReport } from './TeamReport'

// ---------------------------------------------------------------------------
// Ticket desk: ServiceNow incidents assigned to you, triaged into your own
// plans. Data comes in by pasting the JSONv2 list page; nothing is written
// back to ServiceNow.
// ---------------------------------------------------------------------------

const SN = 'https://support.rowan.edu'
/** open incidents assigned to you, plus everything you closed in the last 12 months */
const LIST_URL =
  SN +
  '/incident_list.do?JSONv2&displayvalue=true&sysparm_query=assigned_to%3Djavascript:getMyAssignments()%5Eactive%3Dtrue%5Estate%3D1%5EORstate%3D2%5EORstate%3D3%5EORstate%3D11%5EORstate%3D4%5ENQassigned_to%3Djavascript:getMyAssignments()%5Eactive%3Dfalse%5Eclosed_at%3E%3Djavascript:gs.beginningOfLast12Months()%5EORDERBYDESCopened_at'

const ticketUrl = (t: Ticket): string =>
  `${SN}/nav_to.do?uri=${encodeURIComponent('/incident.do?sys_id=' + t.sysId)}`

type DeskView = 'now' | 'next' | 'later' | 'waiting' | 'untriaged' | 'latest' | 'open' | 'closed'
type SortKey = 'activity' | 'oldest' | 'newest'

const PLANS: { id: TicketPlan; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'next', label: 'Next' },
  { id: 'later', label: 'Later' },
  { id: 'waiting', label: 'Waiting' },
  { id: '', label: 'Untriaged' }
]

const VIEWS: { id: DeskView; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'next', label: 'Next' },
  { id: 'later', label: 'Later' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'untriaged', label: 'Untriaged' },
  { id: 'latest', label: 'Latest import' },
  { id: 'open', label: 'All open' },
  { id: 'closed', label: 'Closed' }
]

const EMPTY_NOTE: TicketNote = { plan: '', next: '', notes: '', seen: '' }

const planOfView = (v: DeskView): TicketPlan | null =>
  v === 'untriaged' ? '' : v === 'open' || v === 'closed' || v === 'latest' ? null : v

/** open and first brought in by the most recent update */
const fromLatestImport = (t: Ticket, desk: TicketDesk | null): boolean =>
  !t.closed && !!t.addedAt && t.addedAt === desk?.syncedAt

// ---- small helpers ----------------------------------------------------------

const ms = (iso: string): number => (iso ? Date.parse(iso) : NaN)

function daysSince(iso: string): number | null {
  const t = ms(iso)
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 864e5)
}

/** "today", "3 days", "4 mo", "1.2 yr" */
function rel(iso: string): string {
  const n = daysSince(iso)
  if (n === null) return ''
  if (n <= 0) return 'today'
  if (n === 1) return '1 day'
  if (n < 60) return `${n} days`
  const mo = Math.round(n / 30.4)
  return mo < 18 ? `${mo} mo` : `${(n / 365).toFixed(1)} yr`
}

function short(iso: string): string {
  const t = ms(iso)
  return Number.isNaN(t)
    ? ''
    : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Kells, Tyler" -> "Tyler Kells" */
const person = (name: string): string =>
  name.includes(',')
    ? name
        .split(',')
        .map((x) => x.trim())
        .reverse()
        .join(' ')
    : name || 'Unknown'

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const nameKey = (s: string): string =>
  s
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .sort()
    .join(' ')

/**
 * Who counts as you in a ticket's history: your name as assigned_to shows it
 * (in either name order), your full name from Settings, or the bare login
 * ServiceNow sometimes prints instead (last name plus an initial).
 */
function makeIsMe(me: string | null, yourName: string): (who: string) => boolean {
  const keys = new Set<string>()
  let last = ''
  if (me) {
    keys.add(nameKey(me))
    last = (me.includes(',') ? me.split(',')[0] : (me.trim().split(/\s+/).pop() ?? '')).trim().toLowerCase()
  }
  if (yourName.trim().includes(' ')) keys.add(nameKey(yourName))
  return (who) => {
    if (!who) return false
    if (keys.has(nameKey(who))) return true
    const w = who.trim().toLowerCase()
    return !!last && /^[a-z]+$/.test(w) && w.startsWith(last) && w.length <= last.length + 2
  }
}

type FlagKind = 'unanswered' | 'replied' | 'updated' | 'stale'

function flagsFor(t: Ticket, note: TicketNote | undefined, isMe: (w: string) => boolean): { kind: FlagKind; label: string; hint: string }[] {
  const out: { kind: FlagKind; label: string; hint: string }[] = []
  const mine = t.thread.some((e) => isMe(e.who))
  const latest = t.thread[0]
  if (!mine && t.state !== 'On Hold') {
    out.push({ kind: 'unanswered', label: 'No reply yet', hint: 'You haven’t commented on this one' })
  } else if (mine && latest && !isMe(latest.who)) {
    out.push({ kind: 'replied', label: 'They replied', hint: 'The last word isn’t yours' })
  }
  if (!note?.seen) out.push({ kind: 'updated', label: 'New', hint: 'You haven’t opened it here yet' })
  else if (note.seen !== t.updatedAt) out.push({ kind: 'updated', label: 'Updated', hint: 'Changed since you last opened it' })
  const quiet = daysSince(t.updatedAt)
  if (quiet !== null && quiet > 30) out.push({ kind: 'stale', label: 'Quiet 30+ days', hint: 'No activity in a month' })
  return out
}

/** plain text with its URLs made clickable (they open in the browser) */
function Linkified({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p.length > 70 ? p.slice(0, 67) + '…' : p}
          </a>
        ) : (
          p
        )
      )}
    </>
  )
}

function summaryText(s: TicketSyncSummary): string {
  if (s.notesImported) {
    return `Brought over plans and notes for ${s.notesImported} ticket${s.notesImported === 1 ? '' : 's'}.`
  }
  const parts: string[] = []
  if (s.open) parts.push(`${s.open} open`)
  if (s.added.length) parts.push(`${s.added.length} new (${s.added.join(', ')})`)
  if (s.updated.length) parts.push(`${s.updated.length} with new activity`)
  if (s.closed.length)
    parts.push(`${s.closed.length} moved to Closed: ${s.closed.map((c) => `${c.number} ${c.title}`).join('; ')}`)
  if (s.archived) parts.push(`${s.archived} closed tickets added to history`)
  return `Updated. ${parts.length ? parts.join('. ') : 'No changes'}.`
}

async function copyTicketLink(t: Ticket): Promise<void> {
  const url = ticketUrl(t)
  // pastes as the ticket number, linked, in Outlook, Teams and Webex
  await window.scribe.clipboard.writeRich(`<a href="${esc(url)}">${esc(t.number)}</a>`, url)
}

// ---- the view ----------------------------------------------------------------

export function TicketsView({ yourName }: { yourName: string }): React.JSX.Element {
  // your own tickets every time the tab opens; the team report is a click away
  const [mode, setMode] = useState<'mine' | 'team'>('mine')
  if (mode === 'team') return <TeamReport onBack={() => setMode('mine')} />
  return <MyTickets yourName={yourName} onTeam={() => setMode('team')} />
}

function MyTickets({ yourName, onTeam }: { yourName: string; onTeam: () => void }): React.JSX.Element {
  const [desk, setDesk] = useState<TicketDesk | null>(null)
  const [notes, setNotes] = useState<Record<string, TicketNote>>({})
  const [view, setView] = useState<DeskView>(
    () => (localStorage.getItem('ticketsView') as DeskView | null) ?? 'open'
  )
  const [sort, setSort] = useState<SortKey>(
    () => (localStorage.getItem('ticketsSort') as SortKey | null) ?? 'activity'
  )
  const [query, setQuery] = useState('')
  const [caller, setCaller] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // latest: the update brought in new tickets, so the banner links to them
  const [banner, setBanner] = useState<{ ok: boolean; text: string; latest?: boolean } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [recapOpen, setRecapOpen] = useState(false)
  const [agendaOpen, setAgendaOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.scribe.tickets.get().then((d) => {
      setDesk(d)
      setNotes(d.notes)
    })
  }, [])

  const tickets = desk?.tickets ?? []
  const byNumber = useMemo(() => new Map(tickets.map((t) => [t.number, t])), [tickets])
  /** every topic in use, once each, for the panel's suggestions */
  const topics = useMemo(() => {
    const seen = new Map<string, string>()
    for (const n of Object.values(notes)) {
      const t = n.topic?.trim()
      if (t && !seen.has(topicKey(t))) seen.set(topicKey(t), t)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [notes])
  const isMe = useMemo(() => makeIsMe(desk?.me ?? null, yourName), [desk?.me, yourName])
  const selected = selectedId ? (byNumber.get(selectedId) ?? null) : null

  const writeNote = useCallback((number: string, patch: Partial<TicketNote>): Promise<void> => {
    setNotes((prev) => ({ ...prev, [number]: { ...EMPTY_NOTE, ...prev[number], ...patch } }))
    return window.scribe.tickets.setNote(number, patch).then(
      () => undefined,
      () => setBanner({ ok: false, text: 'Couldn’t save that change. Try again in a moment.' })
    )
  }, [])

  // opening a ticket marks its current activity as seen
  useEffect(() => {
    if (!selected || selected.closed) return
    if (notes[selected.number]?.seen !== selected.updatedAt) {
      writeNote(selected.number, { seen: selected.updatedAt })
    }
    // keyed on the ticket alone: later note edits must not re-trigger this
  }, [selected?.number, selected?.updatedAt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]')) return
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      if (e.key === 'Escape' && selectedId) {
        if (typing) (e.target as HTMLElement).blur()
        else setSelectedId(null)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  function changeView(v: DeskView): void {
    setView(v)
    setSelectedId(null)
    localStorage.setItem('ticketsView', v)
  }

  function changeSort(s: SortKey): void {
    setSort(s)
    localStorage.setItem('ticketsSort', s)
  }

  async function copyLink(t: Ticket): Promise<void> {
    try {
      await copyTicketLink(t)
      setCopied(t.number)
      setTimeout(() => setCopied((c) => (c === t.number ? null : c)), 1600)
    } catch {
      setBanner({ ok: false, text: `Couldn’t reach the clipboard. The link is ${ticketUrl(t)}` })
    }
  }

  const counts = useMemo(() => {
    const c: Record<DeskView, number> = {
      now: 0,
      next: 0,
      later: 0,
      waiting: 0,
      untriaged: 0,
      latest: 0,
      open: 0,
      closed: 0
    }
    for (const t of tickets) {
      if (t.closed) {
        c.closed++
        continue
      }
      c.open++
      if (fromLatestImport(t, desk)) c.latest++
      const plan = notes[t.number]?.plan ?? ''
      c[plan === '' ? 'untriaged' : plan]++
    }
    return c
  }, [tickets, notes, desk])

  const closedView = view === 'closed'
  const scoped = useMemo(
    () =>
      tickets.filter((t) => {
        if (closedView !== t.closed) return false
        if (view === 'latest' && !fromLatestImport(t, desk)) return false
        const plan = planOfView(view)
        return plan === null || (notes[t.number]?.plan ?? '') === plan
      }),
    [tickets, notes, view, closedView, desk]
  )

  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const list = scoped.filter((t) => {
      if (caller && t.caller !== caller) return false
      if (stateFilter && t.state !== stateFilter) return false
      if (!needle) return true
      const hay = `${t.number} ${t.title} ${t.caller} ${person(t.caller)} ${notes[t.number]?.next ?? ''} ${notes[t.number]?.topic ?? ''}`
      return hay.toLowerCase().includes(needle)
    })
    const key =
      sort === 'activity'
        ? (t: Ticket) => -(ms(closedView ? t.closedAt : t.updatedAt) || 0)
        : sort === 'oldest'
          ? (t: Ticket) => ms(t.openedAt) || 0
          : (t: Ticket) => -(ms(t.openedAt) || 0)
    return list.sort((a, b) => key(a) - key(b))
  }, [scoped, caller, stateFilter, needle, sort, closedView, notes])

  const callers = useMemo(() => [...new Set(tickets.map((t) => t.caller))].filter(Boolean).sort(), [tickets])
  const states = useMemo(() => [...new Set(tickets.map((t) => t.state))].filter(Boolean).sort(), [tickets])

  const applied = (d: TicketDesk, s: TicketSyncSummary): void => {
    setDesk(d)
    setNotes(d.notes)
    setUpdating(false)
    setBanner({ ok: true, text: summaryText(s), latest: s.added.length > 0 })
  }

  const updateDialog = updating && (
    <UpdateDialog
      title="Update from ServiceNow"
      link={LIST_URL}
      linkLabel="Open my tickets in ServiceNow"
      hint="Your plans, next steps and notes are kept separately and carry through every update."
      runUpdate={(text) => (text ? window.scribe.tickets.apply(text) : window.scribe.tickets.applyClipboard())}
      onClose={() => setUpdating(false)}
      onApplied={(r) => applied(r.desk, r.summary)}
    />
  )

  if (!desk) {
    return <p className="cuc-empty">Loading tickets…</p>
  }

  if (tickets.length === 0) {
    return (
      <>
        <div className="empty-state">
          <h2>Tickets</h2>
          <p>
            Your ServiceNow incidents in one place: sort them into Now, Next, Later and Waiting,
            keep a next step and notes on each, and see at a glance who&apos;s waiting on you.
            Plans and notes stay on this computer.
          </p>
          {banner && <p className={`field-note ${banner.ok ? 'ok' : 'error'}`}>{banner.text}</p>}
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={() => setUpdating(true)}>
              Update from ServiceNow
            </button>
            <button className="btn" onClick={onTeam}>
              Team report
            </button>
          </div>
        </div>
        {updateDialog}
      </>
    )
  }

  // ---- rail ----
  const rail = (
    <aside className="cuc-rail">
      <button
        className="btn btn-primary cuc-new"
        onClick={() => setUpdating(true)}
        title="Bring in your latest ticket list from ServiceNow"
      >
        Update tickets
      </button>
      <nav className="cuc-rail-group" aria-label="Plans">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`cuc-rail-item ${view === v.id ? 'active' : ''}`}
            onClick={() => changeView(v.id)}
          >
            <span>{v.label}</span>
            <span className="cuc-rail-n">{counts[v.id]}</span>
          </button>
        ))}
      </nav>
      <div className="cuc-rail-head">
        <span>Team</span>
      </div>
      <button className="cuc-rail-item" onClick={onTeam} title="RO Operations service report: the whole group's ticket stats">
        <span>Service report</span>
        <span className="cuc-rail-n" aria-hidden="true">
          ›
        </span>
      </button>
      <div className="cuc-rail-foot">
        <button
          className="link-btn"
          onClick={() => setAgendaOpen(true)}
          title="Your open tickets summed up for a meeting agenda, ready for Google Sheets"
        >
          Agenda summary
        </button>
        <button className="link-btn" onClick={() => setRecapOpen(true)}>
          Monthly recap
        </button>
        <span>
          {desk.syncedAt
            ? `Synced ${new Date(desk.syncedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}`
            : 'Not synced yet'}
        </span>
      </div>
    </aside>
  )

  // ---- closed stats ----
  const stats = closedView && (() => {
    const closed = tickets.filter((t) => t.closed)
    const within = (days: number): number =>
      closed.filter((t) => Date.now() - ms(t.closedAt) <= days * 864e5).length
    const durations = closed
      .map((t) => (ms(t.closedAt) - ms(t.openedAt)) / 864e5)
      .filter((d) => Number.isFinite(d))
      .sort((a, b) => a - b)
    const median = durations.length ? Math.round(durations[Math.floor((durations.length - 1) / 2)]) : null
    const by = new Map<string, number>()
    for (const t of closed) by.set(t.caller, (by.get(t.caller) ?? 0) + 1)
    const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0]
    return (
      <div className="tk-stats">
        <div className="tk-stat">
          <b>{within(30)}</b>
          <span>closed in the last 30 days</span>
        </div>
        <div className="tk-stat">
          <b>{within(365)}</b>
          <span>closed in the last 12 months</span>
        </div>
        <div className="tk-stat">
          <b>{median === null ? 'n/a' : `${median} days`}</b>
          <span>typical time to close (median)</span>
        </div>
        {top && (
          <div className="tk-stat">
            <b>{person(top[0])}</b>
            <span>top requester, {top[1]} closed</span>
          </div>
        )}
      </div>
    )
  })()

  // ---- table ----
  const numberCell = (t: Ticket): React.JSX.Element => (
    <span className="tk-td tk-c-num">
      <span>{t.number}</span>
      {t.sysId && (
        <button
          className={`tk-copy ${copied === t.number ? 'done' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            copyLink(t)
          }}
          aria-label={`Copy link to ${t.number}`}
        >
          {copied === t.number ? 'Copied' : 'Copy link'}
        </button>
      )}
    </span>
  )

  const row = (t: Ticket): React.JSX.Element => {
    const note = notes[t.number]
    const flags = closedView ? [] : flagsFor(t, note, isMe)
    const days = Math.max(0, Math.round((ms(t.closedAt) - ms(t.openedAt)) / 864e5))
    return (
      <div
        key={t.number}
        role="row"
        className={`tk-tr ${selectedId === t.number ? 'active' : ''}`}
        onClick={() => setSelectedId(t.number)}
      >
        {numberCell(t)}
        <span className="tk-td tk-c-req">
          <span className="tk-name">{t.title}</span>
          <span className="tk-caller">
            {note?.topic?.trim() && <span className="tk-topic">{note.topic.trim()}</span>}
            {/* number and date ride along here when the table is too narrow for their columns */}
            <span className="tk-inline">{t.number} · </span>
            {person(t.caller)}
            <span className="tk-inline"> · {closedView ? short(t.closedAt) : rel(t.updatedAt)}</span>
          </span>
          {!closedView && note?.next && (
            <span className="tk-next">
              <b>Next:</b> {note.next}
            </span>
          )}
          {closedView && note?.notes && <span className="tk-next"><b>Notes kept</b></span>}
          {flags.length > 0 && (
            <span className="tk-flags">
              {flags.map((f) => (
                <span key={f.kind + f.label} className={`tk-flag tk-flag-${f.kind}`} title={f.hint}>
                  {f.label}
                </span>
              ))}
            </span>
          )}
        </span>
        {closedView ? (
          <>
            <span className="tk-td tk-num tk-c-opened">{short(t.openedAt)}</span>
            <span className="tk-td tk-num tk-c-closed">{short(t.closedAt)}</span>
            <span className="tk-td tk-num tk-c-days">{Number.isFinite(days) ? days : ''}</span>
            <span className="tk-td tk-state hold tk-c-state">{t.state}</span>
          </>
        ) : (
          <>
            <span className="tk-td tk-num tk-c-opened" title={short(t.openedAt)}>{rel(t.openedAt)}</span>
            <span className="tk-td tk-num tk-c-activity" title={short(t.updatedAt)}>{rel(t.updatedAt)}</span>
            <span className={`tk-td tk-state tk-c-state ${t.state === 'On Hold' ? 'hold' : ''}`}>{t.state}</span>
            <span className="tk-td tk-c-plan">
              <select
                className="cuc-select tk-plan"
                value={note?.plan ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => writeNote(t.number, { plan: e.target.value as TicketPlan })}
                aria-label={`Plan for ${t.number}`}
              >
                {PLANS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </span>
          </>
        )}
      </div>
    )
  }

  const table = (
    <div className="tk-table" role="table">
      <div className="tk-thead" role="row">
        <span className="tk-th tk-c-num">Ticket</span>
        <span className="tk-th tk-c-req">Request</span>
        {closedView ? (
          <>
            <span className="tk-th tk-num tk-c-opened">Opened</span>
            <span className="tk-th tk-num tk-c-closed">Closed</span>
            <span className="tk-th tk-num tk-c-days">Days open</span>
            <span className="tk-th tk-c-state">State</span>
          </>
        ) : (
          <>
            <span className="tk-th tk-num tk-c-opened">Opened</span>
            <span className="tk-th tk-num tk-c-activity">Activity</span>
            <span className="tk-th tk-c-state">State</span>
            <span className="tk-th tk-c-plan">Plan</span>
          </>
        )}
      </div>
      {shown.map(row)}
    </div>
  )

  const viewLabel = VIEWS.find((v) => v.id === view)?.label ?? 'Tickets'
  const filtered = needle || caller || stateFilter

  const main = (
    <section className="cuc-main" aria-label={viewLabel}>
      <div className="cuc-toolbar">
        <h2 className="cuc-title">
          {viewLabel}
          <span className="cuc-title-n">
            {filtered && shown.length !== scoped.length ? `${shown.length} of ${scoped.length}` : shown.length}
          </span>
        </h2>
        <span className="cu-search-wrap cuc-search-wrap">
          <input
            ref={searchRef}
            className="text-input cuc-search"
            placeholder="Search  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search tickets"
          />
          {query && (
            <button
              className="cu-search-clear"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </span>
        <select className="cuc-select" value={caller} onChange={(e) => setCaller(e.target.value)} aria-label="Caller">
          <option value="">All callers</option>
          {callers.map((c) => (
            <option key={c} value={c}>
              {person(c)}
            </option>
          ))}
        </select>
        <select
          className="cuc-select"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          aria-label="ServiceNow state"
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="cuc-groupby">
          <span>Sort</span>
          <select className="cuc-select" value={sort} onChange={(e) => changeSort(e.target.value as SortKey)}>
            <option value="activity">{closedView ? 'Recently closed' : 'Last activity'}</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
      </div>
      {banner && (
        <div className={`tk-banner ${banner.ok ? '' : 'error'}`} role="status">
          <span>{banner.text}</span>
          {banner.latest && view !== 'latest' && (
            <button className="link-btn" onClick={() => changeView('latest')}>
              Show the new ones
            </button>
          )}
          <button className="mailc-ic" onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <div className="cuc-scroll">
        {stats}
        {shown.length === 0 ? (
          <p className="cuc-empty">
            {filtered
              ? 'No tickets match these filters.'
              : closedView
                ? 'Closed tickets show up here after an update, or when an open ticket drops off your list.'
                : view === 'open'
                  ? 'Nothing open. Enjoy it while it lasts.'
                  : view === 'latest'
                    ? 'The last update brought in no new tickets. New ones show here after each update, whatever plan you file them under.'
                    : 'No tickets in this plan. Pick a plan from the dropdown on any ticket to file it here.'}
          </p>
        ) : (
          table
        )}
      </div>
    </section>
  )

  return (
    <div className={`cuc tk ${closedView ? 'tk-closed' : ''} ${selected ? 'with-panel' : ''}`}>
      {rail}
      {main}
      {selected && (
        <TicketPanel
          key={selected.number}
          ticket={selected}
          note={notes[selected.number] ?? EMPTY_NOTE}
          topics={topics}
          isMe={isMe}
          copied={copied === selected.number}
          onCopy={() => copyLink(selected)}
          onNote={(patch) => writeNote(selected.number, patch)}
          onClose={() => setSelectedId(null)}
        />
      )}
      {updateDialog}
      {recapOpen && <RecapDialog tickets={tickets} onClose={() => setRecapOpen(false)} />}
      {agendaOpen && <AgendaDialog tickets={tickets} notes={notes} onClose={() => setAgendaOpen(false)} />}
    </div>
  )
}

// ---- detail panel -------------------------------------------------------------

function TicketPanel({
  ticket: t,
  note,
  topics,
  isMe,
  copied,
  onCopy,
  onNote,
  onClose
}: {
  ticket: Ticket
  note: TicketNote
  topics: string[]
  isMe: (who: string) => boolean
  copied: boolean
  onCopy: () => void
  onNote: (patch: Partial<TicketNote>) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [next, setNext] = useState(note.next)
  const [topic, setTopic] = useState(note.topic ?? '')
  const [text, setText] = useState(note.notes)
  const [saveState, setSaveState] = useState<'' | 'Saving…' | 'Saved'>('')
  const pending = useRef<Partial<TicketNote>>({})
  const timer = useRef<number | undefined>(undefined)
  const onNoteRef = useRef(onNote)
  onNoteRef.current = onNote

  const flush = useCallback((): void => {
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    onNoteRef.current(patch).then(() => setSaveState('Saved'))
  }, [])

  function queue(patch: Partial<TicketNote>): void {
    pending.current = { ...pending.current, ...patch }
    setSaveState('Saving…')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 700)
  }

  // switching tickets or closing the panel saves whatever is still pending
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      flush()
    },
    [flush]
  )

  return (
    <aside className="cuc-panel tk-panel" aria-label="Ticket">
      <div className="cuc-panel-bar">
        <button className="mailc-ic" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
        <span className="cuc-panel-crumb">
          {t.number} · {t.state}
        </span>
        <span className="mailc-read-bar-gap" />
        {t.sysId && (
          <>
            <button className="btn btn-ghost mailc-read-tool" onClick={onCopy} title="Copies as a link labelled with the ticket number">
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a className="btn btn-ghost mailc-read-tool" href={ticketUrl(t)} target="_blank" rel="noreferrer">
              ServiceNow ↗
            </a>
          </>
        )}
      </div>
      <div className="cuc-panel-scroll">
        <h2 className="tk-panel-title">{t.title}</h2>
        <div className="cuc-props">
          <span className="cuc-prop-k">Caller</span>
          <span className="cuc-prop-v cuc-prop-text">{person(t.caller)}</span>
          <span className="cuc-prop-k">Opened</span>
          <span className="cuc-prop-v cuc-prop-text">{short(t.openedAt)}</span>
          <span className="cuc-prop-k">{t.closed ? 'Closed' : 'Last activity'}</span>
          <span className="cuc-prop-v cuc-prop-text">{short(t.closed ? t.closedAt : t.updatedAt)}</span>
        </div>
        {!t.closed && (
          <div className="pd-field">
            <span>Plan</span>
            <span className="mode-toggle tk-plan-seg" role="radiogroup" aria-label="Plan">
              {PLANS.map((p) => (
                <button
                  key={p.id}
                  className={note.plan === p.id ? 'active' : ''}
                  role="radio"
                  aria-checked={note.plan === p.id}
                  onClick={() => onNote({ plan: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </span>
          </div>
        )}
        {!t.closed && (
          <label className="pd-field">
            <span>Next step</span>
            <input
              className="text-input"
              value={next}
              placeholder="What has to happen next on this one"
              onChange={(e) => {
                setNext(e.target.value)
                queue({ next: e.target.value })
              }}
            />
          </label>
        )}
        {!t.closed && (
          <label className="pd-field">
            <span>Topic</span>
            <input
              className="text-input"
              value={topic}
              list="tk-topics"
              placeholder="e.g. RO KPI Dashboard. Same topic, same line in the agenda summary"
              onChange={(e) => {
                setTopic(e.target.value)
                queue({ topic: e.target.value })
              }}
            />
            <datalist id="tk-topics">
              {topics.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </label>
        )}
        <label className="pd-field">
          <span className="tk-field-head">
            Notes <span className="tk-save" aria-live="polite">{saveState}</span>
          </span>
          <textarea
            className="text-input tk-notes"
            value={text}
            placeholder="Your working notes. Never sent to ServiceNow."
            onChange={(e) => {
              setText(e.target.value)
              queue({ notes: e.target.value })
            }}
          />
        </label>
        {t.closed && t.closeNotes && (
          <div className="cuc-comments">
            <span className="card-subhead">Close notes</span>
            <p className="cuc-desc">
              <Linkified text={t.closeNotes} />
            </p>
          </div>
        )}
        <div className="cuc-comments">
          <span className="card-subhead">History, newest first</span>
          {t.thread.length === 0 && <span className="cu-comments-note">No comments on this ticket.</span>}
          {t.thread.map((e, i) => {
            const mine = isMe(e.who)
            return (
              <div className={`cuc-comment ${mine ? 'tk-mine' : ''}`} key={i}>
                <Avatar name={person(e.who)} size={26} />
                <div className="cuc-comment-body">
                  <span className="cuc-comment-head">
                    <strong>{mine ? 'You' : person(e.who)}</strong>
                    <span>{short(e.at)}</span>
                    {e.kind === 'worknote' && <span className="tk-kind">Work note</span>}
                  </span>
                  <span className="cuc-comment-text">
                    <Linkified text={e.text} />
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

// ---- update dialog --------------------------------------------------------------

type SyncOutcome = { ok: true } | { ok: false; error: string }

/** paste a ServiceNow JSONv2 page (or read it straight off the clipboard) and merge it */
export function UpdateDialog<R extends SyncOutcome>({
  title,
  link,
  linkLabel,
  hint,
  runUpdate,
  onClose,
  onApplied
}: {
  title: string
  link: string
  linkLabel: string
  hint: string
  /** '' means read the clipboard */
  runUpdate: (text: string) => Promise<R>
  onClose: () => void
  onApplied: (result: Extract<R, { ok: true }>) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function apply(): Promise<void> {
    setBusy(true)
    setError(null)
    const r = await runUpdate(text.trim() ? text : '')
    setBusy(false)
    if (r.ok) onApplied(r as Extract<R, { ok: true }>)
    else setError((r as { error: string }).error)
  }

  return (
    <dialog
      ref={ref}
      className="confirm tk-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose()
      }}
    >
      <h3>{title}</h3>
      <ol className="tk-steps">
        <li>
          <a href={SN} target="_blank" rel="noreferrer">
            Sign in to ServiceNow
          </a>{' '}
          the way you normally do. The ticket list link only returns your data once you&apos;re
          already signed in; it won&apos;t take you through the sign-in itself.
        </li>
        <li>
          Then{' '}
          <a href={link} target="_blank" rel="noreferrer">
            {linkLabel.charAt(0).toLowerCase() + linkLabel.slice(1)}
          </a>{' '}
          (opens in your browser).
        </li>
        <li>On that page press Ctrl+A, then Ctrl+C.</li>
        <li>Come back here and choose Apply from clipboard.</li>
      </ol>
      <label className="pd-field">
        <span>Or paste it here instead</span>
        <textarea
          className="text-input tk-paste"
          spellCheck={false}
          placeholder='{"records":[ … ]}'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="tk-hint">{hint}</p>
      {error && <p className="field-note error">{error}</p>}
      <div className="confirm-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={apply} disabled={busy}>
          {busy ? 'Applying…' : text.trim() ? 'Apply update' : 'Apply from clipboard'}
        </button>
      </div>
    </dialog>
  )
}

// ---- monthly recap ----------------------------------------------------------------

const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

const monthLabel = (key: string): string => {
  const [y, m] = key.split('-')
  return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function RecapDialog({ tickets, onClose }: { tickets: Ticket[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const thisMonth = monthKey(new Date())
  const months = useMemo(() => {
    const keys = new Set([thisMonth])
    for (const t of tickets) if (t.closed && t.closedAt) keys.add(monthKey(new Date(t.closedAt)))
    return [...keys].sort().reverse()
  }, [tickets, thisMonth])
  const [month, setMonth] = useState(thisMonth)
  const [group, setGroup] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const items = tickets
    .filter((t) => t.closed && t.closedAt && monthKey(new Date(t.closedAt)) === month)
    .sort((a, b) => ms(a.closedAt) - ms(b.closedAt))

  const groups = useMemo(() => {
    const by = new Map<string, Ticket[]>()
    for (const t of items) {
      const p = person(t.caller)
      by.set(p, [...(by.get(p) ?? []), t])
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [items])

  const line = (t: Ticket): string => `${t.number}: ${t.title}${group ? '' : ` (${person(t.caller)})`}`
  const lineHtml = (t: Ticket): string =>
    `<li>${t.sysId ? `<a href="${esc(ticketUrl(t))}">${esc(t.number)}</a>` : esc(t.number)}: ${esc(t.title)}${
      group ? '' : ` (${esc(person(t.caller))})`
    }</li>`

  async function copy(): Promise<void> {
    let html: string
    let text: string
    if (group) {
      html = groups.map(([p, ts]) => `<h4>${esc(p)} (${ts.length})</h4><ul>${ts.map(lineHtml).join('')}</ul>`).join('')
      text = groups.map(([p, ts]) => `${p} (${ts.length})\n${ts.map((t) => '- ' + line(t)).join('\n')}`).join('\n\n')
    } else {
      html = `<ul>${items.map(lineHtml).join('')}</ul>`
      text = items.map((t) => '- ' + line(t)).join('\n')
    }
    await window.scribe.clipboard.writeRich(html, text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const li = (t: Ticket): React.JSX.Element => (
    <li key={t.number}>
      {t.sysId ? (
        <a href={ticketUrl(t)} target="_blank" rel="noreferrer">
          {t.number}
        </a>
      ) : (
        t.number
      )}
      : {t.title}
      {!group && ` (${person(t.caller)})`}
    </li>
  )

  return (
    <dialog
      ref={ref}
      className="confirm tk-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <h3>Monthly recap</h3>
      <p>Tickets closed in the month you pick, ready to paste into your recap email. Ticket numbers paste as links.</p>
      <div className="tk-recap-controls">
        <label className="cuc-groupby">
          <span>Month</span>
          <select className="cuc-select" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((k) => (
              <option key={k} value={k}>
                {monthLabel(k)}
                {k === thisMonth ? ' (month to date)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="tk-check">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group by requester
        </label>
      </div>
      <div className="tk-recap-preview">
        {items.length === 0 ? (
          <p>No tickets closed in {monthLabel(month)} yet.</p>
        ) : group ? (
          groups.map(([p, ts]) => (
            <div key={p}>
              <h4>
                {p} ({ts.length})
              </h4>
              <ul>{ts.map(li)}</ul>
            </div>
          ))
        ) : (
          <ul>{items.map(li)}</ul>
        )}
      </div>
      {items.length > 0 && (
        <p className="tk-hint">
          {items.length} ticket{items.length === 1 ? '' : 's'} closed in {monthLabel(month)}
          {month === thisMonth ? ' so far' : ''}.
        </p>
      )}
      <div className="confirm-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" onClick={copy} disabled={items.length === 0}>
          {copied ? 'Copied' : 'Copy for email'}
        </button>
      </div>
    </dialog>
  )
}

// ---- agenda summary ---------------------------------------------------------------
// Open tickets summed up for a meeting agenda: a count, then groups naming
// their tickets, with next steps under them. The draft is plain text, edited
// in place; Google Sheets gets it as a one-cell table so it lands in a single
// cell, line breaks and all.

type AgendaBy = 'type' | 'plan' | 'status' | 'requester'
interface AgendaOpts {
  by: AgendaBy
  names: boolean
  steps: boolean
  closed: boolean
}
interface AgendaLine {
  level: 0 | 1 | 2
  text: string
}

const AGENDA_BY: { id: AgendaBy; label: string }[] = [
  { id: 'type', label: 'Request type' },
  { id: 'plan', label: 'Your plan' },
  { id: 'status', label: 'ServiceNow status' },
  { id: 'requester', label: 'Requester' }
]
const PLAN_PHRASE: Record<TicketPlan, string> = {
  now: 'in progress',
  next: 'up next',
  waiting: 'waiting on someone else',
  later: 'for later',
  '': 'not triaged yet'
}
const PLAN_ORDER: TicketPlan[] = ['now', 'next', 'waiting', 'later', '']
/** the bullets an agenda already uses, one per level */
const BULLET = ['', '● ', '    ○ ']

function readAgendaOpts(): AgendaOpts {
  const d: AgendaOpts = { by: 'type', names: true, steps: true, closed: true }
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('agendaOpts') ?? '{}') }
  } catch {
    return d
  }
}

/** topics match whatever their case or spacing */
const topicKey = (topic: string): string => topic.trim().replace(/\s+/g, ' ').toLowerCase()

/** a ticket title trimmed for a list in parentheses */
function shortTitle(title: string): string {
  const s = title.replace(/^\s*(\[external\]\s*)?((re|fwd?)\s*:\s*)*/i, '').trim()
  return s.length > 48 ? s.slice(0, 46).trimEnd() + '…' : s
}

/** "Data Request" reads "Data Requests" when there are several */
const pluralize = (label: string, n: number): string =>
  n === 1 ? label : label.replace(/\b(Request|Issue|Question|Report|Ticket|Update|Change|Problem|Error)$/i, '$1s')

const waitingOnSomeone = (t: Ticket, plan: TicketPlan): boolean =>
  plan === 'waiting' || /await|pending|on hold/i.test(t.state)

function agendaLines(tickets: Ticket[], notes: Record<string, TicketNote>, o: AgendaOpts): AgendaLine[] {
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

const agendaText = (lines: AgendaLine[]): string => lines.map((l) => BULLET[l.level] + l.text).join('\n')

/** read a (possibly edited) draft back into levels: bullets mark items, indenting marks sub-items */
function parseAgenda(text: string): AgendaLine[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((raw) => {
      const indent = (/^[ \t\u00a0]*/.exec(raw)?.[0] ?? '').replace(/\t/g, '    ').length
      const rest = raw.trimStart()
      const bullet = /^[■●•◦○▪*-]\s+/.exec(rest)
      return {
        level: !bullet ? 0 : indent >= 2 ? 2 : 1,
        text: bullet ? rest.slice(bullet[0].length) : rest
      }
    })
}

/** nested bullets for email, Docs and Teams */
function agendaListHtml(lines: AgendaLine[]): string {
  interface Node {
    text: string
    level: number
    kids: Node[]
  }
  const root: Node = { text: '', level: -1, kids: [] }
  const stack: Node[] = [root]
  for (const l of lines) {
    while (stack.length > 1 && stack[stack.length - 1].level >= l.level) stack.pop()
    const node: Node = { text: l.text, level: l.level, kids: [] }
    stack[stack.length - 1].kids.push(node)
    stack.push(node)
  }
  const render = (ns: Node[]): string =>
    ns.length ? `<ul>${ns.map((n) => `<li>${esc(n.text)}${render(n.kids)}</li>`).join('')}</ul>` : ''
  return render(root.kids)
}

/** one table cell, so Google Sheets keeps the whole summary in a single cell */
const agendaSheetsHtml = (text: string): string =>
  `<table><tr><td>${text
    .split(/\r?\n/)
    .map((l) => esc(l).replace(/^ +/, (m) => '&nbsp;'.repeat(m.length)))
    .join('<br style="mso-data-placement:same-cell">')}</td></tr></table>`

function AgendaDialog({
  tickets,
  notes,
  onClose
}: {
  tickets: Ticket[]
  notes: Record<string, TicketNote>
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [opts, setOpts] = useState<AgendaOpts>(readAgendaOpts)
  const generated = useMemo(() => agendaText(agendaLines(tickets, notes, opts)), [tickets, notes, opts])
  const [draft, setDraft] = useState(generated)
  const [edited, setEdited] = useState(false)
  const [copied, setCopied] = useState<'sheets' | 'list' | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  // settings rebuild the draft until it has been edited by hand
  useEffect(() => {
    if (!edited) setDraft(generated)
  }, [generated, edited])

  function change(p: Partial<AgendaOpts>): void {
    const next = { ...opts, ...p }
    setOpts(next)
    localStorage.setItem('agendaOpts', JSON.stringify(next))
  }

  async function copy(kind: 'sheets' | 'list'): Promise<void> {
    const html = kind === 'sheets' ? agendaSheetsHtml(draft) : agendaListHtml(parseAgenda(draft))
    await window.scribe.clipboard.writeRich(html, draft)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1600)
  }

  const open = tickets.filter((t) => !t.closed)
  const typesPending = opts.by === 'type' && open.length > 0 && open.every((t) => t.type === undefined)
  const rows = Math.min(18, Math.max(8, draft.split('\n').length + 1))

  return (
    <dialog
      ref={ref}
      className="confirm tk-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <h3>Agenda summary</h3>
      <p>
        Your open tickets summed up for a meeting agenda. Change the wording below if you like, then
        copy it.
      </p>
      <div className="tk-recap-controls">
        <label className="cuc-groupby">
          <span>Group by</span>
          <select className="cuc-select" value={opts.by} onChange={(e) => change({ by: e.target.value as AgendaBy })}>
            {AGENDA_BY.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tk-check">
          <input type="checkbox" checked={opts.names} onChange={(e) => change({ names: e.target.checked })} /> Name
          the tickets
        </label>
        <label className="tk-check">
          <input type="checkbox" checked={opts.steps} onChange={(e) => change({ steps: e.target.checked })} /> Next
          steps
        </label>
        <label className="tk-check">
          <input type="checkbox" checked={opts.closed} onChange={(e) => change({ closed: e.target.checked })} />{' '}
          Closed this past week
        </label>
      </div>
      {typesPending && (
        <p className="tk-hint">Request types fill in the next time you update your tickets.</p>
      )}
      {!Object.values(notes).some((n) => n.topic?.trim()) && (
        <p className="tk-hint">
          To keep related tickets on one line, give them the same Topic in the ticket panel.
        </p>
      )}
      <textarea
        className="tk-agenda-draft"
        value={draft}
        rows={rows}
        spellCheck
        aria-label="Agenda summary"
        onChange={(e) => {
          setDraft(e.target.value)
          setEdited(true)
        }}
      />
      <p className="tk-hint">
        {edited ? (
          <>
            You&apos;ve edited this, so changing the settings above leaves it alone.{' '}
            <button
              className="link-btn"
              onClick={() => {
                setEdited(false)
                setDraft(generated)
              }}
            >
              Start over from your tickets
            </button>
          </>
        ) : (
          'Copy for Google Sheets puts it all in one cell. If Sheets spreads it over several rows, double-click the cell and paste again.'
        )}
      </p>
      <div className="confirm-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn" onClick={() => copy('list')} title="Nested bullets, for email, Docs or Teams">
          {copied === 'list' ? 'Copied' : 'Copy as a list'}
        </button>
        <button className="btn btn-primary" onClick={() => copy('sheets')}>
          {copied === 'sheets' ? 'Copied' : 'Copy for Google Sheets'}
        </button>
      </div>
    </dialog>
  )
}
