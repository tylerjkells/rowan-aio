import { useEffect, useRef, useState } from 'react'
import type { ToolboxData, ToolboxGuide, ToolboxQuery } from '../../../shared/types'
import { BackIcon, useConfirm } from '../ui'

// ---------------------------------------------------------------------------
// SQL query editor dialog
// ---------------------------------------------------------------------------

function QueryEditDialog({
  query,
  onClose
}: {
  /** null = adding a new query */
  query: ToolboxQuery | null
  onClose: (data: ToolboxData | null) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(query?.name ?? '')
  const [note, setNote] = useState(query?.note ?? '')
  const [sql, setSql] = useState(query?.sql ?? '')

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim() || !sql.trim()) return
    onClose(await window.scribe.toolbox.saveQuery({ id: query?.id, name, sql, note }))
  }

  return (
    <dialog
      ref={ref}
      className="confirm person-edit sql-edit"
      onClose={() => onClose(null)}
      onClick={(e) => {
        if (e.target === ref.current) onClose(null)
      }}
    >
      <form onSubmit={save}>
        <h3>{query ? 'Edit query' : 'Add query'}</h3>
        <div className="pd-grid">
          <label className="pd-field">
            <span>Name</span>
            <input
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus={!query}
              required
            />
          </label>
          <label className="pd-field">
            <span>Note (optional)</span>
            <input className="text-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <label className="pd-field">
          <span>SQL</span>
          <textarea
            className="text-input sql-input"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={14}
            spellCheck={false}
            required
          />
        </label>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Guide reader: converted Word HTML with click-to-copy on every block, so
// LOD calcs and formulas lift straight out of the steps.
// ---------------------------------------------------------------------------

function GuideReader({
  guide,
  onBack,
  onSaved
}: {
  guide: ToolboxGuide
  onBack: () => void
  onSaved: (data: ToolboxData) => void
}): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(guide.title)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.scribe.toolbox.guideHtml(guide.id).then(setHtml)
  }, [guide.id])

  async function copyBlock(e: React.MouseEvent): Promise<void> {
    if (editing) return
    const block = (e.target as HTMLElement).closest('p, pre, li, td, h1, h2, h3, h4')
    if (!block || !bodyRef.current?.contains(block)) return
    const text = (block as HTMLElement).innerText.trim()
    if (!text) return
    await navigator.clipboard.writeText(text)
    // feedback lands where the eye is: the block itself flashes…
    block.classList.add('guide-flash')
    setTimeout(() => block.classList.remove('guide-flash'), 900)
    // …and a toast floats at the bottom of the viewport
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  async function save(): Promise<void> {
    if (saving) return
    setSaving(true)
    const edited = bodyRef.current?.innerHTML
    const data = await window.scribe.toolbox.updateGuide(guide.id, {
      title: titleDraft.trim() || guide.title,
      html: edited
    })
    if (edited) setHtml(edited)
    setSaving(false)
    setEditing(false)
    onSaved(data)
  }

  async function cancelEdit(): Promise<void> {
    setEditing(false)
    setTitleDraft(guide.title)
    // re-fetch so any in-place edits are discarded
    setHtml(await window.scribe.toolbox.guideHtml(guide.id))
  }

  return (
    <div className="main-narrow">
      <div className="detail-head">
        <button className="back-link" onClick={onBack}>
          <BackIcon /> All guides
        </button>
        {editing ? (
          <input
            className="text-input guide-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            aria-label="Guide title"
          />
        ) : (
          <h1>{guide.title}</h1>
        )}
        <div className="detail-meta">
          <span>{guide.source}</span>
          {!editing && <span className="guide-copy-hint">Click any step to copy it</span>}
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn" onClick={cancelEdit} disabled={saving}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      </div>
      {html === null ? (
        <p className="today-quiet">Loading…</p>
      ) : (
        <div
          ref={bodyRef}
          className={`guide-body ${editing ? 'editing' : ''}`}
          contentEditable={editing}
          suppressContentEditableWarning
          onClick={copyBlock}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {copied && <div className="copy-toast">Copied ✓</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbox page
// ---------------------------------------------------------------------------

type ToolboxTab = 'guides' | 'images' | 'files' | 'queries'

export function ToolboxView(): React.JSX.Element {
  const [data, setData] = useState<ToolboxData | null>(null)
  const [tab, setTab] = useState<ToolboxTab>(
    () => (localStorage.getItem('toolboxTab') as ToolboxTab) || 'guides'
  )
  const [reading, setReading] = useState<ToolboxGuide | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingQuery, setEditingQuery] = useState<ToolboxQuery | 'new' | null>(null)
  const [openQueryId, setOpenQueryId] = useState<string | null>(null)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [confirmDialog, confirm] = useConfirm()

  // bulk upload: each .sql/.txt becomes a query named after the file
  async function importQueries(): Promise<void> {
    const r = await window.scribe.toolbox.importQueries()
    if (!r) return
    setData(r.data)
    const parts = [
      r.added > 0 ? `${r.added} added` : '',
      r.updated > 0 ? `${r.updated} updated` : ''
    ].filter(Boolean)
    setImportNote(parts.length > 0 ? `${parts.join(', ')} ✓` : 'Files were empty')
    setTimeout(() => setImportNote(null), 3000)
  }

  async function copyQuery(q: ToolboxQuery): Promise<void> {
    await navigator.clipboard.writeText(q.sql)
    setCopiedId(q.id)
    setTimeout(() => setCopiedId((c) => (c === q.id ? null : c)), 1200)
  }

  useEffect(() => {
    window.scribe.toolbox.get().then(setData)
  }, [])

  function switchTab(t: ToolboxTab): void {
    setTab(t)
    localStorage.setItem('toolboxTab', t)
  }

  async function addGuide(): Promise<void> {
    setError(null)
    const r = await window.scribe.toolbox.addGuide()
    if (r && 'error' in r) setError(r.error)
    else if (r) setData(r)
  }

  async function copyImage(img: { id: string; file: string }): Promise<void> {
    setError(null)
    try {
      if (img.file.endsWith('.svg')) {
        // SVG copies as markup (Tableau wants text there)
        const r = await window.scribe.toolbox.copyImage(img.id)
        if (!r.ok) throw new Error(r.error ?? 'Could not copy the SVG')
      } else {
        // decode through Chromium (handles every format the grid can show)
        // and hand the clipboard a PNG, transparency intact
        const el = new Image()
        el.crossOrigin = 'anonymous'
        await new Promise<void>((resolve, reject) => {
          el.onload = () => resolve()
          el.onerror = () => reject(new Error('Could not load the image'))
          el.src = `scribe-media://toolbox/${encodeURIComponent(img.file)}`
        })
        const canvas = document.createElement('canvas')
        canvas.width = el.naturalWidth
        canvas.height = el.naturalHeight
        canvas.getContext('2d')!.drawImage(el, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))),
            'image/png'
          )
        )
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      }
      setCopiedId(img.id)
      setTimeout(() => setCopiedId((c) => (c === img.id ? null : c)), 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy the image')
    }
  }

  async function removeWithConfirm(kind: string, name: string, run: () => Promise<ToolboxData>): Promise<void> {
    const sure = await confirm({
      title: `Remove ${kind} "${name}"?`,
      body: 'It is deleted from the Toolbox (your original file elsewhere is untouched).',
      confirmLabel: 'Remove',
      danger: true
    })
    if (sure) setData(await run())
  }

  if (reading)
    return (
      <GuideReader
        guide={reading}
        onBack={() => setReading(null)}
        onSaved={(next) => {
          setData(next)
          setReading(next.guides.find((g) => g.id === reading.id) ?? null)
        }}
      />
    )
  if (!data) return <></>

  return (
    <>
      {confirmDialog}
      <div className="page-head">
        <h1>Toolbox</h1>
        <div className="page-head-tools">
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="Toolbox section">
            <button
              className={tab === 'guides' ? 'active' : ''}
              role="radio"
              aria-checked={tab === 'guides'}
              onClick={() => switchTab('guides')}
            >
              Guides
            </button>
            <button
              className={tab === 'images' ? 'active' : ''}
              role="radio"
              aria-checked={tab === 'images'}
              onClick={() => switchTab('images')}
            >
              Images
            </button>
            <button
              className={tab === 'files' ? 'active' : ''}
              role="radio"
              aria-checked={tab === 'files'}
              onClick={() => switchTab('files')}
            >
              Files
            </button>
            <button
              className={tab === 'queries' ? 'active' : ''}
              role="radio"
              aria-checked={tab === 'queries'}
              onClick={() => switchTab('queries')}
            >
              SQL
            </button>
          </div>
          {tab === 'guides' && (
            <button className="btn" onClick={addGuide}>
              Add guide
            </button>
          )}
          {tab === 'images' && (
            <button
              className="btn"
              onClick={async () => {
                const r = await window.scribe.toolbox.addImages()
                if (r) setData(r)
              }}
            >
              Add images
            </button>
          )}
          {tab === 'files' && (
            <button
              className="btn"
              onClick={async () => {
                const r = await window.scribe.toolbox.addFiles()
                if (r) setData(r)
              }}
            >
              Add files
            </button>
          )}
          {tab === 'queries' && (
            <>
              <button className="btn" onClick={importQueries}>
                {importNote ?? 'Upload .sql files'}
              </button>
              <button className="btn" onClick={() => setEditingQuery('new')}>
                Add query
              </button>
            </>
          )}
        </div>
      </div>
      {editingQuery !== null && (
        <QueryEditDialog
          query={editingQuery === 'new' ? null : editingQuery}
          onClose={(next) => {
            setEditingQuery(null)
            if (next) setData(next)
          }}
        />
      )}
      {error && <p className="field-note error">{error}</p>}

      {tab === 'guides' &&
        (data.guides.length === 0 ? (
          <div className="empty-state">
            <h2>No guides yet</h2>
            <p>
              Upload the Word docs you have Claude write — step-by-step guides for Tableau
              dashboards, Excel reports, anything — and read them here with one-click copying of
              every step, formula, and LOD calc.
            </p>
            <button className="btn btn-primary" onClick={addGuide}>
              Add guide
            </button>
          </div>
        ) : (
          <div className="guide-list">
            {data.guides.map((g) => (
              <div key={g.id} className="guide-row">
                <button className="guide-open" onClick={() => setReading(g)}>
                  <span className="guide-title">{g.title}</span>
                  <span className="guide-sub">
                    {g.source} · added {new Date(g.addedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    removeWithConfirm('guide', g.title, () =>
                      window.scribe.toolbox.removeGuide(g.id)
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ))}

      {tab === 'images' &&
        (data.images.length === 0 ? (
          <div className="empty-state">
            <h2>No images yet</h2>
            <p>
              Keep the images you reuse across dashboards — Rowan logos, home icons, download
              buttons — and copy any of them to the clipboard, ready to paste into Tableau.
            </p>
            <button
              className="btn btn-primary"
              onClick={async () => {
                const r = await window.scribe.toolbox.addImages()
                if (r) setData(r)
              }}
            >
              Add images
            </button>
          </div>
        ) : (
          <div className="tbx-image-grid">
            {data.images.map((img) => (
              <div key={img.id} className="tbx-image-card">
                <button
                  className="tbx-image-media"
                  onClick={() => copyImage(img)}
                  title="Copy to clipboard"
                >
                  <img src={`scribe-media://toolbox/${encodeURIComponent(img.file)}`} alt={img.name} loading="lazy" />
                  {copiedId === img.id && <span className="tbx-copied">Copied ✓</span>}
                </button>
                <div className="tbx-image-foot">
                  <span className="tbx-image-name" title={img.name}>
                    {img.name}
                  </span>
                  <span className="link-card-tools">
                    <button className="btn btn-ghost" onClick={() => copyImage(img)}>
                      {copiedId === img.id ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() =>
                        removeWithConfirm('image', img.name, () =>
                          window.scribe.toolbox.removeImage(img.id)
                        )
                      }
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === 'files' &&
        (data.files.length === 0 ? (
          <div className="empty-state">
            <h2>No files yet</h2>
            <p>
              Store your starting templates here — the Tableau workbook you begin every dashboard
              from, report shells, anything — and save a fresh copy out whenever you need one.
            </p>
            <button
              className="btn btn-primary"
              onClick={async () => {
                const r = await window.scribe.toolbox.addFiles()
                if (r) setData(r)
              }}
            >
              Add files
            </button>
          </div>
        ) : (
          <div className="guide-list">
            {data.files.map((f) => (
              <div key={f.id} className="guide-row">
                <div className="guide-open tbx-file-info">
                  <span className="guide-title">{f.name}</span>
                  <span className="guide-sub">
                    {formatBytes(f.bytes)} · added {new Date(f.addedAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await window.scribe.toolbox.saveFileCopy(f.id)
                    if (r.error) setError(r.error)
                  }}
                >
                  Save a copy…
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    removeWithConfirm('file', f.name, () => window.scribe.toolbox.removeFile(f.id))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ))}

      {tab === 'queries' &&
        (data.queries.length === 0 ? (
          <div className="empty-state">
            <h2>No queries yet</h2>
            <p>
              Save the SQL you keep reaching for — extracts, joins, the directory export — named
              and noted, with the whole statement one click from your clipboard.
            </p>
            <button className="btn btn-primary" onClick={() => setEditingQuery('new')}>
              Add query
            </button>
            <button className="btn" onClick={importQueries}>
              {importNote ?? 'Upload .sql files'}
            </button>
          </div>
        ) : (
          <div className="guide-list">
            {data.queries.map((q) => {
              const open = openQueryId === q.id
              return (
                <div key={q.id} className={`guide-row sql-row ${open ? 'open' : ''}`}>
                  <div className="sql-row-head">
                    <button
                      className="guide-open"
                      onClick={() => setOpenQueryId(open ? null : q.id)}
                      title={open ? 'Collapse' : 'Show the SQL'}
                    >
                      <span className="guide-title">{q.name}</span>
                      {q.note && <span className="guide-sub">{q.note}</span>}
                    </button>
                    <button className="btn btn-ghost" onClick={() => copyQuery(q)}>
                      {copiedId === q.id ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setEditingQuery(q)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() =>
                        removeWithConfirm('query', q.name, () =>
                          window.scribe.toolbox.removeQuery(q.id)
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                  {open && <pre className="sql-block">{q.sql}</pre>}
                </div>
              )
            })}
          </div>
        ))}
    </>
  )
}
