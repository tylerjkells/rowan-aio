import { useEffect, useRef, useState } from 'react'

/**
 * "Before the meeting" notes on a calendar event: numbers to pull, questions
 * to raise, links to have open. Stored per occurrence, shown wherever the
 * event appears, and never fed into the AI summary.
 */
export function PrepDialog({
  eventId,
  title,
  when,
  initial,
  onSaved,
  onClose
}: {
  eventId: string
  title: string
  /** human-readable date/time line under the title */
  when: string
  initial: string
  onSaved: (notes: Record<string, string>) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function save(): Promise<void> {
    if (saving) return
    setSaving(true)
    const notes = await window.scribe.prep.set(eventId, text)
    setSaving(false)
    onSaved(notes)
    onClose()
  }

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h3>Before the meeting</h3>
        <p className="complete-task-name">
          {title} <span className="prep-when">· {when}</span>
        </p>
        <label className="pd-field">
          <span>What to have ready (just for you — not part of any summary)</span>
          <textarea
            className="text-input pd-notes prep-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Pull enrollment numbers for fall\nBring up the dashboard timeline'}
            rows={6}
            autoFocus
          />
        </label>
        <div className="confirm-actions">
          {initial && (
            <button
              type="button"
              className="btn btn-ghost pd-remove"
              onClick={async () => {
                const notes = await window.scribe.prep.set(eventId, '')
                onSaved(notes)
                onClose()
              }}
            >
              Clear note
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}
