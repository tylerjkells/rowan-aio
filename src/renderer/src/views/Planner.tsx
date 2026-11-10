import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanItem, PlanLink, PlanStatus, PlanStep, PlanUpdate } from '../../../shared/types'
import { ClickupPushDialog } from '../ClickupPush'
import { PLAN_COLUMNS, PlannerAddDialog, usePlannerSuggestions } from '../PlannerAdd'
import { Avatar, hueFor, useConfirm } from '../ui'

// ---------------------------------------------------------------------------
// Planner: your own tracker for off-the-books work, the asks and projects
// that never made it into ClickUp or a ServiceNow ticket. Laid out like the
// ClickUp page (a rail, a board or list, a detail panel on the right) so it
// reads as its sibling, but everything here stays on this machine. When a
// piece of work becomes official, "Send to ClickUp" hands it over.
// ---------------------------------------------------------------------------

type ViewId = 'open' | 'due' | 'done' | `project:${string}`
type Layout = 'board' | 'list'
type GroupBy = 'status' | 'project' | 'requester'

const VIEW_KEY = 'plannerView'
const LAYOUT_KEY = 'plannerLayout'
const GROUP_KEY = 'plannerGroup'

const STATUS_LABEL: Record<PlanStatus, string> = {
  now: 'Now',
  next: 'Next',
  waiting: 'Waiting',
  later: 'Later',
  done: 'Done'
}
const STATUS_ORDER: PlanStatus[] = ['now', 'next', 'waiting', 'later', 'done']
const STATUS_COLOR: Record<PlanStatus, string> = {
  now: 'var(--accent)',
  next: 'var(--ink-soft)',
  waiting: 'var(--warn)',
  later: 'var(--ink-faint)',
  done: 'var(--ok)'
}

/** done items the board keeps in view, so the week's wins stay visible */
const BOARD_DONE_DAYS = 14
const BOARD_DONE_MAX = 8
const DAY = 86_400_000

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const todayIso = (): string => isoOf(new Date())
const plusDaysIso = (n: number): string => isoOf(new Date(Date.now() + n * DAY))

/** next Monday, the way "next week" is usually meant */
function nextMondayIso(): string {
  const d = new Date()
  const delta = (8 - d.getDay()) % 7 || 7
  return isoOf(new Date(d.getTime() + delta * DAY))
}

/** "Today", "Tomorrow", "Nov 12", or "Nov 12, 2027" once the year differs */
function formatDue(iso: string): string {
  if (iso === todayIso()) return 'Today'
  if (iso === plusDaysIso(1)) return 'Tomorrow'
  if (iso === plusDaysIso(-1)) return 'Yesterday'
  const d = new Date(`${iso}T12:00:00`)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) })
}

/** a time today, else "Nov 2" (with the year once it differs) */
function formatWhen(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  const thisYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

const newId = (): string => crypto.randomUUID()

/** the same reordering the main process does, so a drop lands at once */
function moveLocal(items: PlanItem[], id: string, status: PlanStatus, beforeId: string | null): PlanItem[] {
  const item = items.find((x) => x.id === id)
  if (!item) return items
  const moved: PlanItem = {
    ...item,
    status,
    doneAt: item.status === status ? item.doneAt : status === 'done' ? new Date().toISOString() : ''
  }
  const column = items.filter((x) => x.status === status && x.id !== id).sort((a, b) => a.order - b.order)
  const at = beforeId ? column.findIndex((x) => x.id === beforeId) : -1
  column.splice(at < 0 ? column.length : at, 0, moved)
  const orders = new Map(column.map((x, n) => [x.id, n]))
  return items.map((x) => (x.id === id ? { ...moved, order: orders.get(id)! } : orders.has(x.id) ? { ...x, order: orders.get(x.id)! } : x))
}

/** the project an item is filed under, with a dot to tell projects apart at a glance */
function ProjectLabel({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="cuc-project" style={{ '--project-hue': hueFor(name.toLowerCase()) } as React.CSSProperties} title={name}>
      <span className="cuc-project-dot" aria-hidden="true" />
      <span className="cuc-project-name">{name}</span>
    </span>
  )
}

/**
 * A text input that saves when you leave it (or press Enter), and puts the
 * old text back on Escape. It follows the saved value only while you're not
 * typing in it, so a save landing mid-edit never eats keystrokes.
 */
function CommitInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'onKeyDown'
>): React.JSX.Element {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const skip = useRef(false)
  useEffect(() => {
    if (document.activeElement !== ref.current) setV(value)
  }, [value])
  return (
    <input
      {...rest}
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (skip.current) {
          skip.current = false
          setV(value)
          return
        }
        if (v.trim() !== value.trim()) onCommit(v.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          skip.current = true
          ref.current?.blur()
        }
      }}
    />
  )
}

/** notes: saved a moment after you stop typing, when you leave, and if the panel closes first */
function NotesBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  const saved = useRef(value)
  const latest = useRef(v)
  latest.current = v
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => {
    if (document.activeElement !== ref.current) {
      setV(value)
      saved.current = value
    }
  }, [value])
  useEffect(() => {
    if (v === saved.current) return
    const t = setTimeout(() => {
      saved.current = v
      commit.current(v)
    }, 800)
    return () => clearTimeout(t)
  }, [v])
  useEffect(
    () => () => {
      if (latest.current !== saved.current) commit.current(latest.current)
    },
    []
  )
  return (
    <textarea
      ref={ref}
      className="text-input pl-notes"
      value={v}
      rows={Math.min(14, Math.max(4, v.split('\n').length + 1))}
      placeholder="The ask, where the data lives, decisions, who to loop in…"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== saved.current) {
          saved.current = v
          onCommit(v)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          ref.current?.blur()
        }
      }}
    />
  )
}

export function PlannerView({ openId }: { openId?: string }): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[] | null>(null)
  const [view, setView] = useState<ViewId>(() => (localStorage.getItem(VIEW_KEY) as ViewId | null) || 'open')
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board'))
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    const g = localStorage.getItem(GROUP_KEY)
    return g === 'project' || g === 'requester' ? g : 'status'
  })
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(openId ?? null)
  const [adding, setAdding] = useState(false)
  const [quickAdd, setQuickAdd] = useState<{ status: PlanStatus; text: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ status: PlanStatus; beforeId: string | null } | null>(null)
  const dropRef = useRef<{ status: PlanStatus; beforeId: string | null } | null>(null)
  const [pushing, setPushing] = useState<PlanItem | null>(null)
  const [clickupOn, setClickupOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newStep, setNewStep] = useState('')
  const [newUpdate, setNewUpdate] = useState('')
  const [newLink, setNewLink] = useState({ url: '', label: '' })
  const [confirmEl, confirm] = useConfirm()
  const searchRef = useRef<HTMLInputElement>(null)
  const { projects, people } = usePlannerSuggestions(items ?? [])

  useEffect(() => {
    window.scribe.planner
      .list()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the Planner'))
    window.scribe.clickup
      .status()
      .then((st) => setClickupOn(st.connected))
      .catch(() => {})
  }, [])

  // a fresh panel starts with empty add boxes
  useEffect(() => {
    setNewStep('')
    setNewUpdate('')
    setNewLink({ url: '', label: '' })
  }, [selectedId])

  const persist = useCallback((p: Promise<PlanItem[]>) => {
    p.then((next) => {
      setItems(next)
      setError(null)
    }).catch((err) => setError(err instanceof Error ? err.message : 'Could not save that change'))
  }, [])

  const patch = useCallback(
    (id: string, change: Partial<PlanItem>) => {
      setItems(
        (prev) =>
          prev?.map((i) => {
            if (i.id !== id) return i
            const statusMoved = change.status && change.status !== i.status
            return {
              ...i,
              ...change,
              ...(statusMoved
                ? { doneAt: change.status === 'done' ? new Date().toISOString() : '', order: Number.MAX_SAFE_INTEGER }
                : {}),
              updatedAt: new Date().toISOString()
            }
          }) ?? prev
      )
      persist(window.scribe.planner.update(id, change))
    },
    [persist]
  )

  const move = useCallback(
    (id: string, status: PlanStatus, beforeId: string | null) => {
      if (id === beforeId) return
      setItems((prev) => (prev ? moveLocal(prev, id, status, beforeId) : prev))
      persist(window.scribe.planner.move(id, status, beforeId))
    },
    [persist]
  )

  const changeView = (v: ViewId): void => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }
  const changeLayout = (l: Layout): void => {
    setLayout(l)
    localStorage.setItem(LAYOUT_KEY, l)
  }
  const changeGroupBy = (g: GroupBy): void => {
    setGroupBy(g)
    localStorage.setItem(GROUP_KEY, g)
  }

  // a remembered project view whose project is gone falls back to everything open
  const all = items ?? []
  const projectOf = view.startsWith('project:') ? view.slice('project:'.length) : null
  const activeView: ViewId = projectOf !== null && !all.some((i) => i.project.trim() === projectOf) && items ? 'open' : view
  const activeProject = activeView.startsWith('project:') ? activeView.slice('project:'.length) : null

  const today = todayIso()
  const weekOut = plusDaysIso(7)
  const needle = query.trim().toLowerCase()
  const matches = (i: PlanItem): boolean =>
    !needle ||
    [i.title, i.project, i.requester, i.notes, ...i.steps.map((s) => s.text), ...i.updates.map((u) => u.text)].some((x) =>
      x.toLowerCase().includes(needle)
    )

  const open = all.filter((i) => i.status !== 'done')
  const counts = {
    open: open.length,
    due: open.filter((i) => i.due && i.due <= weekOut).length,
    overdue: open.filter((i) => i.due && i.due < today).length,
    done: all.filter((i) => i.status === 'done').length
  }

  // projects with open work, plus any finished in the last month
  const railProjects = useMemo(() => {
    const cutoff = Date.now() - 30 * DAY
    const by = new Map<string, number>()
    for (const i of items ?? []) {
      const p = i.project.trim()
      if (!p) continue
      const live = i.status !== 'done' || (i.doneAt && Date.parse(i.doneAt) >= cutoff)
      if (!live && !by.has(p)) continue
      by.set(p, (by.get(p) ?? 0) + (i.status !== 'done' ? 1 : 0))
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [items])

  /** what the current view shows, done items included only where they belong */
  const shown = all.filter((i) => {
    if (!matches(i)) return false
    if (activeProject !== null) return i.project.trim() === activeProject
    if (activeView === 'done') return i.status === 'done'
    if (activeView === 'due') return i.status !== 'done' && !!i.due && i.due <= weekOut
    return true
  })
  const shownOpen = shown.filter((i) => i.status !== 'done')
  const shownDone = shown
    .filter((i) => i.status === 'done')
    .sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''))

  const selected = selectedId ? (all.find((i) => i.id === selectedId) ?? null) : null

  // keyboard: n new, / search, Esc closes the panel
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (document.querySelector('dialog[open]')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) return
      if (e.key === 'Escape' && selectedId) {
        setSelectedId(null)
      } else if (e.key === 'n') {
        e.preventDefault()
        setAdding(true)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  async function submitQuickAdd(status: PlanStatus): Promise<void> {
    const text = quickAdd?.text.trim()
    if (!text) return
    setQuickAdd({ status, text: '' })
    try {
      const r = await window.scribe.planner.add({ title: text, status, project: activeProject ?? '' })
      setItems(r.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it')
    }
  }

  async function removeItem(item: PlanItem): Promise<void> {
    const ok = await confirm({
      title: 'Delete this item?',
      body: `“${item.title}” and its steps, notes and updates will be gone for good. Marking it done keeps the record instead.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    if (selectedId === item.id) setSelectedId(null)
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev)
    persist(window.scribe.planner.remove(item.id))
  }

  async function afterPush(item: PlanItem, url: string): Promise<void> {
    setPushing(null)
    patch(item.id, { clickupUrl: url })
    if (item.status === 'done') return
    const finish = await confirm({
      title: 'It’s in ClickUp now',
      body: 'Mark it done here so it isn’t tracked in two places? It stays under Done with a link to the ClickUp task.',
      confirmLabel: 'Mark done'
    })
    if (finish) patch(item.id, { status: 'done', clickupUrl: url })
  }

  /** what goes into ClickUp's description when an item is handed over */
  function pushDescription(item: PlanItem): string {
    const parts: string[] = []
    if (item.requester) parts.push(`Requested by: ${item.requester}`)
    if (item.notes.trim()) parts.push(item.notes.trim())
    if (item.steps.length) parts.push(['Steps:', ...item.steps.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`)].join('\n'))
    if (item.links.length) parts.push(['Links:', ...item.links.map((l) => `${l.label ? `${l.label}: ` : ''}${l.url}`)].join('\n'))
    return parts.join('\n\n')
  }

  // ---- rail ----
  const railCount = (n: number): React.ReactNode => <span className="cuc-rail-n">{n}</span>
  const rail = (
    <aside className="cuc-rail">
      <button className="btn btn-primary cuc-new" onClick={() => setAdding(true)} title="New work (n)">
        <span aria-hidden="true">+</span> New work
      </button>
      <nav className="cuc-rail-group" aria-label="Views">
        <button
          className={`cuc-rail-item ${activeView === 'open' ? 'active' : ''}`}
          onClick={() => changeView('open')}
          title="Everything not finished"
        >
          <span>Open</span>
          {railCount(counts.open)}
        </button>
        <button
          className={`cuc-rail-item ${activeView === 'due' ? 'active' : ''} ${counts.overdue > 0 ? 'warn' : ''}`}
          onClick={() => changeView('due')}
          title={counts.overdue > 0 ? `Due within a week; ${counts.overdue} overdue` : 'Due within a week, or overdue'}
        >
          <span>Due this week</span>
          {railCount(counts.due)}
        </button>
        <button
          className={`cuc-rail-item ${activeView === 'done' ? 'active' : ''}`}
          onClick={() => changeView('done')}
          title="Everything finished, newest first"
        >
          <span>Done</span>
          {railCount(counts.done)}
        </button>
      </nav>
      {railProjects.length > 0 && (
        <>
          <div className="cuc-rail-head">
            <span>Projects</span>
          </div>
          <nav className="cuc-rail-group" aria-label="Projects">
            {railProjects.map(([p, n]) => (
              <button
                key={p}
                className={`cuc-rail-item list ${activeProject === p ? 'active' : ''}`}
                onClick={() => changeView(`project:${p}`)}
              >
                <ProjectLabel name={p} />
                {railCount(n)}
              </button>
            ))}
          </nav>
        </>
      )}
      <p className="cuc-rail-note pl-rail-note">
        Work that isn’t in ClickUp or a ticket. It stays on this machine; Ask and the Claude connector can see it.
      </p>
    </aside>
  )

  // ---- board ----
  const cardFoot = (i: PlanItem): React.ReactNode => {
    const stepsDone = i.steps.filter((s) => s.done).length
    const overdue = i.status !== 'done' && !!i.due && i.due < today
    const bits = i.requester || i.steps.length > 0 || i.due || i.clickupUrl || i.status === 'done'
    if (!bits) return null
    return (
      <div className="cuc-card-foot">
        {i.requester && <Avatar name={i.requester} size={20} title={`Asked by ${i.requester}`} />}
        {i.steps.length > 0 && (
          <span className={`pl-stepcount ${stepsDone === i.steps.length ? 'all' : ''}`} title={`${stepsDone} of ${i.steps.length} steps done`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {stepsDone}/{i.steps.length}
          </span>
        )}
        {i.clickupUrl && (
          <span className="pl-cu-mark" title="Sent to ClickUp">
            ClickUp
          </span>
        )}
        <span className="cuc-card-gap" />
        {i.status === 'done' ? (
          <span className="cuc-due inline">Done {formatWhen(i.doneAt)}</span>
        ) : (
          i.due && <span className={`cuc-due inline ${overdue ? 'overdue' : ''}`}>{formatDue(i.due)}</span>
        )}
      </div>
    )
  }

  const card = (i: PlanItem, col: PlanStatus): React.JSX.Element => (
    <div
      key={i.id}
      className={`cuc-card pl-card ${selectedId === i.id ? 'active' : ''} ${dragId === i.id ? 'dragging' : ''} ${
        dropAt && dragId && dragId !== i.id && dropAt.beforeId === i.id ? 'pl-drop-before' : ''
      } ${i.status === 'done' ? 'done' : ''}`}
      draggable
      onDragStart={(e) => {
        setDragId(i.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', i.id)
      }}
      onDragEnd={() => {
        setDragId(null)
        setDropAt(null)
        dropRef.current = null
      }}
      onDragOver={(e) => {
        if (!dragId) return
        e.preventDefault()
        e.stopPropagation()
        // the done column keeps newest first, so a drop there just files it
        const at = { status: col, beforeId: col === 'done' ? null : i.id }
        dropRef.current = at
        if (dropAt?.status !== at.status || dropAt?.beforeId !== at.beforeId) setDropAt(at)
      }}
      onClick={() => setSelectedId(i.id)}
    >
      {i.project && activeProject === null && (
        <div className="cuc-where">
          <ProjectLabel name={i.project} />
        </div>
      )}
      <div className="cuc-card-name">{i.title}</div>
      {cardFoot(i)}
    </div>
  )

  const columnDrop = (status: PlanStatus): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!dragId) return
      e.preventDefault()
      const at = { status, beforeId: null }
      dropRef.current = at
      if (dropAt?.status !== status || dropAt?.beforeId !== null) setDropAt(at)
    },
    onDragLeave: (e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
        if (dropAt?.status === status) setDropAt(null)
      }
    },
    onDrop: (e) => {
      e.preventDefault()
      const at = dropRef.current ?? { status, beforeId: null }
      if (dragId) move(dragId, at.status, at.beforeId)
      setDragId(null)
      setDropAt(null)
      dropRef.current = null
    }
  })

  const columns = PLAN_COLUMNS.map((c) => ({
    ...c,
    items: shownOpen.filter((i) => i.status === c.id).sort((a, b) => a.order - b.order)
  }))
  const boardDone = shownDone.filter((i) => i.doneAt && Date.now() - Date.parse(i.doneAt) <= BOARD_DONE_DAYS * DAY)

  const board = (
    <div className="cuc-board pl-board">
      {columns.map((c) => (
        <div
          key={c.id}
          className={`cuc-col ${dropAt?.status === c.id && dropAt.beforeId === null ? 'over' : ''}`}
          {...columnDrop(c.id)}
        >
          <div className="cuc-col-head" style={{ '--pill': STATUS_COLOR[c.id] } as React.CSSProperties} title={c.hint}>
            <span className="cuc-pill-dot" />
            <span className="cuc-col-name">{c.label}</span>
            <span className="cuc-group-n">{c.items.length}</span>
          </div>
          <div className="cuc-col-body">
            {c.items.map((i) => card(i, c.id))}
            {activeView === 'due' ? null : quickAdd?.status === c.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  submitQuickAdd(c.id)
                }}
              >
                <input
                  className="cuc-quick-input"
                  autoFocus
                  placeholder="Enter to add, Esc to close"
                  value={quickAdd.text}
                  onChange={(e) => setQuickAdd({ status: c.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setQuickAdd(null)
                    }
                  }}
                  onBlur={() => !quickAdd.text.trim() && setQuickAdd(null)}
                />
              </form>
            ) : (
              <button className="cuc-quick-btn" onClick={() => setQuickAdd({ status: c.id, text: '' })}>
                + Add
              </button>
            )}
          </div>
        </div>
      ))}
      {activeView !== 'due' && (
        <div
          className={`cuc-col cuc-col-done ${dropAt?.status === 'done' ? 'over' : ''}`}
          {...columnDrop('done')}
        >
          <div className="cuc-col-head" style={{ '--pill': STATUS_COLOR.done } as React.CSSProperties}>
            <span className="cuc-pill-dot" />
            <span className="cuc-col-name">Done</span>
            <span className="cuc-group-n">{boardDone.length}</span>
          </div>
          <div className="cuc-col-body">
            {boardDone.length === 0 && (
              <p className="cuc-col-hint">Drop a card here when it’s finished. The last two weeks show here.</p>
            )}
            {boardDone.slice(0, BOARD_DONE_MAX).map((i) => card(i, 'done'))}
            {(boardDone.length > BOARD_DONE_MAX || shownDone.length > boardDone.length) && (
              <button className="cuc-quick-btn" onClick={() => changeView('done')}>
                All {counts.done} done →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )

  // ---- list ----
  type Group = { key: string; label: string; color?: string; items: PlanItem[] }
  const listItems = activeView === 'done' ? shownDone : activeProject !== null ? shown : shownOpen
  const byStatusThenOrder = (a: PlanItem, b: PlanItem): number =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    (a.status === 'done' ? (b.doneAt || '').localeCompare(a.doneAt || '') : a.order - b.order)
  const groups: Group[] = (() => {
    if (activeView === 'done') return [{ key: 'done', label: 'Done', color: STATUS_COLOR.done, items: listItems }]
    if (activeView === 'due') {
      const sorted = [...listItems].sort((a, b) => a.due.localeCompare(b.due) || byStatusThenOrder(a, b))
      return [
        { key: 'overdue', label: 'Overdue', color: 'var(--accent-strong)', items: sorted.filter((i) => i.due < today) },
        { key: 'today', label: 'Today', color: 'var(--accent)', items: sorted.filter((i) => i.due === today) },
        { key: 'week', label: 'This week', color: 'var(--ink-soft)', items: sorted.filter((i) => i.due > today) }
      ].filter((g) => g.items.length > 0)
    }
    if (groupBy === 'status') {
      return STATUS_ORDER.map((s) => ({
        key: s,
        label: STATUS_LABEL[s],
        color: STATUS_COLOR[s],
        items: listItems.filter((i) => i.status === s).sort(byStatusThenOrder)
      })).filter((g) => g.items.length > 0)
    }
    const field = groupBy === 'project' ? 'project' : 'requester'
    const by = new Map<string, PlanItem[]>()
    for (const i of listItems) {
      const k = i[field].trim()
      by.set(k, [...(by.get(k) ?? []), i])
    }
    return [...by.entries()]
      .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
      .map(([k, xs]) => ({
        key: k || '(none)',
        label: k || (groupBy === 'project' ? 'No project' : 'Nobody named'),
        items: xs.sort(byStatusThenOrder)
      }))
  })()

  const row = (i: PlanItem): React.JSX.Element => {
    const done = i.status === 'done'
    const overdue = !done && !!i.due && i.due < today
    const stepsDone = i.steps.filter((s) => s.done).length
    return (
      <div
        key={i.id}
        className={`cuc-tr ${selectedId === i.id ? 'active' : ''} ${done ? 'done' : ''}`}
        role="row"
        onClick={() => setSelectedId(i.id)}
      >
        <span className="cuc-td">
          <input
            type="checkbox"
            className="rollup-check"
            checked={done}
            onClick={(e) => e.stopPropagation()}
            onChange={() => patch(i.id, { status: done ? 'now' : 'done' })}
            aria-label={done ? `Reopen “${i.title}”` : `Mark “${i.title}” done`}
          />
        </span>
        <span className="cuc-td cuc-td-name">
          <span className="cuc-name">{i.title}</span>
          {i.project && groupBy !== 'project' && activeProject === null && (
            <span className="cuc-where">
              <ProjectLabel name={i.project} />
            </span>
          )}
        </span>
        <span className="cuc-td" onClick={(e) => e.stopPropagation()}>
          <select
            className="cuc-select pl-status-select"
            style={{ '--pill': STATUS_COLOR[i.status] } as React.CSSProperties}
            value={i.status}
            onChange={(e) => patch(i.id, { status: e.target.value as PlanStatus })}
            aria-label="Column"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
        <span className="cuc-td pl-td-who">
          {i.requester ? (
            <>
              <Avatar name={i.requester} size={20} />
              <span className="pl-who-name">{i.requester}</span>
            </>
          ) : (
            <span className="cuc-where">—</span>
          )}
        </span>
        <span className="cuc-td">
          {done ? (
            <span className="cuc-due inline">{formatWhen(i.doneAt)}</span>
          ) : i.due ? (
            <span className={`cuc-due inline ${overdue ? 'overdue' : ''}`}>{formatDue(i.due)}</span>
          ) : (
            <span className="cuc-where">—</span>
          )}
        </span>
        <span className="cuc-td">
          {i.steps.length > 0 ? (
            <span className={`pl-stepcount ${stepsDone === i.steps.length ? 'all' : ''}`}>
              {stepsDone}/{i.steps.length}
            </span>
          ) : (
            <span className="cuc-where">—</span>
          )}
        </span>
      </div>
    )
  }

  const table = (
    <div className="cuc-table pl-table" role="table">
      <div className="cuc-thead" role="row">
        <span />
        <span className="cuc-th">Name</span>
        <span className="cuc-th">Column</span>
        <span className="cuc-th pl-th-who">Asked by</span>
        <span className="cuc-th">{activeView === 'done' ? 'Finished' : 'Due'}</span>
        <span className="cuc-th">Steps</span>
      </div>
      {groups.map((g) => (
        <div key={g.key} className="cuc-group">
          <div className="cuc-group-head">
            {g.color && <span className="cuc-pill-dot" style={{ '--pill': g.color } as React.CSSProperties} />}
            <span className="cuc-group-label">{g.label}</span>
            <span className="cuc-group-n">{g.items.length}</span>
          </div>
          {g.items.map(row)}
        </div>
      ))}
    </div>
  )

  // ---- main ----
  const viewTitle =
    activeProject !== null
      ? activeProject
      : activeView === 'due'
        ? 'Due this week'
        : activeView === 'done'
          ? 'Done'
          : 'Open work'
  const useBoard = layout === 'board' && activeView !== 'done'
  const visibleCount = activeView === 'done' ? shownDone.length : shownOpen.length
  const emptyText = needle
    ? `Nothing matches “${query.trim()}”.`
    : activeView === 'due'
      ? 'Nothing due in the next week.'
      : activeView === 'done'
        ? 'Nothing finished yet.'
        : null

  const main = (
    <section className="cuc-main" aria-label={viewTitle}>
      <div className="cuc-toolbar">
        <h2 className="cuc-title">
          {viewTitle}
          {items && <span className="cuc-title-n">{visibleCount}</span>}
        </h2>
        <span className="cu-search-wrap cuc-search-wrap">
          <input
            ref={searchRef}
            className="text-input cuc-search"
            placeholder="Search  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                searchRef.current?.blur()
              }
            }}
            aria-label="Search the Planner"
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
        {!useBoard && activeView !== 'done' && activeView !== 'due' && (
          <label className="cuc-groupby pl-groupby">
            <span>Group</span>
            <select className="cuc-select" value={groupBy} onChange={(e) => changeGroupBy(e.target.value as GroupBy)}>
              <option value="status">Column</option>
              <option value="project">Project</option>
              <option value="requester">Asked by</option>
            </select>
          </label>
        )}
        {activeView !== 'done' && (
          <div className="mode-toggle view-toggle cuc-layout pl-layout" role="radiogroup" aria-label="Layout">
            <button className={layout === 'board' ? 'active' : ''} role="radio" aria-checked={layout === 'board'} onClick={() => changeLayout('board')}>
              Board
            </button>
            <button className={layout === 'list' ? 'active' : ''} role="radio" aria-checked={layout === 'list'} onClick={() => changeLayout('list')}>
              List
            </button>
          </div>
        )}
      </div>
      {error && <p className="field-note error cuc-error">{error}</p>}
      <div className="cuc-scroll">
        {!items ? (
          <p className="cuc-empty">Loading…</p>
        ) : all.length === 0 ? (
          <div className="pl-welcome">
            <h3>Track the work nobody filed</h3>
            <p>
              The dashboard someone asked for in a hallway, a quick data pull for a program, the cleanup you keep meaning to
              do: anything that isn’t in ClickUp or a ServiceNow ticket. Give it a column, who asked, a due date and a few
              steps. When it becomes official, send it to ClickUp from its panel.
            </p>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add your first item
            </button>
          </div>
        ) : useBoard ? (
          (needle && shown.length === 0) || (activeView === 'due' && shownOpen.length === 0) ? (
            <p className="cuc-empty">{emptyText}</p>
          ) : (
            board
          )
        ) : groups.length === 0 ? (
          <p className="cuc-empty">{emptyText ?? 'Nothing open. Add something, or switch to the board.'}</p>
        ) : (
          table
        )}
      </div>
    </section>
  )

  // ---- panel ----
  const setSteps = (item: PlanItem, steps: PlanStep[]): void => patch(item.id, { steps })
  const setLinks = (item: PlanItem, links: PlanLink[]): void => patch(item.id, { links })
  const setUpdates = (item: PlanItem, updates: PlanUpdate[]): void => patch(item.id, { updates })

  const panel = selected && (
    <aside className="cuc-panel pl-panel" aria-label="Planner item">
      <div className="cuc-panel-bar">
        <button className="mailc-ic" onClick={() => setSelectedId(null)} title="Close (Esc)" aria-label="Close">
          ×
        </button>
        <span className="cuc-panel-crumb">{selected.project || 'Planner'}</span>
        <span className="mailc-read-bar-gap" />
        {selected.clickupUrl ? (
          <a className="btn btn-ghost mailc-read-tool" href={selected.clickupUrl} target="_blank" rel="noreferrer">
            ClickUp ↗
          </a>
        ) : (
          clickupOn && (
            <button className="btn btn-ghost mailc-read-tool" onClick={() => setPushing(selected)} title="Make it official: create a ClickUp task from it">
              Send to ClickUp
            </button>
          )
        )}
        <button className="btn btn-ghost mailc-read-tool" onClick={() => removeItem(selected)}>
          Delete
        </button>
      </div>
      <div className="cuc-panel-scroll" key={selected.id}>
        <CommitInput
          className="pl-title-input"
          value={selected.title}
          onCommit={(v) => v && patch(selected.id, { title: v })}
          aria-label="Title"
        />
        <div className="mode-toggle tk-plan-seg pl-status-seg" role="radiogroup" aria-label="Column">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={selected.status === s}
              className={selected.status === s ? 'active' : ''}
              style={{ '--pill': STATUS_COLOR[s] } as React.CSSProperties}
              onClick={() => selected.status !== s && patch(selected.id, { status: s })}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="cuc-props">
          <span className="cuc-prop-k">Project</span>
          <span className="cuc-prop-v">
            <CommitInput
              className="pl-prop-input"
              list="planner-projects"
              placeholder="None"
              value={selected.project}
              onCommit={(v) => patch(selected.id, { project: v })}
              aria-label="Project"
            />
          </span>
          <span className="cuc-prop-k">Asked by</span>
          <span className="cuc-prop-v">
            <CommitInput
              className="pl-prop-input"
              list="planner-people"
              placeholder="Nobody named"
              value={selected.requester}
              onCommit={(v) => patch(selected.id, { requester: v })}
              aria-label="Asked by"
            />
          </span>
          <span className="cuc-prop-k">Due</span>
          <span className="cuc-prop-v pl-due-row">
            <input
              type="date"
              className={`pl-prop-input pl-date ${selected.status !== 'done' && selected.due && selected.due < today ? 'overdue' : ''}`}
              value={selected.due}
              onChange={(e) => patch(selected.id, { due: e.target.value })}
              aria-label="Due date"
            />
            {!selected.due && (
              <>
                <button className="pl-chip" onClick={() => patch(selected.id, { due: today })}>
                  Today
                </button>
                <button className="pl-chip" onClick={() => patch(selected.id, { due: nextMondayIso() })}>
                  Next week
                </button>
              </>
            )}
            {selected.due && (
              <button className="pl-chip" onClick={() => patch(selected.id, { due: '' })}>
                Clear
              </button>
            )}
          </span>
          <span className="cuc-prop-k">Added</span>
          <span className="cuc-prop-v cuc-prop-text">{formatWhen(selected.createdAt)}</span>
          {selected.status === 'done' && selected.doneAt && (
            <>
              <span className="cuc-prop-k">Finished</span>
              <span className="cuc-prop-v cuc-prop-text">{formatWhen(selected.doneAt)}</span>
            </>
          )}
        </div>
        <datalist id="planner-projects">
          {projects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <datalist id="planner-people">
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <div className="pl-sec">
          <span className="card-subhead">
            Steps
            {selected.steps.length > 0 &&
              ` · ${selected.steps.filter((s) => s.done).length}/${selected.steps.length}`}
          </span>
          {selected.steps.map((s) => (
            <div className="pl-step" key={s.id}>
              <input
                type="checkbox"
                className="rollup-check"
                checked={s.done}
                onChange={() =>
                  setSteps(
                    selected,
                    selected.steps.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x))
                  )
                }
                aria-label={s.done ? `Reopen step “${s.text}”` : `Mark step “${s.text}” done`}
              />
              <CommitInput
                className={`pl-step-text ${s.done ? 'done' : ''}`}
                value={s.text}
                onCommit={(v) =>
                  setSteps(
                    selected,
                    v
                      ? selected.steps.map((x) => (x.id === s.id ? { ...x, text: v } : x))
                      : selected.steps.filter((x) => x.id !== s.id)
                  )
                }
                aria-label="Step"
              />
              <button
                className="pl-x"
                onClick={() => setSteps(selected, selected.steps.filter((x) => x.id !== s.id))}
                aria-label={`Remove step “${s.text}”`}
                title="Remove step"
              >
                ×
              </button>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const text = newStep.trim()
              if (!text) return
              setSteps(selected, [...selected.steps, { id: newId(), text, done: false }])
              setNewStep('')
            }}
          >
            <input
              className="pl-add-input"
              placeholder={selected.steps.length ? 'Add a step…' : 'Break it down: add a step and press Enter'}
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setNewStep('')
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          </form>
        </div>

        <div className="pl-sec">
          <span className="card-subhead">Notes</span>
          <NotesBox value={selected.notes} onCommit={(v) => patch(selected.id, { notes: v })} />
        </div>

        <div className="pl-sec">
          <span className="card-subhead">Links</span>
          {selected.links.map((l) => (
            <div className="pl-link" key={l.id}>
              <a href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                {l.label || hostOf(l.url)}
              </a>
              {l.label && <span className="cuc-where">{hostOf(l.url)}</span>}
              <button
                className="pl-x"
                onClick={() => setLinks(selected, selected.links.filter((x) => x.id !== l.id))}
                aria-label={`Remove link ${l.label || l.url}`}
                title="Remove link"
              >
                ×
              </button>
            </div>
          ))}
          <form
            className="pl-link-add"
            onSubmit={(e) => {
              e.preventDefault()
              const raw = newLink.url.trim()
              if (!raw) return
              const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
              setLinks(selected, [...selected.links, { id: newId(), url, label: newLink.label.trim() }])
              setNewLink({ url: '', label: '' })
            }}
          >
            <input
              className="pl-add-input"
              placeholder="Paste a link (dashboard, file, query)…"
              value={newLink.url}
              onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
            />
            {newLink.url.trim() && (
              <>
                <input
                  className="pl-add-input pl-link-label"
                  placeholder="Label (optional)"
                  value={newLink.label}
                  onChange={(e) => setNewLink({ ...newLink, label: e.target.value })}
                />
                <button type="submit" className="btn btn-ghost pl-link-btn">
                  Add
                </button>
              </>
            )}
          </form>
        </div>

        <div className="pl-sec">
          <span className="card-subhead">Updates</span>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const text = newUpdate.trim()
              if (!text) return
              setUpdates(selected, [...selected.updates, { id: newId(), at: new Date().toISOString(), text }])
              setNewUpdate('')
            }}
          >
            <input
              className="pl-add-input"
              placeholder="Log progress, e.g. “Sent the first cut to Jen”"
              value={newUpdate}
              onChange={(e) => setNewUpdate(e.target.value)}
            />
          </form>
          {selected.updates.length === 0 ? (
            <span className="cu-comments-note">A running log of where it stands. Ask can read it back to you later.</span>
          ) : (
            [...selected.updates].reverse().map((u) => (
              <div className="pl-update" key={u.id}>
                <span className="pl-update-when">{formatWhen(u.at)}</span>
                <span className="pl-update-text">{u.text}</span>
                <button
                  className="pl-x"
                  onClick={() => setUpdates(selected, selected.updates.filter((x) => x.id !== u.id))}
                  aria-label="Remove update"
                  title="Remove update"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  )

  return (
    <div className={`cuc pl ${selected ? 'with-panel' : ''}`}>
      {rail}
      {main}
      {panel}
      {adding && (
        <PlannerAddDialog
          items={all}
          initial={activeProject ? { title: '', project: activeProject } : undefined}
          onDone={(r) => {
            setItems(r.items)
            setAdding(false)
            setSelectedId(r.id)
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {pushing && (
        <ClickupPushDialog
          task={pushing.title}
          description={pushDescription(pushing)}
          dueDate={pushing.due || null}
          onDone={(url) => afterPush(pushing, url)}
          onClose={() => setPushing(null)}
        />
      )}
      {confirmEl}
    </div>
  )
}
