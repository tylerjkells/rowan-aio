import { useEffect, useRef, useState } from 'react'
import type { ToolboxData, ToolboxGuide } from '../../../shared/types'
import { BackIcon, useConfirm } from '../ui'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Guide reader: converted Word HTML with click-to-copy on every block, so
// LOD calcs and formulas lift straight out of the steps.
// ---------------------------------------------------------------------------

function GuideReader({ guide, onBack }: { guide: ToolboxGuide; onBack: () => void }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.scribe.toolbox.guideHtml(guide.id).then(setHtml)
  }, [guide.id])

  async function copyBlock(e: React.MouseEvent): Promise<void> {
    const block = (e.target as HTMLElement).closest('p, pre, li, td, h1, h2, h3, h4')
    if (!block || !bodyRef.current?.contains(block)) return
    const text = (block as HTMLElement).innerText.trim()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="main-narrow">
      <div className="detail-head">
        <button className="back-link" onClick={onBack}>
          <BackIcon /> All guides
        </button>
        <h1>{guide.title}</h1>
        <div className="detail-meta">
          <span>{guide.source}</span>
          <span className={`guide-copy-hint ${copied ? 'flash' : ''}`}>
            {copied ? 'Copied ✓' : 'Click any step to copy it'}
          </span>
        </div>
      </div>
      {html === null ? (
        <p className="today-quiet">Loading…</p>
      ) : (
        <div
          ref={bodyRef}
          className="guide-body"
          onClick={copyBlock}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbox page
// ---------------------------------------------------------------------------

type ToolboxTab = 'guides' | 'images' | 'files'

export function ToolboxView(): React.JSX.Element {
  const [data, setData] = useState<ToolboxData | null>(null)
  const [tab, setTab] = useState<ToolboxTab>(
    () => (localStorage.getItem('toolboxTab') as ToolboxTab) || 'guides'
  )
  const [reading, setReading] = useState<ToolboxGuide | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDialog, confirm] = useConfirm()

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

  if (reading) return <GuideReader guide={reading} onBack={() => setReading(null)} />
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
        </div>
      </div>
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
    </>
  )
}
