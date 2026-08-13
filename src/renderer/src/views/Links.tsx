import { useEffect, useRef, useState } from 'react'
import type { LinkEntry } from '../../../shared/types'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Add/edit dialog
// ---------------------------------------------------------------------------

const thumbSrc = (l: LinkEntry): string | null =>
  l.thumb ? `scribe-media://thumb/${encodeURIComponent(l.thumb)}` : null

function LinkEditDialog({
  link,
  categories,
  onClose
}: {
  /** null = adding a new link */
  link: LinkEntry | null
  categories: string[]
  onClose: (changed: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(link?.name ?? '')
  const [url, setUrl] = useState(link?.url ?? '')
  const [category, setCategory] = useState(link?.category ?? '')
  const [note, setNote] = useState(link?.note ?? '')
  const [pinned, setPinned] = useState(link?.pinned ?? false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [thumb, setThumb] = useState(link?.thumb)
  const [thumbChanged, setThumbChanged] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)

  async function chooseThumb(): Promise<void> {
    if (!link) return
    const updated = await window.scribe.links.pickThumb(link.id)
    if (updated) {
      setThumb(updated.find((l) => l.id === link.id)?.thumb)
      setThumbChanged(true)
    }
  }

  async function captureThumb(): Promise<void> {
    if (!link || capturing) return
    setCapturing(true)
    setCaptureError(null)
    const r = await window.scribe.links.autoThumb(link.id)
    setCapturing(false)
    if (r.links) {
      setThumb(r.links.find((l) => l.id === link.id)?.thumb)
      setThumbChanged(true)
    } else {
      setCaptureError(r.error ?? 'Could not capture the page')
    }
  }

  async function removeThumb(): Promise<void> {
    if (!link) return
    await window.scribe.links.clearThumb(link.id)
    setThumb(undefined)
    setThumbChanged(true)
  }

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    // links pasted without a scheme should still open in a browser
    const fullUrl = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
    await window.scribe.links.save({
      id: link?.id,
      name: name.trim(),
      url: fullUrl,
      category: category.trim() || 'General',
      note: note.trim() || undefined,
      pinned
    })
    onClose(true)
  }

  async function remove(): Promise<void> {
    if (!link) return
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }
    await window.scribe.links.remove(link.id)
    onClose(true)
  }

  function cancel(): void {
    // thumbnail edits are applied immediately, so a cancel still refreshes
    onClose(thumbChanged)
  }

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={cancel}
      onClick={(e) => {
        if (e.target === ref.current) cancel()
      }}
    >
      <form onSubmit={save}>
        <h3>{link ? 'Edit link' : 'Add link'}</h3>
        <label className="pd-field">
          <span>Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="pd-field">
          <span>URL</span>
          <input
            className="text-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
          />
        </label>
        <div className="pd-grid">
          <label className="pd-field">
            <span>Category</span>
            <input
              className="text-input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="link-categories"
              placeholder="Dashboards, Data Centers, …"
            />
            <datalist id="link-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="pd-field">
            <span>Note</span>
            <input className="text-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <label className="pd-check">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin to the top (and to Today)
        </label>
        {link && (
          <div className="thumb-row">
            {thumb ? (
              <img
                className="thumb-preview"
                src={`scribe-media://thumb/${encodeURIComponent(thumb)}`}
                alt=""
              />
            ) : (
              <span className="thumb-none">No thumbnail</span>
            )}
            <button type="button" className="btn btn-ghost" onClick={chooseThumb}>
              {thumb ? 'Change image…' : 'Choose image…'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={captureThumb}
              disabled={capturing}
              title="Screenshot the page itself. Pages behind a login will capture the login screen — use Choose image for those."
            >
              {capturing ? 'Capturing…' : 'Auto-capture'}
            </button>
            {thumb && (
              <button type="button" className="btn btn-ghost" onClick={removeThumb}>
                Remove image
              </button>
            )}
          </div>
        )}
        {captureError && <p className="field-note error">{captureError}</p>}
        {!link && (
          <p className="thumb-hint">Save the link first, then edit it to add a card thumbnail.</p>
        )}
        <div className="confirm-actions">
          {link && (
            <button type="button" className="btn btn-danger pd-remove" onClick={remove}>
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          <button type="button" className="btn" onClick={cancel}>
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

// ---------------------------------------------------------------------------
// Links page
// ---------------------------------------------------------------------------

export function LinksView(): React.JSX.Element {
  const [links, setLinks] = useState<LinkEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<LinkEntry | 'new' | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'cards'>(
    () => (localStorage.getItem('linksLayout') as 'list' | 'cards') || 'list'
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('linksCollapsed') ?? '[]'))
    } catch {
      return new Set()
    }
  })

  function toggleSection(label: string): void {
    const next = new Set(collapsed)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setCollapsed(next)
    localStorage.setItem('linksCollapsed', JSON.stringify([...next]))
  }

  function load(): void {
    window.scribe.links.list().then((list) => {
      setLinks(list)
      setLoaded(true)
    })
  }
  useEffect(load, [])

  async function copy(link: LinkEntry): Promise<void> {
    await navigator.clipboard.writeText(link.url)
    setCopiedId(link.id)
    setTimeout(() => setCopiedId((c) => (c === link.id ? null : c)), 1200)
  }

  async function togglePin(link: LinkEntry): Promise<void> {
    setLinks(await window.scribe.links.togglePin(link.id))
  }

  const dialog =
    editing !== null ? (
      <LinkEditDialog
        link={editing === 'new' ? null : editing}
        categories={[...new Set(links.map((l) => l.category))].sort()}
        onClose={(changed) => {
          setEditing(null)
          if (changed) load()
        }}
      />
    ) : null

  if (loaded && links.length === 0) {
    return (
      <>
        {dialog}
        <div className="empty-state">
          <h2>No links yet</h2>
          <p>
            Collect your work links here — dashboards, data centers, tools — organized by category,
            with your favorites pinned on top and on Today.
          </p>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            Add link
          </button>
        </div>
      </>
    )
  }

  const row = (l: LinkEntry): React.JSX.Element => (
    <div key={l.id} className="link-row">
      <a className="link-main" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
        <span className="link-name">{l.name}</span>
        <span className="link-host">{hostOf(l.url)}</span>
        {l.note && <span className="link-note">{l.note}</span>}
      </a>
      <span className="link-tools">
        <button className="btn btn-ghost" onClick={() => copy(l)}>
          {copiedId === l.id ? 'Copied' : 'Copy'}
        </button>
        <button
          className={`btn btn-ghost link-pin ${l.pinned ? 'pinned' : ''}`}
          onClick={() => togglePin(l)}
          title={l.pinned ? 'Unpin' : 'Pin to the top (and to Today)'}
        >
          {l.pinned ? '★' : '☆'}
        </button>
        <button className="btn btn-ghost" onClick={() => setEditing(l)}>
          Edit
        </button>
      </span>
    </div>
  )

  function switchMode(m: 'list' | 'cards'): void {
    setMode(m)
    localStorage.setItem('linksLayout', m)
  }

  const card = (l: LinkEntry): React.JSX.Element => {
    const src = thumbSrc(l)
    return (
      <div key={l.id} className="link-card">
        <a className="link-card-media" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
          {src ? (
            <img src={src} alt="" loading="lazy" />
          ) : (
            <span className="link-card-letter" aria-hidden="true">
              {l.name.charAt(0).toUpperCase()}
            </span>
          )}
        </a>
        <div className="link-card-foot">
          <a className="link-card-name" href={l.url} target="_blank" rel="noreferrer" title={l.name}>
            {l.name}
          </a>
          <span className="link-card-tools">
            <button className="btn btn-ghost" onClick={() => copy(l)}>
              {copiedId === l.id ? 'Copied' : 'Copy'}
            </button>
            <button
              className={`btn btn-ghost link-pin ${l.pinned ? 'pinned' : ''}`}
              onClick={() => togglePin(l)}
              title={l.pinned ? 'Unpin' : 'Pin to the top (and to Today)'}
            >
              {l.pinned ? '★' : '☆'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(l)}>
              Edit
            </button>
          </span>
        </div>
      </div>
    )
  }

  const render = (items: LinkEntry[]): React.JSX.Element =>
    mode === 'cards' ? (
      <div className="link-cards">{items.map(card)}</div>
    ) : (
      <div className="link-list">{items.map(row)}</div>
    )

  const pinned = links.filter((l) => l.pinned).sort((a, b) => a.name.localeCompare(b.name))
  const categories = [...new Set(links.map((l) => l.category))].sort()

  return (
    <>
      {dialog}
      <div className="page-head">
        <h1>Links</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {links.length} {links.length === 1 ? 'link' : 'links'}
          </span>
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="Layout">
            <button
              className={mode === 'list' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'list'}
              onClick={() => switchMode('list')}
            >
              Compact
            </button>
            <button
              className={mode === 'cards' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'cards'}
              onClick={() => switchMode('cards')}
            >
              Cards
            </button>
          </div>
          <button className="btn" onClick={() => setEditing('new')}>
            Add link
          </button>
        </div>
      </div>
      {pinned.length > 0 && (
        <section className="section">
          <button className="cu-section-head" onClick={() => toggleSection('Pinned')}>
            <span className={`cu-section-chevron ${collapsed.has('Pinned') ? '' : 'open'}`}>›</span>
            <span className="card-subhead">Pinned · {pinned.length}</span>
          </button>
          {!collapsed.has('Pinned') && render(pinned)}
        </section>
      )}
      {categories.map((c) => {
        const inCategory = links
          .filter((l) => l.category === c)
          .sort((a, b) => a.name.localeCompare(b.name))
        return (
          <section className="section" key={c}>
            <button className="cu-section-head" onClick={() => toggleSection(c)}>
              <span className={`cu-section-chevron ${collapsed.has(c) ? '' : 'open'}`}>›</span>
              <span className="card-subhead">
                {c} · {inCategory.length}
              </span>
            </button>
            {!collapsed.has(c) && render(inCategory)}
          </section>
        )
      })}
    </>
  )
}
