import { useEffect, useRef, useState } from 'react'
import type { MailMessage } from '../../shared/types'

/**
 * Draft a reply to one message: the model writes it with Rowan's context
 * behind it (who the sender is, what they owe you, what you owe them), you
 * edit it, and it goes to Outlook as a draft. Rowan never sends.
 */
export function MailReplyDialog({
  message,
  onClose
}: {
  message: MailMessage
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [instruction, setInstruction] = useState('')
  const [body, setBody] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [queued, setQueued] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function draft(): Promise<void> {
    setDrafting(true)
    setError(null)
    const result = await window.scribe.mail.draftReply(message.id, instruction || undefined)
    setDrafting(false)
    if (result.ok && result.body) setBody(result.body)
    else setError(result.error ?? 'Could not draft a reply')
  }

  async function queue(): Promise<void> {
    if (!body.trim()) return
    setBusy(true)
    setError(null)
    const result = await window.scribe.mail.queueDraft({ messageId: message.id, body: body.trim() })
    setBusy(false)
    if (result.ok) setQueued(true)
    else setError(result.error ?? 'Could not file the draft')
  }

  return (
    <dialog
      ref={ref}
      className="confirm mail-reply"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy && !drafting) onClose()
      }}
    >
      <h3>Reply to {message.fromName ?? message.from}</h3>
      <p className="opt-desc">RE: {message.subject}</p>

      <label className="pd-field">
        <span>How should this be answered? (optional)</span>
        <input
          className="text-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. push it to next week, or say yes but ask for the numbers first"
          onKeyDown={(e) => e.key === 'Enter' && !drafting && draft()}
        />
      </label>

      <div className="mail-reply-actions">
        <button className="btn" onClick={draft} disabled={drafting}>
          {drafting ? 'Drafting…' : body ? 'Redraft' : 'Draft a reply'}
        </button>
        <span className="opt-desc">
          The draft is written with what Rowan knows about this person behind it.
        </span>
      </div>

      <label className="pd-field">
        <span>Draft</span>
        <textarea
          className="text-input mail-reply-body"
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            setQueued(false)
          }}
          rows={14}
          placeholder="Draft a reply above, or write one yourself."
        />
      </label>

      {error && <p className="field-note error">{error}</p>}
      {queued && (
        <p className="field-note ok">
          Filed. It becomes a draft in Outlook within about a minute — review and send it
          from there.
        </p>
      )}

      <div className="confirm-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {queued ? 'Done' : 'Cancel'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={queue}
          disabled={busy || queued || !body.trim()}
        >
          {busy ? 'Filing…' : queued ? 'Filed ✓' : 'Send to Outlook drafts'}
        </button>
      </div>
    </dialog>
  )
}
