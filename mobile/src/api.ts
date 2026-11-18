import { BUILT_IN_HUB } from '../../src/shared/hub'

// ---------------------------------------------------------------------------
// The phone's line to the sync hub: email + password sign-in (the session
// survives restarts in this app's own storage), the sync_* database
// functions, row reads, and the private file bucket. Same hub, same rules as
// the desktop's src/main/sync/hub.ts; this one runs in Safari.
// ---------------------------------------------------------------------------

export interface HubConfig {
  url: string
  key: string
}

interface SavedSession {
  hubUrl: string
  userId: string
  email: string
  refreshToken: string
}

const SESSION = 'rowan.session'
const CUSTOM_HUB = 'rowan.hub'
const DEVICE = 'rowan.device'

export type HubErrorKind = 'auth' | 'network' | 'missing' | 'server'

export class HubError extends Error {
  constructor(
    message: string,
    readonly kind: HubErrorKind,
    readonly status = 0
  ) {
    super(message)
  }
}

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private mode: the session lasts until the app closes
  }
}

export function hubConfig(): HubConfig | null {
  const custom = read<HubConfig>(CUSTOM_HUB)
  if (custom?.url && custom.key) return custom
  if (BUILT_IN_HUB.url && BUILT_IN_HUB.key) return { ...BUILT_IN_HUB }
  return null
}

export function setCustomHub(cfg: HubConfig | null): void {
  write(CUSTOM_HUB, cfg ? { url: cfg.url.trim().replace(/\/+$/, ''), key: cfg.key.trim() } : null)
}

/** this phone's name in the hub's change log */
export function deviceId(): string {
  let id = read<string>(DEVICE)
  if (!id) {
    id = `phone-${crypto.randomUUID()}`
    write(DEVICE, id)
  }
  return id
}

async function call(url: string, init: RequestInit, timeoutMs = 45_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new HubError(timedOut ? 'The hub took too long to answer.' : "You're offline, or the hub can't be reached.", 'network')
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as Record<string, unknown>
    const msg = j.error_description ?? j.msg ?? j.message ?? j.error
    if (typeof msg === 'string' && msg) return msg
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`.trim()
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: { id: string; email?: string }
}

async function token(cfg: HubConfig, grant: 'password' | 'refresh_token', body: Record<string, string>): Promise<TokenResponse> {
  const res = await call(`${cfg.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.ok) return (await res.json()) as TokenResponse
  const msg = await errorText(res)
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new HubError(
      grant === 'password'
        ? /invalid login credentials/i.test(msg)
          ? 'That email and password did not match an account.'
          : msg
        : 'Your sign-in has expired. Sign in again.',
      'auth',
      res.status
    )
  }
  throw new HubError(msg, 'server', res.status)
}

export class Hub {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null

  private constructor(
    private readonly cfg: HubConfig,
    private session: SavedSession
  ) {}

  /** the signed-in hub from last time, if any */
  static restore(): Hub | null {
    const cfg = hubConfig()
    const s = read<SavedSession>(SESSION)
    if (!cfg || !s || s.hubUrl !== cfg.url) return null
    return new Hub(cfg, s)
  }

  static async signIn(email: string, password: string): Promise<Hub> {
    const cfg = hubConfig()
    if (!cfg) throw new HubError('No sync hub is set up yet.', 'server')
    const t = await token(cfg, 'password', { email: email.trim(), password })
    const session = { hubUrl: cfg.url, userId: t.user.id, email: t.user.email ?? email.trim(), refreshToken: t.refresh_token }
    write(SESSION, session)
    const hub = new Hub(cfg, session)
    hub.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 }
    return hub
  }

  get userId(): string {
    return this.session.userId
  }

  get email(): string {
    return this.session.email
  }

  async signOut(): Promise<void> {
    try {
      await this.request('/auth/v1/logout', { method: 'POST' })
    } catch {
      // signing out here is what matters
    }
    write(SESSION, null)
  }

  private async bearer(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token
    if (!this.refreshing) {
      this.refreshing = token(this.cfg, 'refresh_token', { refresh_token: this.session.refreshToken })
        .then((t) => {
          this.session = { ...this.session, refreshToken: t.refresh_token }
          write(SESSION, this.session)
          this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 }
          return t.access_token
        })
        .catch((err) => {
          if (err instanceof HubError && err.kind === 'auth') write(SESSION, null)
          throw err
        })
        .finally(() => {
          this.refreshing = null
        })
    }
    return this.refreshing
  }

  private async request(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: this.cfg.key,
      Authorization: `Bearer ${await this.bearer()}`,
      ...((init.headers as Record<string, string>) ?? {})
    }
    if (init.body && typeof init.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    const res = await call(`${this.cfg.url}${path}`, { ...init, headers }, timeoutMs)
    if (res.ok) return res
    const msg = await errorText(res)
    if (res.status === 401) {
      this.access = null
      throw new HubError('Your sign-in has expired. Sign in again.', 'auth', 401)
    }
    if (res.status === 404 || /not.?found/i.test(msg)) throw new HubError(msg, 'missing', res.status)
    throw new HubError(msg, 'server', res.status)
  }

  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) })
    return (await res.json()) as T
  }

  /** read rows of sync_docs (row-level security limits them to this person) */
  async rows<T>(query: string): Promise<T[]> {
    const res = await this.request(`/rest/v1/sync_docs?${query}`, { method: 'GET' })
    return (await res.json()) as T[]
  }

  /** upload with progress (fetch can't report it) */
  upload(path: string, file: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
    return this.bearer().then(
      (bearer) =>
        new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', `${this.cfg.url}/storage/v1/object/sync/${path.split('/').map(encodeURIComponent).join('/')}`)
          xhr.setRequestHeader('apikey', this.cfg.key)
          xhr.setRequestHeader('Authorization', `Bearer ${bearer}`)
          xhr.setRequestHeader('Content-Type', contentType)
          xhr.setRequestHeader('x-upsert', 'true')
          xhr.timeout = 30 * 60_000
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress?.(e.loaded / e.total)
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve()
            else {
              let msg = `${xhr.status} ${xhr.statusText}`
              try {
                const j = JSON.parse(xhr.responseText) as Record<string, unknown>
                if (typeof j.message === 'string') msg = j.message
              } catch {
                // keep the status line
              }
              reject(new HubError(msg, xhr.status === 401 ? 'auth' : 'server', xhr.status))
            }
          }
          xhr.onerror = () => reject(new HubError("The upload couldn't reach the hub.", 'network'))
          xhr.ontimeout = () => reject(new HubError('The upload took too long.', 'network'))
          xhr.send(file)
        })
    )
  }

  async download(path: string): Promise<Blob> {
    const res = await this.request(
      `/storage/v1/object/authenticated/sync/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'GET' },
      10 * 60_000
    )
    return res.blob()
  }
}
