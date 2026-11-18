import { useEffect, useMemo, useState } from 'react'
import type { DashboardEntry, LinkEntry } from '../../../src/shared/types'
import { useApp } from '../App'
import { loadDashboards, loadLinks, peek } from '../data'
import { Problem, Stale } from '../ui'

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** a link that leaves the app: Safari opens it, with its own sign-ins */
function OutRow({ name, url, sub }: { name: string; url: string; sub?: string }): React.JSX.Element {
  return (
    <a className="row" href={url} target="_blank" rel="noopener noreferrer">
      <span className="row-main">
        <span className="row-title">{name}</span>
        <span className="row-sub">{sub || host(url)}</span>
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </a>
  )
}

function grouped<T>(items: T[], key: (t: T) => string, pinned: (t: T) => boolean): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  const pins = items.filter(pinned)
  if (pins.length) out.push({ label: 'Pinned', items: pins })
  const by = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it) || 'Other'
    by.set(k, [...(by.get(k) ?? []), it])
  }
  for (const k of [...by.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)))) {
    out.push({ label: k, items: by.get(k) as T[] })
  }
  return out
}

function useList<T>(key: string, load: () => Promise<{ value: T[]; stale: boolean }>): { items: T[] | null; stale: boolean; error: string | null } {
  const { tick, fail } = useApp()
  const [items, setItems] = useState<T[] | null>(() => peek(key))
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    load()
      .then((r) => {
        if (!live) return
        setItems(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, fail])
  return { items, stale, error }
}

export function LinksView(): React.JSX.Element {
  const { hub } = useApp()
  const { items, stale, error } = useList<LinkEntry>('links', () => loadLinks(hub))
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = (items ?? []).filter((l) => words.every((w) => `${l.name} ${l.url} ${l.category} ${l.note ?? ''}`.toLowerCase().includes(w)))
    return grouped(shown, (l) => l.category, (l) => !!l.pinned && !words.length)
  }, [items, query])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Links</h1>
        <input className="search" type="search" placeholder="Search links" aria-label="Search links" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {items === null ? (
        <div className="group skeleton tall" />
      ) : groups.length === 0 ? (
        <p className="empty">{items.length ? 'No links match.' : 'No links yet. Add them in Rowan on your PC.'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h2 className="section-title">{g.label}</h2>
            <div className="group">
              {g.items.map((l) => (
                <OutRow key={`${g.label}-${l.id}`} name={l.name} url={l.url} sub={l.note ? `${host(l.url)} · ${l.note}` : undefined} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  )
}

export function DashboardsView(): React.JSX.Element {
  const { hub } = useApp()
  const { items, stale, error } = useList<DashboardEntry>('dashboards', () => loadDashboards(hub))
  const groups = useMemo(() => grouped(items ?? [], (d) => d.folder ?? '', (d) => !!d.pinned), [items])

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Dashboards</h1>
        <p className="lead">They open in Safari, which keeps its Tableau and Power BI sign-ins.</p>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {items === null ? (
        <div className="group skeleton tall" />
      ) : groups.length === 0 ? (
        <p className="empty">No dashboards yet. Add them in Rowan on your PC.</p>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h2 className="section-title">{g.label}</h2>
            <div className="group">
              {g.items.map((d) => (
                <OutRow key={`${g.label}-${d.id}`} name={d.name} url={d.url} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  )
}
