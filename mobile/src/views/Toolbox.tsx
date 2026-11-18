import { useEffect, useRef, useState } from 'react'
import type { ToolboxData, ToolboxImage } from '../../../src/shared/types'
import { useApp } from '../App'
import { attachment, loadToolbox, peek } from '../data'
import { BackIcon, ChevronIcon, Problem, Spinner, Stale } from '../ui'

type Tab = 'guides' | 'images' | 'queries' | 'files'

function useToolbox(): { data: ToolboxData | null; stale: boolean; error: string | null } {
  const { hub, fail, tick } = useApp()
  const [data, setData] = useState<ToolboxData | null>(() => peek('toolbox'))
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadToolbox(hub)
      .then((r) => {
        if (!live) return
        setData(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])
  return { data, stale, error }
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** an image tile that fetches its picture only once it scrolls into view */
function ImageTile({ img }: { img: ToolboxImage }): React.JSX.Element {
  const { hub } = useApp()
  const ref = useRef<HTMLAnchorElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let made: string | null = null
    let cancelled = false
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      attachment(hub, `toolbox/images/${img.file}`)
        .then((blob) => {
          if (cancelled) return
          if (!blob) setMissing(true)
          else {
            made = URL.createObjectURL(blob)
            setUrl(made)
          }
        })
        .catch(() => !cancelled && setMissing(true))
    })
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
      if (made) URL.revokeObjectURL(made)
    }
  }, [hub, img.file])
  return (
    <a ref={ref} className="tile" href={url ?? undefined} target="_blank" rel="noopener noreferrer" aria-label={img.name}>
      <span className="tile-pic">{url ? <img src={url} alt="" /> : missing ? <span className="fine">Not synced</span> : <Spinner />}</span>
      <span className="tile-name">{img.name}</span>
    </a>
  )
}

export function ToolboxView(): React.JSX.Element {
  const { hub, go, fail } = useApp()
  const { data, stale, error } = useToolbox()
  const [tab, setTab] = useState<Tab>('guides')
  const [copied, setCopied] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const counts: Record<Tab, number> = {
    guides: data?.guides.length ?? 0,
    images: data?.images.length ?? 0,
    queries: data?.queries.length ?? 0,
    files: data?.files.length ?? 0
  }
  const tabs = (['guides', 'images', 'queries', 'files'] as Tab[]).filter((t) => counts[t] > 0 || t === 'guides')
  const current = tabs.includes(tab) ? tab : 'guides'

  async function openFile(id: string, file: string): Promise<void> {
    setOpening(id)
    setFileError(null)
    try {
      const blob = await attachment(hub, `toolbox/files/${file}`)
      if (!blob) throw new Error('That file isn’t in the hub yet. Open Rowan on your PC so it syncs.')
      window.open(URL.createObjectURL(blob), '_blank')
    } catch (err) {
      setFileError(fail(err))
    } finally {
      setOpening(null)
    }
  }

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Toolbox</h1>
        {tabs.length > 1 && (
          <div className="segmented" role="tablist">
            {tabs.map((t) => (
              <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
                <span className="seg-count">{counts[t]}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      <Stale show={stale} />
      <Problem error={error ?? fileError} />
      {!data ? (
        <div className="group skeleton tall" />
      ) : current === 'guides' ? (
        data.guides.length === 0 ? (
          <p className="empty">No guides yet. Add Word guides in Rowan on your PC.</p>
        ) : (
          <div className="group">
            {data.guides.map((g) => (
              <button key={g.id} className="row" onClick={() => go(`/guide/${encodeURIComponent(g.id)}`)}>
                <span className="row-main">
                  <span className="row-title">{g.title}</span>
                </span>
                <ChevronIcon size={18} />
              </button>
            ))}
          </div>
        )
      ) : current === 'images' ? (
        <div className="tiles">
          {data.images.map((img) => (
            <ImageTile key={img.id} img={img} />
          ))}
        </div>
      ) : current === 'queries' ? (
        data.queries.map((q) => (
          <section key={q.id} className="query">
            <div className="section-head">
              <h2 className="section-title">{q.name}</h2>
              <button
                className="link"
                onClick={() =>
                  navigator.clipboard.writeText(q.sql).then(() => {
                    setCopied(q.id)
                    setTimeout(() => setCopied(null), 1500)
                  })
                }
              >
                {copied === q.id ? 'Copied' : 'Copy'}
              </button>
            </div>
            {q.note && <p className="fine left">{q.note}</p>}
            <pre className="sql">{q.sql}</pre>
          </section>
        ))
      ) : (
        <div className="group">
          {data.files.map((f) => (
            <button key={f.id} className="row" disabled={opening === f.id} onClick={() => void openFile(f.id, f.file)}>
              <span className="row-main">
                <span className="row-title">{f.name}</span>
                <span className="row-sub">{size(f.bytes)}</span>
              </span>
              {opening === f.id ? <Spinner /> : <ChevronIcon size={18} />}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** a guide's page is the Word document converted on the PC; keep it to plain content */
function clean(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const v = attr.value.trim().toLowerCase()
      if (attr.name.startsWith('on') || ((attr.name === 'href' || attr.name === 'src') && v.startsWith('javascript:'))) {
        el.removeAttribute(attr.name)
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
  })
  return doc.body.innerHTML
}

export function GuideView({ id }: { id: string }): React.JSX.Element {
  const { hub, back, fail } = useApp()
  const { data } = useToolbox()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const guide = data?.guides.find((g) => g.id === id)

  useEffect(() => {
    let live = true
    attachment(hub, `toolbox/guides/${id}/content.html`)
      .then(async (blob) => {
        if (!live) return
        if (!blob) setError('This guide isn’t in the hub yet. Open Rowan on your PC so it syncs.')
        else setHtml(clean(await blob.text()))
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, id, fail])

  return (
    <>
      <nav className="navbar">
        <button className="nav-back" onClick={() => back('/toolbox')}>
          <BackIcon size={22} /> Toolbox
        </button>
      </nav>
      <Problem error={error} />
      <article className="meeting">
        <header className="meeting-head">
          <h1 className="title">{guide?.title ?? 'Guide'}</h1>
        </header>
        {html === null ? !error && <div className="group skeleton tall" /> : <div className="guide" dangerouslySetInnerHTML={{ __html: html }} />}
      </article>
    </>
  )
}
