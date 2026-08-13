import { useEffect, useRef, useState } from 'react'

/**
 * Checking off a ClickUp task prompts for a short closing note first — the
 * team's practice is a comment on every completion. The note posts to the
 * task's thread, then the task moves to done.
 */
export function ClickupCompleteDialog({
  task,
  onDone,
  onClose
}: {
  task: { id: string; listId: string; name: string; url?: string }
  /** the task was completed — remove it from the caller's list */
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function complete(withNote: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    if (withNote && note.trim()) {
      const c = await window.scribe.clickup.comment(task.id, note.trim(), task.name, task.url)
      if (!c.ok) {
        setError(c.error ?? 'Could not post the comment')
        setBusy(false)
        return
      }
    }
    const r = await window.scribe.clickup.complete(task.id, task.listId, task.name, task.url)
    setBusy(false)
    if (r.ok) onDone()
    else setError(r.error ?? 'Could not complete the task')
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
      <form
        onSubmit={(e) => {
          e.preventDefault()
          complete(true)
        }}
      >
        <h3>Mark done</h3>
        <p className="complete-task-name">{task.name}</p>
        <label className="pd-field">
          <span>Closing note (posted as a ClickUp comment)</span>
          <textarea
            className="text-input pd-notes"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What closed it out?"
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                complete(true)
              }
            }}
          />
        </label>
        {error && <p className="field-note error">{error}</p>}
        <div className="confirm-actions">
          <button
            type="button"
            className="btn btn-ghost pd-remove"
            onClick={() => complete(false)}
            disabled={busy}
          >
            Done without comment
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Completing…' : 'Comment & complete'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
