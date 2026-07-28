import { useEffect, useMemo, useState } from 'react'
import type { BulkCandidate, BulkProgress, BulkScan } from '../../../shared/types'

/** ISO instant -> the yyyy-mm-dd a <input type="date"> wants, in local time */
function isoToInputDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** imported meetings sit at midday local, same as a single pasted transcript */
function inputDateToIso(value: string): string {
  const d = new Date(`${value}T12:00:00`)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

const SKIP_NOTE: Record<NonNullable<BulkCandidate['skip']>, string> = {
  empty: 'too short',
  duplicate: 'already imported'
}

export function BulkImportView({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [scan, setScan] = useState<BulkScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dates, setDates] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => window.scribe.meetings.onBulkProgress(setProgress), [])

  // a run started earlier is still going: rejoin it instead of offering the
  // picker (this page can be navigated away from mid-import)
  useEffect(() => {
    window.scribe.meetings.bulkStatus().then((p) => {
      if (p) setProgress((current) => current ?? p)
    })
  }, [])

  async function pick(kind: 'zip' | 'folder'): Promise<void> {
    setError(null)
    setScanning(true)
    try {
      const result = await window.scribe.meetings.bulkPick(kind)
      if (!result) return
      setScan(result)
      setSelected(new Set(result.candidates.filter((c) => !c.skip).map((c) => c.path)))
      setDates(
        Object.fromEntries(result.candidates.map((c) => [c.path, isoToInputDate(c.dateIso)]))
      )
      setProgress(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that source.')
    } finally {
      setScanning(false)
    }
  }

  const candidates = scan?.candidates ?? []
  const counts = useMemo(() => {
    let duplicate = 0
    let empty = 0
    let weakDate = 0
    for (const c of candidates) {
      if (c.skip === 'duplicate') duplicate++
      else if (c.skip === 'empty') empty++
      if (c.dateSource === 'file' && !c.skip) weakDate++
    }
    return { duplicate, empty, weakDate }
  }, [candidates])

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function start(): Promise<void> {
    if (selected.size === 0 || starting) return
    setStarting(true)
    setError(null)
    try {
      await window.scribe.meetings.bulkRun(
        candidates
          .filter((c) => selected.has(c.path))
          .map((c) => ({
            path: c.path,
            title: c.title,
            dateIso: dates[c.path] ? inputDateToIso(dates[c.path]) : c.dateIso,
            attendees: c.attendees
          }))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the import.')
      setStarting(false)
    }
  }

  // --- running / finished -------------------------------------------------
  if (progress) {
    const finished = progress.phase === 'done' || progress.phase === 'cancelled'
    const percent =
      progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      <>
        <div className="card-subhead">{finished ? 'Import finished' : 'Importing…'}</div>
        {finished ? (
          <p className="hint import-hint">
            {progress.imported.length} meeting{progress.imported.length === 1 ? '' : 's'} added
            {progress.phase === 'cancelled' ? ' before you cancelled' : ''}. They are in the
            library now — summaries land as each one finishes.
          </p>
        ) : (
          <p className="hint import-hint">
            {progress.phase === 'creating'
              ? 'Reading transcripts into the library.'
              : 'Summarizing one at a time, so the API is never hammered.'}{' '}
            You can leave this page; it keeps running.
          </p>
        )}

        <div className="setup-progress" aria-live="polite">
          {progress.current || `${progress.done} of ${progress.total}`}
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <p className="count-note">
          {progress.done} of {progress.total}
          {progress.failed.length > 0 && ` · ${progress.failed.length} had problems`}
        </p>

        {progress.failed.length > 0 && (
          <ul className="point-list">
            {progress.failed.slice(0, 8).map((f, i) => (
              <li key={i}>
                {f.title}: {f.error}
              </li>
            ))}
          </ul>
        )}

        <div className="import-actions">
          {finished ? (
            <button className="btn btn-primary" onClick={onDone}>
              Go to the library
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => window.scribe.meetings.bulkCancel()}>
              Stop after this one
            </button>
          )}
        </div>
      </>
    )
  }

  // --- picking ------------------------------------------------------------
  if (!scan) {
    return (
      <>
        <p className="hint import-hint">
          Bring in a whole pile of meetings at once — a Notion export, or any folder of{' '}
          <code>.md</code> / <code>.txt</code> transcripts. In Notion: open the database (or the
          page holding your meetings) → <strong>⋯</strong> → <strong>Export</strong> → format{' '}
          <strong>Markdown &amp; CSV</strong>, include subpages, then hand the downloaded{' '}
          <code>.zip</code> to the button below. Titles, dates, and attendees are read from each
          page&rsquo;s properties; nothing is written until you have reviewed the list.
        </p>
        <div className="import-actions">
          <button className="btn btn-primary" onClick={() => pick('zip')} disabled={scanning}>
            {scanning ? 'Reading…' : 'Choose a Notion export (.zip)…'}
          </button>
          <button className="btn" onClick={() => pick('folder')} disabled={scanning}>
            Choose a folder…
          </button>
        </div>
        {error && (
          <p className="field-note error" role="alert">
            {error}
          </p>
        )}
      </>
    )
  }

  // --- review -------------------------------------------------------------
  const importable = candidates.filter((c) => !c.skip)
  return (
    <>
      <p className="hint import-hint">
        {candidates.length} page{candidates.length === 1 ? '' : 's'} found in{' '}
        <strong>{scan.sourceLabel}</strong>
        {counts.duplicate > 0 && ` · ${counts.duplicate} already in your library`}
        {counts.empty > 0 && ` · ${counts.empty} too short to be a meeting`}
        {counts.weakDate > 0 &&
          ` · ${counts.weakDate} with no date in the page — check those rows`}
        . Each one is summarized like a recording, so expect roughly a cent or two per meeting on
        your Claude key.
      </p>

      <div className="bulk-tools">
        <span className="count-note">
          {selected.size} of {candidates.length} selected
        </span>
        <button
          className="link-btn"
          onClick={() => setSelected(new Set(importable.map((c) => c.path)))}
        >
          Select importable
        </button>
        <button className="link-btn" onClick={() => setSelected(new Set())}>
          Select none
        </button>
        <button
          className="link-btn"
          onClick={() => {
            setScan(null)
            setSelected(new Set())
          }}
        >
          Pick a different source
        </button>
      </div>

      <div className="bulk-list" role="list">
        {candidates.map((c) => (
          <div className={`bulk-row ${c.skip ? 'skipped' : ''}`} role="listitem" key={c.path}>
            <input
              type="checkbox"
              className="rollup-check"
              checked={selected.has(c.path)}
              onChange={() => toggle(c.path)}
              aria-label={`Import ${c.title}`}
            />
            <span className="bulk-body">
              <span className="bulk-title" title={c.relPath}>
                {c.title}
              </span>
              <span className="bulk-meta">
                {c.words.toLocaleString()} words
                {c.skip && <span className="badge badge-quiet">{SKIP_NOTE[c.skip]}</span>}
                {!c.skip && c.dateSource === 'file' && (
                  <span className="badge badge-error">no date found</span>
                )}
                {c.attendees.length > 0 && <span>{c.attendees.join(', ')}</span>}
              </span>
            </span>
            <input
              className="text-input bulk-date"
              type="date"
              value={dates[c.path] ?? ''}
              onChange={(e) => setDates((prev) => ({ ...prev, [c.path]: e.target.value }))}
              aria-label={`Date for ${c.title}`}
            />
          </div>
        ))}
      </div>

      <div className="import-actions">
        <span className="count-note" />
        <button className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          onClick={start}
          disabled={selected.size === 0 || starting}
        >
          {starting ? 'Starting…' : `Import ${selected.size} meeting${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
      {error && (
        <p className="field-note error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
