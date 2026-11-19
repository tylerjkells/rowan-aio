import { useState } from 'react'
import { MIN_PASSWORD, confirmEmailNote, looksLikeEmail } from '../../../src/shared/hub'
import { Hub, hubConfig, setCustomHub } from '../api'
import { errorText } from '../ui'

export function SignIn({ note, onSignedIn }: { note: string | null; onSignedIn: (hub: Hub) => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(note)
  const [info, setInfo] = useState<string | null>(null)
  const [hubOpen, setHubOpen] = useState(() => hubConfig() === null)
  const [hubUrl, setHubUrl] = useState(() => hubConfig()?.url ?? '')
  const [hubKey, setHubKey] = useState(() => hubConfig()?.key ?? '')
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (hubOpen) {
        if (!/^https:\/\/\S+$/.test(hubUrl.trim()) || !hubKey.trim()) throw new Error('Enter the hub address (https://…) and its key.')
        setCustomHub({ url: hubUrl, key: hubKey })
      }
      if (creating) {
        if (!looksLikeEmail(email)) throw new Error('Enter the email that was approved for you.')
        if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password.`)
        if (password !== confirm) throw new Error('The two passwords don’t match.')
        const hub = await Hub.signUp(email, password)
        if (hub) onSignedIn(hub)
        else {
          // the account exists; the hub wants the email confirmed before it lets them in
          setCreating(false)
          setPassword('')
          setConfirm('')
          setInfo(confirmEmailNote(email))
        }
      } else {
        onSignedIn(await Hub.signIn(email, password))
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <div className="signin-mark" aria-hidden="true">
        <span className="brand-dot" />
      </div>
      <h1 className="large-title">Rowan</h1>
      <p className="signin-sub">Your meetings, action items and planner, from your PC.</p>

      <form className="group form" onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            placeholder={creating ? `${MIN_PASSWORD}+ characters` : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {creating && (
          <label className="field">
            <span>Confirm</span>
            <input type="password" autoComplete="new-password" aria-label="Type the password again" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {hubOpen && (
          <>
            <label className="field">
              <span>Hub</span>
              <input type="url" placeholder="https://xxxx.supabase.co" autoCapitalize="off" autoCorrect="off" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
            </label>
            <label className="field">
              <span>Key</span>
              <input placeholder="sb_publishable_…" autoCapitalize="off" autoCorrect="off" value={hubKey} onChange={(e) => setHubKey(e.target.value)} />
            </label>
          </>
        )}
        <button className="btn-primary" type="submit" disabled={busy || !email.trim() || !password || (creating && !confirm)}>
          {creating ? (busy ? 'Creating…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && (
        <p className="problem" role="alert">
          {error}
        </p>
      )}
      {info && (
        <p className="notice" role="status">
          {info}
        </p>
      )}
      <p className="fine">
        {creating
          ? 'Use the email the person who runs your Rowan hub approved, and choose your own password. Your PC signs in with the same one.'
          : 'Use the same account as Settings → Sync on your PC.'}
      </p>
      <button
        className="link"
        onClick={() => {
          setCreating((v) => !v)
          setError(null)
          setConfirm('')
        }}
      >
        {creating ? 'I already have an account' : 'Create an account'}
      </button>
      {!hubOpen && (
        <button className="link" onClick={() => setHubOpen(true)}>
          Use a different hub
        </button>
      )}
      {!standalone && (
        <p className="fine install">
          To keep Rowan on your Home Screen: tap Share, then <b>Add to Home Screen</b>.
        </p>
      )}
    </div>
  )
}
