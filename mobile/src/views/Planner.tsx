import { useEffect, useState } from 'react'
import type { PlanItem, PlanStatus } from '../../../src/shared/types'
import { useApp } from '../App'
import { PLAN_STATUSES, addPlanItem, addPlanUpdate, loadPlanner, peek, setPlanStatus, togglePlanStep } from '../data'
import { Check, ChevronIcon, Problem, Stale, dayInSentence, dayLabel } from '../ui'

export function PlannerView(): React.JSX.Element {
  const { hub, fail, tick } = useApp()
  const [items, setItems] = useState<PlanItem[] | null>(() => peek('planner'))
  const [column, setColumn] = useState<PlanStatus>('now')
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [update, setUpdate] = useState('')
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadPlanner(hub)
      .then((r) => {
        if (!live) return
        setItems(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  async function run(op: () => Promise<PlanItem[]>): Promise<void> {
    setBusy(true)
    try {
      setItems(await op())
      setError(null)
    } catch (err) {
      setError(fail(err))
    } finally {
      setBusy(false)
    }
  }

  const shown = (items ?? [])
    .filter((i) => i.status === column)
    .sort((a, b) => a.order - b.order)
    .slice(0, column === 'done' ? 30 : undefined)
  const count = (s: PlanStatus): number => (items ?? []).filter((i) => i.status === s).length

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Planner</h1>
        <div className="segmented wide" role="tablist">
          {PLAN_STATUSES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={column === s.id}
              className={column === s.id ? 'on' : ''}
              onClick={() => {
                setColumn(s.id)
                setOpen(null)
              }}
            >
              {s.label}
              {s.id !== 'done' && count(s.id) > 0 && <span className="seg-count">{count(s.id)}</span>}
            </button>
          ))}
        </div>
      </header>
      <Stale show={stale} />
      <Problem error={error} />

      {column !== 'done' && (
        <form
          className="add-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim()) return
            const title = draft
            setDraft('')
            void run(() => addPlanItem(hub, title, column))
          }}
        >
          <input
            placeholder={`Add to ${PLAN_STATUSES.find((s) => s.id === column)?.label}…`}
            aria-label="New planner item"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn-primary small" disabled={!draft.trim() || busy}>
            Add
          </button>
        </form>
      )}

      {items === null ? (
        <div className="group skeleton tall" />
      ) : shown.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        <div className="group">
          {shown.map((item) => {
            const expanded = open === item.id
            const stepsDone = item.steps.filter((s) => s.done).length
            return (
              <div key={item.id} className={`plan-item ${expanded ? 'open' : ''}`}>
                <button className="row" onClick={() => setOpen(expanded ? null : item.id)} aria-expanded={expanded}>
                  <span className="row-main">
                    <span className="row-title">{item.title}</span>
                    <span className="row-sub">
                      {[
                        item.requester && `for ${item.requester}`,
                        item.project,
                        item.due && `due ${item.due}`,
                        item.steps.length > 0 && `${stepsDone}/${item.steps.length} steps`,
                        item.status === 'done' && item.doneAt && `done ${dayInSentence(item.doneAt)}`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className={`chev ${expanded ? 'down' : ''}`}>
                    <ChevronIcon size={18} />
                  </span>
                </button>
                {expanded && (
                  <div className="plan-detail">
                    {item.notes && <p className="plan-notes">{item.notes}</p>}
                    {item.steps.length > 0 && (
                      <div className="steps">
                        {item.steps.map((st) => (
                          <button key={st.id} className={`step ${st.done ? 'done' : ''}`} disabled={busy} onClick={() => void run(() => togglePlanStep(hub, item.id, st.id))}>
                            <Check done={st.done} />
                            <span>{st.text}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {item.updates.length > 0 && (
                      <ul className="updates">
                        {item.updates.slice(-3).map((u) => (
                          <li key={u.id}>
                            <span className="ts">{dayLabel(u.at)}</span> {u.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    <form
                      className="add-row inline"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (!update.trim()) return
                        const text = update
                        setUpdate('')
                        void run(() => addPlanUpdate(hub, item.id, text))
                      }}
                    >
                      <input placeholder="Add a progress note…" aria-label="Progress note" value={update} onChange={(e) => setUpdate(e.target.value)} />
                    </form>
                    <div className="move">
                      {PLAN_STATUSES.filter((s) => s.id !== item.status).map((s) => (
                        <button
                          key={s.id}
                          className={`chip ${s.id === 'done' ? 'chip-done' : ''}`}
                          disabled={busy}
                          onClick={() => {
                            setOpen(null)
                            void run(() => setPlanStatus(hub, item.id, s.id))
                          }}
                        >
                          {s.id === 'done' ? 'Mark done' : `Move to ${s.label}`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
