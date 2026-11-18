import { useState } from 'react'
import { MIN_PASSWORD } from '../../../src/shared/hub'
import { useApp } from '../App'
import { TAB_SECTIONS, visibleSections } from '../sections'
import { ChevronIcon } from '../ui'

/** a new password for this account, here and on the PC */
function ChangePassword(): React.JSX.Element {
  const { hub, fail } = useApp()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null)

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setNote(null)
    if (pw.length < MIN_PASSWORD) return setNote({ ok: false, msg: `Use at least ${MIN_PASSWORD} characters.` })
    if (pw !== again) return setNote({ ok: false, msg: 'The two passwords don’t match.' })
    setBusy(true)
    try {
      await hub.changePassword(pw)
      setPw('')
      setAgain('')
      setOpen(false)
      setNote({ ok: true, msg: 'Password changed. Use the new one on your PC next time it asks.' })
    } catch (err) {
      setNote({ ok: false, msg: fail(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {open ? (
        <form className="form" onSubmit={save}>
          <label className="field">
            <span>New</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder={`${MIN_PASSWORD}+ characters`}
              aria-label="New password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Confirm</span>
            <input type="password" autoComplete="new-password" aria-label="Type the new password again" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          <div className="form-actions">
            <button type="button" className="link" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" type="submit" disabled={busy || !pw || !again}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </div>
        </form>
      ) : (
        <button className="row" onClick={() => setOpen(true)}>
          <span className="row-main">
            <span className="row-title">Change password</span>
          </span>
          <ChevronIcon size={18} />
        </button>
      )}
      {note && (
        <p className={`account-note ${note.ok ? 'ok' : 'bad'}`} role="status">
          {note.msg}
        </p>
      )}
    </>
  )
}

export function MoreView(): React.JSX.Element {
  const { hub, settings, signOut } = useApp()
  const items = visibleSections(settings?.hiddenTabs).filter((s) => !TAB_SECTIONS.includes(s.name))

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">More</h1>
      </header>
      <div className="group">
        {items.map(({ name, label, Icon }) => (
          <a key={name} className="row" href={`#/${name}`}>
            <span className="row-icon">
              <Icon size={20} />
            </span>
            <span className="row-main">
              <span className="row-title">{label}</span>
            </span>
            <ChevronIcon size={18} />
          </a>
        ))}
      </div>

      <section>
        <h2 className="section-title">Account</h2>
        <div className="group">
          <div className="row">
            <span className="row-main">
              <span className="row-title">{hub.email}</span>
              <span className="row-sub">Your theme and hidden sections follow Rowan on your PC.</span>
            </span>
          </div>
          <ChangePassword />
          <button className="row danger-row" onClick={signOut}>
            Sign out
          </button>
        </div>
      </section>
      <p className="fine">Mail and ClickUp stay on your PC: mail isn’t synced, and ClickUp has its own iPhone app.</p>
    </>
  )
}
