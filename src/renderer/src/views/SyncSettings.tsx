import { useEffect, useState } from 'react'
import { MIN_PASSWORD, PHONE_APP_URL, confirmEmailNote, inviteText, looksLikeEmail, type SignupApproval } from '../../../shared/hub'
import type { SyncStatus } from '../../../shared/types'

/** the live sync status, kept current by the main process */
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    window.scribe.sync.status().then(setStatus)
    return window.scribe.sync.onStatus(setStatus)
  }, [])
  return status
}

const AUDIO_WINDOWS = [
  { days: 0, label: 'Keep recordings off the hub' },
  { days: 3, label: 'Last 3 days' },
  { days: 7, label: 'Last 7 days' },
  { days: 14, label: 'Last 14 days' },
  { days: 30, label: 'Last 30 days' }
]

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function ago(iso: string | null): string {
  if (!iso) return 'not yet'
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? `at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

function plainError(err: unknown): string {
  return err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(err)
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * For the hub's administrators: approve the email someone will create their
 * account with. Each approval works once; the person picks their own password.
 */
function WhoCanJoin(): React.JSX.Element {
  const [list, setList] = useState<SignupApproval[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    window.scribe.sync
      .approvals()
      .then(setList)
      .catch((err) => setNote({ ok: false, msg: plainError(err) }))
  }, [])

  async function run(fn: () => Promise<SignupApproval[]>, done?: string): Promise<boolean> {
    setBusy(true)
    setNote(null)
    try {
      setList(await fn())
      if (done) setNote({ ok: true, msg: done })
      return true
    } catch (err) {
      setNote({ ok: false, msg: plainError(err) })
      return false
    } finally {
      setBusy(false)
    }
  }

  function copyInvite(to: string): void {
    navigator.clipboard
      .writeText(inviteText(to))
      .then(() => setNote({ ok: true, msg: `Instructions for ${to} copied. Paste them into an email or Teams.` }))
  }

  const waiting = (list ?? []).filter((a) => !a.usedAt)
  const joined = (list ?? []).filter((a) => a.usedAt)

  return (
    <>
      <div className="card-subhead sync-gap">Who can join</div>
      <p className="opt-desc">
        Approve someone&apos;s work email, then send them the instructions. They create their own
        account and password in Rowan on their PC or phone; their data is private to them. Each
        approval works once.
      </p>
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault()
          const to = email.trim().toLowerCase()
          void run(() => window.scribe.sync.approve(to)).then((ok) => {
            if (!ok) return
            setEmail('')
            copyInvite(to)
          })
        }}
      >
        <input
          className="text-input sync-approve-input"
          type="email"
          placeholder="name@rowan.edu"
          aria-label="Email to approve"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy || !looksLikeEmail(email)}>
          Approve
        </button>
      </form>
      {note && (
        <p className={`field-note ${note.ok ? 'ok' : 'error'}`} role="status">
          {note.msg}
        </p>
      )}
      {list && list.length > 0 && (
        <ul className="sync-approvals">
          {waiting.map((a) => (
            <li key={a.email}>
              <span className="sync-approval-main">
                <span className="sync-approval-email">{a.email}</span>
                <span className="opt-desc">Approved {shortDate(a.addedAt)} · hasn&apos;t created an account yet</span>
              </span>
              <button className="btn btn-ghost" disabled={busy} onClick={() => copyInvite(a.email)}>
                Copy instructions
              </button>
              <button
                className="btn btn-ghost btn-danger"
                disabled={busy}
                onClick={() => void run(() => window.scribe.sync.withdraw(a.email), `Withdrew the approval for ${a.email}.`)}
              >
                Withdraw
              </button>
            </li>
          ))}
          {joined.map((a) => (
            <li key={a.email}>
              <span className="sync-approval-main">
                <span className="sync-approval-email">{a.email}</span>
                <span className="opt-desc">Joined {shortDate(a.usedAt as string)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function StateBadge({ status }: { status: SyncStatus }): React.JSX.Element {
  switch (status.state) {
    case 'syncing':
      return (
        <span className="badge badge-working">
          <span className="spinner" aria-hidden="true" /> Syncing
        </span>
      )
    case 'offline':
      return <span className="badge badge-quiet">Offline · will retry</span>
    case 'error':
      return <span className="badge badge-error">Sync problem</span>
    case 'attention':
      return <span className="badge badge-error">Needs your decision</span>
    default:
      return <span className="badge badge-quiet">Up to date ✓</span>
  }
}

/**
 * Settings → Sync: sign in to the hub, see how it's going, choose how much
 * audio rides along, and answer when a pass held back a burst of deletions.
 */
export function SyncSettings({ status }: { status: SyncStatus | null }): React.JSX.Element | null {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [newPw, setNewPw] = useState('')
  const [hubOpen, setHubOpen] = useState(false)
  const [hubUrl, setHubUrl] = useState('')
  const [hubKey, setHubKey] = useState('')
  const [channel, setChannel] = useState<'stable' | 'test' | 'dev'>('stable')
  // re-render once a minute so "synced 3 min ago" stays true
  const [, tick] = useState(0)

  useEffect(() => {
    window.scribe.appChannel().then(setChannel)
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  // a sign-in that lapsed arrives as a status with a message and no account
  useEffect(() => {
    if (status && !status.signedIn && status.message) setNote({ ok: false, msg: status.message })
  }, [status])

  if (!status) return null

  async function act(fn: () => Promise<unknown>, done?: string): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      await fn()
      if (done) setNote({ ok: true, msg: done })
    } catch (err) {
      setNote({ ok: false, msg: plainError(err) })
    } finally {
      setBusy(false)
    }
  }

  const hubForm = (
    <div className="sync-hub">
      {status.customHub ? (
        <div className="field-row">
          <span className="opt-desc sync-hub-url" title={status.hubUrl ?? ''}>
            Using the hub at {status.hubUrl}
          </span>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => act(() => window.scribe.sync.setHub(null))}
          >
            Use the built-in hub
          </button>
        </div>
      ) : hubOpen ? (
        <>
          <label className="field-label" htmlFor="sync-hub-url">
            Hub address
          </label>
          <input
            id="sync-hub-url"
            className="text-input"
            placeholder="https://xxxx.supabase.co"
            value={hubUrl}
            onChange={(e) => setHubUrl(e.target.value)}
          />
          <label className="field-label sync-gap" htmlFor="sync-hub-key">
            Publishable key
          </label>
          <input
            id="sync-hub-key"
            className="text-input"
            placeholder="sb_publishable_…"
            value={hubKey}
            onChange={(e) => setHubKey(e.target.value)}
          />
          <div className="field-row sync-gap">
            <button
              className="btn"
              disabled={busy || !hubUrl.trim() || !hubKey.trim()}
              onClick={() =>
                act(async () => {
                  await window.scribe.sync.setHub({ url: hubUrl, key: hubKey })
                  setHubOpen(false)
                })
              }
            >
              Use this hub
            </button>
            <button className="btn btn-ghost" onClick={() => setHubOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn btn-ghost sync-hub-toggle" onClick={() => setHubOpen(true)}>
          Use a different hub…
        </button>
      )}
    </div>
  )

  if (!status.available) {
    return (
      <>
        <p className="opt-desc">
          This version doesn&apos;t have a sync hub built in yet. If you were given a hub address
          and key, enter them here.
        </p>
        {hubForm}
        {note && (
          <p className={`field-note ${note.ok ? 'ok' : 'error'}`} role="status">
            {note.msg}
          </p>
        )}
      </>
    )
  }

  if (!status.signedIn) {
    const choose = (next: boolean): void => {
      setCreating(next)
      setNote(null)
      setConfirm('')
    }
    return (
      <>
        {channel !== 'stable' && (
          <p className="sync-callout">
            This is a {channel} build with its own data folder. Sign in with a test account, unless
            you want this test copy merged into your real library.
          </p>
        )}
        <div className="mode-toggle sync-mode" role="radiogroup" aria-label="Sign in or create an account">
          <button type="button" role="radio" aria-checked={!creating} className={creating ? '' : 'active'} onClick={() => choose(false)}>
            I have an account
          </button>
          <button type="button" role="radio" aria-checked={creating} className={creating ? 'active' : ''} onClick={() => choose(true)}>
            Create an account
          </button>
        </div>
        <p className="opt-desc sync-mode-desc">
          {creating
            ? 'First ask the person who runs your Rowan hub to approve your email. Then enter that email and choose your own password; you’ll use the same one on your phone.'
            : 'Sign in with the account you made here or on your phone.'}
        </p>
        <form
          className={`sync-signin ${creating ? 'creating' : ''}`}
          onSubmit={(e) => {
            e.preventDefault()
            act(async () => {
              if (creating) {
                if (password !== confirm) throw new Error('The two passwords don’t match.')
                const r = await window.scribe.sync.signUp(email, password)
                setPassword('')
                setConfirm('')
                if (r.confirm) {
                  // the account exists; the hub wants the email confirmed before it lets them in
                  setCreating(false)
                  setNote({ ok: true, msg: confirmEmailNote(email) })
                }
              } else {
                await window.scribe.sync.signIn(email, password)
                setPassword('')
              }
            })
          }}
        >
          <input
            className="text-input"
            type="email"
            autoComplete="username"
            placeholder={creating ? 'Your approved email' : 'Email'}
            aria-label="Sync account email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="text-input"
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            placeholder={creating ? `Choose a password (${MIN_PASSWORD}+ characters)` : 'Password'}
            aria-label={creating ? 'Choose a sync password' : 'Sync account password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {creating && (
            <input
              className="text-input"
              type="password"
              autoComplete="new-password"
              placeholder="Type it again"
              aria-label="Confirm the sync password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={
              busy ||
              !email.trim() ||
              (creating ? password.length < MIN_PASSWORD || !confirm : !password)
            }
          >
            {creating ? (busy ? 'Creating…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {note && (
          <p className={`field-note ${note.ok ? 'ok' : 'error'}`} role="status">
            {note.msg}
          </p>
        )}
        <p className="opt-desc sync-gap">
          The first time you sign in, this PC&apos;s library uploads in the background; another PC
          signing in to the same account then gets all of it.
        </p>
        {hubForm}
      </>
    )
  }

  return (
    <>
      <div className="field-row sync-state">
        <StateBadge status={status} />
        <span className="opt-desc">
          {status.email} · last synced {ago(status.lastSyncAt)}
        </span>
      </div>
      {status.message && (status.state === 'syncing' || status.state === 'offline' || status.state === 'error') && (
        <p className={`field-note ${status.state === 'error' ? 'error' : ''}`} role="status">
          {status.message}
        </p>
      )}

      {status.heldDeletes > 0 && (
        <div className="sync-callout" role="alert">
          <p>
            {status.heldDeletes} {status.heldDeletes === 1 ? 'item was' : 'items were'} deleted on
            this PC all at once. To be safe, sync is holding those deletions back instead of
            removing them from your other devices.
          </p>
          <div className="field-row">
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => act(() => window.scribe.sync.resolveDeletes('delete'))}
            >
              Delete them everywhere
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => act(() => window.scribe.sync.resolveDeletes('restore'))}
            >
              Bring them back here
            </button>
          </div>
        </div>
      )}

      <div className="field-row sync-gap">
        <button className="btn" disabled={busy || status.state === 'syncing'} onClick={() => act(() => window.scribe.sync.now())}>
          Sync now
        </button>
        <button className="btn btn-ghost" onClick={() => setPwOpen((v) => !v)}>
          Change password…
        </button>
        <button className="btn btn-ghost btn-danger" disabled={busy} onClick={() => act(() => window.scribe.sync.signOut())}>
          Sign out
        </button>
      </div>
      {pwOpen && (
        <form
          className="field-row sync-gap"
          onSubmit={(e) => {
            e.preventDefault()
            act(async () => {
              await window.scribe.sync.changePassword(newPw)
              setNewPw('')
              setPwOpen(false)
            }, 'Password changed.')
          }}
        >
          <input
            className="text-input"
            type="password"
            autoComplete="new-password"
            placeholder="New password (8+ characters)"
            aria-label="New sync password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy || newPw.length < 8}>
            Save
          </button>
        </form>
      )}
      {note && (
        <p className={`field-note ${note.ok ? 'ok' : 'error'}`} role="status">
          {note.msg}
        </p>
      )}

      <div className="card-subhead sync-gap">Recordings</div>
      <select
        className="text-input sync-audio"
        aria-label="Recordings kept in the hub"
        value={status.audioDays}
        onChange={(e) => act(() => window.scribe.sync.setAudioDays(Number(e.target.value)))}
      >
        {AUDIO_WINDOWS.map((w) => (
          <option key={w.days} value={w.days}>
            {w.label}
          </option>
        ))}
        {!AUDIO_WINDOWS.some((w) => w.days === status.audioDays) && (
          <option value={status.audioDays}>Last {status.audioDays} days</option>
        )}
      </select>
      <p className="opt-desc sync-gap">
        Transcripts, summaries and notes always sync. Recent recordings ride along so you can play
        them on your other devices; older ones stay on the PC that recorded them. The same choice
        applies on all your PCs.
      </p>
      {status.tooLarge > 0 && (
        <p className="opt-desc">
          {status.tooLarge} {status.tooLarge === 1 ? 'file is' : 'files are'} over the hub&apos;s 50 MB
          limit per file, so {status.tooLarge === 1 ? 'it stays' : 'they stay'} on this PC only.
        </p>
      )}
      <div className="card-subhead sync-gap">Your phone</div>
      <p className="opt-desc">
        On your iPhone, open <span className="sync-url">{PHONE_APP_URL}</span> in Safari, sign in with
        this account, then tap Share → Add to Home Screen. You can read and edit meetings there, check
        off action items, use the Planner, and record in-person meetings, which this PC transcribes.
      </p>
      <div className="field-row">
        <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(PHONE_APP_URL).then(() => setNote({ ok: true, msg: 'Link copied.' }))}>
          Copy link
        </button>
      </div>
      {status.usage && (
        <p className="opt-desc">
          Your share of the hub: {formatBytes(status.usage.docBytes)} of notes and transcripts,{' '}
          {formatBytes(status.usage.fileBytes)} of recordings and files.
        </p>
      )}
      {status.admin && <WhoCanJoin />}
      {status.customHub && hubForm}
    </>
  )
}
