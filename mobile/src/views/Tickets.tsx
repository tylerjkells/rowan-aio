import { useEffect, useMemo, useRef, useState } from 'react'
import type { Ticket, TicketNote, TicketPlan } from '../../../src/shared/types'
import { useApp } from '../App'
import { TICKET_PLANS, loadTickets, peek, setTicketNote, type TicketFile } from '../data'
import { BackIcon, ChevronIcon, Problem, Stale, dayInSentence, dayLabel, timeOf } from '../ui'

const SN = 'https://support.rowan.edu'
const ticketUrl = (t: Ticket): string => `${SN}/nav_to.do?uri=${encodeURIComponent('/incident.do?sys_id=' + t.sysId)}`
const CLOSED = /resolved|closed|cancel/i

function useTickets(): { file: TicketFile | null; setFile: (f: TicketFile) => void; stale: boolean; error: string | null } {
  const { hub, fail, tick } = useApp()
  const [file, setFile] = useState<TicketFile | null>(() => peek('tickets'))
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadTickets(hub)
      .then((r) => {
        if (!live) return
        setFile(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])
  return { file, setFile, stale, error }
}

/** "Kells, Tyler" in ServiceNow is the "me" the PC recorded */
function isMe(who: string, me: string | null): boolean {
  return !!me && who.trim().toLowerCase() === me.trim().toLowerCase()
}

/** the same nudges as the desktop: who has the last word, and what has gone quiet */
function flags(t: Ticket, me: string | null): string[] {
  const out: string[] = []
  const mine = t.thread.some((e) => isMe(e.who, me))
  const latest = t.thread[0]
  if (me && !mine && t.state !== 'On Hold') out.push('No reply yet')
  else if (mine && latest && !isMe(latest.who, me)) out.push('They replied')
  const days = (Date.now() - Date.parse(t.updatedAt)) / 864e5
  if (days > 30) out.push('Quiet 30+ days')
  return out
}

const GROUPS: { plan: TicketPlan; label: string }[] = [...TICKET_PLANS.map((p) => ({ plan: p.id, label: p.label })), { plan: '', label: 'Not sorted' }]

export function TicketsView({ selected }: { selected: string | null }): React.JSX.Element {
  const { go } = useApp()
  const { file, stale, error } = useTickets()
  const [closed, setClosed] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    if (!file) return []
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = Object.values(file.tickets)
      .filter((t) => (closed ? t.closed || CLOSED.test(t.state) : !(t.closed || CLOSED.test(t.state))))
      .filter((t) => words.every((w) => `${t.number} ${t.title} ${t.caller} ${t.type ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => (closed ? (b.closedAt || b.updatedAt).localeCompare(a.closedAt || a.updatedAt) : b.updatedAt.localeCompare(a.updatedAt)))
    if (closed) return [{ label: 'Closed', items: all.slice(0, 60) }]
    return GROUPS.map((g) => ({ label: g.label, items: all.filter((t) => (file.notes[t.number]?.plan ?? '') === g.plan) })).filter((g) => g.items.length)
  }, [file, closed, query])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Tickets</h1>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={!closed} className={!closed ? 'on' : ''} onClick={() => setClosed(false)}>
            Open
          </button>
          <button role="tab" aria-selected={closed} className={closed ? 'on' : ''} onClick={() => setClosed(true)}>
            Closed
          </button>
        </div>
        <input className="search" type="search" placeholder="Search tickets" aria-label="Search tickets" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {file === null ? (
        <div className="group skeleton tall" />
      ) : groups.length === 0 ? (
        <p className="empty">{Object.keys(file.tickets).length ? 'Nothing here.' : 'No tickets yet. Update them in Rowan on your PC.'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h2 className="section-title">
              {g.label} · {g.items.length}
            </h2>
            <div className="group">
              {g.items.map((t) => {
                const note = file?.notes[t.number]
                const f = flags(t, file?.me ?? null)
                return (
                  <button key={t.number} className={`row meeting-row ${selected === t.number ? 'selected' : ''}`} onClick={() => go(`/ticket/${encodeURIComponent(t.number)}`)}>
                    <span className="row-main">
                      <span className="row-title clamp-2">{t.title}</span>
                      <span className="row-sub">{[t.number, t.caller, t.state].filter(Boolean).join(' · ')}</span>
                      {note?.next ? <span className="row-tldr">Next: {note.next}</span> : null}
                      {!closed && f.length > 0 && (
                        <span className="flags">
                          {f.map((x) => (
                            <span key={x} className={`flag ${x === 'They replied' ? 'hot' : ''}`}>
                              {x}
                            </span>
                          ))}
                        </span>
                      )}
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

export function TicketView({ number, embedded = false }: { number: string; embedded?: boolean }): React.JSX.Element {
  const { hub, back, fail } = useApp()
  const { file, setFile, stale, error } = useTickets()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [next, setNext] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const dirty = useRef(false)

  const t = file?.tickets[number]
  const note: TicketNote | undefined = file?.notes[number]

  useEffect(() => {
    if (dirty.current || !file) return
    setNext(file.notes[number]?.next ?? '')
    setNotes(file.notes[number]?.notes ?? '')
  }, [file, number])

  async function save(patch: Partial<Pick<TicketNote, 'plan' | 'next' | 'notes'>>): Promise<void> {
    setSaveError(null)
    try {
      setFile(await setTicketNote(hub, number, patch))
      dirty.current = false
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setSaveError(fail(err))
    }
  }

  return (
    <>
      {!embedded && (
        <nav className="navbar">
          <button className="nav-back" onClick={() => back('/tickets')}>
            <BackIcon size={22} /> Tickets
          </button>
        </nav>
      )}
      <Stale show={stale} />
      <Problem error={error ?? saveError} />
      {!t ? (
        file ? <p className="empty">This ticket isn’t in your list anymore.</p> : <div className="group skeleton tall" />
      ) : (
        <article className="meeting">
          <header className="meeting-head">
            <h1 className="title">{t.title}</h1>
            <p className="meta">{[t.number, t.state, t.type].filter(Boolean).join(' · ')}</p>
            <p className="meta">
              {t.caller} · opened {dayInSentence(t.openedAt)} · updated {dayInSentence(t.updatedAt)}
            </p>
            {t.sysId && (
              <a className="link inline" href={ticketUrl(t)} target="_blank" rel="noopener noreferrer">
                Open in ServiceNow
              </a>
            )}
          </header>

          <section>
            <div className="section-head">
              <h2 className="section-title">Plan</h2>
              <span className="save-state" aria-live="polite">
                {saved ? 'Saved' : ''}
              </span>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Plan">
              {TICKET_PLANS.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={note?.plan === p.id}
                  className={note?.plan === p.id ? 'on' : ''}
                  onClick={() => void save({ plan: note?.plan === p.id ? '' : p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="section-title">Next step</h2>
            <input
              className="field-input"
              placeholder="What happens next"
              value={next ?? ''}
              onChange={(e) => {
                dirty.current = true
                setNext(e.target.value)
              }}
              onBlur={() => next !== null && next !== (note?.next ?? '') && void save({ next })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </section>

          <section>
            <h2 className="section-title">Your notes</h2>
            <textarea
              className="notes"
              rows={4}
              placeholder="Private notes. They sync to your PCs."
              value={notes ?? ''}
              onChange={(e) => {
                dirty.current = true
                setNotes(e.target.value)
              }}
              onBlur={() => notes !== null && notes !== (note?.notes ?? '') && void save({ notes })}
            />
          </section>

          {t.closeNotes && (
            <section>
              <h2 className="section-title">Resolution</h2>
              <p className="plain">{t.closeNotes}</p>
            </section>
          )}

          {t.thread.length > 0 && (
            <section>
              <h2 className="section-title">History</h2>
              <div className="thread">
                {t.thread.map((e, i) => (
                  <div key={i} className={`entry ${isMe(e.who, file?.me ?? null) ? 'mine' : ''}`}>
                    <p className="entry-head">
                      <b>{e.who}</b> · {dayLabel(e.at)} {timeOf(e.at)}
                      {e.kind === 'worknote' && <span className="flag">Work note</span>}
                    </p>
                    <p className="entry-text">{e.text}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </article>
      )}
    </>
  )
}
