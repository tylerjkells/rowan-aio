import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClickupList } from '../../shared/types'

/**
 * "Send to ClickUp" dialog for one meeting action item: pick a list (last
 * choice remembered), confirm the task name/assignee/due, create the task.
 */
export function ClickupPushDialog({
  task,
  owner,
  dueDate,
  meetingTitle,
  onDone,
  onClose
}: {
  task: string
  owner: string | null
  dueDate: string | null
  meetingTitle: string
  /** called with the created task's URL */
  onDone: (url: string) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [lists, setLists] = useState<ClickupList[] | null>(null)
  const [listId, setListId] = useState(() => localStorage.getItem('clickupPushList') ?? '')
  const [name, setName] = useState(task)
  const [assignee, setAssignee] = useState(owner ?? '')
  const [due, setDue] = useState(dueDate ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
    window.scribe.clickup
      .lists()
      .then(setLists)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load lists'))
  }, [])

  // lists grouped by folder for the picker
  const groups = useMemo(() => {
    const byFolder = new Map<string, ClickupList[]>()
    for (const l of lists ?? []) {
      const key = l.folder ?? l.space
      const arr = byFolder.get(key) ?? []
      arr.push(l)
      byFolder.set(key, arr)
    }
    return [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [lists])

  async function push(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!listId || !name.trim() || busy) return
    setBusy(true)
    setError(null)
    const result = await window.scribe.clickup.push({
      listId,
      name: name.trim(),
      description: `From MeetingScribe: "${meetingTitle}"`,
      assignee: assignee.trim() || undefined,
      dueDate: due || null
    })
    setBusy(false)
    if (result.ok && result.url) {
      localStorage.setItem('clickupPushList', listId)
      onDone(result.url)
    } else {
      setError(result.error ?? 'ClickUp rejected the task')
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
      <form onSubmit={push}>
        <h3>Send to ClickUp</h3>
        <label className="pd-field">
          <span>Task</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="pd-field">
          <span>List</span>
          <select
            className="text-input"
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            required
          >
            <option value="" disabled>
              {lists ? 'Choose a list…' : 'Loading lists…'}
            </option>
            {groups.map(([folder, ls]) => (
              <optgroup key={folder} label={folder}>
                {ls.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="pd-grid">
          <label className="pd-field">
            <span>Assignee (name or email)</span>
            <input
              className="text-input"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="matched to a workspace member"
            />
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
        {error && <p className="field-note error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !listId}>
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
