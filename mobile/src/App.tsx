import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Hub, HubError } from './api'
import { clearCache, loadSettings, peek, type PhoneSettings } from './data'
import { ActionsIcon, MeetingsIcon, MicIcon, PlannerIcon, TodayIcon, errorText } from './ui'
import { SignIn } from './views/SignIn'
import { TodayView } from './views/Today'
import { MeetingsView } from './views/Meetings'
import { MeetingView } from './views/Meeting'
import { ActionsView } from './views/Actions'
import { PlannerView } from './views/Planner'
import { RecordView, useRecording } from './views/Record'

type Route =
  | { name: 'today' }
  | { name: 'meetings' }
  | { name: 'meeting'; id: string }
  | { name: 'record' }
  | { name: 'actions' }
  | { name: 'planner' }

function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/')
  if (a === 'meeting' && b) return { name: 'meeting', id: decodeURIComponent(b) }
  if (a === 'meetings' || a === 'record' || a === 'actions' || a === 'planner') return { name: a }
  return { name: 'today' }
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

const TABS = [
  { path: '/today', name: 'today', label: 'Today', Icon: TodayIcon },
  { path: '/meetings', name: 'meetings', label: 'Meetings', Icon: MeetingsIcon },
  { path: '/record', name: 'record', label: 'Record', Icon: MicIcon },
  { path: '/actions', name: 'actions', label: 'Actions', Icon: ActionsIcon },
  { path: '/planner', name: 'planner', label: 'Planner', Icon: PlannerIcon }
] as const

export default function App(): React.JSX.Element {
  const [hub, setHub] = useState<Hub | null>(() => Hub.restore())
  const [route, setRoute] = useState<Route>(() => parse(location.hash))
  const [settings, setSettings] = useState<PhoneSettings | null>(() => peek<PhoneSettings>('settings'))
  const [tick, setTick] = useState(0)
  const [signedOutNote, setSignedOutNote] = useState<string | null>(null)
  const recording = useRecording()

  useEffect(() => applyTheme(settings?.theme), [settings?.theme])

  // each screen keeps its own scroll position, as on iOS: back to Meetings
  // lands where you left it, and a new screen starts at the top
  const scrolls = useRef(new Map<string, number>())
  const shownHash = useRef(location.hash)
  useEffect(() => {
    const onHash = (e: HashChangeEvent): void => {
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

  const active = route.name === 'meeting' ? 'meetings' : route.name

  return (
    <Ctx.Provider value={{ hub, settings, go, back, fail, tick, signOut }}>
      <main className="screen" key={route.name === 'meeting' ? `meeting-${route.id}` : route.name}>
        {route.name === 'today' && <TodayView />}
        {route.name === 'meetings' && <MeetingsView />}
        {route.name === 'meeting' && <MeetingView id={route.id} />}
        {route.name === 'record' && <RecordView />}
        {route.name === 'actions' && <ActionsView />}
        {route.name === 'planner' && <PlannerView />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {TABS.map(({ path, name, label, Icon }) => (
          <a
            key={name}
            href={`#${path}`}
            className={`tab ${active === name ? 'active' : ''} ${name === 'record' ? 'tab-record' : ''} ${name === 'record' && recording ? 'live' : ''}`}
            aria-current={active === name ? 'page' : undefined}
          >
            <span className="tab-icon">
              <Icon size={name === 'record' ? 26 : 24} />
            </span>
            <span className="tab-label">{label}</span>
          </a>
        ))}
      </nav>
    </Ctx.Provider>
  )
}
