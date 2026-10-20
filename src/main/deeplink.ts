import { app } from 'electron'
import { resolve } from 'path'
import { channel } from './channel'
import { navigate } from './system'
import type { NavTarget } from '../shared/types'

// ---------------------------------------------------------------------------
// App links: rowan-aio://meeting/<id>?t=<seconds> and friends open Rowan on
// that page from anywhere Windows hands a URL to — Claude Desktop answers
// (the MCP server returns these), a OneNote page, a ClickUp comment. Test and
// dev builds get their own scheme so a link never opens the wrong library.
// ---------------------------------------------------------------------------

export const URL_SCHEME = channel === 'stable' ? 'rowan-aio' : `rowan-aio-${channel}`

export function registerUrlScheme(): void {
  try {
    // a portable test build runs from a temp copy that is gone after it
    // quits; register the exe the user actually launched instead
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable) app.setAsDefaultProtocolClient(URL_SCHEME, portable)
    else if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(URL_SCHEME, process.execPath, [resolve(process.argv[1])])
    } else app.setAsDefaultProtocolClient(URL_SCHEME)
  } catch {
    // links just won't open the app; nothing else depends on this
  }
}

/** the app link among a launch's arguments, if it was started by one */
export function findAppUrl(argv: string[]): string | null {
  const prefix = `${URL_SCHEME}://`
  return argv.find((a) => a.toLowerCase().startsWith(prefix)) ?? null
}

/** rowan-aio://meeting/<id>?t=90 → the meeting page at 1:30; null for anything unknown */
export function parseAppUrl(raw: string): NavTarget | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol.replace(/:$/, '').toLowerCase() !== URL_SCHEME) return null
  // custom schemes put the first segment in the host: meeting/<id> → host "meeting"
  const parts = [url.hostname, ...url.pathname.split('/')]
    .map((p) => decodeURIComponent(p).trim())
    .filter(Boolean)
  const [page, arg] = parts
  switch ((page ?? 'today').toLowerCase()) {
    case 'meeting': {
      if (!arg || !/^[\w-]+$/.test(arg)) return null
      const t = Number(url.searchParams.get('t'))
      return { name: 'meeting', id: arg, ...(t > 0 ? { at: Math.round(t * 1000) } : {}) }
    }
    case 'record':
      return { name: 'record' }
    case 'library':
    case 'meetings':
    case 'search': {
      const q = url.searchParams.get('q')?.trim()
      return { name: 'library', ...(q ? { query: q } : {}) }
    }
    case 'actions':
      return { name: 'actions' }
    case 'people':
      return arg ? { name: 'person', person: arg } : { name: 'people' }
    case 'person':
      return arg ? { name: 'person', person: arg } : null
    case 'settings':
      return { name: 'settings' }
    case 'today':
      return { name: 'today' }
    default:
      return null
  }
}

/** bring the app forward on the page a link names; unknown links just open the app */
export function openAppUrl(raw: string): void {
  const view = parseAppUrl(raw)
  navigate({ view: view ?? { name: 'today' } })
}

export function meetingUrl(id: string, ms?: number): string {
  const t = ms && ms > 0 ? `?t=${Math.floor(ms / 1000)}` : ''
  return `${URL_SCHEME}://meeting/${encodeURIComponent(id)}${t}`
}
