import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClickupActivityEvent,
  ClickupComment,
  ClickupList,
  ClickupMember,
  ClickupStatus,
  ClickupStatusOption,
  ClickupTask
} from '../../../shared/types'
import { ClickupCompleteDialog } from '../ClickupComplete'
import { ClickupPushDialog } from '../ClickupPush'
import { Avatar } from '../ui'

// ---------------------------------------------------------------------------
// The ClickUp client. Laid out like a task tool: a rail of views and lists on
// the left, a table (or board) in the middle, and a detail panel that slides
// in on the right. Every property is edited where it sits — click a status
// pill, a due date, an avatar, a flag — and ClickUp stays the source of
// truth: each edit is a write to the API and the row updates optimistically.
// ---------------------------------------------------------------------------

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

function todayIso(): string {
  return isoOf(new Date())
}

function plusDaysIso(n: number): string {
  return isoOf(new Date(Date.now() + n * 86_400_000))
}

/** next Monday, the way "next week" is usually meant */
function nextMondayIso(): string {
  const d = new Date()
  const delta = ((8 - d.getDay()) % 7) || 7
  return isoOf(new Date(d.getTime() + delta * 86_400_000))
}

/** "Sep 2", "Today", "Tomorrow", or "Sep 2, 2027" once the year differs */
function formatDue(iso: string): string {
  if (iso === todayIso()) return 'Today'
  if (iso === plusDaysIso(1)) return 'Tomorrow'
  const d = new Date(`${iso}T12:00:00`)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

function formatWhenIso(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const thisYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (isNaN(ms)) return ''
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** the priorities ClickUp knows, in the order its own picker lists them */
const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
type Priority = (typeof PRIORITIES)[number]
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

function priorityOf(p: string | null): Priority | null {
  const v = (p ?? '').toLowerCase()
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : null
}

const KIND_LABEL: Record<ClickupActivityEvent['kind'], string> = {
  new: 'New',
  done: 'Done',
  status: 'Status',
  due: 'Due',
  comment: 'Comment',
  removed: 'Removed',
  you: 'You'
}

type ViewId =
  | 'my'
  | 'today'
  | 'overdue'
  | 'unassigned'
  | 'everyone'
  | 'done'
  | 'activity'
  | `list:${string}`

type Layout = 'list' | 'board'
type GroupBy = 'due' | 'list' | 'status' | 'assignee' | 'priority' | 'none'
type SortKey = 'due' | 'name' | 'status' | 'assignee' | 'priority' | 'updated'

const SAVED_VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: 'my', label: 'My tasks', hint: 'Everything open that is assigned to you' },
  { id: 'today', label: 'Today', hint: 'Yours, due today or overdue' },
  { id: 'overdue', label: 'Overdue', hint: 'Yours, past due' },
  { id: 'unassigned', label: 'Unassigned', hint: 'Open tasks nobody owns' },
  { id: 'everyone', label: 'Everyone', hint: 'Every open task in the workspace' },
  { id: 'done', label: 'Done', hint: 'Yours, finished in the last month' }
]

const GROUP_LABEL: Record<GroupBy, string> = {
  due: 'Due date',
  list: 'List',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  none: 'None'
}

type Group = { key: string; label: string; tasks: ClickupTask[]; listId?: string; overdue?: boolean }

const SEEN_KEY = 'clickupActivitySeen'
const AUTO_REFRESH_MS = 5 * 60_000

function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

// ---- popovers -------------------------------------------------------------

/**
 * A small anchored menu. The parent owns which one is open so only one shows
 * at a time and the keyboard can open them; this handles outside-click and
 * Escape.
 */
function Popover({
  open,
  onClose,
  align = 'left',
  children,
  trigger
}: {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right'
  children: React.ReactNode
  trigger: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  return (
    <span className="cuc-pop-anchor" ref={ref}>
      {trigger}
      {open && (
        <div className={`cuc-pop ${align === 'right' ? 'right' : ''}`} role="menu">
          {children}
        </div>
      )}
    </span>
  )
}

function StatusPill({
  task,
  onClick,
  compact = false
}: {
  task: ClickupTask
  onClick?: () => void
  compact?: boolean
}): React.JSX.Element {
  const color = task.statusColor ?? 'var(--ink-faint)'
  return (
    <button
      className={`cuc-pill ${compact ? 'compact' : ''}`}
      style={{ '--pill': color } as React.CSSProperties}
      onClick={onClick}
      title="Change status"
      disabled={!onClick}
    >
      <span className="cuc-pill-dot" />
      <span className="cuc-pill-name">{task.status}</span>
    </button>
  )
}

function FlagIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M5 3v18h2v-7h11l-2.5-4L18 6H7V3H5z" />
    </svg>
  )
}

// ---- the view --------------------------------------------------------------

export function ProjectsView({ onSettings }: { onSettings: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<ClickupStatus | null>(null)
  const [mine, setMine] = useState<ClickupTask[] | null>(null)
  const [all, setAll] = useState<ClickupTask[] | null>(null)
  const [done, setDone] = useState<ClickupTask[] | null>(null)
  const [events, setEvents] = useState<ClickupActivityEvent[]>([])
  const [truncated, setTruncated] = useState(false)
  const [lists, setLists] = useState<ClickupList[]>([])
  const [members, setMembers] = useState<ClickupMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>(
    () => (localStorage.getItem('clickupView') as ViewId) || 'my'
  )
  const [layout, setLayout] = useState<Layout>(
    () => (localStorage.getItem('clickupLayout') as Layout) || 'list'
  )
  const [groupBy, setGroupBy] = useState<GroupBy>(
    () => (localStorage.getItem('clickupGroupBy') as GroupBy) || 'due'
  )
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'due', dir: 1 })
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pop, setPop] = useState<{ id: string; kind: 'status' | 'assignee' | 'due' | 'priority'; where: 'row' | 'panel' } | null>(null)
  const [completing, setCompleting] = useState<ClickupTask | null>(null)
  const [creating, setCreating] = useState<{ listId?: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [listStatuses, setListStatuses] = useState<Record<string, ClickupStatusOption[]>>({})
  const [comments, setComments] = useState<Record<string, ClickupComment[] | 'loading'>>({})
  const [comment, setComment] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [quickAdd, setQuickAdd] = useState<{ key: string; text: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<string | null>(null)
  const [seenAt, setSeenAt] = useState(() => localStorage.getItem(SEEN_KEY) ?? '')
  const loadSeq = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const commentRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const isListView = view.startsWith('list:')
  const viewListId = isListView ? view.slice(5) : null
  const scope: 'mine' | 'all' =
    view === 'unassigned' || view === 'everyone' || isListView ? 'all' : 'mine'

  // ---- loading ----
  const load = useCallback(
    async (quiet = false): Promise<void> => {
      const seq = ++loadSeq.current
      if (!quiet) setRefreshing(true)
      setError(null)
      try {
        const st = await window.scribe.clickup.status()
        if (seq !== loadSeq.current) return
        setStatus(st)
        if (!st.connected) return
        if (view === 'done') {
          const d = await window.scribe.clickup.done('mine')
          if (seq !== loadSeq.current) return
          setDone(d)
        } else if (view !== 'activity') {
          const r = await window.scribe.clickup.refresh(scope)
          if (seq !== loadSeq.current) return
          if (scope === 'all') setAll(r.tasks)
          else setMine(r.tasks)
          setEvents(r.events)
          setTruncated(r.truncated)
        } else {
          const r = await window.scribe.clickup.refresh('mine')
          if (seq !== loadSeq.current) return
          setMine(r.tasks)
          setEvents(r.events)
        }
        setLastRefresh(new Date().toISOString())
      } catch (err) {
        if (seq !== loadSeq.current) return
        setError(err instanceof Error ? err.message : 'Could not reach ClickUp')
      } finally {
        if (seq === loadSeq.current) setRefreshing(false)
      }
    },
    [view, scope]
  )

  useEffect(() => {
    load()
    const t = setInterval(() => load(true), AUTO_REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!status?.connected) return
    window.scribe.clickup.lists().then(setLists).catch(() => {})
    window.scribe.clickup.members().then(setMembers).catch(() => {})
  }, [status?.connected])

  // opening Activity marks everything currently in it as seen
  useEffect(() => {
    if (view !== 'activity' || events.length === 0) return
    const newest = events[0].at
    if (newest > seenAt) {
      setSeenAt(newest)
      localStorage.setItem(SEEN_KEY, newest)
    }
  }, [view, events, seenAt])

  const unread = useMemo(
    () => events.filter((e) => e.kind !== 'you' && e.at > seenAt).length,
    [events, seenAt]
  )

  function loadStatuses(listId: string): void {
    if (listStatuses[listId]) return
    window.scribe.clickup
      .listStatuses(listId)
      .then((s) => setListStatuses((prev) => ({ ...prev, [listId]: s })))
      .catch(() => {})
  }

  function loadComments(taskId: string): void {
    setComments((prev) => ({ ...prev, [taskId]: 'loading' }))
    window.scribe.clickup
      .comments(taskId)
      .then((c) => setComments((prev) => ({ ...prev, [taskId]: c })))
      .catch(() => setComments((prev) => ({ ...prev, [taskId]: [] })))
  }

  // ---- navigation ----
  function changeView(v: ViewId): void {
    setView(v)
    localStorage.setItem('clickupView', v)
    setSelectedId(null)
    setPop(null)
    setQuickAdd(null)
    setCollapsed(new Set())
    setQuery('')
  }

  function changeLayout(l: Layout): void {
    setLayout(l)
    localStorage.setItem('clickupLayout', l)
    setPop(null)
  }

  function changeGroupBy(g: GroupBy): void {
    setGroupBy(g)
    localStorage.setItem('clickupGroupBy', g)
    setCollapsed(new Set())
  }

  function toggleSort(key: SortKey): void {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }

  // ---- the task set for this view ----
  const source: ClickupTask[] | null =
    view === 'done' ? done : view === 'activity' ? mine : scope === 'all' ? all : mine

  const needle = query.trim().toLowerCase()
  const today = todayIso()

  const tasks = useMemo(() => {
    if (!source) return null
    let out = source
    if (view === 'today') out = out.filter((t) => !!t.dueDate && t.dueDate <= today)
    else if (view === 'overdue') out = out.filter((t) => !!t.dueDate && t.dueDate < today)
    else if (view === 'unassigned') out = out.filter((t) => t.assignees.length === 0)
    else if (viewListId) out = out.filter((t) => t.listId === viewListId)
    if (needle) {
      out = out.filter((t) =>
        [
          t.name,
          t.description ?? '',
          t.listName,
          t.folderName ?? '',
          t.parentName ?? '',
          t.requestor ?? '',
          t.status,
          ...t.assignees
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      )
    }
    const cmp = (a: ClickupTask, b: ClickupTask): number => {
      switch (sort.key) {
        case 'name':
          return a.name.localeCompare(b.name)
        case 'status':
          return a.status.localeCompare(b.status)
        case 'assignee':
          return (a.assignees[0] ?? '~').localeCompare(b.assignees[0] ?? '~')
        case 'priority':
          return (PRIORITY_RANK[priorityOf(a.priority) ?? ''] ?? 9) - (PRIORITY_RANK[priorityOf(b.priority) ?? ''] ?? 9)
        case 'updated':
          return (b.dateUpdated ?? '').localeCompare(a.dateUpdated ?? '')
        default:
          return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
      }
    }
    return [...out].sort((a, b) => sort.dir * cmp(a, b) || a.name.localeCompare(b.name))
  }, [source, view, viewListId, needle, sort, today])

  const groups = useMemo((): Group[] => {
    if (!tasks) return []
    if (view === 'done') {
      // finished work groups by the day it was closed
      const map = new Map<string, ClickupTask[]>()
      for (const t of tasks) {
        const day = t.dateDone ? t.dateDone.slice(0, 10) : 'earlier'
        map.set(day, [...(map.get(day) ?? []), t])
      }
      return [...map.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, ts]) => ({
          key: day,
          label: day === 'earlier' ? 'Earlier' : day === today ? 'Today' : day === plusDaysIso(-1) ? 'Yesterday' : formatDue(day),
          tasks: ts
        }))
    }
    if (groupBy === 'none') return [{ key: 'all', label: 'All', tasks }]
    if (groupBy === 'due') {
      const week = plusDaysIso(7)
      const buckets: Group[] = [
        { key: 'overdue', label: 'Overdue', tasks: [], overdue: true },
        { key: 'today', label: 'Today', tasks: [] },
        { key: 'week', label: 'This week', tasks: [] },
        { key: 'later', label: 'Later', tasks: [] },
        { key: 'none', label: 'No due date', tasks: [] }
      ]
      for (const t of tasks) {
        if (!t.dueDate) buckets[4].tasks.push(t)
        else if (t.dueDate < today) buckets[0].tasks.push(t)
        else if (t.dueDate === today) buckets[1].tasks.push(t)
        else if (t.dueDate <= week) buckets[2].tasks.push(t)
        else buckets[3].tasks.push(t)
      }
      return buckets.filter((g) => g.tasks.length > 0)
    }
    const map = new Map<string, Group>()
    for (const t of tasks) {
      let key: string
      let label: string
      let listId: string | undefined
      if (groupBy === 'list') {
        key = t.listId
        label = t.folderName ? `${t.folderName} / ${t.listName}` : t.listName
        listId = t.listId
      } else if (groupBy === 'status') {
        key = t.status
        label = t.status
      } else if (groupBy === 'assignee') {
        key = t.assignees.join(', ') || '~'
        label = t.assignees.join(', ') || 'Unassigned'
      } else {
        key = priorityOf(t.priority) ?? 'none'
        label = priorityOf(t.priority) ?? 'No priority'
      }
      const g = map.get(key) ?? { key, label, tasks: [], listId }
      g.tasks.push(t)
      map.set(key, g)
    }
    const out = [...map.values()]
    if (groupBy === 'priority') out.sort((a, b) => (PRIORITY_RANK[a.key] ?? 9) - (PRIORITY_RANK[b.key] ?? 9))
    else out.sort((a, b) => a.label.localeCompare(b.label))
    for (const g of out) g.overdue = g.tasks.some((t) => !!t.dueDate && t.dueDate < today)
    return out
  }, [tasks, groupBy, view, today])

  const flat = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.tasks)), [groups, collapsed])

  const selected: ClickupTask | null = useMemo(() => {
    if (!selectedId) return null
    return (
      mine?.find((t) => t.id === selectedId) ??
      all?.find((t) => t.id === selectedId) ??
      done?.find((t) => t.id === selectedId) ??
      null
    )
  }, [selectedId, mine, all, done])

  /** counts for the rail, from whatever is loaded */
  const counts = useMemo(() => {
    const m = mine ?? []
    const a = all ?? []
    const byList = new Map<string, number>()
    for (const t of a) byList.set(t.listId, (byList.get(t.listId) ?? 0) + 1)
    return {
      my: m.length,
      today: m.filter((t) => !!t.dueDate && t.dueDate <= today).length,
      overdue: m.filter((t) => !!t.dueDate && t.dueDate < today).length,
      unassigned: all ? a.filter((t) => t.assignees.length === 0).length : null,
      everyone: all ? a.length : null,
      done: done ? done.length : null,
      byList
    }
  }, [mine, all, done, today])

  /** the workspace tree: space > folder > lists */
  const tree = useMemo(() => {
    const spaces = new Map<string, Map<string, ClickupList[]>>()
    for (const l of lists) {
      const folders = spaces.get(l.space) ?? new Map<string, ClickupList[]>()
      const key = l.folder ?? ''
      folders.set(key, [...(folders.get(key) ?? []), l])
      spaces.set(l.space, folders)
    }
    return [...spaces.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([space, folders]) => ({
        space,
        folders: [...folders.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([folder, ls]) => ({ folder, lists: [...ls].sort((a, b) => a.name.localeCompare(b.name)) }))
      }))
  }, [lists])

  // ---- edits ----
  const patchTask = (id: string, patch: Partial<ClickupTask>): void => {
    const f = (prev: ClickupTask[] | null): ClickupTask[] | null =>
      prev?.map((x) => (x.id === id ? { ...x, ...patch } : x)) ?? null
    setMine(f)
    setAll(f)
    setDone(f)
  }
  const dropTask = (id: string): void => {
    const f = (prev: ClickupTask[] | null): ClickupTask[] | null => prev?.filter((x) => x.id !== id) ?? null
    setMine(f)
    setAll(f)
    if (selectedId === id) setSelectedId(null)
  }

  async function changeStatus(t: ClickupTask, next: string): Promise<void> {
    setPop(null)
    if (next === t.status) return
    setRowError(null)
    setBusyId(t.id)
    const r = await window.scribe.clickup.setStatus(t.id, t.listId, next, t.name, t.url)
    setBusyId(null)
    if (!r.ok) {
      setRowError(r.error ?? 'Could not change the status')
      return
    }
    if (r.finished) dropTask(t.id)
    else {
      const color = listStatuses[t.listId]?.find((s) => s.status === next)?.color ?? t.statusColor
      patchTask(t.id, { status: next, statusColor: color })
    }
  }

  async function changeDue(t: ClickupTask, iso: string | null): Promise<void> {
    setPop(null)
    if (iso === t.dueDate) return
    setRowError(null)
    const r = await window.scribe.clickup.setTaskDue(t.id, iso, t.name, t.url)
    if (r.ok) patchTask(t.id, { dueDate: iso })
    else setRowError(r.error ?? 'Could not change the due date')
  }

  async function changePriority(t: ClickupTask, p: Priority | null): Promise<void> {
    setPop(null)
    if ((p ?? null) === priorityOf(t.priority)) return
    setRowError(null)
    const r = await window.scribe.clickup.setPriority(t.id, p, t.name, t.url)
    if (r.ok) patchTask(t.id, { priority: p })
    else setRowError(r.error ?? 'Could not change the priority')
  }

  async function assign(t: ClickupTask, who: string): Promise<void> {
    setPop(null)
    setRowError(null)
    setBusyId(t.id)
    const r = await window.scribe.clickup.setAssignee(t.id, who, t.name, t.url)
    setBusyId(null)
    if (!r.ok) {
      setRowError(r.error ?? 'Could not reassign the task')
      return
    }
    patchTask(t.id, { assignees: r.assignedTo ? [r.assignedTo] : [] })
    // handing it to someone else takes it off your list
    if (scope === 'mine' && r.assignedTo !== status?.userName) {
      setMine((prev) => prev?.filter((x) => x.id !== t.id) ?? null)
    }
  }

  async function saveName(t: ClickupTask): Promise<void> {
    const name = nameDraft.trim()
    setEditingName(false)
    if (!name || name === t.name) return
    setRowError(null)
    setBusyId(t.id)
    const r = await window.scribe.clickup.rename(t.id, name, t.url)
    setBusyId(null)
    if (r.ok) patchTask(t.id, { name })
    else setRowError(r.error ?? 'Could not rename the task')
  }

  async function sendComment(t: ClickupTask): Promise<void> {
    const text = comment.trim()
    if (!text) return
    setBusyId(t.id)
    setRowError(null)
    const r = await window.scribe.clickup.comment(t.id, text, t.name, t.url)
    setBusyId(null)
    if (r.ok) {
      const posted: ClickupComment = {
        id: `local-${Date.now()}`,
        author: status?.userName ?? 'You',
        text,
        at: new Date().toISOString()
      }
      setComments((prev) => {
        const cur = prev[t.id]
        return { ...prev, [t.id]: [...(Array.isArray(cur) ? cur : []), posted] }
      })
      setComment('')
    } else {
      setRowError(r.error ?? 'Could not post the comment')
    }
  }

  async function submitQuickAdd(listId: string, extra: { dueDate?: string | null } = {}): Promise<void> {
    const name = quickAdd?.text.trim()
    if (!name) {
      setQuickAdd(null)
      return
    }
    setRowError(null)
    setBusyId('quick')
    const r = await window.scribe.clickup.push({
      listId,
      name,
      assignee: scope === 'mine' ? status?.userName ?? undefined : undefined,
      dueDate: extra.dueDate ?? null
    })
    setBusyId(null)
    if (r.ok) {
      setQuickAdd((q) => (q ? { ...q, text: '' } : q))
      load(true)
    } else setRowError(r.error ?? 'ClickUp rejected the task')
  }

  function openTask(t: ClickupTask): void {
    setSelectedId(t.id)
    setPop(null)
    setEditingName(false)
    setComment('')
    setRowError(null)
    loadStatuses(t.listId)
    if (!comments[t.id]) loadComments(t.id)
  }

  function toggleGroup(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // statuses for the lists on screen, so pills and the board can offer them
  useEffect(() => {
    if (!tasks) return
    const ids = new Set(tasks.map((t) => t.listId))
    for (const id of ids) loadStatuses(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  // ---- keyboard ----
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) {
        if (e.key === 'Escape') {
          if (document.activeElement === searchRef.current) setQuery('')
          ;(document.activeElement as HTMLElement).blur()
        }
        return
      }
      if (creating || completing) return
      if (e.key === 'Escape') {
        if (pop) setPop(null)
        else if (quickAdd) setQuickAdd(null)
        else setSelectedId(null)
        return
      }
      const idx = selectedId ? flat.findIndex((t) => t.id === selectedId) : -1
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (flat.length === 0) return
          e.preventDefault()
          openTask(flat[Math.min(idx + 1, flat.length - 1)])
          return
        case 'k':
        case 'ArrowUp':
          if (flat.length === 0) return
          e.preventDefault()
          openTask(flat[Math.max(idx - 1, 0)])
          return
        case '/':
          e.preventDefault()
          searchRef.current?.focus()
          return
        case 'n':
          setCreating({ listId: viewListId ?? undefined })
          return
        case 'r':
          load()
          return
      }
      if (!selected) return
      switch (e.key) {
        case 'x':
          if (view !== 'done') setCompleting(selected)
          return
        case 's':
          setPop({ id: selected.id, kind: 'status', where: 'panel' })
          return
        case 'd':
          setPop({ id: selected.id, kind: 'due', where: 'panel' })
          return
        case 'a':
          setPop({ id: selected.id, kind: 'assignee', where: 'panel' })
          return
        case 'p':
          setPop({ id: selected.id, kind: 'priority', where: 'panel' })
          return
        case 'c':
          e.preventDefault()
          commentRef.current?.focus()
          return
        case 'o':
          window.open(selected.url, '_blank', 'noreferrer')
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- board columns (a hook, so it sits above the early returns) ----
  const boardColumns = useMemo((): { status: string; color: string | null; type: string; tasks: ClickupTask[] }[] => {
    if (!tasks || layout !== 'board') return []
    // a single list gives its own column order; a mixed view takes the union in order of appearance
    const order: { status: string; color: string | null; type: string }[] = []
    const seen = new Set<string>()
    const push = (s: { status: string; color: string | null; type?: string }): void => {
      const k = s.status.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      order.push({ status: s.status, color: s.color, type: s.type ?? 'custom' })
    }
    if (viewListId && listStatuses[viewListId]) listStatuses[viewListId].forEach(push)
    for (const t of tasks) push({ status: t.status, color: t.statusColor })
    return order
      .map((c) => ({ ...c, tasks: tasks.filter((t) => t.status.toLowerCase() === c.status.toLowerCase()) }))
      .filter((c) => c.tasks.length > 0 || !!viewListId)
  }, [tasks, layout, viewListId, listStatuses])

  // ---- not connected ----
  if (!status) {
    return (
      <>
        <div className="page-head">
          <h1>ClickUp</h1>
        </div>
        <p className="today-quiet">Loading your tasks…</p>
      </>
    )
  }

  if (!status.connected) {
    return (
      <div className="empty-state">
        <h2>ClickUp</h2>
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

  // ---- pickers (shared by rows, the board, and the panel) ----
  const isOpen = (t: ClickupTask, kind: NonNullable<typeof pop>['kind'], where: 'row' | 'panel'): boolean =>
    pop?.id === t.id && pop.kind === kind && pop.where === where

  const statusPicker = (t: ClickupTask, where: 'row' | 'panel', compact = false): React.JSX.Element => (
    <Popover
      open={isOpen(t, 'status', where)}
      onClose={() => setPop(null)}
      trigger={
        <StatusPill
          task={t}
          compact={compact}
          onClick={view === 'done' ? undefined : () => {
            loadStatuses(t.listId)
            setPop(isOpen(t, 'status', where) ? null : { id: t.id, kind: 'status', where })
          }}
        />
      }
    >
      {(listStatuses[t.listId] ?? []).length === 0 ? (
        <span className="cuc-pop-note">Loading statuses…</span>
      ) : (
        (listStatuses[t.listId] ?? []).map((s) => (
          <button
            key={s.status}
            className={`cuc-pop-item ${s.status === t.status ? 'on' : ''}`}
            onClick={() => changeStatus(t, s.status)}
          >
            <span className="cuc-pill-dot" style={{ background: s.color ?? 'var(--ink-faint)' }} />
            <span className="cuc-pop-label">{s.status}</span>
            {(s.type === 'done' || s.type === 'closed') && <span className="cuc-pop-hint">finishes it</span>}
          </button>
        ))
      )}
    </Popover>
  )

  const assigneePicker = (t: ClickupTask, where: 'row' | 'panel', full = false): React.JSX.Element => {
    const open = isOpen(t, 'assignee', where)
    return (
      <Popover
        open={open}
        onClose={() => setPop(null)}
        align={full ? 'left' : 'right'}
        trigger={
          <button
            className={`cuc-assignees ${full ? 'full' : ''}`}
            onClick={view === 'done' ? undefined : () => setPop(open ? null : { id: t.id, kind: 'assignee', where })}
            title={t.assignees.length ? `Assigned to ${t.assignees.join(', ')} · click to change` : 'Unassigned · click to assign'}
            disabled={view === 'done'}
          >
            {t.assignees.length === 0 ? (
              <span className="cuc-unassigned" aria-hidden="true">
                +
              </span>
            ) : (
              t.assignees.slice(0, 3).map((a) => <Avatar key={a} name={a} size={full ? 22 : 22} />)
            )}
            {full && <span className="cuc-assignee-names">{t.assignees.join(', ') || 'Unassigned'}</span>}
          </button>
        }
      >
        <AssigneeMenu task={t} members={members} me={status.userName ?? null} onPick={(who) => assign(t, who)} />
      </Popover>
    )
  }

  const duePicker = (t: ClickupTask, where: 'row' | 'panel', full = false): React.JSX.Element => {
    const open = isOpen(t, 'due', where)
    const overdue = !!t.dueDate && t.dueDate < today
    return (
      <Popover
        open={open}
        onClose={() => setPop(null)}
        align={full ? 'left' : 'right'}
        trigger={
          <button
            className={`cuc-due ${overdue ? 'overdue' : ''} ${t.dueDate ? '' : 'empty'}`}
            onClick={view === 'done' ? undefined : () => setPop(open ? null : { id: t.id, kind: 'due', where })}
            title="Change due date"
            disabled={view === 'done'}
          >
            {t.dueDate ? formatDue(t.dueDate) : full ? 'No due date' : '—'}
          </button>
        }
      >
        <button className="cuc-pop-item" onClick={() => changeDue(t, today)}>
          <span className="cuc-pop-label">Today</span>
        </button>
        <button className="cuc-pop-item" onClick={() => changeDue(t, plusDaysIso(1))}>
          <span className="cuc-pop-label">Tomorrow</span>
        </button>
        <button className="cuc-pop-item" onClick={() => changeDue(t, nextMondayIso())}>
          <span className="cuc-pop-label">Next Monday</span>
        </button>
        <button className="cuc-pop-item" onClick={() => changeDue(t, plusDaysIso(7))}>
          <span className="cuc-pop-label">In a week</span>
        </button>
        <label className="cuc-pop-date">
          <span>Pick a day</span>
          <input
            type="date"
            className="text-input"
            value={t.dueDate ?? ''}
            onChange={(e) => changeDue(t, e.target.value || null)}
          />
        </label>
        {t.dueDate && (
          <button className="cuc-pop-item danger" onClick={() => changeDue(t, null)}>
            <span className="cuc-pop-label">Clear</span>
          </button>
        )}
      </Popover>
    )
  }

  const priorityPicker = (t: ClickupTask, where: 'row' | 'panel', full = false): React.JSX.Element => {
    const open = isOpen(t, 'priority', where)
    const p = priorityOf(t.priority)
    return (
      <Popover
        open={open}
        onClose={() => setPop(null)}
        align={full ? 'left' : 'right'}
        trigger={
          <button
            className={`cuc-flag ${p ? `cuc-flag-${p}` : 'none'} ${full ? 'full' : ''}`}
            onClick={view === 'done' ? undefined : () => setPop(open ? null : { id: t.id, kind: 'priority', where })}
            title={p ? `${p} priority · click to change` : 'Set priority'}
            disabled={view === 'done'}
          >
            <FlagIcon />
            {full && <span>{p ?? 'No priority'}</span>}
          </button>
        }
      >
        {PRIORITIES.map((x) => (
          <button key={x} className={`cuc-pop-item ${x === p ? 'on' : ''}`} onClick={() => changePriority(t, x)}>
            <span className={`cuc-flag cuc-flag-${x} inline`}>
              <FlagIcon />
            </span>
            <span className="cuc-pop-label">{x}</span>
          </button>
        ))}
        <button className="cuc-pop-item" onClick={() => changePriority(t, null)}>
          <span className="cuc-flag none inline">
            <FlagIcon />
          </span>
          <span className="cuc-pop-label">None</span>
        </button>
      </Popover>
    )
  }

  // ---- rail ----
  const railCount = (n: number | null): React.ReactNode =>
    n === null ? null : <span className="cuc-rail-n">{n}</span>

  const rail = (
    <aside className="cuc-rail">
      <button className="btn btn-primary cuc-new" onClick={() => setCreating({ listId: viewListId ?? undefined })}>
        <span aria-hidden="true">+</span> New task
      </button>
      <nav className="cuc-rail-group" aria-label="Views">
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.id}
            className={`cuc-rail-item ${view === v.id ? 'active' : ''} ${v.id === 'overdue' && counts.overdue > 0 ? 'warn' : ''}`}
            onClick={() => changeView(v.id)}
            title={v.hint}
          >
            <span>{v.label}</span>
            {railCount(
              v.id === 'my'
                ? counts.my
                : v.id === 'today'
                  ? counts.today
                  : v.id === 'overdue'
                    ? counts.overdue
                    : v.id === 'unassigned'
                      ? counts.unassigned
                      : v.id === 'everyone'
                        ? counts.everyone
                        : counts.done
            )}
          </button>
        ))}
        <button
          className={`cuc-rail-item ${view === 'activity' ? 'active' : ''}`}
          onClick={() => changeView('activity')}
          title="What changed in ClickUp since you last looked"
        >
          <span>Activity</span>
          {unread > 0 && <span className="cuc-rail-badge">{unread}</span>}
        </button>
      </nav>
      <div className="cuc-rail-head">Workspace</div>
      <nav className="cuc-tree" aria-label="Lists">
        {tree.length === 0 && <span className="cuc-rail-note">Loading lists…</span>}
        {tree.map(({ space, folders }) => {
          const spaceOpen = treeOpen.has(`s:${space}`) || tree.length === 1
          return (
            <div key={space} className="cuc-tree-space">
              <button
                className="cuc-tree-head"
                onClick={() =>
                  setTreeOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(`s:${space}`)) next.delete(`s:${space}`)
                    else next.add(`s:${space}`)
                    return next
                  })
                }
                aria-expanded={spaceOpen}
              >
                <span className={`cuc-chev ${spaceOpen ? 'open' : ''}`}>›</span>
                {space}
              </button>
              {spaceOpen &&
                folders.map(({ folder, lists: ls }) => (
                  <div key={folder || '(none)'} className="cuc-tree-folder">
                    {folder && <div className="cuc-tree-folder-name">{folder}</div>}
                    {ls.map((l) => (
                      <button
                        key={l.id}
                        className={`cuc-rail-item list ${view === `list:${l.id}` ? 'active' : ''}`}
                        onClick={() => changeView(`list:${l.id}`)}
                        title={`${l.space}${l.folder ? ` / ${l.folder}` : ''} / ${l.name}`}
                      >
                        <span>{l.name}</span>
                        {railCount(all ? (counts.byList.get(l.id) ?? 0) : null)}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )
        })}
      </nav>
      <div className="cuc-rail-foot">
        <span className="cuc-rail-team">{status.teamName}</span>
        <span>
          {refreshing ? 'Refreshing…' : lastRefresh ? `Refreshed ${formatAgo(lastRefresh)}` : ''}
        </span>
        {truncated && <span className="cuc-rail-warn">Showing the first tasks only; ClickUp has more.</span>}
      </div>
    </aside>
  )

  // ---- table ----
  const sortHead = (key: SortKey, label: string, cls = ''): React.JSX.Element => (
    <button
      className={`cuc-th ${cls} ${sort.key === key ? 'on' : ''}`}
      onClick={() => toggleSort(key)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {sort.key === key && <span className="cuc-th-dir">{sort.dir === 1 ? '↑' : '↓'}</span>}
    </button>
  )

  const row = (t: ClickupTask): React.JSX.Element => {
    const active = selectedId === t.id
    const where = [
      groupBy !== 'list' && !viewListId ? (t.folderName ? `${t.folderName} / ${t.listName}` : t.listName) : '',
      t.parentName ? `↳ ${t.parentName}` : '',
      t.requestor ? `for ${t.requestor}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div
        key={t.id}
        className={`cuc-tr ${active ? 'active' : ''} ${busyId === t.id ? 'busy' : ''} ${view === 'done' ? 'done' : ''}`}
        onClick={(e) => {
          // clicks on the pickers handle themselves
          if ((e.target as HTMLElement).closest('.cuc-pop-anchor, .cuc-check, a')) return
          openTask(t)
        }}
      >
        <span className="cuc-td cuc-td-check">
          {view === 'done' ? (
            <span className="cuc-done-tick" title={t.dateDone ? `Done ${formatWhenIso(t.dateDone)}` : 'Done'}>
              ✓
            </span>
          ) : (
            <input
              type="checkbox"
              className="rollup-check cuc-check"
              checked={completing?.id === t.id}
              onChange={() => setCompleting(t)}
              aria-label={`Mark "${t.name}" done in ClickUp`}
              title="Mark done in ClickUp"
            />
          )}
        </span>
        <span className="cuc-td cuc-td-name">
          <span className="cuc-name">{t.name}</span>
          {where && <span className="cuc-where">{where}</span>}
        </span>
        <span className="cuc-td cuc-td-status">{statusPicker(t, 'row', true)}</span>
        <span className="cuc-td cuc-td-assignee">{assigneePicker(t, 'row')}</span>
        <span className="cuc-td cuc-td-due">{duePicker(t, 'row')}</span>
        <span className="cuc-td cuc-td-priority">{priorityPicker(t, 'row')}</span>
        <a
          className="cuc-td cuc-td-open"
          href={t.url}
          target="_blank"
          rel="noreferrer"
          title="Open in ClickUp"
          aria-label="Open in ClickUp"
        >
          ↗
        </a>
      </div>
    )
  }

  const quickAddRow = (g: Group): React.JSX.Element | null => {
    const listId = g.listId ?? viewListId
    if (!listId || view === 'done') return null
    const key = g.key
    const open = quickAdd?.key === key
    const dueFor = groupBy === 'due' ? (g.key === 'today' ? today : g.key === 'week' ? plusDaysIso(1) : null) : null
    return (
      <div className={`cuc-quick ${open ? 'open' : ''}`}>
        {open ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitQuickAdd(listId, { dueDate: dueFor })
            }}
          >
            <input
              className="cuc-quick-input"
              autoFocus
              placeholder={`New task in ${g.listId ? g.label : lists.find((l) => l.id === listId)?.name ?? 'this list'} — Enter to add, Esc to close`}
              value={quickAdd.text}
              onChange={(e) => setQuickAdd({ key, text: e.target.value })}
              onKeyDown={(e) => e.key === 'Escape' && setQuickAdd(null)}
              disabled={busyId === 'quick'}
            />
          </form>
        ) : (
          <button className="cuc-quick-btn" onClick={() => setQuickAdd({ key, text: '' })}>
            + Add task
          </button>
        )}
      </div>
    )
  }

  const table = (
    <div className="cuc-table" role="table">
      <div className="cuc-thead" role="row">
        <span className="cuc-td cuc-td-check" />
        {sortHead('name', 'Task', 'cuc-td-name')}
        {sortHead('status', 'Status', 'cuc-td-status')}
        {sortHead('assignee', 'Assignee', 'cuc-td-assignee')}
        {sortHead('due', 'Due', 'cuc-td-due')}
        {sortHead('priority', 'Priority', 'cuc-td-priority')}
        <span className="cuc-td cuc-td-open" />
      </div>
      {groups.map((g) => {
        const folded = collapsed.has(g.key)
        return (
          <div key={g.key} className="cuc-group">
            {(groupBy !== 'none' || view === 'done') && (
              <button className={`cuc-group-head ${g.overdue ? 'overdue' : ''}`} onClick={() => toggleGroup(g.key)}>
                <span className={`cuc-chev ${folded ? '' : 'open'}`}>›</span>
                <span className="cuc-group-label">{g.label}</span>
                <span className="cuc-group-n">{g.tasks.length}</span>
              </button>
            )}
            {!folded && g.tasks.map(row)}
            {!folded && quickAddRow(g)}
          </div>
        )
      })}
      {groups.length === 0 && groupBy === 'none' && quickAddRow({ key: 'all', label: 'All', tasks: [] })}
    </div>
  )

  const canDropOn = (t: ClickupTask, statusName: string): boolean =>
    (listStatuses[t.listId] ?? []).some((s) => s.status.toLowerCase() === statusName.toLowerCase())

  const board = (
    <div className="cuc-board">
      {boardColumns.map((col) => {
        const dragged = dragId ? tasks?.find((t) => t.id === dragId) : null
        const allowed = dragged ? canDropOn(dragged, col.status) : true
        return (
          <div
            key={col.status}
            className={`cuc-col ${dropCol === col.status ? 'over' : ''} ${dragged && !allowed ? 'blocked' : ''}`}
            onDragOver={(e) => {
              if (!dragged || !allowed) return
              e.preventDefault()
              if (dropCol !== col.status) setDropCol(col.status)
            }}
            onDragLeave={() => dropCol === col.status && setDropCol(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDropCol(null)
              if (dragged && allowed) changeStatus(dragged, col.status)
              setDragId(null)
            }}
          >
            <div className="cuc-col-head" style={{ '--pill': col.color ?? 'var(--ink-faint)' } as React.CSSProperties}>
              <span className="cuc-pill-dot" />
              <span className="cuc-col-name">{col.status}</span>
              <span className="cuc-group-n">{col.tasks.length}</span>
            </div>
            <div className="cuc-col-body">
              {col.tasks.map((t) => {
                const overdue = !!t.dueDate && t.dueDate < today
                const p = priorityOf(t.priority)
                return (
                  <div
                    key={t.id}
                    className={`cuc-card ${selectedId === t.id ? 'active' : ''} ${dragId === t.id ? 'dragging' : ''}`}
                    draggable={view !== 'done'}
                    onDragStart={(e) => {
                      setDragId(t.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', t.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropCol(null)
                    }}
                    onClick={() => openTask(t)}
                  >
                    <div className="cuc-card-name">{t.name}</div>
                    {(t.parentName || (!viewListId && groupBy !== 'list')) && (
                      <div className="cuc-where">
                        {[t.parentName ? `↳ ${t.parentName}` : '', !viewListId ? t.listName : ''].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div className="cuc-card-foot">
                      {t.assignees.length > 0 ? (
                        <span className="cuc-card-avatars">
                          {t.assignees.slice(0, 3).map((a) => (
                            <Avatar key={a} name={a} size={20} />
                          ))}
                        </span>
                      ) : (
                        <span className="cuc-where">Unassigned</span>
                      )}
                      <span className="cuc-card-gap" />
                      {p && (
                        <span className={`cuc-flag cuc-flag-${p} inline`} title={`${p} priority`}>
                          <FlagIcon />
                        </span>
                      )}
                      {t.dueDate && <span className={`cuc-due inline ${overdue ? 'overdue' : ''}`}>{formatDue(t.dueDate)}</span>}
                    </div>
                  </div>
                )
              })}
              {viewListId && view !== 'done' && (
                <button
                  className="cuc-quick-btn"
                  onClick={() => setCreating({ listId: viewListId })}
                >
                  + Add task
                </button>
              )}
            </div>
          </div>
        )
      })}
      {boardColumns.length === 0 && <p className="cuc-empty">Nothing to lay out.</p>}
    </div>
  )

  // ---- activity ----
  const activity = (
    <div className="cuc-activity">
      {events.length === 0 ? (
        <p className="cuc-empty">
          No changes noticed yet. The changelog builds as refreshes spot differences — new
          assignments, status changes, completions, due-date moves, and fresh comments.
        </p>
      ) : (
        events.map((e) => (
          <div className={`cu-act ${e.at > seenAt ? 'fresh' : ''}`} key={e.id}>
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
        ))
      )}
    </div>
  )

  // ---- main pane ----
  const viewTitle =
    view === 'activity'
      ? 'Activity'
      : viewListId
        ? (lists.find((l) => l.id === viewListId)?.name ?? 'List')
        : (SAVED_VIEWS.find((v) => v.id === view)?.label ?? 'Tasks')
  const shown = tasks?.length ?? 0

  const main = (
    <section className="cuc-main" aria-label={viewTitle}>
      <div className="cuc-toolbar">
        <h2 className="cuc-title">
          {viewTitle}
          {tasks && view !== 'activity' && (
            <span className="cuc-title-n">
              {needle && source && shown !== source.length ? `${shown} of ${source.length}` : shown}
            </span>
          )}
        </h2>
        {view !== 'activity' && (
          <>
            <span className="cu-search-wrap cuc-search-wrap">
              <input
                ref={searchRef}
                className="text-input cuc-search"
                placeholder="Search  ( / )"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search tasks"
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
            {view !== 'done' && (
              <label className="cuc-groupby">
                <span>Group</span>
                <select className="cuc-select" value={groupBy} onChange={(e) => changeGroupBy(e.target.value as GroupBy)}>
                  {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
                    <option key={g} value={g}>
                      {GROUP_LABEL[g]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="mode-toggle view-toggle cuc-layout" role="radiogroup" aria-label="Layout">
              <button className={layout === 'list' ? 'active' : ''} role="radio" aria-checked={layout === 'list'} onClick={() => changeLayout('list')} title="List">
                List
              </button>
              <button className={layout === 'board' ? 'active' : ''} role="radio" aria-checked={layout === 'board'} onClick={() => changeLayout('board')} title="Board">
                Board
              </button>
            </div>
          </>
        )}
        <button className="btn btn-ghost cuc-refresh" onClick={() => load()} disabled={refreshing} title="Refresh (r)">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="field-note error cuc-error">{error}</p>}
      {rowError && !selected && <p className="field-note error cuc-error">{rowError}</p>}
      <div className="cuc-scroll">
        {view === 'activity' ? (
          activity
        ) : !tasks && !error ? (
          <p className="cuc-empty">Loading…</p>
        ) : tasks && tasks.length === 0 ? (
          <p className="cuc-empty">
            {needle
              ? `Nothing matches “${query.trim()}”.`
              : view === 'my'
                ? 'Nothing assigned to you is open. Enjoy it while it lasts.'
                : view === 'today'
                  ? 'Nothing due today.'
                  : view === 'overdue'
                    ? 'Nothing overdue.'
                    : view === 'done'
                      ? 'Nothing finished in the last month.'
                      : 'No open tasks here.'}
          </p>
        ) : layout === 'board' && view !== 'done' ? (
          board
        ) : (
          table
        )}
      </div>
    </section>
  )

  // ---- detail panel ----
  const panel = selected && (
    <aside className="cuc-panel" ref={panelRef} aria-label="Task">
      <div className="cuc-panel-bar">
        <button className="mailc-ic" onClick={() => setSelectedId(null)} title="Close (Esc)" aria-label="Close">
          ×
        </button>
        <span className="cuc-panel-crumb">
          {selected.folderName ? `${selected.folderName} / ` : ''}
          {selected.listName}
        </span>
        <span className="mailc-read-bar-gap" />
        {view !== 'done' && (
          <button className="btn btn-ghost mailc-read-tool" onClick={() => setCompleting(selected)} title="Mark done (x)">
            ✓ Done
          </button>
        )}
        <a className="btn btn-ghost mailc-read-tool" href={selected.url} target="_blank" rel="noreferrer" title="Open in ClickUp (o)">
          ClickUp ↗
        </a>
      </div>
      <div className="cuc-panel-scroll">
        {selected.parentName && <div className="cuc-where">↳ {selected.parentName}</div>}
        {editingName ? (
          <input
            className="cuc-panel-title-input"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => saveName(selected)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName(selected)
              if (e.key === 'Escape') setEditingName(false)
            }}
            aria-label="Task name"
          />
        ) : (
          <h2
            className="cuc-panel-title"
            onClick={view === 'done' ? undefined : () => {
              setNameDraft(selected.name)
              setEditingName(true)
            }}
            title={view === 'done' ? undefined : 'Click to rename'}
          >
            {selected.name}
          </h2>
        )}
        <div className="cuc-props">
          <span className="cuc-prop-k">Status</span>
          <span className="cuc-prop-v">{statusPicker(selected, 'panel')}</span>
          <span className="cuc-prop-k">Assignee</span>
          <span className="cuc-prop-v">{assigneePicker(selected, 'panel', true)}</span>
          <span className="cuc-prop-k">Due</span>
          <span className="cuc-prop-v">{duePicker(selected, 'panel', true)}</span>
          <span className="cuc-prop-k">Priority</span>
          <span className="cuc-prop-v">{priorityPicker(selected, 'panel', true)}</span>
          {selected.requestor && (
            <>
              <span className="cuc-prop-k">Requestor</span>
              <span className="cuc-prop-v cuc-prop-text">{selected.requestor}</span>
            </>
          )}
          {selected.dateDone && (
            <>
              <span className="cuc-prop-k">Done</span>
              <span className="cuc-prop-v cuc-prop-text">{formatWhenIso(selected.dateDone)}</span>
            </>
          )}
        </div>
        {rowError && <p className="field-note error">{rowError}</p>}
        {selected.description ? (
          <p className="cuc-desc">{selected.description}</p>
        ) : (
          <p className="cuc-desc empty">No description.</p>
        )}
        <div className="cuc-comments">
          <span className="card-subhead">Comments</span>
          {comments[selected.id] === 'loading' && <span className="cu-comments-note">Loading…</span>}
          {Array.isArray(comments[selected.id]) && (comments[selected.id] as ClickupComment[]).length === 0 && (
            <span className="cu-comments-note">No comments yet.</span>
          )}
          {Array.isArray(comments[selected.id]) &&
            (comments[selected.id] as ClickupComment[]).map((c) => (
              <div className="cuc-comment" key={c.id}>
                <Avatar name={c.author} size={26} />
                <div className="cuc-comment-body">
                  <span className="cuc-comment-head">
                    <strong>{c.author}</strong>
                    <span>{formatWhenIso(c.at)}</span>
                  </span>
                  <span className="cuc-comment-text">{c.text}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
      <form
        className="cuc-comment-box"
        onSubmit={(e) => {
          e.preventDefault()
          sendComment(selected)
        }}
      >
        <input
          ref={commentRef}
          className="text-input"
          placeholder="Comment in ClickUp…  ( c )"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busyId === selected.id || !comment.trim()}>
          {busyId === selected.id ? 'Sending…' : 'Send'}
        </button>
      </form>
    </aside>
  )

  return (
    <div className={`cuc ${selected ? 'with-panel' : ''}`}>
      {rail}
      {main}
      {panel}
      {creating && (
        <ClickupPushDialog
          owner={scope === 'mine' ? (status.userName ?? null) : null}
          listId={creating.listId}
          onDone={() => {
            setCreating(null)
            load(true)
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {completing && (
        <ClickupCompleteDialog
          task={completing}
          onDone={() => {
            dropTask(completing.id)
            setCompleting(null)
          }}
          onClose={() => setCompleting(null)}
        />
      )}
    </div>
  )
}

/** the assignee popover: a filter box over the member list, plus me and unassign */
function AssigneeMenu({
  task,
  members,
  me,
  onPick
}: {
  task: ClickupTask
  members: ClickupMember[]
  me: string | null
  onPick: (who: string) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = members
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
    .slice(0, 12)
  return (
    <>
      <input
        className="cuc-pop-search"
        autoFocus
        placeholder="Find a person…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) onPick(shown[0].name)
        }}
      />
      {me && !needle && !task.assignees.includes(me) && (
        <button className="cuc-pop-item" onClick={() => onPick(me)}>
          <Avatar name={me} size={20} />
          <span className="cuc-pop-label">Me</span>
        </button>
      )}
      {shown.map((m) => (
        <button
          key={m.id}
          className={`cuc-pop-item ${task.assignees.includes(m.name) ? 'on' : ''}`}
          onClick={() => onPick(m.name)}
        >
          <Avatar name={m.name} size={20} />
          <span className="cuc-pop-label">{m.name}</span>
        </button>
      ))}
      {shown.length === 0 && <span className="cuc-pop-note">No one matches.</span>}
      {task.assignees.length > 0 && (
        <button className="cuc-pop-item danger" onClick={() => onPick('')}>
          <span className="cuc-pop-label">Unassign</span>
        </button>
      )}
    </>
  )
}
