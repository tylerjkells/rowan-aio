import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActionRollupItem,
  AppSettings,
  CalendarEvent,
  EventBrief,
  LinkEntry,
  MeetingListItem
} from '../../../shared/types'
import { ChevronIcon, formatDuration, formatWhen, isOverdue, MicIcon, StageBadge } from '../ui'

/**
 * The location field on virtual/hybrid events often carries platform
 * boilerplate ("Microsoft Teams Meeting") or the join URL itself; keep only
 * the parts that name a real place.
 */
function cleanLocation(location: string | null): string | null {
  if (!location) return null
  const parts = location
    .split(';')
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.length > 0 &&
        !/^https?:\/\//i.test(p) &&
        !/^(microsoft teams|zoom|webex|google|webex by cisco)( meeting)?$/i.test(p)
    )
  return parts.length > 0 ? parts.join('; ') : null
}

function attendeeLabel(attendees: string[]): string {
  const shown = attendees.slice(0, 4)
  const extra = attendees.length - shown.length
  return `with ${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function isToday(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function BriefPanel({
  brief,
  onOpen
}: {
  brief: EventBrief
  onOpen: (id: string) => void
}): React.JSX.Element {
  const decisions = brief.decisions.slice(0, 3)
  const actions = brief.openActions.slice(0, 4)
  const questions = brief.openQuestions.slice(0, 2)
  const empty = decisions.length === 0 && actions.length === 0 && questions.length === 0
  return (
    <span className="sched-brief">
      <button
        className="brief-source"
        onClick={() => onOpen(brief.meetingId)}
        title="Open this meeting"
      >
        {brief.meetingTitle} · {formatWhen(brief.createdAt)} →
      </button>
      {brief.related && brief.filterWords && (
        <span className="brief-filternote">
          Only points mentioning {brief.filterWords.map((w) => `“${w}”`).join(', ')} — open the
          meeting for everything.
        </span>
      )}
      {decisions.length > 0 && (
        <span className="brief-block">
          <span className="brief-label">Decided</span>
          <ul className="brief-list">
            {decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
            {brief.decisions.length > 3 && <li className="brief-more">+{brief.decisions.length - 3} more</li>}
          </ul>
        </span>
      )}
      {actions.length > 0 && (
        <span className="brief-block">
          <span className="brief-label">Still open</span>
          <ul className="brief-list">
            {actions.map((a, i) => (
              <li key={i}>
                {a.task}
                {(a.owner || a.due) && (
                  <span className="brief-owner">
                    {' '}
                    ({[a.owner, a.due].filter(Boolean).join(' · ')})
                  </span>
                )}
              </li>
            ))}
            {brief.openActions.length > 4 && (
              <li className="brief-more">+{brief.openActions.length - 4} more</li>
            )}
          </ul>
        </span>
      )}
      {questions.length > 0 && (
        <span className="brief-block">
          <span className="brief-label">Open questions</span>
          <ul className="brief-list">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </span>
      )}
      {empty && brief.tldr && <span className="brief-tldr">{brief.tldr}</span>}
    </span>
  )
}

export function TodayView({
  meetings,
  onOpen,
  onRecord,
  onSettings,
  onActions,
  onDigest
}: {
  meetings: MeetingListItem[]
  onOpen: (id: string) => void
  onRecord: () => void
  onSettings: () => void
  onActions: () => void
  onDigest: () => void
}): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [calError, setCalError] = useState<string | null>(null)
  const [calLoaded, setCalLoaded] = useState(false)
  const [actions, setActions] = useState<ActionRollupItem[]>([])
  const [briefs, setBriefs] = useState<Map<string, EventBrief>>(new Map())
  const [pinnedLinks, setPinnedLinks] = useState<LinkEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const autoExpanded = useRef(false)
  // re-render every minute so the "Now" marker tracks the clock
  const [, tick] = useState(0)

  useEffect(() => {
    window.scribe.settings.get().then(setSettings)
    window.scribe.actions.list().then(setActions)
    window.scribe.links.list().then((ls) => setPinnedLinks(ls.filter((l) => l.pinned)))
    window.scribe.calendar.today().then((r) => {
      setEvents(r.events)
      setCalError(r.error ?? null)
      setCalLoaded(true)
    })
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  // pre-meeting briefs: where each event's series left off last time
  useEffect(() => {
    let alive = true
    ;(async () => {
      const map = new Map<string, EventBrief>()
      for (const ev of events.filter((e) => !e.allDay)) {
        const brief = await window.scribe.meetings.briefFor(ev.title)
        if (brief) map.set(ev.id, brief)
      }
      if (!alive) return
      setBriefs(map)
      // open the brief you most likely need next: the live event, else the
      // next upcoming one (once — user toggles are respected afterwards)
      if (!autoExpanded.current && map.size > 0) {
        autoExpanded.current = true
        const now = Date.now()
        const target =
          events.find((e) => {
            const s = new Date(e.start).getTime()
            const en = new Date(e.end).getTime()
            return !e.allDay && map.has(e.id) && now >= s && now < en
          }) ??
          events.find((e) => !e.allDay && map.has(e.id) && new Date(e.start).getTime() > now)
        if (target) setExpanded(new Set([target.id]))
      }
    })()
    return () => {
      alive = false
    }
  }, [events])

  const todayMeetings = useMemo(() => meetings.filter((m) => isToday(m.createdAt)), [meetings])
  const myOpenActions = useMemo(
    () =>
      actions
        .filter((a) => !a.done && a.owners.includes('Me'))
        .sort((a, b) => ((a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1)),
    [actions]
  )
  const timedEvents = events.filter((e) => !e.allDay)
  const allDayEvents = events.filter((e) => e.allDay)
  const now = Date.now()

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  async function toggleAction(item: ActionRollupItem): Promise<void> {
    const newDone = await window.scribe.actions.toggle(item.meetingId, item.index)
    setActions((prev) =>
      prev.map((a) =>
        a.meetingId === item.meetingId && a.index === item.index ? { ...a, done: newDone } : a
      )
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Today</h1>
        <div className="page-head-tools">
          <button className="btn btn-ghost" onClick={onDigest}>
            Weekly digest
          </button>
          <span className="count-note">{dateLabel}</span>
        </div>
      </div>

      {pinnedLinks.length > 0 && (
        <div className="today-links">
          {pinnedLinks.map((l) => (
            <a
              key={l.id}
              className="today-link-chip"
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.url}
            >
              {l.name}
            </a>
          ))}
        </div>
      )}

      <div className="today-col">
        <section className="today-section">
          <div className="card-subhead">Schedule</div>

          {settings && !settings.hasCalendar && (
            <div className="today-connect">
              <p>
                Connect your calendar to see today&apos;s meetings here, get recordings titled
                after their events, and jump into related notes before you join.
              </p>
              <button className="btn" onClick={onSettings}>
                Connect calendar in Settings
              </button>
            </div>
          )}

          {calError && (
            <p className="field-note error" role="alert">
              {calError}
            </p>
          )}

          {settings?.hasCalendar && calLoaded && !calError && events.length === 0 && (
            <p className="today-quiet">Nothing on the calendar today.</p>
          )}

          {allDayEvents.length > 0 && (
            <p className="today-allday">
              All day: {allDayEvents.map((e) => e.title).join(' · ')}
            </p>
          )}

          {timedEvents.length > 0 && (
            <div className="sched-list">
              {timedEvents.map((ev) => {
                const start = new Date(ev.start).getTime()
                const end = new Date(ev.end).getTime()
                const live = now >= start && now < end
                const past = now >= end
                const brief = briefs.get(ev.id)
                const briefOpen = expanded.has(ev.id)
                const room = cleanLocation(ev.location)
                return (
                  <div className={`sched-row ${live ? 'live' : ''} ${past ? 'past' : ''}`} key={ev.id}>
                    <span className="sched-time">
                      {formatTime(ev.start)}
                      <span className="sched-time-end">{formatTime(ev.end)}</span>
                    </span>
                    <span className="sched-body">
                      <span className="sched-title">
                        {live && <span className="sched-now">Now</span>}
                        {ev.title}
                      </span>
                      {(room || ev.joinUrl || ev.attendees.length > 0 || brief) && (
                        <span className="sched-meta">
                          {ev.joinUrl && (
                            <a className="sched-join" href={ev.joinUrl} target="_blank" rel="noreferrer">
                              Join link
                            </a>
                          )}
                          {room && <span>{room}</span>}
                          {ev.attendees.length > 0 && (
                            <span title={ev.attendees.join(', ')}>{attendeeLabel(ev.attendees)}</span>
                          )}
                          {brief && (
                            <button
                              className="brief-toggle"
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(ev.id)) next.delete(ev.id)
                                  else next.add(ev.id)
                                  return next
                                })
                              }
                              aria-expanded={briefOpen}
                            >
                              <span className={`chevron ${briefOpen ? 'open' : ''}`} aria-hidden="true">
                                <ChevronIcon />
                              </span>
                              {brief.related
                                ? 'Related notes'
                                : `Last met ${formatWhen(brief.createdAt)}`}
                            </button>
                          )}
                        </span>
                      )}
                      {brief && briefOpen && <BriefPanel brief={brief} onOpen={onOpen} />}
                    </span>
                    {live && (
                      <button className="btn btn-primary sched-record" onClick={onRecord}>
                        <MicIcon /> Record
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="today-section">
          <div className="card-subhead">Today in the library</div>
          {todayMeetings.length === 0 ? (
            <p className="today-quiet">
              No recordings yet today.{' '}
              <button className="link-btn" onClick={onRecord}>
                Start one
              </button>
            </p>
          ) : (
            <div className="meeting-list">
              {todayMeetings.map((m) => (
                <button
                  key={m.id}
                  className="meeting-row compact"
                  onClick={() => onOpen(m.id)}
                  title={m.tldr}
                >
                  <span className="meeting-row-title">{m.title}</span>
                  <span className="meeting-row-meta">
                    <StageBadge stage={m.stage} progress={m.progress} />
                    <span>{formatDuration(m.durationMs)}</span>
                    <span>{formatTime(m.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="today-section">
          <div className="card-subhead">Your open action items</div>
          {myOpenActions.length === 0 ? (
            <p className="today-quiet">Nothing open with your name on it.</p>
          ) : (
            <>
              <div className="rollup-list">
                {myOpenActions.slice(0, 6).map((item) => (
                  <div className="rollup-item" key={`${item.meetingId}-${item.index}`}>
                    <input
                      type="checkbox"
                      className="rollup-check"
                      checked={item.done}
                      onChange={() => toggleAction(item)}
                      aria-label={`Mark "${item.task}" done`}
                    />
                    <div className="rollup-body">
                      <span className="rollup-task">{item.task}</span>
                      <span className="rollup-meta">
                        {item.due && (
                          <span className={`action-due ${isOverdue(item) ? 'overdue' : ''}`}>
                            {item.due}
                          </span>
                        )}
                        <button className="rollup-source" onClick={() => onOpen(item.meetingId)}>
                          {item.meetingTitle}
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {myOpenActions.length > 6 && (
                <button className="link-btn today-more" onClick={onActions}>
                  All {myOpenActions.length} open items
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  )
}
