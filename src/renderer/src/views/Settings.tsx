import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AppTheme,
  EngineProgress,
  EngineStatus,
  WhisperModel
} from '../../../shared/types'

const THEMES: { id: AppTheme; title: string; desc: string; bg: string; accent: string }[] = [
  { id: 'studio', title: 'Studio', desc: 'Warm dark, signal red. The default.', bg: '#1b1717', accent: '#dc5546' },
  { id: 'rowan', title: 'Rowan', desc: 'Brown & gold, after the Profs.', bg: '#211a10', accent: '#e5b52e' },
  { id: 'slate', title: 'Slate', desc: 'Cool graphite, steel blue.', bg: '#16181d', accent: '#5e95dd' },
  { id: 'paper', title: 'Paper', desc: 'Light, for bright offices.', bg: '#f8f6f3', accent: '#c33e2e' }
]

const WHISPER_MODELS: { id: WhisperModel; title: string; desc: string }[] = [
  { id: 'base.en', title: 'Base', desc: 'Fastest, ~140 MB. Fine for clear audio.' },
  { id: 'small.en', title: 'Small', desc: 'Recommended: good accuracy, ~470 MB.' },
  { id: 'medium.en', title: 'Medium', desc: 'Most accurate, ~1.5 GB, slower.' },
  {
    id: 'small.en-tdrz',
    title: 'Small + speaker turns',
    desc: 'Experimental: marks where the speaker changes for cleaner labels. ~470 MB.'
  }
]

const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5', title: 'Claude Haiku 4.5', desc: 'Recommended: excellent summaries for pennies.' },
  { id: 'claude-sonnet-5', title: 'Claude Sonnet 5', desc: 'Stronger on long or messy meetings.' },
  { id: 'claude-opus-4-8', title: 'Claude Opus 4.8', desc: 'Highest quality, highest cost.' }
]

function SwitchRow({
  title,
  desc,
  checked,
  onToggle
}: {
  title: string
  desc: string
  checked: boolean
  onToggle: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="switch-row">
      <span className="switch-label">
        <span className="opt-title">{title}</span>
        <span className="opt-desc">{desc}</span>
      </span>
      <button
        className={`switch ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onToggle(!checked)}
      >
        <span className="switch-knob" aria-hidden="true" />
      </button>
    </div>
  )
}

/** a minutes field that only saves once the user is done typing */
function MinutesRow({
  label,
  value,
  onCommit
}: {
  label: string
  value: number
  onCommit: (minutes: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => setDraft(String(value)), [value])

  function commit(): void {
    const n = Math.round(Number(draft))
    if (!Number.isFinite(n) || n === value) {
      setDraft(String(value))
      return
    }
    onCommit(Math.min(240, Math.max(1, n)))
  }

  return (
    <div className="field-row minutes-row">
      <label className="switch-label" htmlFor={`minutes-${label}`}>
        <span className="opt-title">{label}</span>
      </label>
      <input
        id={`minutes-${label}`}
        className="text-input minutes-input"
        type="number"
        min={1}
        max={240}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span className="opt-desc">minutes</span>
    </div>
  )
}

function OptRow({
  title,
  desc,
  tag,
  selected,
  disabled,
  onSelect
}: {
  title: string
  desc: string
  tag?: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      className={`opt-row ${selected ? 'selected' : ''}`}
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="radio-dot" aria-hidden="true" />
      <span className="opt-body">
        <span className="opt-title">{title}</span>
        <span className="opt-desc">{desc}</span>
      </span>
      {tag && <span className="opt-tag">{tag}</span>}
    </button>
  )
}

export function SettingsView({
  settings,
  onChange,
  engine
}: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  engine: EngineStatus | null
}): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState('')
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [dlProgress, setDlProgress] = useState<EngineProgress | null>(null)
  const [downloading, setDownloading] = useState<WhisperModel | null>(null)
  const [personDraft, setPersonDraft] = useState('')
  const [vocabDraft, setVocabDraft] = useState(settings.vocabulary)
  const [backingUp, setBackingUp] = useState(false)
  const [claude, setClaude] = useState<{
    claudeFound: boolean
    configured: boolean
    claudeRunning: boolean
  } | null>(null)
  const [claudeNote, setClaudeNote] = useState<{ ok: boolean; msg: string } | null>(null)
  const [backupNote, setBackupNote] = useState<{ ok: boolean; msg: string } | null>(null)
  const [calDraft, setCalDraft] = useState('')
  const [calStatus, setCalStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [connectingCal, setConnectingCal] = useState(false)
  const [storage, setStorage] = useState<{ count: number; totalBytes: number; audioBytes: number } | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.scribe.meetings.storageStats().then(setStorage)
    window.scribe.appVersion().then(setVersion)
    window.scribe.claude.status().then(setClaude)
  }, [])

  useEffect(() => window.scribe.engine.onProgress(setDlProgress), [])

  function formatBytes(n: number): string {
    if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`
    if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`
    return `${Math.max(1, Math.round(n / 1024))} KB`
  }

  async function saveKey(): Promise<void> {
    const key = keyDraft.trim()
    if (!key) return
    setSavingKey(true)
    setKeyStatus(null)
    const test = await window.scribe.settings.testApiKey(key)
    if (!test.ok) {
      setKeyStatus({ ok: false, msg: test.error ?? 'Key check failed' })
      setSavingKey(false)
      return
    }
    const next = await window.scribe.settings.setApiKey(key)
    onChange(next)
    setKeyDraft('')
    setKeyStatus({ ok: true, msg: 'Key verified and saved securely.' })
    setSavingKey(false)
  }

  async function removeKey(): Promise<void> {
    const next = await window.scribe.settings.setApiKey(null)
    onChange(next)
    setKeyStatus(null)
  }

  async function pickWhisper(model: WhisperModel): Promise<void> {
    const hasModel = engine?.models.includes(model)
    const next = await window.scribe.settings.update({ whisperModel: model })
    onChange(next)
    if (!hasModel) {
      setDownloading(model)
      try {
        await window.scribe.engine.setup(model)
      } finally {
        setDownloading(null)
        setDlProgress(null)
      }
    }
  }

  async function backupNow(): Promise<void> {
    setBackingUp(true)
    setBackupNote(null)
    try {
      const result = await window.scribe.backup.run()
      if (result) {
        setBackupNote({
          ok: true,
          msg: `Backed up to ${result.path} (${formatBytes(result.bytes)}).`
        })
      }
    } catch (err) {
      setBackupNote({
        ok: false,
        msg: err instanceof Error ? err.message : 'Backup failed.'
      })
    } finally {
      setBackingUp(false)
    }
  }

  async function connectCalendar(): Promise<void> {
    const url = calDraft.trim()
    if (!url) return
    setConnectingCal(true)
    setCalStatus(null)
    const result = await window.scribe.calendar.connect(url)
    if (result.ok) {
      onChange(await window.scribe.settings.get())
      setCalDraft('')
      setCalStatus({
        ok: true,
        msg: `Connected — ${result.countThisWeek ?? 0} event${result.countThisWeek === 1 ? '' : 's'} in the next 7 days.`
      })
    } else {
      setCalStatus({ ok: false, msg: result.error ?? 'Could not read that feed.' })
    }
    setConnectingCal(false)
  }

  async function disconnectCalendar(): Promise<void> {
    onChange(await window.scribe.calendar.disconnect())
    setCalStatus(null)
  }

  async function addPersonToDirectory(): Promise<void> {
    const name = personDraft.trim()
    if (!name) return
    onChange(await window.scribe.settings.update({ people: [...settings.people, name] }))
    setPersonDraft('')
  }

  return (
    <div className="settings-wrap">
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Appearance</h2>
          <p className="hint">Applies immediately, everywhere in the app.</p>
        </header>
        <div className="settings-body">
          <div className="theme-grid" role="radiogroup" aria-label="Color scheme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-opt ${settings.theme === t.id ? 'selected' : ''}`}
                role="radio"
                aria-checked={settings.theme === t.id}
                onClick={async () => {
                  document.documentElement.dataset.theme = t.id
                  onChange(await window.scribe.settings.update({ theme: t.id }))
                }}
              >
                <span className="theme-swatch" style={{ background: t.bg }} aria-hidden="true">
                  <span className="theme-swatch-dot" style={{ background: t.accent }} />
                </span>
                <span className="theme-name">{t.title}</span>
                <span className="opt-desc">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>AI summaries</h2>
          <p className="hint">
            Billed per use by Anthropic, typically 1–5 cents per meeting. Keys come from
            console.anthropic.com and are stored encrypted on this machine.
          </p>
        </header>
        <div className="settings-body">
          {settings.hasApiKey ? (
            <div className="field-row">
              <span className="badge badge-quiet">API key saved ✓</span>
              <button className="btn btn-ghost btn-danger" onClick={removeKey}>
                Remove
              </button>
            </div>
          ) : (
            <div className="field-row">
              <input
                className="text-input"
                type="password"
                placeholder="sk-ant-…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                aria-label="Claude API key"
              />
              <button className="btn btn-primary" onClick={saveKey} disabled={savingKey || !keyDraft.trim()}>
                {savingKey ? 'Checking…' : 'Save'}
              </button>
            </div>
          )}
          {keyStatus && (
            <p className={`field-note ${keyStatus.ok ? 'ok' : 'error'}`} role="status">
              {keyStatus.msg}
            </p>
          )}

          <div className="card-subhead">Model</div>
          <div className="opt-list" role="radiogroup" aria-label="Summary model">
            {CLAUDE_MODELS.map((m) => (
              <OptRow
                key={m.id}
                title={m.title}
                desc={m.desc}
                selected={settings.claudeModel === m.id}
                onSelect={async () =>
                  onChange(await window.scribe.settings.update({ claudeModel: m.id }))
                }
              />
            ))}
          </div>

          <div className="switch-row">
            <span className="switch-label">
              <span className="opt-title">Summarize automatically</span>
              <span className="opt-desc">
                {settings.autoSummarize
                  ? 'Every recording is summarized right after transcription.'
                  : 'Transcripts only; summarize meetings by hand.'}
              </span>
            </span>
            <button
              className={`switch ${settings.autoSummarize ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.autoSummarize}
              aria-label="Summarize automatically"
              onClick={async () =>
                onChange(
                  await window.scribe.settings.update({ autoSummarize: !settings.autoSummarize })
                )
              }
            >
              <span className="switch-knob" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Transcription</h2>
          <p className="hint">
            Runs entirely on this machine; audio never leaves it. Picking a model you haven&apos;t
            downloaded fetches it first.
          </p>
        </header>
        <div className="settings-body">
          <div className="opt-list" role="radiogroup" aria-label="Transcription model">
            {WHISPER_MODELS.map((m) => (
              <OptRow
                key={m.id}
                title={m.title}
                desc={m.desc}
                tag={
                  downloading === m.id
                    ? 'downloading…'
                    : engine?.models.includes(m.id)
                      ? 'downloaded'
                      : undefined
                }
                selected={settings.whisperModel === m.id}
                disabled={downloading !== null}
                onSelect={() => pickWhisper(m.id)}
              />
            ))}
          </div>
          {downloading && dlProgress && (
            <div className="setup-progress" aria-live="polite">
              {dlProgress.detail}
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: dlProgress.percent >= 0 ? `${dlProgress.percent}%` : '100%',
                    opacity: dlProgress.percent >= 0 ? 1 : 0.35
                  }}
                />
              </div>
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="vocab-hints">
              Vocabulary hints
            </label>
            <textarea
              id="vocab-hints"
              className="text-input vocab-input"
              placeholder="Banner, Slate, Canvas, Rowan Global, Dr. Okafor, NJWELL…"
              value={vocabDraft}
              onChange={(e) => setVocabDraft(e.target.value)}
              onBlur={async () => {
                if (vocabDraft.trim() !== settings.vocabulary) {
                  onChange(await window.scribe.settings.update({ vocabulary: vocabDraft }))
                }
              }}
            />
            <p className="opt-desc">
              Names, acronyms, and jargon that speech recognition tends to mangle. Applied to
              future transcriptions and summaries.
            </p>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Auto-end recordings</h2>
          <p className="hint">
            For the meetings you walk away from. Either rule shows a 30-second warning first, with
            a &ldquo;Keep recording&rdquo; button, and pausing on purpose never counts as silence.
          </p>
        </header>
        <div className="settings-body">
          <SwitchRow
            title="Stop when the audio goes quiet"
            desc="Nothing on your mic or from the call for a stretch — the meeting is over and the recorder is still running."
            checked={settings.autoEndSilence}
            onToggle={async (v) =>
              onChange(await window.scribe.settings.update({ autoEndSilence: v }))
            }
          />
          {settings.autoEndSilence && (
            <MinutesRow
              label="Silence before stopping"
              value={settings.autoEndSilenceMinutes}
              onCommit={async (v) =>
                onChange(await window.scribe.settings.update({ autoEndSilenceMinutes: v }))
              }
            />
          )}
          <SwitchRow
            title="Stop after the scheduled end"
            desc={
              settings.hasCalendar
                ? 'Recordings started inside a calendar event stop once they run well past its end time.'
                : 'Needs a connected calendar — the scheduled end comes from the event the recording started in.'
            }
            checked={settings.autoEndOverrun}
            onToggle={async (v) =>
              onChange(await window.scribe.settings.update({ autoEndOverrun: v }))
            }
          />
          {settings.autoEndOverrun && (
            <MinutesRow
              label="Grace past the scheduled end"
              value={settings.autoEndOverrunMinutes}
              onCommit={async (v) =>
                onChange(await window.scribe.settings.update({ autoEndOverrunMinutes: v }))
              }
            />
          )}
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Calendar</h2>
          <p className="hint">
            Read-only, via your calendar&apos;s secret iCal address, stored encrypted on this
            machine. Powers the Today view and titles recordings after their events. In Outlook on
            the web: Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS
            link. In Google Calendar: your calendar&apos;s settings → Integrate calendar → Secret
            address in iCal format.
          </p>
        </header>
        <div className="settings-body">
          {settings.hasCalendar ? (
            <div className="field-row">
              <span className="badge badge-quiet">Calendar connected ✓</span>
              <button className="btn btn-ghost btn-danger" onClick={disconnectCalendar}>
                Remove
              </button>
            </div>
          ) : (
            <div className="field-row">
              <input
                className="text-input"
                type="password"
                placeholder="https://…/calendar.ics"
                value={calDraft}
                onChange={(e) => setCalDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connectCalendar()}
                aria-label="Calendar iCal address"
              />
              <button
                className="btn btn-primary"
                onClick={connectCalendar}
                disabled={connectingCal || !calDraft.trim()}
              >
                {connectingCal ? 'Checking…' : 'Connect'}
              </button>
            </div>
          )}
          {calStatus && (
            <p className={`field-note ${calStatus.ok ? 'ok' : 'error'}`} role="status">
              {calStatus.msg}
            </p>
          )}
          {settings.hasCalendar && (
            <div className="switch-row">
              <span className="switch-label">
                <span className="opt-title">Nudge to record</span>
                <span className="opt-desc">
                  Notify when a meeting with a call link or room starts and nothing is recording.
                </span>
              </span>
              <button
                className={`switch ${settings.recordNudge ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.recordNudge}
                aria-label="Nudge to record"
                onClick={async () =>
                  onChange(
                    await window.scribe.settings.update({ recordNudge: !settings.recordNudge })
                  )
                }
              >
                <span className="switch-knob" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Team directory</h2>
          <p className="hint">
            Offered when assigning action items. Assigning a new name or naming a speaker adds
            people here automatically.
          </p>
        </header>
        <div className="settings-body">
          <div className="field-row">
            <input
              className="text-input"
              placeholder="Add a name"
              value={personDraft}
              onChange={(e) => setPersonDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPersonToDirectory()}
              aria-label="Add a person to the team directory"
            />
            <button className="btn" onClick={addPersonToDirectory} disabled={!personDraft.trim()}>
              Add
            </button>
          </div>
          {settings.people.length > 0 ? (
            <div className="dir-list" role="list">
              {settings.people.map((p) => (
                <div className="dir-row" role="listitem" key={p}>
                  <span className="dir-name">{p}</span>
                  <button
                    className="dir-remove"
                    aria-label={`Remove ${p} from directory`}
                    onClick={async () =>
                      onChange(
                        await window.scribe.settings.update({
                          people: settings.people.filter((x) => x !== p)
                        })
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="opt-desc">Nobody yet. Add your usual meeting crowd.</p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Storage</h2>
          <p className="hint">
            Meetings live on this machine only. Reclaim space from any meeting&apos;s page with
            &ldquo;Delete audio, keep notes&rdquo;.
          </p>
        </header>
        <div className="settings-body">
          {storage && storage.count > 0 ? (
            <>
              <p className="hint">
                {storage.count} {storage.count === 1 ? 'meeting' : 'meetings'} ·{' '}
                {formatBytes(storage.totalBytes)} total
              </p>
              <div className="storage-bar" aria-hidden="true">
                <div
                  className="storage-audio"
                  style={{
                    width: `${storage.totalBytes ? Math.round((storage.audioBytes / storage.totalBytes) * 100) : 0}%`
                  }}
                />
              </div>
              <p className="opt-desc storage-legend">
                <span className="legend-dot audio" /> Audio {formatBytes(storage.audioBytes)}
                <span className="legend-dot rest" /> Transcripts &amp; notes{' '}
                {formatBytes(Math.max(0, storage.totalBytes - storage.audioBytes))}
              </p>
            </>
          ) : (
            <p className="opt-desc">No meetings stored yet.</p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Claude app</h2>
          <p className="hint">
            Connect the Claude Desktop app to your meeting library (read-only, via a local MCP
            server). Then Claude can answer questions about your meetings, build reports and
            spreadsheets from them, or create tasks in tools like ClickUp — your data only goes
            where you send it in a conversation. Order matters: quit Claude Desktop fully (tray →
            Quit), connect here, then start it.
          </p>
        </header>
        <div className="settings-body">
          {claude?.configured ? (
            <div className="field-row">
              <span className="badge badge-quiet">Connected to Claude Desktop ✓</span>
              <button
                className="btn btn-ghost btn-danger"
                onClick={async () => {
                  setClaude(await window.scribe.claude.disconnect())
                  setClaudeNote(null)
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="field-row">
              <button
                className="btn btn-primary"
                onClick={async () => {
                  setClaudeNote(null)
                  try {
                    setClaude(await window.scribe.claude.connect())
                    setClaudeNote({
                      ok: true,
                      msg: 'Connected. Now start Claude Desktop — meetingscribe appears under Settings → Developer and in the chat tools menu.'
                    })
                  } catch (err) {
                    setClaudeNote({
                      ok: false,
                      msg: err instanceof Error ? err.message : 'Could not update the Claude config.'
                    })
                  }
                }}
              >
                Connect Claude Desktop
              </button>
              {claude && !claude.claudeFound && (
                <span className="opt-desc">Claude Desktop not detected on this PC.</span>
              )}
            </div>
          )}
          {claudeNote && (
            <p className={`field-note ${claudeNote.ok ? 'ok' : 'error'}`} role="status">
              {claudeNote.msg}
            </p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>System</h2>
          <p className="hint">
            Keep MeetingScribe on duty in the background — the record nudge and calendar only
            work while the app is running.
          </p>
        </header>
        <div className="settings-body">
          <SwitchRow
            title="Close to tray"
            desc="The ✕ button hides the app to the system tray instead of quitting. Quit from the tray menu."
            checked={settings.closeToTray}
            onToggle={async (v) => onChange(await window.scribe.settings.update({ closeToTray: v }))}
          />
          <SwitchRow
            title="Launch at login"
            desc="Start hidden in the tray when Windows starts. (Applies to the installed app, not dev runs.)"
            checked={settings.launchAtLogin}
            onToggle={async (v) =>
              onChange(await window.scribe.settings.update({ launchAtLogin: v }))
            }
          />
          <SwitchRow
            title="Global record shortcut"
            desc="Ctrl+Alt+R brings MeetingScribe forward on the Record page from anywhere."
            checked={settings.recordHotkey}
            onToggle={async (v) =>
              onChange(await window.scribe.settings.update({ recordHotkey: v }))
            }
          />
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Backup</h2>
          <p className="hint">
            The library lives in one folder on this PC. Back it up on demand, or pick a folder
            (a synced one works well) for automatic weekly backups — the last 8 are kept.
          </p>
        </header>
        <div className="settings-body">
          <div className="field-row">
            <button className="btn" onClick={backupNow} disabled={backingUp}>
              {backingUp ? 'Backing up…' : 'Back up now…'}
            </button>
            {settings.backupFolder ? (
              <>
                <span className="opt-desc backup-folder" title={settings.backupFolder}>
                  Weekly → {settings.backupFolder}
                </span>
                <button
                  className="btn btn-ghost"
                  onClick={async () =>
                    onChange(await window.scribe.settings.update({ backupFolder: null }))
                  }
                >
                  Turn off weekly
                </button>
              </>
            ) : (
              <button
                className="btn btn-ghost"
                onClick={async () => onChange(await window.scribe.backup.chooseFolder())}
              >
                Choose weekly backup folder…
              </button>
            )}
          </div>
          {backupNote && (
            <p className={`field-note ${backupNote.ok ? 'ok' : 'error'}`} role="status">
              {backupNote.msg}
            </p>
          )}
          <SwitchRow
            title="Skip audio in backups"
            desc="Transcripts, summaries, and notes only — archives stay small. Audio is the bulky part."
            checked={settings.backupSkipAudio}
            onToggle={async (v) =>
              onChange(await window.scribe.settings.update({ backupSkipAudio: v }))
            }
          />
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>Privacy</h2>
        </header>
        <div className="settings-body">
          <p className="opt-desc">
            Audio is recorded, transcribed, and stored only on this PC — recordings never leave
            it. Exactly two things ever go over the network: transcript text sent to
            Anthropic&apos;s Claude API when you summarize or ask questions (not used to train
            models under Anthropic&apos;s commercial terms), and read-only fetches of your
            calendar feed. Delete a meeting and it is gone; there is no cloud copy.
          </p>
        </div>
      </section>

      <section className="settings-section">
        <header className="settings-label">
          <h2>About</h2>
        </header>
        <div className="settings-body">
          <p className="opt-desc">
            MeetingScribe {version ? `v${version}` : ''} · updates install automatically from{' '}
            <a href="https://github.com/tylerjkells/meeting-scribe/releases" target="_blank" rel="noreferrer">
              GitHub releases
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  )
}
