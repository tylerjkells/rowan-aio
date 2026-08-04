import { useEffect, useMemo, useState } from 'react'
import type { ActionRollupItem } from '../../../shared/types'
import { DueEditor, formatWhen, isOverdue, OwnerEditor, useConfirm } from '../ui'

/** items from meetings older than this, with no live due date, are stale */
const STALE_DAYS = 14

function isStale(i: ActionRollupItem, todayIso: string): boolean {
  const ageMs = Date.now() - new Date(i.createdAt).getTime()
  if (ageMs < STALE_DAYS * 86400000) return false
  return !i.dueDate || i.dueDate < todayIso
}

export function ActionsView({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [items, setItems] = useState<ActionRollupItem[]>([])
  const [directory, setDirectory] = useState<string[]>([])
  const [showDone, setShowDone] = useState(false)
  const [showStale, setShowStale] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [who, setWho] = useState<string>('me')
  const [confirmDialog, confirm] = useConfirm()

  async function reload(): Promise<void> {
    const list = await window.scribe.actions.list()
    setItems(list)
  }

  useEffect(() => {
    window.scribe.settings.get().then((s) => setDirectory(s.people))
    window.scribe.actions.list().then((list) => {
      setItems(list)
      setLoaded(true)
      // default to "assigned to me", but not to an empty view
      if (!list.some((i) => i.owners.includes('Me') && !i.done)) setWho('all')
    })
  }, [])

  const todayIso = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])

  // canonical people with anything on the board, busiest first
  const people = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) {
      for (const o of i.owners) {
        if (o === 'Me') continue
        counts.set(o, (counts.get(o) ?? 0) + (i.done ? 0 : 1))
      }
    }
    return [...counts.keys()].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)
    )
  }, [items])

  const matchesWho = (i: ActionRollupItem): boolean => {
    if (who === 'all') return true
    if (who === 'me') return i.owners.includes('Me')
    if (who === 'unassigned') return i.owners.length === 0
    return i.owners.includes(who)
  }

  const scoped = useMemo(() => items.filter(matchesWho), [items, who])
  // most urgent first: dated items ascending, undated after
  const byUrgency = (a: ActionRollupItem, b: ActionRollupItem): number =>
    (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1
  const open = useMemo(
    () => scoped.filter((i) => !i.done && !isStale(i, todayIso)).sort(byUrgency),
    [scoped, todayIso]
  )
  const stale = useMemo(
    () => scoped.filter((i) => !i.done && isStale(i, todayIso)).sort(byUrgency),
    [scoped, todayIso]
  )
  const done = useMemo(() => scoped.filter((i) => i.done), [scoped])

  const openCount = (name: string): number =>
    items.filter((i) => !i.done && (name === 'me' ? i.owners.includes('Me') : i.owners.includes(name)))
      .length

  async function toggle(item: ActionRollupItem): Promise<void> {
    const newDone = await window.scribe.actions.toggle(item.meetingId, item.index)
    setItems((prev) =>
      prev.map((i) =>
        i.meetingId === item.meetingId && i.index === item.index ? { ...i, done: newDone } : i
      )
    )
  }

  async function clearStale(): Promise<void> {
    const ok = await confirm({
      title: `Mark ${stale.length} stale ${stale.length === 1 ? 'item' : 'items'} done?`,
      body: `Everything still open from meetings more than two weeks old, with no upcoming due date${who !== 'all' ? ', in the current person filter' : ''}. You can find them again under "Show done".`,
      confirmLabel: 'Mark all done'
    })
    if (!ok) return
    for (const item of stale) {
      if (!item.done) await window.scribe.actions.toggle(item.meetingId, item.index)
    }
    await reload()
  }

  const knownOwners = useMemo(() => {
    const names = new Set<string>(['Me', ...directory])
    for (const i of items) for (const o of i.owners) names.add(o)
    names.delete('Me')
    return ['Me', ...[...names].sort((a, b) => a.localeCompare(b))]
  }, [items, directory])

  async function setOwner(item: ActionRollupItem, owner: string | null): Promise<void> {
    await window.scribe.actions.setOwner(item.meetingId, item.index, owner)
    // re-list so the new owner runs through identity resolution
    await reload()
  }

  async function setDue(item: ActionRollupItem, isoDate: string | null): Promise<void> {
    await window.scribe.actions.setDue(item.meetingId, item.index, isoDate)
    await reload()
  }

  if (loaded && items.length === 0) {
    return (
      <div className="empty-state">
        <h2>No action items yet</h2>
        <p>
          When a meeting summary includes follow-ups, they collect here across all your meetings.
        </p>
      </div>
    )
  }

  const renderItem = (item: ActionRollupItem): React.JSX.Element => (
    <div className={`rollup-item ${item.done ? 'done' : ''}`} key={`${item.meetingId}-${item.index}`}>
      <input
        type="checkbox"
        className="rollup-check"
        checked={item.done}
        onChange={() => toggle(item)}
        aria-label={`Mark "${item.task}" ${item.done ? 'open' : 'done'}`}
      />
      <div className="rollup-body">
        <span className="rollup-task">{item.task}</span>
        <span className="rollup-meta">
          <OwnerEditor
            owner={item.owner}
            label={item.owners.length > 0 ? item.owners.join(' + ') : null}
            suggestions={knownOwners}
            onSave={(owner) => setOwner(item, owner)}
          />
          <DueEditor
            due={item.due}
            dueDate={item.dueDate}
            edited={item.dueEdited}
            overdue={isOverdue(item)}
            onSave={(iso) => setDue(item, iso)}
          />
          <button className="rollup-source" onClick={() => onOpen(item.meetingId)}>
            {item.meetingTitle} · {formatWhen(item.createdAt)}
          </button>
        </span>
      </div>
    </div>
  )

  return (
    <>
      {confirmDialog}
      <div className="page-head">
        <h1>Action items</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {open.length + stale.length} open{done.length > 0 ? ` · ${done.length} done` : ''}
          </span>
          {done.length > 0 && (
            <button className="btn btn-ghost" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide done' : 'Show done'}
            </button>
          )}
        </div>
      </div>

      <div className="who-filter" role="radiogroup" aria-label="Filter by person">
        <button
          className={`who-chip ${who === 'me' ? 'active' : ''}`}
          role="radio"
          aria-checked={who === 'me'}
          onClick={() => setWho('me')}
        >
          Me{openCount('me') > 0 ? ` · ${openCount('me')}` : ''}
        </button>
        {people.map((p) => (
          <button
            className={`who-chip ${who === p ? 'active' : ''}`}
            role="radio"
            aria-checked={who === p}
            onClick={() => setWho(p)}
            key={p}
          >
            {p}
            {openCount(p) > 0 ? ` · ${openCount(p)}` : ''}
          </button>
        ))}
        {items.some((i) => i.owners.length === 0) && (
          <button
            className={`who-chip ${who === 'unassigned' ? 'active' : ''}`}
            role="radio"
            aria-checked={who === 'unassigned'}
            onClick={() => setWho('unassigned')}
          >
            Unassigned
          </button>
        )}
        <button
          className={`who-chip ${who === 'all' ? 'active' : ''}`}
          role="radio"
          aria-checked={who === 'all'}
          onClick={() => setWho('all')}
        >
          Everyone
        </button>
      </div>

      {open.length === 0 && stale.length === 0 && (!showDone || done.length === 0) ? (
        <div className="empty-state">
          <h2>All caught up</h2>
          <p>
            {who === 'all'
              ? 'Every action item is checked off.'
              : 'Nothing open here. Switch person or show done items.'}
          </p>
        </div>
      ) : (
        <>
          {open.length > 0 && <div className="rollup-list">{open.map(renderItem)}</div>}

          {stale.length > 0 && (
            <section className="stale-section">
              <div className="person-section-head">
                <button className="btn btn-ghost" onClick={() => setShowStale(!showStale)}>
                  {showStale ? 'Hide' : 'Show'} {stale.length} stale{' '}
                  {stale.length === 1 ? 'item' : 'items'} · over two weeks old
                </button>
                <button className="btn btn-ghost" onClick={clearStale}>
                  Mark all done
                </button>
              </div>
              {showStale && <div className="rollup-list">{stale.map(renderItem)}</div>}
            </section>
          )}

          {showDone && done.length > 0 && <div className="rollup-list">{done.map(renderItem)}</div>}
        </>
      )}
    </>
  )
}
