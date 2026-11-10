import { useEffect, useRef, useState } from 'react'
import type { PlanItem, PlanItemInput, PlanStatus } from '../../shared/types'

/** the open Planner columns, in board order */
export const PLAN_COLUMNS: { id: Exclude<PlanStatus, 'done'>; label: string; hint: string }[] = [
  { id: 'now', label: 'Now', hint: 'What you’re working on' },
  { id: 'next', label: 'Next', hint: 'Up after that' },
  { id: 'waiting', label: 'Waiting', hint: 'Blocked on someone else' },
  { id: 'later', label: 'Later', hint: 'Not this week' }
]

/** names already used on Planner items plus everyone in the directory, for suggestions */
export function usePlannerSuggestions(items?: PlanItem[]): { projects: string[]; people: string[] } {
  const [people, setPeople] = useState<string[]>([])
  const [own, setOwn] = useState<PlanItem[]>(items ?? [])
  useEffect(() => {
    window.scribe.people
      .list()
      .then((ps) => setPeople(ps.map((p) => p.name)))
      .catch(() => {})
    if (!items) window.scribe.planner.list().then(setOwn).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const source = items ?? own
  const uniq = (xs: string[]): string[] =>
    [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return {
    projects: uniq(source.map((i) => i.project)),
    people: uniq([...source.map((i) => i.requester), ...people])
  }
}

/**
 * "New work" dialog: capture a piece of off-the-books work in the Planner.
 * Opened from the Planner rail, and from an email ("Add to Planner") with the
 * subject, sender and a link back already filled in.
 */
export function PlannerAddDialog({
  initial,
  items,
  heading = 'New work',
  onDone,
  onClose
}: {
  initial?: Partial<PlanItemInput>
  /** the Planner's items when the caller already has them (for suggestions) */
  items?: PlanItem[]
  heading?: string
  onDone: (result: { items: PlanItem[]; id: string }) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [project, setProject] = useState(initial?.project ?? '')
  const [requester, setRequester] = useState(initial?.requester ?? '')
  const [due, setDue] = useState(initial?.due ?? '')
  const [status, setStatus] = useState<PlanStatus>(initial?.status ?? 'now')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { projects, people } = usePlannerSuggestions(items)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.scribe.planner.add({
        ...initial,
        title: title.trim(),
        project: project.trim(),
        requester: requester.trim(),
        due,
        status,
        notes: notes.trim()
      })
      onDone(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it')
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose()
      }}
    >
      <form onSubmit={save}>
        <h3>{heading}</h3>
        <label className="pd-field">
          <span>What needs doing</span>
          <input
            className="text-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Enrollment funnel dashboard, or a data pull for Growth programs"
            autoFocus
            required
          />
        </label>
        <div className="pd-grid">
          <label className="pd-field">
            <span>Project</span>
            <input
              className="text-input"
              list="planner-add-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="Optional, groups related work"
            />
            <datalist id="planner-add-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          <label className="pd-field">
            <span>Asked by</span>
            <input
              className="text-input"
              list="planner-add-people"
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
              placeholder="Optional"
            />
            <datalist id="planner-add-people">
              {people.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="pd-grid">
          <label className="pd-field">
            <span>Column</span>
            <select
              className="text-input"
              value={status}
              onChange={(e) => setStatus(e.target.value as PlanStatus)}
            >
              {PLAN_COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.hint}
                </option>
              ))}
            </select>
          </label>
          <label className="pd-field">
            <span>Due date</span>
            <input
              className="text-input"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
        </div>
        <label className="pd-field">
          <span>Notes</span>
          <textarea
            className="text-input pd-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Optional: the ask, where the data lives, who to loop in"
          />
        </label>
        {error && <p className="field-note error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? 'Adding…' : 'Add to Planner'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
