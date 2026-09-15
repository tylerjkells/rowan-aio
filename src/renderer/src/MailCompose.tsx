import { useEffect, useMemo, useRef, useState } from 'react'
import type { PersonSummary } from '../../shared/types'

/**
 * The compose card: a floating panel in the corner of the mail view, the way
 * Gmail does it, so the list stays in reach while you write. The model can
 * draft the message from a one-line brief with Rowan's context on each
 * recipient; the result is filed to Outlook as a draft. Rowan never sends.
 */
export function MailCompose({
  initialTo,
  initialSubject,
  people,
  onClose,
  onFiled
}: {
  initialTo?: string[]
  initialSubject?: string
  people: PersonSummary[]
  onClose: () => void
  onFiled: () => void
}): React.JSX.Element {
  const [to, setTo] = useState((initialTo ?? []).join('; '))
  const [subject, setSubject] = useState(initialSubject ?? '')
  const [instruction, setInstruction] = useState('')
  const [body, setBody] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(false)
  const [signed, setSigned] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ;(initialTo?.length ? bodyRef : toRef).current?.focus()
    window.scribe.settings.get().then((s) => setSigned(!!s.mailSignatureHtml))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** colleagues with an address on file, for the To suggestions */
  const known = useMemo(
    () =>
      people
        .filter((p) => p.details?.email?.trim())
        .map((p) => ({ name: p.name, email: p.details!.email!.trim() })),
    [people]
  )

  /** "Sam Lee; kellst@rowan.edu, Priya" → addresses, names resolved via the directory */
  const recipients = useMemo(() => {
    const out: string[] = []
    for (const raw of to.split(/[;,\n]+/)) {
      const s = raw.trim()
      if (!s) continue
      const angle = s.match(/<([^>]+)>/)
      if (angle) {
        out.push(angle[1].trim())
        continue
      }
      if (s.includes('@')) {
        out.push(s)
        continue
      }
      const hit = known.find((k) => k.name.toLowerCase() === s.toLowerCase())
      if (hit) out.push(hit.email)
      else out.push(s)
    }
    return [...new Set(out)]
  }, [to, known])

  const unresolved = recipients.filter((r) => !r.includes('@'))

  async function draft(): Promise<void> {
    setDrafting(true)
    setError(null)
    const result = await window.scribe.mail.draftNew({
      to: recipients.filter((r) => r.includes('@')),
      subject,
      instruction
    })
    setDrafting(false)
    if (result.ok && result.body) {
      setBody(result.body)
      setQueued(false)
      bodyRef.current?.focus()
    } else setError(result.error ?? 'Could not draft that')
  }

  async function queue(): Promise<void> {
    if (!body.trim()) return
    if (recipients.length === 0) {
      setError('Add at least one recipient.')
      return
    }
    if (unresolved.length > 0) {
      setError(
        `No address on file for ${unresolved.join(', ')}. Type the address, or add it on their People page.`
      )
      return
    }
    setBusy(true)
    setError(null)
    const result = await window.scribe.mail.queueNew({ to: recipients, subject, body: body.trim() })
    setBusy(false)
    if (result.ok) {
      setQueued(true)
      onFiled()
    } else setError(result.error ?? 'Could not file the draft')
  }

  const title = subject.trim() || 'New message'

  return (
    <div className={`mailc-composer ${minimized ? 'min' : ''}`} role="dialog" aria-label="New message">
      <div className="mailc-composer-head" onDoubleClick={() => setMinimized((m) => !m)}>
        <span className="mailc-composer-title">{title}</span>
        <button
          className="mailc-ic"
          onClick={() => setMinimized((m) => !m)}
          title={minimized ? 'Expand' : 'Minimize'}
          aria-label={minimized ? 'Expand' : 'Minimize'}
        >
          {minimized ? '▴' : '▾'}
        </button>
        <button className="mailc-ic" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      {!minimized && (
        <>
          <label className="mailc-composer-field">
            <span>To</span>
            <input
              ref={toRef}
              className="mailc-composer-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Names from People, or addresses; separate with ;"
              list="mailc-people"
              aria-label="To"
              autoComplete="off"
            />
            <datalist id="mailc-people">
              {known.map((k) => (
                <option key={k.email} value={k.name}>
                  {k.email}
                </option>
              ))}
            </datalist>
          </label>
          <label className="mailc-composer-field">
            <span>Subject</span>
            <input
              className="mailc-composer-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Subject"
            />
          </label>
          <div className="mailc-ai-row mailc-composer-ai">
            <input
              className="text-input mailc-ai-input"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="What should it say? e.g. ask Sam for the Q3 numbers by Friday"
              onKeyDown={(e) => e.key === 'Enter' && !drafting && draft()}
              aria-label="What should it say"
            />
            <button className="btn mailc-ai-btn" onClick={draft} disabled={drafting || !instruction.trim()}>
              {drafting ? 'Drafting…' : body ? '✦ Redraft' : '✦ Draft it'}
            </button>
          </div>
          <textarea
            ref={bodyRef}
            className="mailc-composer-body"
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setQueued(false)
            }}
            placeholder="Write it, or brief Rowan above and let it draft."
            aria-label="Message"
          />
          {error && <p className="field-note error mailc-composer-note">{error}</p>}
          {queued && (
            <p className="field-note ok mailc-composer-note">
              Filed. It becomes a draft in Outlook within about a minute — review and send it
              from there.
            </p>
          )}
          <div className="mailc-composer-foot">
            <button
              type="button"
              className="btn btn-primary"
              onClick={queue}
              disabled={busy || queued || !body.trim()}
            >
              {busy ? 'Filing…' : queued ? 'Filed ✓' : 'Send to Outlook drafts'}
            </button>
            <span className="mailc-replybox-note">
              {signed && !queued ? 'Signature added when filed.' : ''}
            </span>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              {queued ? 'Done' : 'Discard'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
