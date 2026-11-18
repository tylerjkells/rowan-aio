import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../App'
import { listMeetings, peek, type MeetingRow } from '../data'
import { ChevronIcon, Problem, Stale, dayLabel, duration, stageNote, timeOf } from '../ui'

export function MeetingsView({ selected }: { selected: string | null }): React.JSX.Element {
  const { hub, go, fail, tick } = useApp()
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(() => peek('meetings'))
  const [query, setQuery] = useState('')
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listMeetings(hub)
      .then((r) => {
        if (!live) return
        setMeetings(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = (meetings ?? []).filter((m) => {
      if (!words.length) return true
      const hay = `${m.title} ${m.tldr ?? ''} ${m.notes ?? ''} ${(m.tags ?? []).join(' ')}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    const out: { day: string; items: MeetingRow[] }[] = []
    for (const m of shown) {
      const day = dayLabel(m.createdAt)
      if (out[out.length - 1]?.day === day) out[out.length - 1].items.push(m)
      else out.push({ day, items: [m] })
    }
    return out
  }, [meetings, query])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Meetings</h1>
        <input
          className="search"
          type="search"
          placeholder="Search titles, summaries, notes"
          aria-label="Search meetings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {meetings === null ? (
        <div className="group skeleton tall" />
      ) : groups.length === 0 ? (
        <p className="empty">{query ? 'No meetings match.' : 'No meetings yet. Once your PC syncs, they show up here.'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.day}>
            <h2 className="section-title">{g.day}</h2>
            <div className="group">
              {g.items.map((m) => {
                const note = stageNote(m.stage, m.claimedBy)
                return (
                  <button
                    key={m.id}
                    className={`row meeting-row ${selected === m.id ? 'selected' : ''}`}
                    aria-current={selected === m.id ? 'true' : undefined}
                    onClick={() => go(`/meeting/${encodeURIComponent(m.id)}`)}
                  >
                    <span className="row-main">
                      <span className="row-title clamp-2">{m.title}</span>
                      <span className="row-sub">{[timeOf(m.createdAt), duration(m.durationMs), m.source === 'phone' ? 'from phone' : ''].filter(Boolean).join(' · ')}</span>
                      {note ? <span className="row-note">{note}</span> : m.tldr && <span className="row-tldr">{m.tldr}</span>}
                    </span>
                    <ChevronIcon size={18} />
                  </button>
                )
              })}
            </div>
          </section>
        ))
      )}
    </>
  )
}
