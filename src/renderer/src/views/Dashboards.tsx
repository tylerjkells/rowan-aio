import { useEffect, useRef, useState } from 'react'
import type { DashboardEntry, LinkEntry } from '../../../shared/types'

// must match DASHBOARD_PARTITION in main/dashboards.ts (main enforces it)
const PARTITION = 'persist:dashboards'
const LAST_KEY = 'dashboardsCurrent'

interface FrameState {
  loading: boolean
  error?: string
  canBack: boolean
}

function lastOpened(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function rememberOpened(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // storage blocked: the first dashboard opens next time
  }
}

/**
 * Dashboards embedded in the app. Each one is a <webview> on a shared,
 * persistent session, so a sign-in sticks across restarts. The shell keeps
 * this view mounted once opened, and every dashboard visited stays loaded,
 * so switching back is instant.
 */
export function DashboardsView(): React.JSX.Element {
  const [list, setList] = useState<DashboardEntry[] | null>(null)
  const [current, setCurrent] = useState<string | null>(lastOpened)
  // dashboards whose webview has been created; they stay loaded once opened
  const [opened, setOpened] = useState<string[]>([])
  const [frames, setFrames] = useState<Record<string, FrameState>>({})
  const [editing, setEditing] = useState<DashboardEntry | 'new' | null>(null)
  const views = useRef(new Map<string, HTMLWebViewElement>())

  useEffect(() => {
    window.scribe.dashboards.list().then(setList)
  }, [])

  const active = list?.find((d) => d.id === current) ?? list?.[0] ?? null

  useEffect(() => {
    if (!active) return
    setOpened((ids) => (ids.includes(active.id) ? ids : [...ids, active.id]))
    rememberOpened(active.id)
  }, [active])

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

  if (!list) return <></>

  const view = active ? views.current.get(active.id) : undefined
  const state = active ? frames[active.id] : undefined

  return (
    <div className="dash">
      <div className="dash-bar">
        <div className="dash-tabs" role="tablist" aria-label="Dashboards">
          {list.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={d.id === active?.id}
              className={`dash-tab ${d.id === active?.id ? 'active' : ''}`}
              onClick={() => setCurrent(d.id)}
              onDoubleClick={() => setEditing(d)}
              title={d.url}
            >
              {d.name}
            </button>
          ))}
          <button className="dash-tab dash-add" onClick={() => setEditing('new')}>
            + Add dashboard
          </button>
        </div>
        {active && (
          <div className="dash-tools">
            <button
              className="dash-icon"
              onClick={() => view?.goBack()}
              disabled={!state?.canBack}
              title="Back"
              aria-label="Back"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button
              className="dash-icon"
              onClick={() => {
                frameState(active.id, { error: undefined })
                view?.reload()
              }}
              title="Reload"
              aria-label="Reload"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            <button
              className="dash-icon"
              onClick={() => {
                frameState(active.id, { error: undefined })
                view?.loadURL(active.url).catch(() => {})
              }}
              title="Back to the dashboard's own address"
              aria-label="Home"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 11l9-8 9 8" />
                <path d="M5 10v10h14V10" />
              </svg>
            </button>
            <button
              className="dash-icon"
              onClick={() => window.scribe.dashboards.openExternal(active.url)}
              title="Open in your browser"
              aria-label="Open in your browser"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6" />
                <path d="M10 14L20 4" />
                <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
              </svg>
            </button>
            <button className="btn btn-ghost dash-edit" onClick={() => setEditing(active)}>
              Edit
            </button>
          </div>
        )}
      </div>

      <div className="dash-body">
        {!active && (
          <div className="empty-state">
            <h2>Keep your dashboards here</h2>
            <p>
              Add a dashboard&apos;s address (Power BI, Tableau, Grafana, ClickUp, anything on the
              web) and it opens right inside Rowan. Sign in once; it remembers you.
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
                    view?.loadURL(active.url).catch(() => {})
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

      {editing && (
        <DashboardDialog
          dashboard={editing === 'new' ? null : editing}
          index={editing === 'new' ? -1 : list.findIndex((d) => d.id === editing.id)}
          count={list.length}
          onDone={(next, selectId) => {
            setEditing(null)
            if (!next) return
            applyList(next)
            if (selectId) setCurrent(selectId)
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
        src={dashboard.url}
        partition={PARTITION}
        allowpopups={'true' as unknown as boolean}
      />
    </div>
  )
}

function DashboardDialog({
  dashboard,
  index,
  count,
  onDone
}: {
  /** null = adding */
  dashboard: DashboardEntry | null
  index: number
  count: number
  /** next list when something changed; selectId opens that dashboard */
  onDone: (next: DashboardEntry[] | null, selectId?: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(dashboard?.name ?? '')
  const [url, setUrl] = useState(dashboard?.url ?? '')
  const [links, setLinks] = useState<LinkEntry[]>([])
  const [error, setError] = useState<string | null>(null)
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

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!url.trim()) return
    try {
      const next = await window.scribe.dashboards.save({ id: dashboard?.id, name, url })
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

  const pos = changed && dashboard ? changed.findIndex((d) => d.id === dashboard.id) : index

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
                setUrl(l.url)
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
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            placeholder="https://app.powerbi.com/…"
            autoFocus
            required
          />
        </label>
        <label className="pd-field">
          <span>Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shown on its tab"
          />
        </label>
        {error && <p className="field-note error">{error}</p>}
        {dashboard && (
          <div className="dash-dialog-row">
            <button type="button" className="btn btn-ghost" onClick={() => move(-1)} disabled={pos <= 0}>
              ← Move left
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => move(1)}
              disabled={pos < 0 || pos >= count - 1}
            >
              Move right →
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
