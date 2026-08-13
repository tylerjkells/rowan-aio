import { useCallback, useEffect, useState } from 'react'
import type { ClickupStatus, ClickupTask } from '../../../shared/types'

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

type Bucket = { label: string; tasks: ClickupTask[]; overdue?: boolean }

function bucketize(tasks: ClickupTask[]): Bucket[] {
  const today = todayIso()
  const week = weekFromNowIso()
  const buckets: Bucket[] = [
    { label: 'Overdue', tasks: [], overdue: true },
    { label: 'Today', tasks: [] },
    { label: 'This week', tasks: [] },
    { label: 'Later', tasks: [] },
    { label: 'No due date', tasks: [] }
  ]
  for (const t of tasks) {
    if (!t.dueDate) buckets[4].tasks.push(t)
    else if (t.dueDate < today) buckets[0].tasks.push(t)
    else if (t.dueDate === today) buckets[1].tasks.push(t)
    else if (t.dueDate <= week) buckets[2].tasks.push(t)
    else buckets[3].tasks.push(t)
  }
  return buckets.filter((b) => b.tasks.length > 0)
}

export function ProjectsView({ onSettings }: { onSettings: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<ClickupStatus | null>(null)
  const [tasks, setTasks] = useState<ClickupTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      const st = await window.scribe.clickup.status()
      setStatus(st)
      if (st.connected) setTasks(await window.scribe.clickup.myTasks())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach ClickUp')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!status) return <></>

  if (!status.connected) {
    return (
      <div className="empty-state">
        <h2>Projects</h2>
        <p>
          Connect your ClickUp workspace to see everything assigned to you and push meeting action
          items into real tasks. ClickUp stays the source of truth.
          {status.error && <> ({status.error})</>}
        </p>
        <button className="btn btn-primary" onClick={onSettings}>
          Connect in Settings
        </button>
      </div>
    )
  }

  const buckets = tasks ? bucketize(tasks) : []

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {status.teamName}
            {tasks && <> · {tasks.length} open {tasks.length === 1 ? 'task' : 'tasks'}</>}
          </span>
          <button className="btn btn-ghost" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <p className="field-note error">{error}</p>}
      {tasks && tasks.length === 0 && !error && (
        <p className="today-quiet">Nothing assigned to you is open. Enjoy it while it lasts.</p>
      )}
      {buckets.map((b) => (
        <section className="section" key={b.label}>
          <div className="card-subhead">
            {b.label} · {b.tasks.length}
          </div>
          <div className="cu-list">
            {b.tasks.map((t) => (
              <a
                key={t.id}
                className="cu-row"
                href={t.url}
                target="_blank"
                rel="noreferrer"
                title="Open in ClickUp"
              >
                <span
                  className="cu-status-dot"
                  style={{ background: t.statusColor ?? 'var(--ink-faint)' }}
                  title={t.status}
                />
                <span className="cu-main">
                  <span className="cu-name">{t.name}</span>
                  <span className="cu-where">
                    {t.folderName ? `${t.folderName} / ` : ''}
                    {t.listName}
                  </span>
                </span>
                <span className="cu-meta">
                  {t.priority && <span className="cu-priority">{t.priority}</span>}
                  {t.dueDate && (
                    <span className={`cu-due ${b.overdue ? 'overdue' : ''}`}>
                      {formatDue(t.dueDate)}
                    </span>
                  )}
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
