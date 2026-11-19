import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { BUILT_IN_HUB, MIN_PASSWORD, looksLikeEmail, type SignupApproval } from '../../shared/hub'
import type { SyncChangeEvent, SyncStatus } from '../../shared/types'
import { applyPortableSettings, getSyncPrefs, readPortableSettings, setSyncPrefs } from '../settings'
import { dropTicketsCache } from '../tickets'
import { dropTeamCache } from '../team'
import { dropStatusUpdateCache } from '../statusUpdate'
import { readMeeting, writeMeeting } from '../store'
import { BLOB_DIRS, SYNCED_FILES, SyncEngine } from './engine'
import { HubError, SupabaseHub, type HubConfig, type SavedSession } from './hub'

// ---------------------------------------------------------------------------
// Sync, wired into the app: sign-in, a pass every minute (sooner after a
// local change or when the window comes forward), and the Settings page's
// controls. The engine does the work; this keeps it fed and reports back.
// ---------------------------------------------------------------------------

const PASS_EVERY_MS = 60_000
const AFTER_CHANGE_MS = 4_000
const FOCUS_GAP_MS = 20_000
const USAGE_EVERY_MS = 10 * 60_000
/** per-meeting refresh events beyond this are folded into one list refresh */
const MEETING_EVENTS_MAX = 20

let hub: SupabaseHub | null = null
let engine: SyncEngine | null = null
let timer: NodeJS.Timeout | null = null
let nextPassAt = 0
let running = false
let rerun = false
let lastPassAt = 0
let watcher: FSWatcher | null = null
let state: SyncStatus['state'] = 'off'
let message: string | null = null
let usage: SyncStatus['usage'] = null
let usageAt = 0
let admin = false
let onSettingsSynced: () => void = () => {}

/**
 * Phone recordings this PC claimed. Decoding the audio needs the window (the
 * main process has no decoder), so the window takes them from here one at a
 * time through the same path as "Re-transcribe".
 */
const toTranscribe = new Set<string>()
const transcribing = new Set<string>()

function root(): string {
  return app.getPath('userData')
}

function hubConfig(): HubConfig | null {
  const prefs = getSyncPrefs()
  if (prefs.hubUrl && prefs.hubKey) return { url: prefs.hubUrl, key: prefs.hubKey }
  if (BUILT_IN_HUB.url && BUILT_IN_HUB.key) return { ...BUILT_IN_HUB }
  return null
}

// ---- the stored sign-in ----------------------------------------------------

interface AccountFile {
  hubUrl: string
  userId: string
  email: string
  /** safeStorage-encrypted refresh token, base64 */
  refresh: string
}

function accountPath(): string {
  return join(root(), 'sync', 'account.json')
}

function ownerPath(): string {
  return join(root(), 'sync', 'owner.json')
}

function seal(text: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text).toString('base64')
    : `plain:${Buffer.from(text).toString('base64')}`
}

function unseal(value: string): string | null {
  try {
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString()
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

function saveSession(cfg: HubConfig, s: SavedSession): void {
  mkdirSync(join(root(), 'sync'), { recursive: true })
  const file: AccountFile = { hubUrl: cfg.url, userId: s.userId, email: s.email, refresh: seal(s.refreshToken) }
  writeFileSync(accountPath(), JSON.stringify(file, null, 2))
}

function loadSession(cfg: HubConfig): SavedSession | null {
  try {
    const a = JSON.parse(readFileSync(accountPath(), 'utf8')) as AccountFile
    if (a.hubUrl !== cfg.url) return null
    const refreshToken = unseal(a.refresh)
    return refreshToken ? { userId: a.userId, email: a.email, refreshToken } : null
  } catch {
    return null
  }
}

function clearSession(): void {
  rmSync(accountPath(), { force: true })
}

/** the account this PC's library belongs to, once it has synced */
function owner(): { userId: string; email: string } | null {
  try {
    return JSON.parse(readFileSync(ownerPath(), 'utf8'))
  } catch {
    return null
  }
}

// ---- status ----------------------------------------------------------------

export function syncStatus(): SyncStatus {
  const cfg = hubConfig()
  const prefs = getSyncPrefs()
  return {
    available: cfg !== null,
    customHub: !!(prefs.hubUrl && prefs.hubKey),
    hubUrl: cfg?.url ?? null,
    signedIn: hub !== null,
    email: hub?.email ?? null,
    state: hub ? state : 'off',
    message: hub ? message : null,
    lastSyncAt: engine?.lastSyncAt ?? null,
    heldDeletes: engine?.heldCount ?? 0,
    tooLarge: engine?.tooLarge.size ?? 0,
    audioDays: prefs.audioDays,
    usage: hub ? usage : null,
    admin: hub ? admin : false
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

let statusTimer: NodeJS.Timeout | null = null
function announce(): void {
  // progress can tick quickly during a first upload; a few updates a second is plenty
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = null
    broadcast('sync:status', syncStatus())
  }, 250)
}

// ---- running passes ----------------------------------------------------------

function schedule(ms: number): void {
  if (!engine) return
  const at = Date.now() + ms
  if (timer && nextPassAt <= at) return
  if (timer) clearTimeout(timer)
  nextPassAt = at
  timer = setTimeout(() => {
    timer = null
    void runPass()
  }, ms)
}

function deliverChanges(): void {
  if (!engine) return
  const c = engine.takeChange()
  if (c.areas.size === 0 && c.meetings.length === 0 && c.removedMeetings.length === 0) return
  const meetings = [...new Set(c.meetings)]
  if (meetings.length <= MEETING_EVENTS_MAX) {
    for (const id of meetings) {
      const m = readMeeting(id)
      if (m) broadcast('meeting:updated', m)
    }
  }
  const event: SyncChangeEvent = {
    areas: [...c.areas],
    meetings,
    removedMeetings: [...new Set(c.removedMeetings)]
  }
  broadcast('sync:changed', event)
}

/** the account's share of the hub, and whether it approves new accounts */
async function refreshUsage(): Promise<void> {
  if (!hub || Date.now() - usageAt < USAGE_EVERY_MS) return
  usageAt = Date.now()
  try {
    const [u, a] = await Promise.all([hub.usage(), hub.isAdmin()])
    usage = { docBytes: u.doc_bytes, fileBytes: u.file_bytes }
    admin = a
  } catch {
    // usage is a nicety; the next pass tries again
    usageAt = 0
  }
}

async function runPass(): Promise<void> {
  if (!engine || !hub) return
  if (running) {
    rerun = true
    return
  }
  running = true
  rerun = false
  state = 'syncing'
  message = null
  announce()
  try {
    await engine.run()
    mkdirSync(join(root(), 'sync'), { recursive: true })
    writeFileSync(ownerPath(), JSON.stringify({ userId: hub.userId, email: hub.email }))
    state = engine.heldCount > 0 ? 'attention' : 'idle'
    message = null
    await refreshUsage()
  } catch (err) {
    if (err instanceof HubError && err.kind === 'auth') {
      // the stored sign-in no longer works: stop until the person signs in again
      clearSession()
      hub = null
      engine = null
      state = 'off'
      message = null
      deliverChanges()
      broadcast('sync:status', { ...syncStatus(), message: err.message })
      return
    }
    state = err instanceof HubError && err.kind === 'network' ? 'offline' : 'error'
    message = err instanceof Error ? err.message : String(err)
  } finally {
    running = false
    lastPassAt = Date.now()
  }
  deliverChanges()
  announce()
  schedule(rerun ? 1_000 : PASS_EVERY_MS)
}

/** a local change worth sending soon */
function isSyncedPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/')
  if (norm === 'settings.json' || SYNCED_FILES[norm]) return true
  if (norm.endsWith('.sync-tmp')) return false
  if (norm.startsWith('meetings/')) return norm.endsWith('/meeting.json') || /\/audio\.(webm|wav)$/.test(norm)
  return Object.keys(BLOB_DIRS).some((d) => norm.startsWith(`${d}/`))
}

function startWatching(): void {
  if (watcher) return
  try {
    watcher = watch(root(), { recursive: true }, (_event, file) => {
      if (file && isSyncedPath(file.toString())) schedule(AFTER_CHANGE_MS)
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    // no watcher: the minute timer still catches every change
  }
}

function stopWatching(): void {
  watcher?.close()
  watcher = null
}

function begin(h: SupabaseHub): void {
  hub = h
  engine = new SyncEngine(root(), h, {
    readPortableSettings,
    applyPortableSettings: (v) => {
      applyPortableSettings(v)
      onSettingsSynced()
    },
    fileWritten: (rel) => {
      if (rel === 'tickets.json') dropTicketsCache()
      else if (rel === 'team-tickets.json') dropTeamCache()
      else if (rel === 'status-update.json') dropStatusUpdateCache()
    },
    audioDays: () => getSyncPrefs().audioDays,
    progress: (text) => {
      message = text
      announce()
    },
    process: (id) => {
      if (transcribing.has(id) || toTranscribe.has(id)) return
      toTranscribe.add(id)
      broadcast('sync:transcribe', id)
    }
  })
  engine.purgeTrash()
  state = 'idle'
  usageAt = 0
  startWatching()
}

function end(): void {
  if (timer) clearTimeout(timer)
  timer = null
  stopWatching()
  hub = null
  engine = null
  state = 'off'
  message = null
  usage = null
  admin = false
}

/** at startup: pick up where the last session left off */
export function initSync(): void {
  const cfg = hubConfig()
  if (!cfg) return
  const saved = loadSession(cfg)
  if (!saved) return
  begin(new SupabaseHub(cfg, saved, (s) => saveSession(cfg, s)))
  // let the app finish starting before the first pass
  schedule(8_000)
}

// ---- Settings → Sync -----------------------------------------------------------

async function signIn(email: string, password: string): Promise<SyncStatus> {
  const cfg = hubConfig()
  if (!cfg) throw new Error('This build has no sync hub set up.')
  if (!email.trim() || !password) throw new Error('Enter your email and password.')
  const h = await SupabaseHub.signIn(cfg, email, password, (s) => saveSession(cfg, s))
  const own = owner()
  if (own && own.userId !== h.userId) {
    await h.signOut()
    clearSession()
    throw new Error(
      `This PC's library syncs with ${own.email}. Sign in with that account to keep it in sync.`
    )
  }
  return start(h)
}

function start(h: SupabaseHub): SyncStatus {
  end()
  begin(h)
  schedule(0)
  return syncStatus()
}

/**
 * A new account, with a password the person picks; their email must be
 * approved. `confirm`: made, but the hub wants the email confirmed first.
 */
async function signUp(email: string, password: string): Promise<{ confirm: boolean; status: SyncStatus }> {
  const cfg = hubConfig()
  if (!cfg) throw new Error('This build has no sync hub set up.')
  if (!looksLikeEmail(email)) throw new Error('Enter the email that was approved for you.')
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password.`)
  // a library that already syncs with an account can't move to a new one
  const own = owner()
  if (own) {
    throw new Error(
      `This PC's library already syncs with ${own.email}. Sign in with that account instead.`
    )
  }
  const h = await SupabaseHub.signUp(cfg, email, password, (s) => saveSession(cfg, s))
  return h ? { confirm: false, status: start(h) } : { confirm: true, status: syncStatus() }
}

function adminHub(): SupabaseHub {
  if (!hub) throw new Error('Sign in first.')
  if (!admin) throw new Error('Only the hub’s administrators can approve accounts.')
  return hub
}

async function approve(email: string): Promise<SignupApproval[]> {
  const h = adminHub()
  const clean = email.trim().toLowerCase()
  if (!looksLikeEmail(clean)) throw new Error('That doesn’t look like an email address.')
  try {
    await h.approve(clean)
  } catch (err) {
    if (!(err instanceof HubError) || err.status !== 409) throw err
    const existing = (await h.approvals()).find((a) => a.email === clean)
    throw new Error(
      existing?.usedAt ? `${clean} already has an account.` : `${clean} is already approved.`
    )
  }
  return h.approvals()
}

async function signOut(): Promise<SyncStatus> {
  const h = hub
  end()
  clearSession()
  await h?.signOut()
  return syncStatus()
}

export function registerSyncIpc(opts: { onSettingsSynced: () => void }): void {
  onSettingsSynced = opts.onSettingsSynced
  // coming back to the window is a good moment to catch up
  app.on('browser-window-focus', () => {
    if (engine && !running && Date.now() - lastPassAt > FOCUS_GAP_MS) schedule(500)
  })
  ipcMain.handle('sync:status', () => syncStatus())
  // the window asks for the next phone recording to transcribe, then reports back
  ipcMain.handle('sync:nextUpload', () => {
    const next = [...toTranscribe][0] ?? null
    if (next) {
      toTranscribe.delete(next)
      transcribing.add(next)
    }
    return next
  })
  ipcMain.handle('sync:uploadDone', (_e, id: string, error?: string) => {
    transcribing.delete(id)
    if (!error) return
    // an unreadable recording would otherwise be offered again every pass
    const m = readMeeting(id)
    if (m && m.stage === 'uploaded') {
      const failed = { ...m, stage: 'error' as const, error: `Couldn't transcribe the recording from your phone: ${error}` }
      writeMeeting(failed)
      broadcast('meeting:updated', failed)
    }
  })
  ipcMain.handle('sync:signIn', (_e, email: string, password: string) => signIn(email, password))
  ipcMain.handle('sync:signUp', (_e, email: string, password: string) => signUp(email, password))
  ipcMain.handle('sync:approvals', () => adminHub().approvals())
  ipcMain.handle('sync:approve', (_e, email: string) => approve(email))
  ipcMain.handle('sync:withdraw', async (_e, email: string) => {
    const h = adminHub()
    await h.withdraw(email)
    return h.approvals()
  })
  ipcMain.handle('sync:signOut', () => signOut())
  ipcMain.handle('sync:now', () => {
    schedule(0)
    return syncStatus()
  })
  ipcMain.handle('sync:changePassword', async (_e, password: string) => {
    if (!hub) throw new Error('Sign in first.')
    if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`)
    await hub.changePassword(password)
    return syncStatus()
  })
  ipcMain.handle('sync:setAudioDays', (_e, days: number) => {
    setSyncPrefs({ audioDays: days })
    schedule(AFTER_CHANGE_MS)
    return syncStatus()
  })
  ipcMain.handle('sync:resolveDeletes', (_e, choice: 'delete' | 'restore') => {
    if (!engine) return syncStatus()
    if (choice === 'delete') engine.confirmDeletes()
    else engine.restoreDeletes()
    schedule(0)
    return syncStatus()
  })
  ipcMain.handle('sync:setHub', async (_e, next: { url: string; key: string } | null) => {
    if (next) {
      let url: URL
      try {
        url = new URL(next.url.trim())
      } catch {
        throw new Error('That does not look like a web address.')
      }
      if (url.protocol !== 'https:') throw new Error('The hub address must start with https://')
      if (!next.key.trim()) throw new Error('Enter the hub’s publishable key.')
      next = { url: url.origin, key: next.key.trim() }
    }
    if (hub) await signOut()
    setSyncPrefs({ hub: next })
    return syncStatus()
  })
}
