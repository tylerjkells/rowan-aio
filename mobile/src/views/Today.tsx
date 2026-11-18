import { useEffect, useState } from 'react'
import type { PlanItem } from '../../../src/shared/types'
import { useApp } from '../App'
import { listMeetings, loadPlanner, openActions, peek, type MeetingRow, type OpenAction } from '../data'
import { pending, type PendingRecording } from '../recorder'
import { ChevronIcon, MicIcon, Problem, Stale, dayLabel, dueLabel, duration, stageNote, timeOf } from '../ui'

function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const first = name.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

export function TodayView(): React.JSX.Element {
  const { hub, settings, go, fail, tick, signOut } = useApp()
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(() => peek('meetings'))
  const [actions, setActions] = useState<OpenAction[] | null>(() => peek('actions'))
  const [plan, setPlan] = useState<PlanItem[] | null>(() => peek('planner'))
  const [unsent, setUnsent] = useState<PendingRecording[]>([])
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    pending().then((p) => live && setUnsent(p)).catch(() => {})
    Promise.all([listMeetings(hub), openActions(hub), loadPlanner(hub)])
      .then(([m, a, p]) => {
        if (!live) return
        setMeetings(m.value)
        setActions(a.value)
        setPlan(p.value)
        setStale(m.stale || a.stale || p.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  const todayIso = new Date().toISOString().slice(0, 10)
  const weekAhead = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
  const due = (actions ?? []).filter((a) => a.due && a.due <= weekAhead).slice(0, 5)
  const overdue = (actions ?? []).filter((a) => a.due && a.due < todayIso).length
  const now = (plan ?? []).filter((p) => p.status === 'now').sort((a, b) => a.order - b.order)
  // phone recordings not yet back from the PC as a finished meeting
  const waiting = (meetings ?? []).filter(
    (m) => m.stage === 'uploaded' || (m.source === 'phone' && m.stage !== 'ready' && m.stage !== 'transcript-only')
  )
  const recent = (meetings ?? []).filter((m) => !waiting.includes(m)).slice(0, 5)

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1 className="large-title">{greeting(settings?.yourName ?? '')}</h1>
      </header>
      <Stale show={stale} />
      <Problem error={error} />

      <button className="record-card" onClick={() => go('/record')}>
        <span className="record-card-dot" aria-hidden="true">
          <MicIcon size={22} />
        </span>
        <span className="record-card-text">
          <span className="record-card-title">Record a meeting</span>
          <span className="record-card-sub">Keep the app open on the table; your PC transcribes it.</span>
        </span>
      </button>

      {unsent.length > 0 && (
        <section>
          <h2 className="section-title">Not sent yet</h2>
          <div className="group">
            {unsent.map((r) => (
              <button key={r.id} className="row" onClick={() => go('/record')}>
                <span className="row-main">
                  <span className="row-title">{r.title}</span>
                  <span className="row-sub">
                    {r.state === 'failed' ? 'Didn’t send · tap to try again' : 'Saved on this phone · tap to send'}
                  </span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section>
          <h2 className="section-title">From your phone</h2>
          <div className="group">
            {waiting.map((m) => (
              <button key={m.id} className="row" onClick={() => go(`/meeting/${encodeURIComponent(m.id)}`)}>
                <span className="row-main">
                  <span className="row-title">{m.title}</span>
                  <span className="row-sub">{stageNote(m.stage, m.claimedBy)}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2 className="section-title">Due soon</h2>
          {actions && actions.length > 0 && (
            <button className="link" onClick={() => go('/actions')}>
              All {actions.length}
            </button>
          )}
        </div>
        {overdue > 0 && <p className="note-warn">{overdue} overdue</p>}
        {actions === null ? (
          <div className="group skeleton" />
        ) : due.length === 0 ? (
          <p className="empty">Nothing due this week.</p>
        ) : (
          <div className="group">
            {due.map((a) => (
              <button key={`${a.meetingId}-${a.index}`} className="row" onClick={() => go(`/meeting/${encodeURIComponent(a.meetingId)}`)}>
                <span className="row-main">
                  <span className="row-title">{a.item.task}</span>
                  <span className={`row-sub ${a.due && a.due < todayIso ? 'overdue' : ''}`}>
                    {[dueLabel(a.due, a.item.due), a.item.owner].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {now.length > 0 && (
        <section>
          <div className="section-head">
            <h2 className="section-title">Planner · Now</h2>
            <button className="link" onClick={() => go('/planner')}>
              Open
            </button>
          </div>
          <div className="group">
            {now.slice(0, 5).map((p) => (
              <button key={p.id} className="row" onClick={() => go('/planner')}>
                <span className="row-main">
                  <span className="row-title">{p.title}</span>
                  {(p.requester || p.due) && (
                    <span className="row-sub">{[p.requester && `for ${p.requester}`, p.due && `due ${p.due}`].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2 className="section-title">Recent meetings</h2>
          <button className="link" onClick={() => go('/meetings')}>
            All
          </button>
        </div>
        {meetings === null ? (
          <div className="group skeleton" />
        ) : recent.length === 0 ? (
          <p className="empty">No meetings yet. Once your PC syncs, they show up here.</p>
        ) : (
          <div className="group">
            {recent.map((m) => (
              <button key={m.id} className="row" onClick={() => go(`/meeting/${encodeURIComponent(m.id)}`)}>
                <span className="row-main">
                  <span className="row-title">{m.title}</span>
                  <span className="row-sub">{[dayLabel(m.createdAt), timeOf(m.createdAt), duration(m.durationMs)].filter(Boolean).join(' · ')}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        )}
      </section>

      <footer className="account">
        Signed in as {hub.email} ·{' '}
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </footer>
    </>
  )
}
