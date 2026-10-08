import { app, session, shell, type WebContents } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { DashboardEntry } from '../shared/types'

// ---------------------------------------------------------------------------
// Dashboards tab: pages embedded in the app with <webview>, which (unlike an
// iframe) is not refused by X-Frame-Options, so Power BI, Tableau, Grafana and
// friends render in place. The list lives in userData/dashboards.json.
// ---------------------------------------------------------------------------

/** one persistent cookie jar for every dashboard, apart from the app's own */
export const DASHBOARD_PARTITION = 'persist:dashboards'

function file(): string {
  return join(app.getPath('userData'), 'dashboards.json')
}

export function listDashboards(): DashboardEntry[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return []
  }
}

function write(list: DashboardEntry[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(list, null, 2))
}

/** a typed address without a scheme is taken as https */
function normalizeUrl(raw: string): string {
  const url = raw.trim()
  const withScheme = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('That does not look like a web address.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Dashboards need a web address (https://…).')
  }
  return parsed.toString()
}

/** Add (no id) or update (with id) a dashboard; returns the full list. */
export function saveDashboard(entry: { id?: string; name: string; url: string }): DashboardEntry[] {
  const list = listDashboards()
  const url = normalizeUrl(entry.url)
  const name = entry.name.trim() || new URL(url).hostname.replace(/^www\./, '')
  if (entry.id) {
    const i = list.findIndex((d) => d.id === entry.id)
    if (i >= 0) list[i] = { ...list[i], name, url }
  } else {
    list.push({ id: randomUUID(), name, url })
  }
  write(list)
  return list
}

export function removeDashboard(id: string): DashboardEntry[] {
  const kept = listDashboards().filter((d) => d.id !== id)
  write(kept)
  return kept
}

/** shift a dashboard one place left (-1) or right (+1) in the tab strip */
export function moveDashboard(id: string, delta: -1 | 1): DashboardEntry[] {
  const list = listDashboards()
  const i = list.findIndex((d) => d.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return list
  ;[list[i], list[j]] = [list[j], list[i]]
  write(list)
  return list
}

/** Forget every dashboard sign-in (cookies, storage, cache). */
export async function signOutDashboards(): Promise<void> {
  const ses = session.fromPartition(DASHBOARD_PARTITION)
  await ses.clearStorageData()
  await ses.clearCache()
}

/**
 * Configure the dashboards' session once at startup. Sign-in pages (Google's,
 * some Microsoft tenants) refuse browsers that announce themselves as
 * Electron, so the session presents as the Chrome it is underneath. Dashboards
 * get no device permissions beyond clipboard writes and fullscreen.
 */
export function setupDashboardSession(): void {
  const ses = session.fromPartition(DASHBOARD_PARTITION)
  const platform = app.userAgentFallback.match(/\(([^)]*)\)/)?.[1] ?? 'Windows NT 10.0; Win64; x64'
  ses.setUserAgent(
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  )
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen'])
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

/**
 * The app window may only host dashboard webviews: no preload, no Node, its
 * own sandboxed session, and only web addresses.
 */
export function guardWebviews(host: WebContents): void {
  host.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.partition = DASHBOARD_PARTITION
    if (!/^https?:\/\//i.test(params.src)) e.preventDefault()
  })
  host.on('did-attach-webview', (_e, guest) => {
    // sign-in popups (SSO, "Sign in with Google") must share the dashboards'
    // cookies to work, so web popups open as app windows on that session;
    // anything else (mailto:, teams:) goes to the system
    guest.setWindowOpenHandler(({ url }) => {
      if (!/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {})
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          autoHideMenuBar: true,
          webPreferences: {
            partition: DASHBOARD_PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      }
    })
  })
}
