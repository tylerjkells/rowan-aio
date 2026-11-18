import { useEffect, useMemo, useState } from 'react'
import type { PersonDetails } from '../../../src/shared/types'
import { useApp } from '../App'
import { listMeetings, loadDirectory, openActions, peek, type MeetingRow, type OpenAction } from '../data'
import { BackIcon, ChevronIcon, Problem, Stale, dayLabel, dueLabel } from '../ui'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** everyone in the team directory: the roster from Settings, with the directory's details */
function usePeople(): {
  names: string[]
  dir: Record<string, PersonDetails>
  stale: boolean
  error: string | null
} {
  const { hub, settings, fail, tick } = useApp()
  const [dir, setDir] = useState<Record<string, PersonDetails>>(() => peek('directory') ?? {})
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadDirectory(hub)
      .then((r) => {
        if (!live) return
        setDir(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])
  const names = useMemo(() => {
    const roster = settings?.people ?? []
    const known = new Set(roster.map((n) => n.toLowerCase()))
    // anyone with details but missing from the roster still shows, title-cased
    const extra = Object.keys(dir)
      .filter((k) => !known.has(k))
      .map((k) => k.replace(/\b\w/g, (c) => c.toUpperCase()))
    return [...roster, ...extra].sort((a, b) => a.localeCompare(b))
  }, [settings?.people, dir])
  return { names, dir, stale, error }
}

export function PeopleView({ selected }: { selected: string | null }): React.JSX.Element {
  const { go } = useApp()
  const { names, dir, stale, error } = usePeople()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const out: { letter: string; names: string[] }[] = []
    for (const n of names) {
      const d = dir[n.toLowerCase()] ?? {}
      const hay = `${n} ${d.title ?? ''} ${d.department ?? ''} ${d.email ?? ''}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
      const letter = n[0]?.toUpperCase() ?? '#'
      if (out[out.length - 1]?.letter === letter) out[out.length - 1].names.push(n)
      else out.push({ letter, names: [n] })
    }
    return out
  }, [names, dir, query])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">People</h1>
        <input
          className="search"
          type="search"
          placeholder="Search names, titles, departments"
          aria-label="Search people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {names.length === 0 ? (
        <p className="empty">No one in the directory yet. Add people in Rowan on your PC.</p>
      ) : groups.length === 0 ? (
        <p className="empty">No one matches.</p>
      ) : (
        groups.map((g) => (
          <section key={g.letter}>
            <h2 className="section-title">{g.letter}</h2>
            <div className="group">
              {g.names.map((n) => {
                const d = dir[n.toLowerCase()] ?? {}
                return (
                  <button
                    key={n}
                    className={`row ${selected?.toLowerCase() === n.toLowerCase() ? 'selected' : ''}`}
                    onClick={() => go(`/person/${encodeURIComponent(n)}`)}
                  >
                    <span className="avatar" aria-hidden="true">
                      {initials(n)}
                    </span>
                    <span className="row-main">
                      <span className="row-title">{n}</span>
                      {(d.title || d.department) && <span className="row-sub">{[d.title, d.department].filter(Boolean).join(' · ')}</span>}
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

/** "David", "David Lee" and "David and Melissa" all count as David Lee's */
function owns(owner: string | null, name: string): boolean {
  const o = (owner ?? '').toLowerCase()
  const full = name.toLowerCase()
  const first = full.split(/\s+/)[0]
  return o === full || o.split(/\s*(?:,|\band\b|&|\/)\s*/).some((part) => part === full || part === first)
}

export function PersonView({ name, embedded = false }: { name: string; embedded?: boolean }): React.JSX.Element {
  const { hub, go, back, fail, tick } = useApp()
  const { names, dir, stale, error } = usePeople()
  const [actions, setActions] = useState<OpenAction[] | null>(() => peek('actions'))
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(() => peek('meetings'))

  useEffect(() => {
    let live = true
    Promise.all([openActions(hub), listMeetings(hub)])
      .then(([a, m]) => {
        if (!live) return
        setActions(a.value)
        setMeetings(m.value)
      })
      .catch((err) => live && fail(err))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  const d: PersonDetails = dir[name.toLowerCase()] ?? {}
  const reports = names.filter((n) => (dir[n.toLowerCase()]?.reportsTo ?? '').toLowerCase() === name.toLowerCase())
  const theirs = (actions ?? []).filter((a) => owns(a.item.owner, name)).slice(0, 8)
  const together = (meetings ?? [])
    .filter((m) => (m.attendees ?? []).some((a) => a.toLowerCase() === name.toLowerCase()))
    .slice(0, 8)
  const phone = d.phone?.replace(/[^\d+]/g, '')

  return (
    <>
      {!embedded && (
        <nav className="navbar">
          <button className="nav-back" onClick={() => back('/people')}>
            <BackIcon size={22} /> People
          </button>
        </nav>
      )}
      <Stale show={stale} />
      <Problem error={error} />
      <header className="person-head">
        <span className="avatar large" aria-hidden="true">
          {initials(name)}
        </span>
        <h1 className="title">{name}</h1>
        {(d.title || d.department) && <p className="meta">{[d.title, d.department].filter(Boolean).join(' · ')}</p>}
        {d.office && <p className="meta">{d.office}</p>}
      </header>

      {(d.email || phone) && (
        <div className="contact-actions">
          {d.email && (
            <a className="contact" href={`mailto:${d.email}`}>
              <span>Email</span>
            </a>
          )}
          {phone && (
            <a className="contact" href={`tel:${phone}`}>
              <span>Call</span>
            </a>
          )}
          {d.email && (
            <a className="contact" href={`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(d.email)}`} target="_blank" rel="noopener noreferrer">
              <span>Teams</span>
            </a>
          )}
        </div>
      )}

      {(d.email || d.phone) && (
        <div className="group details">
          {d.email && (
            <div className="detail">
              <span className="detail-label">Email</span>
              <span className="detail-value">{d.email}</span>
            </div>
          )}
          {d.phone && (
            <div className="detail">
              <span className="detail-label">Phone</span>
              <span className="detail-value">{d.phone}</span>
            </div>
          )}
        </div>
      )}

      {(d.reportsTo || reports.length > 0) && (
        <section>
          <h2 className="section-title">Team</h2>
          <div className="group">
            {d.reportsTo && (
              <button className="row" onClick={() => go(`/person/${encodeURIComponent(d.reportsTo as string)}`)}>
                <span className="row-main">
                  <span className="row-sub">Reports to</span>
                  <span className="row-title">{d.reportsTo}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            )}
            {reports.map((r) => (
              <button key={r} className="row" onClick={() => go(`/person/${encodeURIComponent(r)}`)}>
                <span className="row-main">
                  <span className="row-sub">Reports to {name.split(/\s+/)[0]}</span>
                  <span className="row-title">{r}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {theirs.length > 0 && (
        <section>
          <h2 className="section-title">Open action items</h2>
          <div className="group">
            {theirs.map((a) => (
              <button key={`${a.meetingId}-${a.index}`} className="row" onClick={() => go(`/meeting/${encodeURIComponent(a.meetingId)}`)}>
                <span className="row-main">
                  <span className="row-title clamp-3">{a.item.task}</span>
                  <span className="row-sub">{[dueLabel(a.due, a.item.due), a.meetingTitle].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {together.length > 0 && (
        <section>
          <h2 className="section-title">Meetings together</h2>
          <div className="group">
            {together.map((m) => (
              <button key={m.id} className="row" onClick={() => go(`/meeting/${encodeURIComponent(m.id)}`)}>
                <span className="row-main">
                  <span className="row-title clamp-2">{m.title}</span>
                  <span className="row-sub">{dayLabel(m.createdAt)}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {d.notes && (
        <section>
          <h2 className="section-title">Notes</h2>
          <p className="plain">{d.notes}</p>
        </section>
      )}
    </>
  )
}
