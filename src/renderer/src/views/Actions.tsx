import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActionRollupItem } from '../../../shared/types'
import { isOpenAction, isSnoozed, RECENT_DAYS, todayIso } from '../../../shared/actions'
import { DueEditor, formatWhen, isOverdue, OwnerEditor, useConfirm } from '../ui'
import { ClickupPushDialog } from '../ClickupPush'

/**
 * Your Action items list: only the items you chose to follow, yours or ones
 * you're waiting on from others. Every meeting summary keeps all of its items;
 * you add the ones that matter from there, or from "From recent meetings" at
 * the bottom of this page, and Remove takes one off the list again (it stays
 * in its meeting). Dated items lead, grouped by when; undated items follow,
 * grouped by meeting. Beyond "done", an item can be snoozed (not now).
 */

function shiftIso(days: number): string {
  return todayIso(new Date(Date.now() + days * 86_400_000))
}

function formatShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

function formatMeetingDay(iso: string): string {
  const d = new Date(iso)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

const keyOf = (i: ActionRollupItem): string => `${i.meetingId}-${i.index}`

/** items of one meeting, for the undated / by-meeting sections */
interface MeetingGroup {
  meetingId: string
  title: string
  createdAt: string
  items: ActionRollupItem[]
}

function byMeeting(items: ActionRollupItem[]): MeetingGroup[] {
  const map = new Map<string, MeetingGroup>()
  for (const i of items) {
    const g = map.get(i.meetingId)
    if (g) g.items.push(i)
    else map.set(i.meetingId, { meetingId: i.meetingId, title: i.meetingTitle, createdAt: i.createdAt, items: [i] })
  }
  return [...map.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.index - b.index) }))
}

/** dated items ascending, then newest meeting first */
const byUrgency = (a: ActionRollupItem, b: ActionRollupItem): number =>
  (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || b.createdAt.localeCompare(a.createdAt)

type Mode = 'due' | 'meeting'
type WhoKey = 'me' | 'all' | 'unassigned' | string

/** how many people get their own chip before the rest fold into a picker */
const CHIP_LIMIT = 6

export function ActionsView({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [items, setItems] = useState<ActionRollupItem[]>([])
  const [directory, setDirectory] = useState<string[]>([])
  const [hasClickup, setHasClickup] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [who, setWho] = useState<WhoKey>('all')
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem('actionsView') as Mode) || 'due'
  )
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [showSnoozed, setShowSnoozed] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null)
  const [pushing, setPushing] = useState<ActionRollupItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDialog, confirm] = useConfirm()
  const searchRef = useRef<HTMLInputElement>(null)

  const today = useMemo(() => todayIso(), [])

  async function reload(): Promise<void> {
    setItems(await window.scribe.actions.list())
  }

  useEffect(() => {
    window.scribe.settings.get().then((s) => {
      setDirectory(s.people)
      setHasClickup(s.hasClickup)
    })
    window.scribe.actions.list().then((list) => {
      setItems(list)
      setLoaded(true)
    })
  }, [])

  // ---- scope: person, then search ----------------------------------------

  const matchesWho = (i: ActionRollupItem): boolean => {
    if (who === 'all') return true
    if (who === 'me') return i.owners.includes('Me')
    if (who === 'unassigned') return i.owners.length === 0
    return i.owners.includes(who)
  }

  const needle = query.trim().toLowerCase()
  const matchesQuery = (i: ActionRollupItem): boolean =>
    !needle ||
    [i.task, i.owner ?? '', i.meetingTitle, ...i.owners].join(' ').toLowerCase().includes(needle)

  // the list is only what you added; every other item stays in its meeting
  const listed = useMemo(() => items.filter((i) => i.tracked), [items])

  const scoped = useMemo(
    () => listed.filter((i) => matchesWho(i) && matchesQuery(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listed, who, needle]
  )

  // what you could add: open items from the last week's meetings, not on the list yet
  const recent = useMemo(() => {
    const since = Date.now() - RECENT_DAYS * 86_400_000
    return items.filter(
      (i) => !i.tracked && !i.done && !i.dismissed && new Date(i.createdAt).getTime() >= since && matchesWho(i) && matchesQuery(i)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, who, needle])

  // ---- buckets -------------------------------------------------------------

  const open = useMemo(() => scoped.filter((i) => isOpenAction(i, today)), [scoped, today])
  // you added each of these yourself, so nothing folds away as stale
  const live = open
  const done = useMemo(() => scoped.filter((i) => i.done && !i.dismissed), [scoped])
  const snoozed = useMemo(
    () => scoped.filter((i) => !i.done && !i.dismissed && isSnoozed(i, today)),
    [scoped, today]
  )

  const week = shiftIso(7)
  const overdue = live.filter((i) => i.dueDate && i.dueDate < today).sort(byUrgency)
  const dueToday = live.filter((i) => i.dueDate === today).sort(byUrgency)
  const dueWeek = live.filter((i) => i.dueDate && i.dueDate > today && i.dueDate <= week).sort(byUrgency)
  const dueLater = live.filter((i) => i.dueDate && i.dueDate > week).sort(byUrgency)
  const undated = live.filter((i) => !i.dueDate)

  // ---- people chips ------------------------------------------------------

  const people = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of listed) {
      if (!isOpenAction(i, today)) continue
      for (const o of i.owners) {
        if (o === 'Me') continue
        counts.set(o, (counts.get(o) ?? 0) + 1)
      }
    }
    // people with nothing open still exist (done items) but don't earn a chip
    for (const i of listed) for (const o of i.owners) if (o !== 'Me' && !counts.has(o)) counts.set(o, 0)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }))
  }, [listed, today])

  const chipPeople = people.slice(0, CHIP_LIMIT)
  const morePeople = people.slice(CHIP_LIMIT)
  const myOpen = listed.filter((i) => isOpenAction(i, today) && i.owners.includes('Me')).length
  const unassignedOpen = listed.filter((i) => isOpenAction(i, today) && i.owners.length === 0).length

  const knownOwners = useMemo(() => {
    const names = new Set<string>(['Me', ...directory])
    for (const i of items) for (const o of i.owners) names.add(o)
    names.delete('Me')
    return ['Me', ...[...names].sort((a, b) => a.localeCompare(b))]
  }, [items, directory])

  // ---- mutations -----------------------------------------------------------

  const patchLocal = (keys: Set<string>, patch: Partial<ActionRollupItem>): void =>
    setItems((prev) => prev.map((i) => (keys.has(keyOf(i)) ? { ...i, ...patch } : i)))

  async function toggle(item: ActionRollupItem): Promise<void> {
    const newDone = await window.scribe.actions.toggle(item.meetingId, item.index)
    patchLocal(new Set([keyOf(item)]), { done: newDone })
  }

  async function setDone(list: ActionRollupItem[], value: boolean): Promise<void> {
    setBusy(true)
    for (const i of list) {
      if (i.done !== value) await window.scribe.actions.toggle(i.meetingId, i.index)
    }
    patchLocal(new Set(list.map(keyOf)), { done: value })
    setBusy(false)
  }

  /** on or off your list; the item itself stays in its meeting either way */
  async function setTracked(list: ActionRollupItem[], value: boolean): Promise<void> {
    setBusy(true)
    for (const i of list) {
      await window.scribe.actions.setState(i.meetingId, i.index, { tracked: value })
    }
    patchLocal(new Set(list.map(keyOf)), value ? { tracked: true, dismissed: false } : { tracked: false })
    setBusy(false)
  }

  async function setSnooze(list: ActionRollupItem[], until: string | null): Promise<void> {
    setBusy(true)
    for (const i of list) {
      await window.scribe.actions.setState(i.meetingId, i.index, { snoozedUntil: until })
    }
    patchLocal(new Set(list.map(keyOf)), { snoozedUntil: until ?? undefined })
    setSnoozeFor(null)
    setBusy(false)
  }

  async function setOwner(item: ActionRollupItem, owner: string | null): Promise<void> {
    await window.scribe.actions.setOwner(item.meetingId, item.index, owner)
    // re-list so the new owner runs through identity resolution
    await reload()
  }

  async function setDue(item: ActionRollupItem, isoDate: string | null): Promise<void> {
    await window.scribe.actions.setDue(item.meetingId, item.index, isoDate)
    await reload()
  }

  async function removeMany(list: ActionRollupItem[], where: string): Promise<void> {
    const ok = await confirm({
      title: `Take ${list.length} ${list.length === 1 ? 'item' : 'items'} off your list?`,
      body: `Everything open ${where}. They stay in their meetings' summaries, where you can add them back.`,
      confirmLabel: 'Remove'
    })
    if (!ok) return
    await setTracked(list, false)
  }

  // ---- selection -----------------------------------------------------------

  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(keyOf(i))),
    [items, selected]
  )

  function toggleSelect(item: ActionRollupItem): void {
    const k = keyOf(item)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function selectMany(list: ActionRollupItem[], on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const i of list) {
        if (on) next.add(keyOf(i))
        else next.delete(keyOf(i))
      }
      return next
    })
  }

  function leaveSelect(): void {
    setSelecting(false)
    setSelected(new Set())
  }

  async function bulk(action: 'done' | 'remove' | 'snooze-week'): Promise<void> {
    const list = selectedItems
    if (list.length === 0) return
    if (action === 'done') await setDone(list, true)
    else if (action === 'remove') await setTracked(list, false)
    else await setSnooze(list, shiftIso(7))
    leaveSelect()
  }

  // ---- sections ------------------------------------------------------------

  // `collapsed` holds the keys the user toggled away from their default
  const isCollapsed = (key: string, defaultOpen: boolean): boolean =>
    defaultOpen ? collapsed.has(key) : !collapsed.has(key)

  function toggleCollapsed(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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

  const renderItem = (
    item: ActionRollupItem,
    opts: { hideSource?: boolean; hideDue?: boolean } = {}
  ): React.JSX.Element => {
    const k = keyOf(item)
    const isSel = selected.has(k)
    const snoozing = snoozeFor === k
    const state = item.dismissed ? 'dismissed' : item.done ? 'done' : isSnoozed(item, today) ? 'snoozed' : 'open'
    return (
      <div className={`ai-row ${state} ${isSel ? 'selected' : ''} ${snoozing ? 'snoozing' : ''}`} key={k}>
        {selecting ? (
          <input
            type="checkbox"
            className="rollup-check"
            checked={isSel}
            onChange={() => toggleSelect(item)}
            aria-label={`Select "${item.task}"`}
          />
        ) : (
          <input
            type="checkbox"
            className="rollup-check"
            checked={item.done}
            onChange={() => toggle(item)}
            aria-label={`Mark "${item.task}" ${item.done ? 'open' : 'done'}`}
          />
        )}
        <div className="ai-body">
          <span className="ai-task">{item.task}</span>
          <span className="ai-meta">
            <OwnerEditor
              owner={item.owner}
              label={item.owners.length > 0 ? item.owners.join(' + ') : null}
              suggestions={knownOwners}
              onSave={(owner) => setOwner(item, owner)}
            />
            {!opts.hideDue && (
              <DueEditor
                due={item.due}
                dueDate={item.dueDate}
                edited={item.dueEdited}
                overdue={isOverdue(item)}
                onSave={(iso) => setDue(item, iso)}
              />
            )}
            {state === 'snoozed' && item.snoozedUntil && (
              <span className="ai-state">until {formatShort(item.snoozedUntil)}</span>
            )}
            {item.clickupUrl && (
              <a className="cu-pushed" href={item.clickupUrl} target="_blank" rel="noreferrer">
                In ClickUp ↗
              </a>
            )}
            {!opts.hideSource && (
              <button className="rollup-source" onClick={() => onOpen(item.meetingId)}>
                {item.meetingTitle} · {formatWhen(item.createdAt)}
              </button>
            )}
          </span>
          {snoozing && (
            <span className="ai-snooze-menu" role="group" aria-label="Snooze until">
              <button className="btn" onClick={() => setSnooze([item], shiftIso(1))}>Tomorrow</button>
              <button className="btn" onClick={() => setSnooze([item], shiftIso(7))}>Next week</button>
              <button className="btn" onClick={() => setSnooze([item], shiftIso(30))}>In a month</button>
              <input
                type="date"
                className="text-input ai-snooze-date"
                min={shiftIso(1)}
                onChange={(e) => e.target.value && setSnooze([item], e.target.value)}
                aria-label="Snooze until a date"
              />
              <button className="btn btn-ghost" onClick={() => setSnoozeFor(null)}>Cancel</button>
            </span>
          )}
        </div>
        {!selecting && (
          <span className="ai-actions">
            {state === 'open' && (
              <>
                {hasClickup && !item.clickupUrl && (
                  <button className="ai-action" onClick={() => setPushing(item)} title="Create a ClickUp task from this">
                    → ClickUp
                  </button>
                )}
                <button
                  className="ai-action"
                  onClick={() => setSnoozeFor(snoozing ? null : k)}
                  title="Hide it until a day you choose"
                  aria-expanded={snoozing}
                >
                  Snooze
                </button>
                <button
                  className="ai-action"
                  onClick={() => setTracked([item], false)}
                  title="Take it off your list. It stays in its meeting's summary"
                >
                  Remove
                </button>
              </>
            )}
            {state === 'snoozed' && (
              <button className="ai-action" onClick={() => setSnooze([item], null)}>
                Unsnooze
              </button>
            )}
            {state === 'done' && (
              <button
                className="ai-action"
                onClick={() => setTracked([item], false)}
                title="Take it off your list. It stays in its meeting's summary"
              >
                Remove
              </button>
            )}
          </span>
        )}
      </div>
    )
  }

  const sectionHead = (
    key: string,
    label: React.ReactNode,
    count: number,
    list: ActionRollupItem[],
    opts: { defaultOpen?: boolean; tone?: 'overdue' | 'quiet'; extra?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const defaultOpen = opts.defaultOpen ?? true
    const closed = isCollapsed(key, defaultOpen)
    const allSel = list.length > 0 && list.every((i) => selected.has(keyOf(i)))
    return (
      <div className={`ai-section-head ${opts.tone ?? ''}`}>
        <button className="cu-section-head" onClick={() => toggleCollapsed(key)} aria-expanded={!closed}>
          <span className={`cu-section-chevron ${closed ? '' : 'open'}`}>›</span>
          <span className="card-subhead">
            {label} · {count}
          </span>
        </button>
        <span className="ai-section-tools">
          {opts.extra}
          {selecting && !closed && (
            <button className="link-btn ai-section-action" onClick={() => selectMany(list, !allSel)}>
              {allSel ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </span>
      </div>
    )
  }

  const timeSection = (
    key: string,
    label: string,
    list: ActionRollupItem[],
    opts: { tone?: 'overdue'; hideDue?: boolean } = {}
  ): React.JSX.Element | null => {
    if (list.length === 0) return null
    const closed = isCollapsed(key, true)
    return (
      <section className="section ai-section" key={key}>
        {sectionHead(key, label, list.length, list, { tone: opts.tone })}
        {!closed && <div className="ai-list">{list.map((i) => renderItem(i, { hideDue: opts.hideDue }))}</div>}
      </section>
    )
  }

  const meetingGroups = (groups: MeetingGroup[], keyPrefix: string): React.JSX.Element[] =>
    groups.map((g) => {
      const key = `${keyPrefix}:${g.meetingId}`
      const closed = isCollapsed(key, true)
      const allSel = g.items.every((i) => selected.has(keyOf(i)))
      return (
        <div className="ai-meeting" key={key}>
          <div className="ai-meeting-head">
            <button className="ai-meeting-toggle" onClick={() => toggleCollapsed(key)} aria-expanded={!closed}>
              <span className={`cu-section-chevron ${closed ? '' : 'open'}`}>›</span>
              <span className="ai-meeting-title">{g.title}</span>
              <span className="ai-meeting-when">{formatMeetingDay(g.createdAt)}</span>
              <span className="ai-meeting-count">{g.items.length}</span>
            </button>
            <span className="ai-section-tools">
              <button className="link-btn ai-section-action" onClick={() => onOpen(g.meetingId)}>
                Open meeting
              </button>
              {selecting ? (
                <button className="link-btn ai-section-action" onClick={() => selectMany(g.items, !allSel)}>
                  {allSel ? 'Deselect all' : 'Select all'}
                </button>
              ) : (
                g.items.some((i) => isOpenAction(i, today)) && (
                  <button
                    className="link-btn ai-section-action"
                    onClick={() => removeMany(g.items.filter((i) => isOpenAction(i, today)), `from “${g.title}”`)}
                    title="Take every open item from this meeting off your list"
                  >
                    Remove all
                  </button>
                )
              )}
            </span>
          </div>
          {!closed && <div className="ai-list">{g.items.map((i) => renderItem(i, { hideSource: true }))}</div>}
        </div>
      )
    })

  const nothingOpen = open.length === 0
  const nothingShown = nothingOpen && !(showDone && done.length) && !(showSnoozed && snoozed.length)

  /** one item you could add: what, who, when, where from, and Add */
  const renderSuggestion = (item: ActionRollupItem): React.JSX.Element => (
    <div className="ai-row suggest" key={keyOf(item)}>
      <div className="ai-body">
        <span className="ai-task">{item.task}</span>
        <span className="ai-meta">
          {item.owners.length > 0 && <span className="ai-owner-plain">{item.owners.join(' + ')}</span>}
          {item.due && <span className={`action-due ${isOverdue(item) ? 'overdue' : ''}`}>{item.due}</span>}
        </span>
      </div>
      <span className="ai-actions shown">
        <button className="btn ai-add" disabled={busy} onClick={() => setTracked([item], true)}>
          + Add to my list
        </button>
      </span>
    </div>
  )

  const recentGroups = byMeeting(recent)
  const recentOpen = !isCollapsed('recent', listed.length === 0)
  const recentSection = recent.length > 0 && (
    <section className="section ai-section ai-recent">
      <div className="ai-section-head quiet">
        <button className="cu-section-head" onClick={() => toggleCollapsed('recent')} aria-expanded={recentOpen}>
          <span className={`cu-section-chevron ${recentOpen ? 'open' : ''}`}>›</span>
          <span className="card-subhead">From recent meetings · {recent.length}</span>
        </button>
        <span className="ai-section-tools">
          <span className="ai-section-note">the last {RECENT_DAYS} days, not on your list</span>
        </span>
      </div>
      {recentOpen && (
        <div className="ai-meetings">
          {recentGroups.map((g) => (
            <div className="ai-meeting" key={`recent:${g.meetingId}`}>
              <div className="ai-meeting-head">
                <span className="ai-meeting-toggle static">
                  <span className="ai-meeting-title">{g.title}</span>
                  <span className="ai-meeting-when">{formatMeetingDay(g.createdAt)}</span>
                </span>
                <span className="ai-section-tools">
                  <button className="link-btn ai-section-action" onClick={() => onOpen(g.meetingId)}>
                    Open meeting
                  </button>
                  {g.items.length > 1 && (
                    <button className="link-btn ai-section-action" disabled={busy} onClick={() => setTracked(g.items, true)}>
                      Add all {g.items.length}
                    </button>
                  )}
                </span>
              </div>
              <div className="ai-list">{g.items.map(renderSuggestion)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )

  return (
    <>
      {confirmDialog}
      <div className="page-head">
        <h1>Action items</h1>
        <div className="page-head-tools cu-tools">
          <span className="count-note">
            {open.length} open
            {overdue.length > 0 && (
              <>
                {' · '}
                <span className="ai-count-overdue">{overdue.length} overdue</span>
              </>
            )}
          </span>
          <span className="cu-search-wrap">
            <input
              ref={searchRef}
              className="text-input cu-search"
              placeholder="Search items…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              aria-label="Search action items"
            />
            {query && (
              <button
                className="cu-search-clear"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </span>
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="Group by">
            <button
              className={mode === 'due' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'due'}
              onClick={() => {
                setMode('due')
                localStorage.setItem('actionsView', 'due')
              }}
            >
              By due
            </button>
            <button
              className={mode === 'meeting' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'meeting'}
              onClick={() => {
                setMode('meeting')
                localStorage.setItem('actionsView', 'meeting')
              }}
            >
              By meeting
            </button>
          </div>
          <button
            className={`btn ${selecting ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={selecting}
            onClick={() => (selecting ? leaveSelect() : setSelecting(true))}
            title="Tick several items, then mark them done, remove them, or snooze them together"
          >
            {selecting ? 'Done selecting' : 'Select'}
          </button>
        </div>
      </div>

      <div className="who-filter" role="radiogroup" aria-label="Filter by person">
        <button
          className={`who-chip ${who === 'me' ? 'active' : ''}`}
          role="radio"
          aria-checked={who === 'me'}
          onClick={() => setWho('me')}
        >
          Me{myOpen > 0 ? ` · ${myOpen}` : ''}
        </button>
        {chipPeople.map((p) => (
          <button
            className={`who-chip ${who === p.name ? 'active' : ''}`}
            role="radio"
            aria-checked={who === p.name}
            onClick={() => setWho(p.name)}
            key={p.name}
          >
            {p.name}
            {p.count > 0 ? ` · ${p.count}` : ''}
          </button>
        ))}
        {morePeople.length > 0 && (
          <select
            className={`who-chip who-more ${morePeople.some((p) => p.name === who) ? 'active' : ''}`}
            value={morePeople.some((p) => p.name === who) ? who : ''}
            onChange={(e) => e.target.value && setWho(e.target.value)}
            aria-label="More people"
          >
            <option value="">
              {morePeople.some((p) => p.name === who) ? who : `${morePeople.length} more…`}
            </option>
            {morePeople.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.count > 0 ? ` · ${p.count}` : ''}
              </option>
            ))}
          </select>
        )}
        {unassignedOpen > 0 && (
          <button
            className={`who-chip ${who === 'unassigned' ? 'active' : ''}`}
            role="radio"
            aria-checked={who === 'unassigned'}
            onClick={() => setWho('unassigned')}
          >
            Unassigned · {unassignedOpen}
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
        <span className="who-spacer" />
        {snoozed.length > 0 && (
          <button
            className={`who-chip who-state ${showSnoozed ? 'active' : ''}`}
            aria-pressed={showSnoozed}
            onClick={() => setShowSnoozed(!showSnoozed)}
          >
            Snoozed · {snoozed.length}
          </button>
        )}
        {done.length > 0 && (
          <button
            className={`who-chip who-state ${showDone ? 'active' : ''}`}
            aria-pressed={showDone}
            onClick={() => setShowDone(!showDone)}
          >
            Done · {done.length}
          </button>
        )}
      </div>

      {selecting && (
        <div className="mail-bulk ai-bulk" role="toolbar" aria-label="Selected items">
          <span className="mail-bulk-count">
            {selectedItems.length === 0 ? 'Tick items, or Select all on a group' : `${selectedItems.length} selected`}
          </span>
          <button className="btn btn-primary" disabled={busy || selectedItems.length === 0} onClick={() => bulk('done')}>
            Mark done
          </button>
          <button className="btn" disabled={busy || selectedItems.length === 0} onClick={() => bulk('remove')}>
            Remove from list
          </button>
          <button className="btn" disabled={busy || selectedItems.length === 0} onClick={() => bulk('snooze-week')}>
            Snooze a week
          </button>
          <button className="btn btn-ghost" onClick={leaveSelect}>
            Cancel
          </button>
        </div>
      )}

      {loaded && listed.length === 0 && !needle ? (
        <div className="empty-state ai-empty">
          <h2>Your list is empty</h2>
          <p>
            Add the action items you want to follow: yours, or ones you&apos;re waiting on from
            someone else. Every meeting&apos;s summary keeps all of its items with an Add to my list
            button, and this week&apos;s are below.
          </p>
        </div>
      ) : (
        loaded &&
        nothingShown && (
          <div className="empty-state ai-empty">
            <h2>{needle ? 'Nothing matches' : 'All caught up'}</h2>
            <p>
              {needle
                ? `Nothing on your list matches “${query.trim()}”.`
                : who === 'all'
                  ? 'Everything on your list is done or snoozed.'
                  : 'Nothing open here. Switch person, or show snoozed items.'}
            </p>
          </div>
        )
      )}

      {mode === 'due' ? (
        <>
          {timeSection('overdue', 'Overdue', overdue, { tone: 'overdue' })}
          {timeSection('today', 'Today', dueToday)}
          {timeSection('week', 'This week', dueWeek)}
          {timeSection('later', 'Later', dueLater)}
          {undated.length > 0 && (
            <section className="section ai-section">
              {sectionHead('undated', 'No date yet', undated.length, undated, {
                extra: <span className="ai-section-note">grouped by meeting</span>
              })}
              {!isCollapsed('undated', true) && (
                <div className="ai-meetings">{meetingGroups(byMeeting(undated), 'undated')}</div>
              )}
            </section>
          )}
        </>
      ) : (
        live.length > 0 && (
          <section className="section ai-section">
            <div className="ai-meetings">{meetingGroups(byMeeting(live), 'meeting')}</div>
          </section>
        )
      )}

      {showSnoozed && snoozed.length > 0 && (
        <section className="section ai-section">
          {sectionHead('snoozed', 'Snoozed', snoozed.length, snoozed, { tone: 'quiet' })}
          {!isCollapsed('snoozed', true) && (
            <div className="ai-list">
              {[...snoozed]
                .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''))
                .map((i) => renderItem(i))}
            </div>
          )}
        </section>
      )}

      {showDone && done.length > 0 && (
        <section className="section ai-section">
          {sectionHead('done', 'Done', done.length, done, { tone: 'quiet' })}
          {!isCollapsed('done', true) && (
            <div className="ai-meetings">{meetingGroups(byMeeting(done), 'done')}</div>
          )}
        </section>
      )}

      {recentSection}

      {pushing && (
        <ClickupPushDialog
          task={pushing.task}
          owner={pushing.owner}
          dueDate={pushing.dueDate ?? null}
          meetingTitle={pushing.meetingTitle}
          onDone={async (url) => {
            await window.scribe.actions.setClickupUrl(pushing.meetingId, pushing.index, url)
            patchLocal(new Set([keyOf(pushing)]), { clickupUrl: url })
            setPushing(null)
          }}
          onClose={() => setPushing(null)}
        />
      )}
    </>
  )
}
