import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DashboardEntry, LinkEntry } from '../../../shared/types'
import { addressFromEmbedCode, tableauEmbed, tableauName } from '../tableau'

// must match DASHBOARD_PARTITION in main/dashboards.ts (main enforces it)
const PARTITION = 'persist:dashboards'
const LAST_KEY = 'dashboardsCurrent'
const FOLDED_KEY = 'dashboardsFolded'
const RAIL_KEY = 'dashboardsRail'
/** dashboards kept loaded at once, most recent first; an older one reloads when reopened */
const KEEP_LOADED = 5

/** what a dashboard loads: a Tableau view on its own unless you asked for the full site */
const srcOf = (d: DashboardEntry): string => (!d.full && tableauEmbed(d.url)) || d.url

interface FrameState {
  loading: boolean
  error?: string
  canBack: boolean
}

/** one run of the sidebar: Pinned, a folder, or the unfiled rest */
interface Section {
  key: string
  /** null = no heading, when there's nothing to tell apart */
  label: string | null
  foldable: boolean
  items: DashboardEntry[]
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked: forgotten next time
  }
}

function storedFolded(): Set<string> {
  try {
    return new Set(JSON.parse(stored(FOLDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function sectionsOf(list: DashboardEntry[]): Section[] {
  const out: Section[] = []
  const pinned = list.filter((d) => d.pinned)
  if (pinned.length > 0) out.push({ key: 'pinned', label: 'Pinned', foldable: false, items: pinned })
  const folders = [...new Set(list.flatMap((d) => (d.folder ? [d.folder] : [])))].sort((a, b) =>
    a.localeCompare(b)
  )
  for (const f of folders) {
    out.push({ key: `f:${f}`, label: f, foldable: true, items: list.filter((d) => d.folder === f) })
  }
  const loose = list.filter((d) => !d.folder)
  if (loose.length > 0) {
    out.push({
      key: 'other',
      label: folders.length > 0 ? 'Other' : pinned.length > 0 ? 'All dashboards' : null,
      foldable: folders.length > 0,
      items: loose
    })
  }
  return out
}

/** dashboards whose name or folder holds every typed word, names starting with it first */
function search(list: DashboardEntry[], query: string): DashboardEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = list.filter((d) => {
    const hay = `${d.name} ${d.folder ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  const lead = (d: DashboardEntry): number => (d.name.toLowerCase().startsWith(words[0]) ? 0 : 1)
  return hits.sort((a, b) => lead(a) - lead(b))
}

const icon = (paths: React.ReactNode): React.JSX.Element => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths}
  </svg>
)

const STAR = <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />

/**
 * Dashboards embedded in the app. Each one is a <webview> on a shared,
 * persistent session, so a sign-in sticks across restarts. A sidebar files
 * them in folders, with Pinned on top and a search (Ctrl+K, even from inside
 * a dashboard). The shell keeps this view mounted once opened, and the last
 * few dashboards visited stay loaded, so switching back is instant. A Tableau
 * view loads in its embed mode, just the dashboard, unless it's switched to
 * the full site.
 */
export function DashboardsView(): React.JSX.Element {
  const [list, setList] = useState<DashboardEntry[] | null>(null)
  const [current, setCurrent] = useState<string | null>(() => stored(LAST_KEY))
  // dashboards whose webview exists, least recently shown first
  const [opened, setOpened] = useState<string[]>([])
  const [frames, setFrames] = useState<Record<string, FrameState>>({})
  const [editing, setEditing] = useState<DashboardEntry | 'new' | null>(null)
  const [railHidden, setRailHidden] = useState(() => stored(RAIL_KEY) === 'hidden')
  // the hidden sidebar shown over the dashboard for a search
  const [peek, setPeek] = useState(false)
  // bumped to put the cursor in the search; focused before the next keystroke lands
  const [findAsk, setFindAsk] = useState(0)
  const [folded, setFolded] = useState<Set<string>>(storedFolded)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const views = useRef(new Map<string, HTMLWebViewElement>())
  const rootRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.scribe.dashboards.list().then(setList)
  }, [])

  const active = list?.find((d) => d.id === current) ?? list?.[0] ?? null

  useEffect(() => {
    if (!active) return
    setOpened((ids) => [...ids.filter((id) => id !== active.id), active.id].slice(-KEEP_LOADED))
    store(LAST_KEY, active.id)
  }, [active])

  // Ctrl+K, from the app or from inside a dashboard, while this tab is showing
  useEffect(() => {
    const find = (): boolean => {
      if (!rootRef.current?.getClientRects().length) return false
      setPeek(true)
      setFindAsk((n) => n + 1)
      return true
    }
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && find()) {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.scribe.dashboards.onFind(find)
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [])

  useLayoutEffect(() => {
    if (!findAsk) return
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [findAsk])

  const sections = useMemo(() => sectionsOf(list ?? []), [list])
  const results = useMemo(() => (query.trim() ? search(list ?? [], query) : []), [list, query])

  function frameState(id: string, patch: Partial<FrameState>): void {
    setFrames((all) => ({
      ...all,
      [id]: { ...(all[id] ?? { loading: false, canBack: false }), ...patch }
    }))
  }

  function applyList(next: DashboardEntry[]): void {
    setList(next)
    setOpened((ids) => ids.filter((id) => next.some((d) => d.id === id)))
  }

  function focusDashboard(id: string): void {
    requestAnimationFrame(() => views.current.get(id)?.focus())
  }

  function open(d: DashboardEntry): void {
    setCurrent(d.id)
    setQuery('')
    setPeek(false)
    focusDashboard(d.id)
  }

  function toggleFolder(key: string): void {
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      store(FOLDED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  function setRail(hidden: boolean): void {
    setRailHidden(hidden)
    setPeek(false)
    store(RAIL_KEY, hidden ? 'hidden' : 'shown')
  }

  async function togglePin(d: DashboardEntry): Promise<void> {
    applyList(await window.scribe.dashboards.save({ ...d, pinned: !d.pinned }))
  }

  if (!list) return <></>

  const view = active ? views.current.get(active.id) : undefined
  const state = active ? frames[active.id] : undefined
  // a Tableau view can show on its own or with the site around it
  const embeddable = !!active && tableauEmbed(active.url) !== null
  const embedded = embeddable && !active?.full
  const showRail = list.length > 0 && (!railHidden || peek)

  const row = (d: DashboardEntry, opts: { sub?: string; lit?: boolean } = {}): React.JSX.Element => (
    <div
      key={d.id}
      className={`dash-item ${d.id === active?.id ? 'active' : ''} ${opts.lit ? 'lit' : ''} ${d.pinned ? 'pinned' : ''}`}
      ref={opts.lit ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
    >
      <button
        className="dash-item-open"
        onClick={() => open(d)}
        onDoubleClick={() => setEditing(d)}
        title={d.url}
        aria-current={d.id === active?.id ? 'page' : undefined}
      >
        <span className="dash-item-name">{d.name}</span>
        {opts.sub && <span className="dash-item-sub">{opts.sub}</span>}
      </button>
      <button
        className="dash-star"
        onClick={() => togglePin(d)}
        aria-pressed={!!d.pinned}
        title={d.pinned ? 'Unpin' : 'Pin to the top'}
        aria-label={d.pinned ? `Unpin ${d.name}` : `Pin ${d.name}`}
      >
        {icon(STAR)}
      </button>
    </div>
  )

  return (
    <div ref={rootRef} className={`dash ${railHidden ? 'rail-hidden' : ''} ${list.length === 0 ? 'empty' : ''}`}>
      {showRail && (
        <aside
          ref={railRef}
          className={`dash-rail ${railHidden ? 'peek' : ''}`}
          aria-label="Dashboards"
          // focusable so a click on its blank space keeps a peek open
          tabIndex={-1}
          onBlur={(e) => {
            if (peek && !railRef.current?.contains(e.relatedTarget as Node | null)) {
              setPeek(false)
              setQuery('')
            }
          }}
        >
          <div className="dash-search">
            {icon(
              <>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </>
            )}
            <input
              ref={searchRef}
              type="search"
              placeholder="Find a dashboard"
              aria-label="Find a dashboard"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHi(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHi((h) => Math.min(h + 1, results.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHi((h) => Math.max(h - 1, 0))
                } else if (e.key === 'Enter') {
                  const d = results[hi]
                  if (d) open(d)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuery('')
                  if (peek) {
                    setPeek(false)
                    if (active) focusDashboard(active.id)
                  }
                }
              }}
            />
            {!query && <kbd>Ctrl K</kbd>}
          </div>

          <nav className="dash-list">
            {query.trim() ? (
              results.length > 0 ? (
                results.map((d, i) => row(d, { sub: d.folder, lit: i === hi }))
              ) : (
                <p className="dash-note">No dashboard called that.</p>
              )
            ) : (
              sections.map((s) => {
                const isFolded = s.foldable && folded.has(s.key)
                return (
                  <div key={s.key} className="dash-section">
                    {s.label &&
                      (s.foldable ? (
                        <button
                          className={`dash-folder ${isFolded && s.items.some((d) => d.id === active?.id) ? 'holds-active' : ''}`}
                          onClick={() => toggleFolder(s.key)}
                          aria-expanded={!isFolded}
                        >
                          <span className={`dash-chev ${isFolded ? '' : 'open'}`}>›</span>
                          <span className="dash-folder-name">{s.label}</span>
                          {isFolded && <span className="dash-folder-n">{s.items.length}</span>}
                        </button>
                      ) : (
                        <div className="dash-section-head">{s.label}</div>
                      ))}
                    {!isFolded && s.items.map((d) => row(d))}
                  </div>
                )
              })
            )}
          </nav>

          <div className="dash-rail-foot">
            <button className="dash-add" onClick={() => setEditing('new')}>
              + Add dashboard
            </button>
            <button
              className="dash-icon"
              onClick={() => setRail(!railHidden)}
              title={railHidden ? 'Keep the sidebar open' : 'Hide the sidebar'}
              aria-label={railHidden ? 'Keep the sidebar open' : 'Hide the sidebar'}
            >
              {icon(<path d={railHidden ? 'M13 17l5-5-5-5M6 17l5-5-5-5' : 'M11 17l-5-5 5-5M18 17l-5-5 5-5'} />)}
            </button>
          </div>
        </aside>
      )}

      <div className="dash-main">
        {active && (
          <div className="dash-bar">
            {railHidden && (
              <button
                className="dash-icon"
                onClick={() => setRail(false)}
                title="Show the sidebar"
                aria-label="Show the sidebar"
              >
                {icon(
                  <>
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M9 4v16" />
                  </>
                )}
              </button>
            )}
            <button
              className="dash-title"
              onClick={() => {
                setPeek(true)
                setFindAsk((n) => n + 1)
              }}
              title="Find another dashboard (Ctrl+K)"
            >
              {active.folder && <span className="dash-title-folder">{active.folder} /</span>}
              <span className="dash-title-name">{active.name}</span>
            </button>
            <div className="dash-tools">
              {(!embedded || state?.canBack) && (
                <button
                  className="dash-icon"
                  onClick={() => view?.goBack()}
                  disabled={!state?.canBack}
                  title="Back"
                  aria-label="Back"
                >
                  {icon(<path d="M15 18l-6-6 6-6" />)}
                </button>
              )}
              <button
                className="dash-icon"
                onClick={() => {
                  frameState(active.id, { error: undefined })
                  view?.reload()
                }}
                title="Reload"
                aria-label="Reload"
              >
                {icon(
                  <>
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </>
                )}
              </button>
              {!embedded && (
                <button
                  className="dash-icon"
                  onClick={() => {
                    frameState(active.id, { error: undefined })
                    view?.loadURL(srcOf(active)).catch(() => {})
                  }}
                  title="Back to the dashboard's own address"
                  aria-label="Home"
                >
                  {icon(
                    <>
                      <path d="M3 11l9-8 9 8" />
                      <path d="M5 10v10h14V10" />
                    </>
                  )}
                </button>
              )}
              {embeddable && (
                <button
                  className="btn btn-ghost dash-mode"
                  onClick={async () => {
                    frameState(active.id, { error: undefined })
                    applyList(await window.scribe.dashboards.save({ ...active, full: !active.full }))
                  }}
                  title={
                    embedded
                      ? 'Show Tableau’s own pages around it, to browse other views, subscribe or sign in'
                      : 'Show just the dashboard, without Tableau’s menus'
                  }
                >
                  {embedded ? 'Full site' : 'Just the dashboard'}
                </button>
              )}
              <button
                className="dash-icon"
                onClick={() => window.scribe.dashboards.openExternal(active.url)}
                title="Open in your browser"
                aria-label="Open in your browser"
              >
                {icon(
                  <>
                    <path d="M14 4h6v6" />
                    <path d="M10 14L20 4" />
                    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                  </>
                )}
              </button>
              <button className="btn btn-ghost dash-edit" onClick={() => setEditing(active)}>
                Edit
              </button>
            </div>
          </div>
        )}

        <div className="dash-body">
          {!active && (
            <div className="empty-state">
              <h2>Keep your dashboards here</h2>
              <p>
                Add a dashboard&apos;s address (Tableau, Power BI, Grafana, ClickUp, anything on the
                web) and it opens right inside Rowan. A Tableau view shows on its own, without
                Tableau&apos;s menus around it. Sign in once; it remembers you. File them in folders
                as the list grows, and press Ctrl+K to jump to one by name.
              </p>
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                Add a dashboard
              </button>
            </div>
          )}
          {list
            .filter((d) => opened.includes(d.id))
            .map((d) => (
              <DashboardFrame
                key={d.id}
                dashboard={d}
                visible={d.id === active?.id}
                onState={(patch) => frameState(d.id, patch)}
                register={(el) => {
                  if (el) views.current.set(d.id, el)
                  else views.current.delete(d.id)
                }}
              />
            ))}
          {active && state?.loading && <div className="dash-loading" aria-hidden="true" />}
          {active && state?.error && (
            <div className="dash-error" role="alert">
              <div>
                <h2>{active.name} didn&apos;t load</h2>
                <p>{state.error}</p>
                <div className="dash-error-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      frameState(active.id, { error: undefined })
                      view?.loadURL(srcOf(active)).catch(() => {})
                    }}
                  >
                    Try again
                  </button>
                  <button
                    className="btn"
                    onClick={() => window.scribe.dashboards.openExternal(active.url)}
                  >
                    Open in browser
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <DashboardDialog
          dashboard={editing === 'new' ? null : editing}
          list={list}
          onDone={(next, selectId) => {
            setEditing(null)
            if (!next) return
            applyList(next)
            if (!selectId) return
            setCurrent(selectId)
            // show where it was filed
            const folder = next.find((d) => d.id === selectId)?.folder
            const key = folder ? `f:${folder}` : 'other'
            if (folded.has(key)) toggleFolder(key)
          }}
        />
      )}
    </div>
  )
}

function DashboardFrame({
  dashboard,
  visible,
  onState,
  register
}: {
  dashboard: DashboardEntry
  visible: boolean
  onState: (patch: Partial<FrameState>) => void
  register: (el: HTMLWebViewElement | null) => void
}): React.JSX.Element {
  const ref = useRef<HTMLWebViewElement>(null)
  // the listeners attach once; the latest callbacks are read through refs
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  const registerRef = useRef(register)
  registerRef.current = register

  useEffect(() => {
    const el = ref.current
    if (!el) return
    registerRef.current(el)
    const canBack = (): boolean => {
      try {
        return el.canGoBack()
      } catch {
        return false // not attached yet
      }
    }
    const start = (): void => onStateRef.current({ loading: true, error: undefined })
    const stop = (): void => onStateRef.current({ loading: false, canBack: canBack() })
    const nav = (): void => onStateRef.current({ canBack: canBack() })
    const fail = (e: Event): void => {
      const ev = e as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean }
      // -3 is a load aborted by a redirect or a new navigation, not a failure
      if (!ev.isMainFrame || ev.errorCode === -3) return
      onStateRef.current({
        loading: false,
        error: ev.errorDescription
          ? `The page reported: ${ev.errorDescription}. Check the address, or your connection or VPN.`
          : 'Check the address, or your connection or VPN.'
      })
    }
    el.addEventListener('did-start-loading', start)
    el.addEventListener('did-stop-loading', stop)
    el.addEventListener('did-navigate', nav)
    el.addEventListener('did-navigate-in-page', nav)
    el.addEventListener('did-fail-load', fail)
    return () => {
      el.removeEventListener('did-start-loading', start)
      el.removeEventListener('did-stop-loading', stop)
      el.removeEventListener('did-navigate', nav)
      el.removeEventListener('did-navigate-in-page', nav)
      el.removeEventListener('did-fail-load', fail)
      registerRef.current(null)
    }
  }, [])

  return (
    <div className="dash-frame" style={visible ? undefined : { display: 'none' }}>
      {/* React drops boolean attributes it does not know, so allowpopups goes
          as a string; its presence is what lets sign-in popups open */}
      <webview
        ref={ref}
        src={srcOf(dashboard)}
        partition={PARTITION}
        allowpopups={'true' as unknown as boolean}
      />
    </div>
  )
}

function DashboardDialog({
  dashboard,
  list,
  onDone
}: {
  /** null = adding */
  dashboard: DashboardEntry | null
  list: DashboardEntry[]
  /** next list when something changed; selectId opens that dashboard */
  onDone: (next: DashboardEntry[] | null, selectId?: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(dashboard?.name ?? '')
  const [url, setUrl] = useState(dashboard?.url ?? '')
  const [folder, setFolder] = useState(dashboard?.folder ?? '')
  const [links, setLinks] = useState<LinkEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  // the name the dialog filled in itself, so a new address can replace it
  const [autoName, setAutoName] = useState<string | null>(null)
  const [fromCode, setFromCode] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [signedOut, setSignedOut] = useState(false)
  // moves and sign-outs apply immediately; a cancel still hands back the list
  const [changed, setChanged] = useState<DashboardEntry[] | null>(null)

  useEffect(() => {
    ref.current?.showModal()
    if (!dashboard) {
      // dashboards first, since the Links tab is where most of them live today
      window.scribe.links.list().then((all) =>
        setLinks(
          [...all]
            .filter((l) => /^https?:/i.test(l.url))
            .sort((a, b) => Number(/dashboard/i.test(b.category)) - Number(/dashboard/i.test(a.category)))
        )
      )
    }
  }, [dashboard])

  /** a typed or pasted address; Tableau embed code turns into the address inside it */
  function changeAddress(raw: string): void {
    const inCode = addressFromEmbedCode(raw)
    const next = inCode ?? raw
    setUrl(next)
    setFromCode(inCode !== null)
    setError(inCode === null && /<[a-z]/i.test(raw) ? 'No dashboard address in that code.' : null)
    // a Tableau view names itself, unless a name is already typed
    if (!name.trim() || name === autoName) {
      const auto = tableauName(next) ?? ''
      setName(auto)
      setAutoName(auto)
    }
  }

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!url.trim()) return
    try {
      const next = await window.scribe.dashboards.save({ id: dashboard?.id, name, url, folder })
      onDone(next, dashboard?.id ?? next[next.length - 1]?.id)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
          : 'Could not save'
      )
    }
  }

  async function move(delta: -1 | 1): Promise<void> {
    if (!dashboard) return
    setChanged(await window.scribe.dashboards.move(dashboard.id, delta))
  }

  async function remove(): Promise<void> {
    if (!dashboard) return
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }
    onDone(await window.scribe.dashboards.remove(dashboard.id))
  }

  const folders = [...new Set(list.flatMap((d) => (d.folder ? [d.folder] : [])))].sort((a, b) =>
    a.localeCompare(b)
  )
  // moves stay inside the folder it's saved in
  const siblings = (changed ?? list).filter((d) => (d.folder ?? '') === (dashboard?.folder ?? ''))
  const pos = dashboard ? siblings.findIndex((d) => d.id === dashboard.id) : -1

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={() => onDone(changed)}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close()
      }}
    >
      <form onSubmit={save}>
        <h3>{dashboard ? 'Edit dashboard' : 'Add a dashboard'}</h3>
        {!dashboard && links.length > 0 && (
          <label className="pd-field">
            <span>From your Links</span>
            <select
              className="text-input"
              value=""
              onChange={(e) => {
                const l = links.find((x) => x.id === e.target.value)
                if (!l) return
                setName(l.name)
                setAutoName(null)
                setUrl(l.url)
                setFromCode(false)
              }}
            >
              <option value="">Pick a link…</option>
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.category}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="pd-field">
          <span>Address</span>
          <input
            className="text-input"
            value={url}
            onChange={(e) => changeAddress(e.target.value)}
            onPaste={(e) => {
              // a one-line field drops embed code's line breaks, so read the paste whole
              const text = e.clipboardData.getData('text/plain')
              if (!/<[a-z]/i.test(text)) return
              e.preventDefault()
              changeAddress(text)
            }}
            placeholder="Paste a link, or Tableau’s embed code"
            autoFocus
            required
          />
          {fromCode && <span className="field-note ok">Took the dashboard’s address from the embed code.</span>}
        </label>
        <label className="pd-field">
          <span>Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setAutoName(null)
            }}
            placeholder="Shown in the sidebar"
          />
        </label>
        <label className="pd-field">
          <span>Folder</span>
          <input
            className="text-input"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={folders.length > 0 ? 'Pick one or type a new folder' : 'e.g. Enrollment (optional)'}
            list="dash-folders"
          />
          <datalist id="dash-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        {error && <p className="field-note error">{error}</p>}
        {dashboard && (
          <div className="dash-dialog-row">
            <button type="button" className="btn btn-ghost" onClick={() => move(-1)} disabled={pos <= 0}>
              ↑ Move up
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => move(1)}
              disabled={pos < 0 || pos >= siblings.length - 1}
            >
              ↓ Move down
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await window.scribe.dashboards.signOut()
                setSignedOut(true)
              }}
              disabled={signedOut}
              title="Forget the sign-ins of every dashboard, to switch accounts. Dashboards ask you to sign in again when they reload."
            >
              {signedOut ? 'Signed out' : 'Sign out of all dashboards'}
            </button>
          </div>
        )}
        <div className="confirm-actions">
          {dashboard && (
            <button type="button" className="btn btn-danger pd-remove" onClick={remove}>
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {dashboard ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
