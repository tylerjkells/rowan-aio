// ---------------------------------------------------------------------------
// The sync hub: a Supabase project holding each person's documents in one
// table (sync_docs, private to its owner by row-level security) and their
// audio and attachments in one private storage bucket (`sync`, one folder per
// person). See supabase/migrations for the schema. Plain fetch, no SDK: the
// surface is three database functions, sign-in, and file storage.
// ---------------------------------------------------------------------------

import { CONFIRM_EMAIL_PROBLEM, signUpProblem, type SignupApproval } from '../../shared/hub'

export interface HubConfig {
  url: string
  /** the project's publishable (anon) key: public by design, data is guarded by RLS */
  key: string
}

/** what survives a restart: the refresh token rotates on every use */
export interface SavedSession {
  userId: string
  email: string
  refreshToken: string
}

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

export interface DocRef {
  collection: string
  doc_id: string
}

export interface RemoteKey extends DocRef {
  rev: number
  deleted: boolean
  updated_at: string
}

export interface RemoteDoc extends RemoteKey {
  body: unknown
}

export interface PushDoc extends DocRef {
  body: unknown
  deleted: boolean
  /** the revision this change was made from; null for a document new to the hub */
  base_rev: number | null
}

export interface PushResult extends DocRef {
  /** false: the hub moved on since base_rev, so pull, merge, and try again */
  ok: boolean
  rev: number
  deleted: boolean
  updated_at: string
}

/** what the sync engine needs from a hub; the tests use an in-memory one */
export interface Hub {
  readonly userId: string
  /** documents changed after (sinceAt, sinceRev), oldest first, without bodies */
  changes(sinceAt: string, sinceRev: number, limit: number): Promise<RemoteKey[]>
  fetch(refs: DocRef[]): Promise<RemoteDoc[]>
  push(docs: PushDoc[], device: string): Promise<PushResult[]>
  upload(path: string, data: Buffer, contentType: string): Promise<void>
  download(path: string): Promise<Buffer>
  remove(paths: string[]): Promise<void>
}

const API_TIMEOUT_MS = 60_000
const FILE_TIMEOUT_MS = 15 * 60_000

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as Record<string, unknown>
    const msg = j.error_description ?? j.msg ?? j.message ?? j.error
    if (typeof msg === 'string' && msg) return msg
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`.trim()
}

async function call(
  url: string,
  init: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS) })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new HubError(
      timedOut ? 'The sync hub took too long to answer.' : "Can't reach the sync hub.",
      'network'
    )
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: { id: string; email?: string }
}

async function tokenRequest(
  cfg: HubConfig,
  grant: 'password' | 'refresh_token',
  body: Record<string, string>
): Promise<TokenResponse> {
  const res = await call(`${trimUrl(cfg.url)}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const msg = await readError(res)
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HubError(
        grant === 'password'
          ? /invalid login credentials/i.test(msg)
            ? 'That email and password did not match an account.'
            : msg
          : 'Your sync sign-in has expired. Sign in again.',
        'auth',
        res.status
      )
    }
    throw new HubError(msg, 'server', res.status)
  }
  return (await res.json()) as TokenResponse
}

export class SupabaseHub implements Hub {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly cfg: HubConfig,
    private session: SavedSession,
    /** called whenever the refresh token rotates, so it can be stored */
    private readonly onSession: (s: SavedSession) => void
  ) {}

  static async signIn(
    cfg: HubConfig,
    email: string,
    password: string,
    onSession: (s: SavedSession) => void
  ): Promise<SupabaseHub> {
    const t = await tokenRequest(cfg, 'password', { email: email.trim(), password })
    const session = { userId: t.user.id, email: t.user.email ?? email.trim(), refreshToken: t.refresh_token }
    onSession(session)
    const hub = new SupabaseHub(cfg, session, onSession)
    hub.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 }
    return hub
  }

  /**
   * Create an account with a password the person chooses. The hub only
   * accepts an email an administrator approved (approved_signups migration).
   */
  static async signUp(
    cfg: HubConfig,
    email: string,
    password: string,
    onSession: (s: SavedSession) => void
  ): Promise<SupabaseHub> {
    const res = await call(`${trimUrl(cfg.url)}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password })
    })
    if (!res.ok) {
      const msg = await readError(res)
      const refused = res.status < 500 || /database error saving new user/i.test(msg)
      throw new HubError(signUpProblem(res.status, msg, email), refused ? 'auth' : 'server', res.status)
    }
    const t = (await res.json()) as Partial<TokenResponse>
    // with "Confirm email" on, the hub answers with the user and no session
    if (!t.access_token || !t.refresh_token || !t.user?.id) throw new HubError(CONFIRM_EMAIL_PROBLEM, 'auth')
    const session = { userId: t.user.id, email: t.user.email ?? email.trim(), refreshToken: t.refresh_token }
    onSession(session)
    const hub = new SupabaseHub(cfg, session, onSession)
    hub.access = { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
    return hub
  }

  get userId(): string {
    return this.session.userId
  }

  get email(): string {
    return this.session.email
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token
    if (!this.refreshing) {
      this.refreshing = tokenRequest(this.cfg, 'refresh_token', {
        refresh_token: this.session.refreshToken
      })
        .then((t) => {
          this.session = { ...this.session, refreshToken: t.refresh_token }
          this.onSession(this.session)
          this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 }
          return t.access_token
        })
        .finally(() => {
          this.refreshing = null
        })
    }
    return this.refreshing
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number },
    json = true
  ): Promise<Response> {
    const token = await this.token()
    const headers: Record<string, string> = {
      apikey: this.cfg.key,
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers as Record<string, string>) ?? {})
    }
    const res = await call(`${trimUrl(this.cfg.url)}${path}`, { ...init, headers })
    if (res.ok) return res
    const msg = await readError(res)
    if (res.status === 401) {
      this.access = null
      throw new HubError('Your sync sign-in has expired. Sign in again.', 'auth', 401)
    }
    if (res.status === 404 || /not.?found/i.test(msg)) throw new HubError(msg, 'missing', res.status)
    throw new HubError(msg, 'server', res.status)
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.request(`/rest/v1/rpc/${name}`, {
      method: 'POST',
      body: JSON.stringify(args)
    })
    return (await res.json()) as T
  }

  async changes(sinceAt: string, sinceRev: number, limit: number): Promise<RemoteKey[]> {
    return (
      (await this.rpc<RemoteKey[] | null>('sync_changes', {
        since_at: sinceAt,
        since_rev: sinceRev,
        max_rows: limit
      })) ?? []
    )
  }

  async fetch(refs: DocRef[]): Promise<RemoteDoc[]> {
    if (refs.length === 0) return []
    return (await this.rpc<RemoteDoc[] | null>('sync_get', { refs })) ?? []
  }

  async push(docs: PushDoc[], device: string): Promise<PushResult[]> {
    if (docs.length === 0) return []
    return (await this.rpc<PushResult[] | null>('sync_push', { docs, device })) ?? []
  }

  private objectPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/')
  }

  async upload(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.request(
      `/storage/v1/object/sync/${this.objectPath(path)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: new Uint8Array(data),
        timeoutMs: FILE_TIMEOUT_MS
      },
      false
    )
  }

  async download(path: string): Promise<Buffer> {
    const res = await this.request(
      `/storage/v1/object/authenticated/sync/${this.objectPath(path)}`,
      { method: 'GET', timeoutMs: FILE_TIMEOUT_MS },
      false
    )
    return Buffer.from(await res.arrayBuffer())
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.request('/storage/v1/object/sync', {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: paths })
    })
  }

  /** this person's share of the hub: document rows and stored files, in bytes */
  async usage(): Promise<{ doc_bytes: number; file_bytes: number }> {
    return this.rpc('sync_usage', {})
  }

  async changePassword(password: string): Promise<void> {
    await this.request('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) })
  }

  // ---- approvals (the hub's administrators only; row-level security enforces it)

  /** whether this person may approve new accounts; false on a hub without approvals */
  async isAdmin(): Promise<boolean> {
    try {
      const res = await this.request(
        `/rest/v1/hub_admins?select=user_id&user_id=eq.${encodeURIComponent(this.userId)}`,
        { method: 'GET' }
      )
      return ((await res.json()) as unknown[]).length > 0
    } catch (err) {
      if (err instanceof HubError && err.kind === 'missing') return false
      throw err
    }
  }

  async approvals(): Promise<SignupApproval[]> {
    const res = await this.request(
      '/rest/v1/signup_allowlist?select=email,added_at,used_at&order=added_at.desc',
      { method: 'GET' }
    )
    const rows = (await res.json()) as { email: string; added_at: string; used_at: string | null }[]
    return rows.map((r) => ({ email: r.email, addedAt: r.added_at, usedAt: r.used_at }))
  }

  /** approve an email; a 409 HubError means it's already on the list */
  async approve(email: string): Promise<void> {
    await this.request('/rest/v1/signup_allowlist', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ email: email.trim().toLowerCase() })
    })
  }

  async withdraw(email: string): Promise<void> {
    await this.request(`/rest/v1/signup_allowlist?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    })
  }

  async signOut(): Promise<void> {
    try {
      await this.request('/auth/v1/logout', { method: 'POST' })
    } catch {
      // the local sign-out is what matters
    }
  }
}
