import { useState } from 'react'
import type { Meeting } from '../../../shared/types'
import { BulkImportView } from './BulkImport'

function todayLocalIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ImportView({
  onDone,
  onBulkDone,
  onCancel
}: {
  onDone: (m: Meeting) => void
  onBulkDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [source, setSource] = useState<'paste' | 'bulk'>('paste')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayLocalIso())
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function doImport(): Promise<void> {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      // anchor imported meetings at midday local time on the chosen date
      const iso = new Date(`${date}T12:00:00`).toISOString()
      const meeting = await window.scribe.meetings.import(title, iso, text)
      onDone(meeting)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
      setBusy(false)
    }
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  const modeToggle = (
    <div className="mode-toggle import-source" role="radiogroup" aria-label="Import source">
      <button
        className={source === 'paste' ? 'active' : ''}
        role="radio"
        aria-checked={source === 'paste'}
        onClick={() => setSource('paste')}
      >
        Paste one
      </button>
      <button
        className={source === 'bulk' ? 'active' : ''}
        role="radio"
        aria-checked={source === 'bulk'}
        onClick={() => setSource('bulk')}
      >
        Bulk import
      </button>
    </div>
  )

  if (source === 'bulk') {
    return (
      <div className="main-narrow">
        <div className="page-head">
          <h1>Import transcripts</h1>
        </div>
        {modeToggle}
        <BulkImportView onDone={onBulkDone} />
      </div>
    )
  }

  return (
    <div className="main-narrow">
      <div className="page-head">
        <h1>Import a transcript</h1>
      </div>
      {modeToggle}
      <p className="hint import-hint">
        Paste a transcript from Notion or anywhere else. Timestamps like 0:00 and speaker names are
        picked up when present. The meeting gets summarized just like a recording, minus audio
        playback. Got a stack of them? Switch to <strong>Bulk import</strong>.
      </p>

      <div className="import-form">
        <div className="import-meta-row">
          <div className="import-field">
            <label className="field-label" htmlFor="import-title">
              Title (optional, AI fills it in otherwise)
            </label>
            <input
              id="import-title"
              className="text-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q3 planning sync"
            />
          </div>
          <div className="import-field import-date">
            <label className="field-label" htmlFor="import-date">
              Meeting date
            </label>
            <input
              id="import-date"
              className="text-input"
              type="date"
              value={date}
              max={todayLocalIso()}
              onChange={(e) => setDate(e.target.value)}
              onClick={(e) => {
                // the field body should open the calendar, not just the tiny icon
                try {
                  ;(e.target as HTMLInputElement).showPicker()
                } catch {
                  // picker already open or not permitted; typing still works
                }
              }}
            />
          </div>
        </div>

        <label className="field-label" htmlFor="import-text">
          Transcript
        </label>
        <textarea
          id="import-text"
          className="text-input import-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'0:00 Okay, let’s get started…\n0:14 David: First item is the dashboard migration…'}
          spellCheck={false}
        />
        <div className="import-actions">
          <span className="count-note">{words > 0 ? `${words.toLocaleString()} words` : ''}</span>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={doImport} disabled={busy || !text.trim()}>
            {busy ? 'Importing…' : 'Import and summarize'}
          </button>
        </div>
        {error && (
          <p className="field-note error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
