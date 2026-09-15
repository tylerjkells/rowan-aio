import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClickupDropdownField, ClickupList } from '../../shared/types'

/**
 * "Send to ClickUp" dialog: pick a list (last choice remembered), confirm the
 * task name/description/assignee/due, create the task. Used for a meeting
 * action item (prefilled, credited back to the meeting) and for a task typed
 * from scratch on the ClickUp page.
 *
 * If the chosen list has a "Requestor" dropdown custom field (the Data
 * Governance lists do, inherited from their folder), a Requestor picker
 * appears and the choice is written to that field on the new task.
 */

const REQUESTOR_KEY = 'clickupPushRequestor'

function findRequestor(fields: ClickupDropdownField[]): ClickupDropdownField | null {
  return fields.find((f) => f.name.trim().toLowerCase() === 'requestor') ?? null
}

export function ClickupPushDialog({
  task = '',
  owner = null,
  dueDate = null,
  listId: initialListId,
  meetingTitle,
  description: initialDescription,
  onDone,
  onClose
}: {
  task?: string
  owner?: string | null
  dueDate?: string | null
  /** start on this list instead of the remembered one */
  listId?: string
  /** the meeting this came from; omitted for a task typed from scratch */
  meetingTitle?: string
  /** starting description, for sources other than a meeting (e.g. an email) */
  description?: string
  /** called with the created task's URL */
  onDone: (url: string) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [lists, setLists] = useState<ClickupList[] | null>(null)
  const [listId, setListId] = useState(
    () => initialListId ?? localStorage.getItem('clickupPushList') ?? ''
  )
  const [name, setName] = useState(task)
  const [description, setDescription] = useState(
    initialDescription ?? (meetingTitle ? `From meeting: ${meetingTitle}` : '')
  )
  const [assignee, setAssignee] = useState(owner ?? '')
  const [due, setDue] = useState(dueDate ?? '')
  // the chosen list's Requestor field, if it has one; null while loading / absent
  const [requestorField, setRequestorField] = useState<ClickupDropdownField | null>(null)
  const [requestor, setRequestor] = useState(() => localStorage.getItem(REQUESTOR_KEY) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
    window.scribe.clickup
      .lists()
      .then(setLists)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load lists'))
  }, [])

  // custom fields follow the list: the Requestor picker only shows on lists
  // that have the field, and a remembered choice is kept only if it's an option
  useEffect(() => {
    setRequestorField(null)
    if (!listId) return
    let stale = false
    window.scribe.clickup
      .listFields(listId)
      .then((fields) => {
        if (stale) return
        const field = findRequestor(fields)
        setRequestorField(field)
        if (field && !field.options.some((o) => o.id === requestor)) setRequestor('')
      })
      .catch(() => {
        // fields unavailable: the task can still be created without one
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId])

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
      description: description.trim() || undefined,
      assignee: assignee.trim() || undefined,
      dueDate: due || null,
      customFields:
        requestorField && requestor ? [{ id: requestorField.id, value: requestor }] : undefined
    })
    setBusy(false)
    if (result.ok && result.url) {
      localStorage.setItem('clickupPushList', listId)
      if (requestorField) {
        if (requestor) localStorage.setItem(REQUESTOR_KEY, requestor)
        else localStorage.removeItem(REQUESTOR_KEY)
      }
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
        <h3>{meetingTitle ? 'Send to ClickUp' : 'New ClickUp task'}</h3>
        <label className="pd-field">
          <span>Task</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What needs doing"
            autoFocus={!task}
            required
          />
        </label>
        <label className="pd-field">
          <span>Description</span>
          <textarea
            className="text-input cu-push-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Optional detail"
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
        {requestorField && (
          <label className="pd-field">
            <span>{requestorField.name}</span>
            <select
              className="text-input"
              value={requestor}
              onChange={(e) => setRequestor(e.target.value)}
            >
              <option value="">None</option>
              {requestorField.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !listId || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
