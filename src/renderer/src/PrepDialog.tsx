import { useEffect, useRef, useState } from 'react'
import type { PrepEntry } from '../../shared/types'

/**
 * Read-only rendering of a prep note's content — the text plus its
 * attachments. Images render inline; other files open in their own app.
 */
export function PrepBody({
  eventId,
  entry
}: {
  eventId: string
  entry: PrepEntry
}): React.JSX.Element {
  return (
    <>
      {entry.text && <span className="prep-text">{entry.text}</span>}
      {entry.files.length > 0 && (
        <span className="prep-files">
          {entry.files.map((f) =>
            f.image ? (
              <button
                key={f.id}
                className="prep-thumb"
                title={`${f.name} — open`}
                onClick={() => window.scribe.prep.openFile(eventId, f.id)}
              >
                <img src={`scribe-media://prep/${f.file}`} alt={f.name} />
              </button>
            ) : (
              <button
                key={f.id}
                className="prep-file-chip"
                title="Open"
                onClick={() => window.scribe.prep.openFile(eventId, f.id)}
              >
                📄 {f.name}
              </button>
            )
          )}
        </span>
      )}
    </>
  )
}

/**
 * "Before the meeting" notes on a calendar event: numbers to pull, questions
 * to raise, screenshots and files to have handy. Stored per occurrence,
 * shown wherever the event appears, and never fed into the AI summary.
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
  initial: PrepEntry | undefined
  onSaved: (notes: Record<string, PrepEntry>) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(initial?.text ?? '')
  const [files, setFiles] = useState(initial?.files ?? [])
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

  async function attach(): Promise<void> {
    const notes = await window.scribe.prep.addFiles(eventId)
    if (notes) {
      onSaved(notes)
      setFiles(notes[eventId]?.files ?? [])
    }
  }

  async function removeFile(fileId: string): Promise<void> {
    const notes = await window.scribe.prep.removeFile(eventId, fileId)
    onSaved(notes)
    setFiles(notes[eventId]?.files ?? [])
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
        {files.length > 0 && (
          <div className="prep-files prep-files-edit">
            {files.map((f) => (
              <span key={f.id} className={f.image ? 'prep-thumb-wrap' : 'prep-file-chip'}>
                {f.image ? (
                  <img src={`scribe-media://prep/${f.file}`} alt={f.name} title={f.name} />
                ) : (
                  <>📄 {f.name}</>
                )}
                <button
                  type="button"
                  className="prep-file-x"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost pd-remove" onClick={attach}>
            Attach files…
          </button>
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
