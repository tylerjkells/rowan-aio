import { useState } from 'react'
import { Hub, hubConfig, setCustomHub } from '../api'
import { errorText } from '../ui'

export function SignIn({ note, onSignedIn }: { note: string | null; onSignedIn: (hub: Hub) => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(note)
  const [hubOpen, setHubOpen] = useState(() => hubConfig() === null)
  const [hubUrl, setHubUrl] = useState(() => hubConfig()?.url ?? '')
  const [hubKey, setHubKey] = useState(() => hubConfig()?.key ?? '')
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (hubOpen) {
        if (!/^https:\/\/\S+$/.test(hubUrl.trim()) || !hubKey.trim()) throw new Error('Enter the hub address (https://…) and its key.')
        setCustomHub({ url: hubUrl, key: hubKey })
      }
      onSignedIn(await Hub.signIn(email, password))
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
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
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
        <button className="btn-primary" type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && (
        <p className="problem" role="alert">
          {error}
        </p>
      )}
      <p className="fine">Use the same account as Settings → Sync on your PC.</p>
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
