import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Hub, HubError, takeAuthReturn } from './api'
import { clearCache, loadSettings, peek, type PhoneSettings } from './data'
import { ActionsIcon, MeetingsIcon, MicIcon, MoreIcon, TodayIcon, WIDE, errorText, useMedia } from './ui'
import { visibleSections } from './sections'
import { SignIn } from './views/SignIn'
import { TodayView } from './views/Today'
import { MeetingsView } from './views/Meetings'
import { MeetingView } from './views/Meeting'
import { ActionsView } from './views/Actions'
import { PlannerView } from './views/Planner'
import { RecordView, useRecording } from './views/Record'
import { PeopleView, PersonView } from './views/People'
import { TicketsView, TicketView } from './views/Tickets'
import { DashboardsView, LinksView } from './views/Links'
import { GuideView, ToolboxView } from './views/Toolbox'
import { BrandView } from './views/Brand'
import { MoreView } from './views/More'

const SIMPLE = ['today', 'meetings', 'record', 'actions', 'planner', 'people', 'tickets', 'links', 'dashboards', 'toolbox', 'brand', 'more'] as const

type Route =
  | { name: (typeof SIMPLE)[number] }
  | { name: 'meeting'; id: string }
  | { name: 'person'; id: string }
  | { name: 'ticket'; id: string }
  | { name: 'guide'; id: string }

function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/')
  if ((a === 'meeting' || a === 'person' || a === 'ticket' || a === 'guide') && b) return { name: a, id: decodeURIComponent(b) }
  return { name: (SIMPLE as readonly string[]).includes(a) ? (a as (typeof SIMPLE)[number]) : 'today' }
}

/** the section a screen belongs to, for highlighting it in the tabs or sidebar */
function sectionOf(r: Route): string {
  return r.name === 'meeting' ? 'meetings' : r.name === 'person' ? 'people' : r.name === 'ticket' ? 'tickets' : r.name === 'guide' ? 'toolbox' : r.name
}

/** lists that open an item: on a wide screen the two sit side by side */
const SPLITS: Record<string, { list: string; detail: string }> = {
  meetings: { list: 'meetings', detail: 'meeting' },
  meeting: { list: 'meetings', detail: 'meeting' },
  people: { list: 'people', detail: 'person' },
  person: { list: 'people', detail: 'person' },
  tickets: { list: 'tickets', detail: 'ticket' },
  ticket: { list: 'tickets', detail: 'ticket' }
}

interface AppContext {
  hub: Hub
  settings: PhoneSettings | null
  /** go to an in-app address such as "/meeting/<id>" */
  go: (path: string) => void
  back: (fallback: string) => void
  /** a failure as words; an expired sign-in also signs out */
  fail: (err: unknown) => string
  /** bumps when the app comes back to the foreground: screens reload */
  tick: number
  signOut: () => void
}

const Ctx = createContext<AppContext | null>(null)

export function useApp(): AppContext {
  const c = useContext(Ctx)
  if (!c) throw new Error('outside the app')
  return c
}

function applyTheme(theme: string | undefined): void {
  const t = theme || 'studio'
  document.documentElement.dataset.theme = t
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#1b1717')
}

/** the phone's tab bar; every other section is one tap away under More */
const TABS = [
  { path: '/today', name: 'today', label: 'Today', Icon: TodayIcon },
  { path: '/meetings', name: 'meetings', label: 'Meetings', Icon: MeetingsIcon },
  { path: '/record', name: 'record', label: 'Record', Icon: MicIcon },
  { path: '/actions', name: 'actions', label: 'Actions', Icon: ActionsIcon },
  { path: '/more', name: 'more', label: 'More', Icon: MoreIcon }
] as const

export default function App(): React.JSX.Element {
  // first, before the address is read as a screen: a link Supabase emailed
  const [authReturn] = useState(() => takeAuthReturn())
  const [hub, setHub] = useState<Hub | null>(() => authReturn?.hub ?? Hub.restore())
  const [route, setRoute] = useState<Route>(() => parse(location.hash))
  const [welcome, setWelcome] = useState(() => !!authReturn?.confirmed)
  const [settings, setSettings] = useState<PhoneSettings | null>(() => peek<PhoneSettings>('settings'))
  const [tick, setTick] = useState(0)
  const [signedOutNote, setSignedOutNote] = useState<string | null>(() => authReturn?.problem ?? null)
  const recording = useRecording()
  const wide = useMedia(WIDE)

  useEffect(() => applyTheme(settings?.theme), [settings?.theme])

  // each screen keeps its own scroll position, as on iOS: back to Meetings
  // lands where you left it, and a new screen starts at the top
  const scrolls = useRef(new Map<string, number>())
  const shownHash = useRef(location.hash)
  useEffect(() => {
    const onHash = (e: HashChangeEvent): void => {
      // a link Supabase emailed, opened where Rowan is already showing: start over to take it
      if (/(^|[#&/])(access_token|error_description)=/.test(location.hash)) {
        location.reload()
        return
      }
      scrolls.current.set(new URL(e.oldURL).hash, window.scrollY)
      setRoute(parse(location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useLayoutEffect(() => {
    if (shownHash.current === location.hash) return
    shownHash.current = location.hash
    window.scrollTo(0, scrolls.current.get(location.hash) ?? 0)
  }, [route])

  // back in the foreground or back online: reload what's on screen
  useEffect(() => {
    let hiddenAt = 0
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (Date.now() - hiddenAt > 15_000) setTick((n) => n + 1)
    }
    const onOnline = (): void => setTick((n) => n + 1)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  const signOut = useCallback(() => {
    void hub?.signOut()
    clearCache()
    setHub(null)
    setSettings(null)
  }, [hub])

  useEffect(() => {
    if (!hub) return
    loadSettings(hub)
      .then((s) => setSettings(s.value))
      .catch((err) => {
        if (err instanceof HubError && err.kind === 'auth') {
          setSignedOutNote(err.message)
          setHub(null)
        }
      })
  }, [hub, tick])

  const go = useCallback((path: string) => {
    location.hash = path
  }, [])

  const back = useCallback((fallback: string) => {
    if (history.length > 1 && sessionStorage.getItem('rowan.navigated')) history.back()
    else location.hash = fallback
  }, [])

  useEffect(() => {
    const mark = (): void => sessionStorage.setItem('rowan.navigated', '1')
    window.addEventListener('hashchange', mark)
    return () => window.removeEventListener('hashchange', mark)
  }, [])

  const fail = useCallback((err: unknown): string => {
    if (err instanceof HubError && err.kind === 'auth') {
      setSignedOutNote(err.message)
      setHub(null)
    }
    return errorText(err)
  }, [])

  if (!hub) {
    return (
      <SignIn
        note={signedOutNote}
        onSignedIn={(h) => {
          setSignedOutNote(null)
          setHub(h)
        }}
      />
    )
  }

  const section = sectionOf(route)
  const split = wide ? SPLITS[route.name] : undefined
  const selected = split && route.name === split.detail && 'id' in route ? route.id : null

  const list = (name: string): React.JSX.Element | null =>
    name === 'meetings' ? (
      <MeetingsView selected={selected} />
    ) : name === 'people' ? (
      <PeopleView selected={selected} />
    ) : name === 'tickets' ? (
      <TicketsView selected={selected} />
    ) : null

  const detail = (r: Route, embedded: boolean): React.JSX.Element | null =>
    r.name === 'meeting' ? (
      <MeetingView id={r.id} embedded={embedded} />
    ) : r.name === 'person' ? (
      <PersonView name={r.id} embedded={embedded} />
    ) : r.name === 'ticket' ? (
      <TicketView number={r.id} embedded={embedded} />
    ) : null

  const single = (r: Route): React.JSX.Element | null => {
    switch (r.name) {
      case 'today':
        return <TodayView />
      case 'record':
        return <RecordView />
      case 'actions':
        return <ActionsView />
      case 'planner':
        return <PlannerView />
      case 'links':
        return <LinksView />
      case 'dashboards':
        return <DashboardsView />
      case 'toolbox':
        return <ToolboxView />
      case 'guide':
        return <GuideView id={r.id} />
      case 'brand':
        return <BrandView />
      case 'more':
        return <MoreView />
      case 'meetings':
      case 'people':
      case 'tickets':
        return list(r.name)
      default:
        return detail(r, false)
    }
  }

  return (
    <Ctx.Provider value={{ hub, settings, go, back, fail, tick, signOut }}>
      <div className={`app ${wide ? 'app-wide' : ''}`}>
        {wide && (
          // a wide screen gets the desktop's sidebar: every section, one tap away
          <nav className="sidebar" aria-label="Sections">
            <div className="sidebar-brand">
              <span className="brand-dot small" aria-hidden="true" /> Rowan
            </div>
            <a href="#/record" className={`sidebar-record ${recording ? 'live' : ''} ${section === 'record' ? 'active' : ''}`}>
              <MicIcon size={18} /> {recording ? 'Recording…' : 'Record'}
            </a>
            {visibleSections(settings?.hiddenTabs).map(({ name, label, Icon }) => (
              <a key={name} href={`#/${name}`} className={`sidebar-item ${section === name ? 'active' : ''}`} aria-current={section === name ? 'page' : undefined}>
                <Icon size={20} />
                {label}
              </a>
            ))}
            <div className="sidebar-foot">
              {hub.email}
              <button className="link" onClick={signOut}>
                Sign out
              </button>
            </div>
          </nav>
        )}
        {split ? (
          <main className="screen split" key={`split-${split.list}`}>
            <div className="split-list">{list(split.list)}</div>
            <div className="split-detail" key={selected ?? 'none'}>
              {selected ? detail(route, true) : <p className="empty split-empty">Choose one to see it here.</p>}
            </div>
          </main>
        ) : (
          <main
            className={`screen ${route.name === 'today' ? 'screen-wide' : ''}`}
            key={'id' in route ? `${route.name}-${route.id}` : route.name}
          >
            {welcome && (
              <div className="notice welcome" role="status">
                <p>
                  Your email is confirmed and you’re signed in. On your PC, open Rowan → Settings → Sync and choose <b>I have an account</b>, with the same email and password.
                </p>
                <button className="link" onClick={() => setWelcome(false)}>
                  OK
                </button>
              </div>
            )}
            {single(route)}
          </main>
        )}
        {!wide && (
          <nav className="tabbar" aria-label="Sections">
            {TABS.map(({ path, name, label, Icon }) => {
              const on = name === 'more' ? !['today', 'meetings', 'record', 'actions'].includes(section) : section === name
              return (
                <a
                  key={name}
                  href={`#${path}`}
                  className={`tab ${on ? 'active' : ''} ${name === 'record' ? 'tab-record' : ''} ${name === 'record' && recording ? 'live' : ''}`}
                  aria-current={on ? 'page' : undefined}
                >
                  <span className="tab-icon">
                    <Icon size={name === 'record' ? 26 : 24} />
                  </span>
                  <span className="tab-label">{label}</span>
                </a>
              )
            })}
          </nav>
        )}
      </div>
    </Ctx.Provider>
  )
}
