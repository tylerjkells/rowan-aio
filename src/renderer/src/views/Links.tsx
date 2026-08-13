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

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={() => onClose(false)}
      onClick={(e) => {
        if (e.target === ref.current) onClose(false)
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
        <div className="confirm-actions">
          {link && (
            <button type="button" className="btn btn-danger pd-remove" onClick={remove}>
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          <button type="button" className="btn" onClick={() => onClose(false)}>
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
          {!collapsed.has('Pinned') && <div className="link-list">{pinned.map(row)}</div>}
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
            {!collapsed.has(c) && <div className="link-list">{inCategory.map(row)}</div>}
          </section>
        )
      })}
    </>
  )
}
