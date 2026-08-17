import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent, MeetingListItem } from '../../../shared/types'
import { PrepDialog } from '../PrepDialog'
import { formatDuration, formatWhen, StageBadge } from '../ui'

type LibView = 'list' | 'calendar'

export function LibraryView({
  meetings,
  onOpen,
  onRecord,
  onImport
}: {
  meetings: MeetingListItem[]
  onOpen: (id: string) => void
  onRecord: () => void
  onImport: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [libView, setLibView] = useState<LibView>(
    () => (localStorage.getItem('libView') as LibView) || 'list'
  )
  const searchRef = useRef<HTMLInputElement>(null)

  function switchView(v: LibView): void {
    setLibView(v)
    localStorage.setItem('libView', v)
  }

  // "/" focuses search from anywhere in the library
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (e.key === '/' && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // deep search: matches inside transcripts and summaries, via the main process
  const [deepMatches, setDeepMatches] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) {
      setDeepMatches(new Map())
      return
    }
    const t = setTimeout(() => {
      window.scribe.meetings.search(q).then((hits) => {
        setDeepMatches(new Map(hits.map((h) => [h.id, h.snippet])))
      })
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter((m) => {
      const haystack = `${m.title} ${m.tldr ?? ''} ${formatWhen(m.createdAt)} ${m.createdAt.slice(0, 10)}`.toLowerCase()
      return q.split(/\s+/).every((word) => haystack.includes(word)) || deepMatches.has(m.id)
    })
  }, [meetings, query, deepMatches])

  if (meetings.length === 0) {
    return (
      <div className="empty-state">
        <h2>No meetings yet</h2>
        <p>
          Record an in-person conversation or a virtual call. It gets transcribed on this machine
          and summarized into decisions and action items.
        </p>
        <button className="btn btn-primary" onClick={onRecord}>
          Record your first meeting
        </button>
        <p className="empty-alt">
          Migrating from another tool?{' '}
          <button className="link-btn" onClick={onImport}>
            Import a transcript
          </button>
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Meetings</h1>
        <div className="page-head-tools">
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="View">
            <button
              className={libView === 'list' ? 'active' : ''}
              role="radio"
              aria-checked={libView === 'list'}
              onClick={() => switchView('list')}
            >
              List
            </button>
            <button
              className={libView === 'calendar' ? 'active' : ''}
              role="radio"
              aria-checked={libView === 'calendar'}
              onClick={() => switchView('calendar')}
            >
              Calendar
            </button>
          </div>
          <input
            ref={searchRef}
            className="text-input search-input"
            type="search"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            aria-label="Search meetings"
          />
          <span className="count-note">
            {query
              ? `${filtered.length} of ${meetings.length}`
              : `${meetings.length} ${meetings.length === 1 ? 'recording' : 'recordings'}`}
          </span>
          <button className="btn btn-ghost" onClick={onImport}>
            Import
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <h2>No matches</h2>
          <p>Nothing matches &ldquo;{query}&rdquo;. Try a shorter word or a date like &ldquo;Jul 10&rdquo;.</p>
        </div>
      ) : libView === 'calendar' ? (
        <CalendarView meetings={filtered} onOpen={onOpen} />
      ) : (
        <div className="meeting-list">
          {filtered.map((m) => (
            <button key={m.id} className="meeting-row" onClick={() => onOpen(m.id)}>
              <span className="meeting-row-title">{m.title}</span>
              <span className="meeting-row-meta">
                <StageBadge stage={m.stage} progress={m.progress} />
                <span>{formatDuration(m.durationMs)}</span>
                <span>{formatWhen(m.createdAt)}</span>
              </span>
              <span className="meeting-row-sub">
                {(query ? deepMatches.get(m.id) : undefined) ??
                  m.tldr ??
                  (m.stage === 'error' ? (m.error ?? 'Processing failed') : '')}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

// weekends are dropped from the grid — this is a work calendar
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function CalendarView({
  meetings,
  onOpen
}: {
  meetings: MeetingListItem[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [showSchedule, setShowSchedule] = useState(
    () => localStorage.getItem('calSchedule') !== 'off'
  )
  const [prep, setPrep] = useState<Record<string, string>>({})
  const [prepFor, setPrepFor] = useState<CalendarEvent | null>(null)

  useEffect(() => {
    window.scribe.prep.all().then(setPrep)
  }, [])

  function toggleSchedule(): void {
    const next = !showSchedule
    setShowSchedule(next)
    localStorage.setItem('calSchedule', next ? 'on' : 'off')
  }

  const byDay = useMemo(() => {
    const map = new Map<string, MeetingListItem[]>()
    for (const m of meetings) {
      const key = dayKey(new Date(m.createdAt))
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    // chronological within a day
    for (const list of map.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
    return map
  }, [meetings])

  // 6 rows x 5 columns: weeks starting Monday, weekends skipped
  const days = useMemo(() => {
    const startOffset = (anchor.getDay() + 6) % 7
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - startOffset)
    return Array.from(
      { length: 42 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    ).filter((d) => d.getDay() !== 0 && d.getDay() !== 6)
  }, [anchor])

  // scheduled calendar events for the visible grid (when a feed is connected)
  useEffect(() => {
    if (!showSchedule) {
      setEvents([])
      return
    }
    let alive = true
    const from = days[0]
    const to = new Date(days[days.length - 1].getTime() + 86400000)
    window.scribe.calendar.range(from.toISOString(), to.toISOString()).then((r) => {
      if (alive) setEvents(r.events)
    })
    return () => {
      alive = false
    }
  }, [days, showSchedule])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      if (e.allDay) continue
      const key = dayKey(new Date(e.start))
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start))
    }
    return map
  }, [events])

  const today = dayKey(new Date())
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  function shift(months: number): void {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + months, 1))
  }

  return (
    <div className="calendar">
      <div className="calendar-nav">
        <span className="calendar-month">{monthLabel}</span>
        <div className="calendar-nav-btns">
          <button
            className={`who-chip ${showSchedule ? 'active' : ''}`}
            role="switch"
            aria-checked={showSchedule}
            title={
              showSchedule
                ? 'Showing your full schedule — click for recordings only'
                : 'Showing recordings only — click to include your full schedule'
            }
            onClick={toggleSchedule}
          >
            Schedule
          </button>
          <button className="btn btn-ghost" onClick={() => shift(-1)} aria-label="Previous month">
            ‹
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              const now = new Date()
              setAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
            }}
          >
            Today
          </button>
          <button className="btn btn-ghost" onClick={() => shift(1)} aria-label="Next month">
            ›
          </button>
        </div>
      </div>
      <div className="calendar-grid calendar-weekdays">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="calendar-grid calendar-days">
        {days.map((d) => {
          const key = dayKey(d)
          const inMonth = d.getMonth() === anchor.getMonth()
          const dayMeetings = byDay.get(key) ?? []
          // scheduled events, minus ones already represented by a recording
          const recorded = new Set(dayMeetings.map((m) => m.title.trim().toLowerCase()))
          const dayEvents = (eventsByDay.get(key) ?? []).filter(
            (e) => !recorded.has(e.title.trim().toLowerCase())
          )
          return (
            <div
              className={`calendar-cell ${inMonth ? '' : 'outside'} ${key === today ? 'today' : ''}`}
              key={key}
            >
              <span className="calendar-daynum">
                {d.getDate() === 1
                  ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  : d.getDate()}
              </span>
              {dayMeetings.map((m) => (
                <button
                  className="calendar-card"
                  key={m.id}
                  onClick={() => onOpen(m.id)}
                  title={m.tldr ?? m.title}
                >
                  {m.title}
                </button>
              ))}
              {dayEvents.map((e) => (
                <button
                  className={`calendar-event ${prep[e.id] ? 'has-prep' : ''}`}
                  key={e.id}
                  onClick={() => setPrepFor(e)}
                  title={
                    `${e.title}${e.location ? ` · ${e.location}` : ''}` +
                    (prep[e.id] ? `\n\nPrep: ${prep[e.id]}` : ' — click to add prep notes')
                  }
                >
                  <span className="calendar-event-time">
                    {new Date(e.start).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                  {prep[e.id] && <span className="prep-dot" aria-label="Has prep notes" />}
                  {e.title}
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {prepFor && (
        <PrepDialog
          eventId={prepFor.id}
          title={prepFor.title}
          when={new Date(prepFor.start).toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
          initial={prep[prepFor.id] ?? ''}
          onSaved={setPrep}
          onClose={() => setPrepFor(null)}
        />
      )}
    </div>
  )
}
