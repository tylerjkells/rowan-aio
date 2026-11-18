import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { openActions, peek, setActionDone, type OpenAction } from '../data'
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

  const shown = (items ?? []).filter((a) => !mineOnly || isMine(a.item.owner))
  const groups = ORDER.map((name) => ({ name, items: shown.filter((a) => bucket(a.due) === name) })).filter((g) => g.items.length)

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
        <p className="empty">Nothing open. Nice.</p>
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
                  </div>
                )
              })}
            </div>
          </section>
        ))
      )}
    </>
  )
}
