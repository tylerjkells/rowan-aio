import { useCallback, useEffect, useState } from 'react'
import type {
  ClickupActivityEvent,
  ClickupStatus,
  ClickupStatusOption,
  ClickupTask
} from '../../../shared/types'
import { ClickupCompleteDialog } from '../ClickupComplete'
import { ClickupPushDialog } from '../ClickupPush'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

function weekFromNowIso(): string {
  const d = new Date(Date.now() + 7 * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

function formatDue(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

type Group = { label: string; tasks: ClickupTask[]; overdue?: boolean }

function byDue(tasks: ClickupTask[]): Group[] {
  const today = todayIso()
  const week = weekFromNowIso()
  const groups: Group[] = [
    { label: 'Overdue', tasks: [], overdue: true },
    { label: 'Today', tasks: [] },
    { label: 'This week', tasks: [] },
    { label: 'Later', tasks: [] },
    { label: 'No due date', tasks: [] }
  ]
  for (const t of tasks) {
    if (!t.dueDate) groups[4].tasks.push(t)
    else if (t.dueDate < today) groups[0].tasks.push(t)
    else if (t.dueDate === today) groups[1].tasks.push(t)
    else if (t.dueDate <= week) groups[2].tasks.push(t)
    else groups[3].tasks.push(t)
  }
  return groups.filter((g) => g.tasks.length > 0)
}

function byProject(tasks: ClickupTask[]): Group[] {
  const today = todayIso()
  const map = new Map<string, ClickupTask[]>()
  for (const t of tasks) {
    const key = t.folderName ? `${t.folderName} / ${t.listName}` : t.listName
    const arr = map.get(key) ?? []
    arr.push(t)
    map.set(key, arr)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, ts]) => ({
      label,
      tasks: ts.sort((a, b) => (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1),
      overdue: ts.some((t) => t.dueDate && t.dueDate < today)
    }))
}

type ProjectsMode = 'due' | 'project' | 'activity'

const KIND_LABEL: Record<ClickupActivityEvent['kind'], string> = {
  new: 'New',
  done: 'Done',
  status: 'Status',
  due: 'Due',
  comment: 'Comment',
  removed: 'Removed',
  you: 'You'
}

function formatWhenIso(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ProjectsView({ onSettings }: { onSettings: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<ClickupStatus | null>(null)
  const [tasks, setTasks] = useState<ClickupTask[] | null>(null)
  const [events, setEvents] = useState<ClickupActivityEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [mode, setMode] = useState<ProjectsMode>(
    () => (localStorage.getItem('projectsView') as ProjectsMode) || 'due'
  )
  const [scope, setScope] = useState<'mine' | 'all'>(
    () => (localStorage.getItem('projectsScope') as 'mine' | 'all') || 'mine'
  )
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [completing, setCompleting] = useState<ClickupTask | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [commentSent, setCommentSent] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [listStatuses, setListStatuses] = useState<Record<string, ClickupStatusOption[]>>({})

  function loadStatuses(listId: string): void {
    if (listStatuses[listId]) return
    window.scribe.clickup
      .listStatuses(listId)
      .then((s) => setListStatuses((prev) => ({ ...prev, [listId]: s })))
  }

  async function changeStatus(t: ClickupTask, status: string): Promise<void> {
    setRowError(null)
    const r = await window.scribe.clickup.setStatus(t.id, t.listId, status, t.name, t.url)
    if (!r.ok) {
      setRowError(r.error ?? 'Could not change the status')
      return
    }
    if (r.finished) {
      setTasks((prev) => prev?.filter((x) => x.id !== t.id) ?? null)
      setExpandedId(null)
    } else {
      const color = listStatuses[t.listId]?.find((s) => s.status === status)?.color ?? null
      setTasks(
        (prev) =>
          prev?.map((x) => (x.id === t.id ? { ...x, status, statusColor: color } : x)) ?? null
      )
    }
  }

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      const st = await window.scribe.clickup.status()
      setStatus(st)
      if (st.connected) {
        const r = await window.scribe.clickup.refresh(scope)
        setTasks(r.tasks)
        setEvents(r.events)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach ClickUp')
    } finally {
      setRefreshing(false)
    }
  }, [scope])

  useEffect(() => {
    load()
  }, [load])

  function switchScope(s: 'mine' | 'all'): void {
    setScope(s)
    localStorage.setItem('projectsScope', s)
    // load() reruns via its scope dependency
  }

  if (!status) return <></>

  if (!status.connected) {
    return (
      <div className="empty-state">
        <h2>Projects</h2>
        <p>
          Connect your ClickUp workspace to see everything assigned to you, check tasks off, and
          push meeting action items into real tasks. ClickUp stays the source of truth.
          {status.error && <> ({status.error})</>}
        </p>
        <button className="btn btn-primary" onClick={onSettings}>
          Connect in Settings
        </button>
      </div>
    )
  }

  const groups = tasks ? (mode === 'due' ? byDue(tasks) : byProject(tasks)) : []

  // big walls of overdue/backlog start folded; everything else starts open
  const isCollapsed = (g: Group): boolean =>
    collapsed ? collapsed.has(g.label) : g.tasks.length > 12

  function toggleSection(g: Group): void {
    const next = new Set(collapsed ?? groups.filter(isCollapsed).map((x) => x.label))
    if (next.has(g.label)) next.delete(g.label)
    else next.add(g.label)
    setCollapsed(next)
  }

  function switchMode(m: ProjectsMode): void {
    setMode(m)
    setCollapsed(null)
    localStorage.setItem('projectsView', m)
  }

  async function changeDue(t: ClickupTask, iso: string | null): Promise<void> {
    setRowError(null)
    const r = await window.scribe.clickup.setTaskDue(t.id, iso, t.name, t.url)
    if (r.ok) {
      setTasks((prev) =>
        prev?.map((x) => (x.id === t.id ? { ...x, dueDate: iso } : x)) ?? null
      )
    } else {
      setRowError(r.error ?? 'Could not change the due date')
    }
  }

  async function sendComment(t: ClickupTask): Promise<void> {
    if (!comment.trim()) return
    setBusyId(t.id)
    setRowError(null)
    const r = await window.scribe.clickup.comment(t.id, comment.trim(), t.name, t.url)
    setBusyId(null)
    if (r.ok) {
      setComment('')
      setCommentSent(true)
      setTimeout(() => setCommentSent(false), 1500)
    } else {
      setRowError(r.error ?? 'Could not post the comment')
    }
  }

  // collaborators worth naming on a row: everyone assigned except yourself
  const otherAssignees = (t: ClickupTask): string[] =>
    t.assignees.filter((a) => a !== status?.userName)

  const row = (t: ClickupTask, overdueGroup: boolean): React.JSX.Element => {
    const expanded = expandedId === t.id
    const overdue = !!t.dueDate && t.dueDate < todayIso()
    const where = [
      mode === 'due' ? (t.folderName ? `${t.folderName} / ${t.listName}` : t.listName) : '',
      otherAssignees(t).join(', '),
      scope === 'all' && t.assignees.length === 0 ? 'Unassigned' : ''
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div key={t.id} className={`cu-item ${expanded ? 'expanded' : ''}`}>
        <div className="cu-row">
          <input
            type="checkbox"
            className="rollup-check"
            checked={false}
            onChange={() => setCompleting(t)}
            aria-label={`Mark "${t.name}" done in ClickUp`}
            title="Mark done in ClickUp"
          />
          <button
            className="cu-main"
            onClick={() => {
              setExpandedId(expanded ? null : t.id)
              setComment('')
              setRowError(null)
              if (!expanded) loadStatuses(t.listId)
            }}
          >
            <span className="cu-name">{t.name}</span>
            {where && <span className="cu-where">{where}</span>}
          </button>
          <span className="cu-meta">
            <span className="cu-status">
              <span
                className="cu-status-dot"
                style={{ background: t.statusColor ?? 'var(--ink-faint)' }}
              />
              <span className="cu-status-name">{t.status}</span>
            </span>
            {t.priority && <span className="cu-priority">{t.priority}</span>}
            {t.dueDate && (
              <span className={`cu-due ${overdue || overdueGroup ? 'overdue' : ''}`}>
                {formatDue(t.dueDate)}
              </span>
            )}
          </span>
        </div>
        {expanded && (
          <div className="cu-detail">
            {t.description && <p className="cu-desc">{t.description}</p>}
            <div className="cu-controls">
              <label className="cu-control">
                Due
                <input
                  type="date"
                  className="text-input cu-date"
                  value={t.dueDate ?? ''}
                  onChange={(e) => changeDue(t, e.target.value || null)}
                />
              </label>
              <label className="cu-control">
                Status
                <select
                  className="text-input cu-status-select"
                  value={t.status}
                  onChange={(e) => changeStatus(t, e.target.value)}
                >
                  {!listStatuses[t.listId]?.some((s) => s.status === t.status) && (
                    <option value={t.status}>{t.status}</option>
                  )}
                  {(listStatuses[t.listId] ?? []).map((s) => (
                    <option key={s.status} value={s.status}>
                      {s.status}
                    </option>
                  ))}
                </select>
              </label>
              {t.priority && <span className="cu-control-status">{t.priority}</span>}
              <a className="cu-pushed" href={t.url} target="_blank" rel="noreferrer">
                Open in ClickUp ↗
              </a>
            </div>
            <div className="cu-comment">
              <input
                className="text-input"
                placeholder="Add a comment in ClickUp…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendComment(t)}
              />
              <button
                className="btn"
                onClick={() => sendComment(t)}
                disabled={busyId === t.id || !comment.trim()}
              >
                {commentSent ? 'Sent ✓' : busyId === t.id ? 'Sending…' : 'Comment'}
              </button>
            </div>
            {rowError && <p className="field-note error">{rowError}</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {status.teamName}
            {tasks && <> · {tasks.length} open {tasks.length === 1 ? 'task' : 'tasks'}</>}
          </span>
          {mode !== 'activity' && (
            <div className="mode-toggle view-toggle" role="radiogroup" aria-label="Whose tasks">
              <button
                className={scope === 'mine' ? 'active' : ''}
                role="radio"
                aria-checked={scope === 'mine'}
                onClick={() => switchScope('mine')}
              >
                Mine
              </button>
              <button
                className={scope === 'all' ? 'active' : ''}
                role="radio"
                aria-checked={scope === 'all'}
                onClick={() => switchScope('all')}
              >
                Everyone
              </button>
            </div>
          )}
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="Group by">
            <button
              className={mode === 'due' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'due'}
              onClick={() => switchMode('due')}
            >
              By due
            </button>
            <button
              className={mode === 'project' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'project'}
              onClick={() => switchMode('project')}
            >
              By project
            </button>
            <button
              className={mode === 'activity' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'activity'}
              onClick={() => switchMode('activity')}
            >
              Activity
            </button>
          </div>
          <button className="btn btn-ghost" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New task
          </button>
        </div>
      </div>
      {error && <p className="field-note error">{error}</p>}
      {mode === 'activity' ? (
        events.length === 0 ? (
          <p className="today-quiet">
            No changes noticed yet. The changelog builds as refreshes spot differences — new
            assignments, status changes, completions, due-date moves, and fresh comments.
          </p>
        ) : (
          <div className="cu-act-list">
            {events.map((e) => (
              <div className="cu-act" key={e.id}>
                <span className={`cu-act-kind kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <span className="cu-act-body">
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer" className="cu-act-task">
                      {e.taskName}
                    </a>
                  ) : (
                    <span className="cu-act-task">{e.taskName}</span>
                  )}
                  {e.detail && <span className="cu-act-detail">{e.detail}</span>}
                </span>
                <span className="cu-act-when">{formatWhenIso(e.at)}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          {tasks && tasks.length === 0 && !error && (
            <p className="today-quiet">Nothing assigned to you is open. Enjoy it while it lasts.</p>
          )}
        </>
      )}
      {mode !== 'activity' &&
        groups.map((g) => (
        <section className="section" key={g.label}>
          <button className="cu-section-head" onClick={() => toggleSection(g)}>
            <span className={`cu-section-chevron ${isCollapsed(g) ? '' : 'open'}`}>›</span>
            <span className="card-subhead">
              {g.label} · {g.tasks.length}
            </span>
          </button>
          {!isCollapsed(g) && (
            <div className="cu-list">{g.tasks.map((t) => row(t, !!g.overdue && mode === 'due'))}</div>
          )}
        </section>
      ))}
      {creating && (
        <ClickupPushDialog
          owner={status.userName ?? null}
          onDone={() => {
            setCreating(false)
            load()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {completing && (
        <ClickupCompleteDialog
          task={completing}
          onDone={() => {
            setTasks((prev) => prev?.filter((x) => x.id !== completing.id) ?? null)
            if (expandedId === completing.id) setExpandedId(null)
            setCompleting(null)
          }}
          onClose={() => setCompleting(null)}
        />
      )}
    </>
  )
}
