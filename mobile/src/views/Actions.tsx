import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { RECENT_DAYS, addable, onList, openActions, peek, setActionDone, setActionTracked, type OpenAction } from '../data'
import { Check, Problem, Stale, dueLabel, localDay } from '../ui'

function bucket(due: string | null): string {
  if (!due) return 'No date'
  const today = localDay()
  const week = localDay(7)
  if (due < today) return 'Overdue'
  if (due <= week) return 'This week'
  return 'Later'
}

const ORDER = ['Overdue', 'This week', 'Later', 'No date']

export function ActionsView(): React.JSX.Element {
  const { hub, go, fail, tick, settings } = useApp()
  const [items, setItems] = useState<OpenAction[] | null>(() => peek('actions'))
  const [done, setDone] = useState<Set<string>>(new Set())
  // added or removed here, ahead of the next load
  const [moved, setMoved] = useState<Map<string, boolean>>(new Map())
  const [mineOnly, setMineOnly] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    openActions(hub)
      .then((r) => {
        if (!live) return
        setItems(r.value)
        setStale(r.stale)
        setDone(new Set())
        setMoved(new Map())
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  // the summarizer writes owners as "Me", a first name, or a full name
  const me = (settings?.yourName ?? '').trim().toLowerCase()
  const first = me.split(/\s+/)[0]
  const isMine = (owner: string | null): boolean => {
    const o = (owner ?? '').trim().toLowerCase()
    return !o || o === 'me' || (!!first && (o === me || o.split(/\s+/)[0] === first))
  }

  async function toggle(a: OpenAction): Promise<void> {
    const key = `${a.meetingId}:${a.index}`
    const nowDone = !done.has(key)
    setDone((s) => {
      const n = new Set(s)
      if (nowDone) n.add(key)
      else n.delete(key)
      return n
    })
    try {
      await setActionDone(hub, a.meetingId, a.index, a.item.task, nowDone)
    } catch (err) {
      setDone((s) => {
        const n = new Set(s)
        if (nowDone) n.delete(key)
        else n.add(key)
        return n
      })
      setError(fail(err))
    }
  }

  async function track(a: OpenAction, tracked: boolean): Promise<void> {
    const key = `${a.meetingId}:${a.index}`
    setMoved((m) => new Map(m).set(key, tracked))
    try {
      await setActionTracked(hub, a.meetingId, a.index, a.item.task, tracked)
    } catch (err) {
      setMoved((m) => {
        const n = new Map(m)
        n.delete(key)
        return n
      })
      setError(fail(err))
    }
  }

  // each item as it stands after what was tapped here
  const all = (items ?? []).map((a) => {
    const t = moved.get(`${a.meetingId}:${a.index}`)
    return t === undefined ? a : { ...a, item: { ...a.item, tracked: t } }
  })
  const mine = (a: OpenAction): boolean => !mineOnly || isMine(a.item.owner)
  const shown = onList(all).filter(mine)
  const groups = ORDER.map((name) => ({ name, items: shown.filter((a) => bucket(a.due) === name) })).filter((g) => g.items.length)
  const toAdd = addable(all).filter(mine)
  const byMeeting = toAdd.reduce<{ id: string; title: string; items: OpenAction[] }[]>((out, a) => {
    const g = out.find((x) => x.id === a.meetingId)
    if (g) g.items.push(a)
    else out.push({ id: a.meetingId, title: a.meetingTitle, items: [a] })
    return out
  }, [])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Action items</h1>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={!mineOnly} className={!mineOnly ? 'on' : ''} onClick={() => setMineOnly(false)}>
            Everyone
          </button>
          <button role="tab" aria-selected={mineOnly} className={mineOnly ? 'on' : ''} onClick={() => setMineOnly(true)}>
            Mine
          </button>
        </div>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {items === null ? (
        <div className="group skeleton tall" />
      ) : groups.length === 0 ? (
        <p className="empty">
          {onList(all).length === 0
            ? 'Your list is empty. Add the action items you want to follow, yours or someone else’s, from a meeting or from below.'
            : 'Nothing open. Nice.'}
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.name}>
            <h2 className={`section-title ${g.name === 'Overdue' ? 'overdue' : ''}`}>{g.name}</h2>
            <div className="group">
              {g.items.map((a) => {
                const key = `${a.meetingId}:${a.index}`
                const isDone = done.has(key)
                return (
                  <div key={key} className={`row check-row ${isDone ? 'done' : ''}`}>
                    <button className="check-hit" onClick={() => void toggle(a)} aria-pressed={isDone} aria-label={isDone ? 'Mark not done' : 'Mark done'}>
                      <Check done={isDone} />
                    </button>
                    <button className="row-main as-button" onClick={() => go(`/meeting/${encodeURIComponent(a.meetingId)}`)}>
                      <span className="row-title clamp-3">{a.item.task}</span>
                      <span className="row-sub">{[dueLabel(a.due, a.item.due), a.item.owner, a.meetingTitle].filter(Boolean).join(' · ')}</span>
                    </button>
                    <button className="track on" onClick={() => void track(a, false)} aria-label={`Take off your list: ${a.item.task}`}>
                      Remove
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))
      )}

      {byMeeting.length > 0 && (
        <section className="addable">
          <h2 className="section-title">From recent meetings</h2>
          <p className="fine left">Open items from the last {RECENT_DAYS} days that aren’t on your list.</p>
          {byMeeting.map((g) => (
            <div key={g.id} className="addable-meeting">
              <button className="addable-title link" onClick={() => go(`/meeting/${encodeURIComponent(g.id)}`)}>
                {g.title}
              </button>
              <div className="group">
                {g.items.map((a) => (
                  <div key={`${a.meetingId}:${a.index}`} className="row">
                    <span className="row-main">
                      <span className="row-title clamp-3">{a.item.task}</span>
                      {(a.item.owner || a.due) && <span className="row-sub">{[a.item.owner, dueLabel(a.due, a.item.due)].filter(Boolean).join(' · ')}</span>}
                    </span>
                    <button className="track" onClick={() => void track(a, true)} aria-label={`Add to your list: ${a.item.task}`}>
                      Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  )
}
