import { useEffect, useRef, useState } from 'react'
import { useApp } from '../App'
import {
  LiveRecording,
  defaultTitle,
  forget,
  importAudio,
  pending,
  send,
  updatePending,
  type PendingRecording
} from '../recorder'
import { MicIcon, Problem, Spinner, clock, dayLabel, duration, timeOf } from '../ui'

// the recording outlives this screen: switching tabs mid-meeting keeps it going
let live: LiveRecording | null = null
const listeners = new Set<() => void>()
function changed(): void {
  for (const l of listeners) l()
}

/** true while a recording is running, for the tab bar */
export function useRecording(): boolean {
  const [on, setOn] = useState(live !== null)
  useEffect(() => {
    const l = (): void => setOn(live !== null)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return on
}

type Sending = { id: string; progress: number } | null

export function RecordView(): React.JSX.Element {
  const { hub, go, fail } = useApp()
  const [title, setTitle] = useState(() => defaultTitle())
  const [notes, setNotes] = useState('')
  const recording = useRecording()
  const [, setFrame] = useState(0)
  const meterRef = useRef<HTMLSpanElement>(null)
  const [starting, setStarting] = useState(false)
  const [unsent, setUnsent] = useState<PendingRecording[]>([])
  const [sending, setSending] = useState<Sending>(null)
  const [sent, setSent] = useState<{ id: string; title: string } | null>(null)
  const [interrupted, setInterrupted] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshUnsent = (): void => {
    pending()
      .then(setUnsent)
      .catch(() => {})
  }

  useEffect(refreshUnsent, [])

  // the level meter moves every frame (straight on the element); the clock four times a second
  useEffect(() => {
    if (!recording) return
    let raf = 0
    let last = 0
    const loop = (t: number): void => {
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${Math.max(0.02, live?.level() ?? 0)})`
      if (t - last > 250) {
        last = t
        setFrame((n) => n + 1)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [recording])

  async function start(): Promise<void> {
    setError(null)
    setSent(null)
    setInterrupted(null)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser can’t record audio. Update iOS, or use Voice Memos and import the file below.')
      return
    }
    setStarting(true)
    const rec = new LiveRecording()
    try {
      await rec.start(title.trim() || defaultTitle())
      rec.onInterrupted = () => {
        setInterrupted(clock(rec.elapsedMs()))
        void finish(rec, true)
      }
      live = rec
      setNotes('')
      changed()
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      setError(
        name === 'NotAllowedError'
          ? 'Rowan isn’t allowed to use the microphone. Allow it in Settings → Safari (or for this web app), then try again.'
          : fail(err)
      )
    } finally {
      setStarting(false)
    }
  }

  async function finish(rec: LiveRecording, wasInterrupted = false): Promise<void> {
    const r = await rec.stop(wasInterrupted)
    if (live === rec) {
      live = null
      changed()
    }
    setTitle(defaultTitle())
    if (r.state === 'ready') await sendOne(r)
    else refreshUnsent()
  }

  async function sendOne(r: PendingRecording): Promise<void> {
    setSending({ id: r.id, progress: 0 })
    setError(null)
    try {
      await send(hub, r, (p) => setSending({ id: r.id, progress: p }))
      setSent({ id: r.id, title: r.title })
    } catch (err) {
      setError(fail(err))
    } finally {
      setSending(null)
      refreshUnsent()
    }
  }

  async function discard(): Promise<void> {
    if (!live || !confirm('Throw this recording away? It can’t be recovered.')) return
    const rec = live
    live = null
    changed()
    await rec.discard()
    setTitle(defaultTitle())
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return
    setError(null)
    setSent(null)
    try {
      await sendOne(await importAudio(file))
    } catch (err) {
      setError(fail(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (live) {
    const rec = live
    return (
      <div className="recording">
        <p className="eyebrow rec-live">
          <span className="rec-dot" aria-hidden="true" /> Recording
        </p>
        <input
          className="title-input center"
          value={title}
          aria-label="Meeting title"
          onChange={(e) => {
            setTitle(e.target.value)
            rec.setTitle(e.target.value)
          }}
        />
        <p className="big-clock" aria-live="off">
          {clock(rec.elapsedMs())}
        </p>
        <div className="meter" aria-hidden="true">
          <span ref={meterRef} />
        </div>
        <p className="fine">Keep Rowan open with the screen on. Locking the phone or switching apps stops the recording (what’s recorded so far is kept).</p>
        <textarea
          className="notes"
          rows={5}
          placeholder="Notes as you go. They go with the recording."
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value)
            rec.setNotes(e.target.value)
          }}
        />
        <button className="stop-btn" onClick={() => void finish(rec)} aria-label="Stop and send">
          <span className="stop-square" aria-hidden="true" />
        </button>
        <p className="stop-label">Stop &amp; send</p>
        <button className="link danger" onClick={() => void discard()}>
          Discard
        </button>
      </div>
    )
  }

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Record</h1>
      </header>
      <Problem error={error} />
      {interrupted && (
        <p className="note-warn">
          The recording stopped at {interrupted}, probably when the screen locked. Everything up to then was kept.
        </p>
      )}

      {sending ? (
        <div className="sending" role="status">
          <Spinner /> Sending… {Math.round(sending.progress * 100)}%
          <div className="progress">
            <span style={{ transform: `scaleX(${sending.progress})` }} />
          </div>
        </div>
      ) : sent ? (
        <div className="sent" role="status">
          <p>
            <b>Sent.</b> Your PC will transcribe and summarize it the next time it syncs.
          </p>
          <button className="link" onClick={() => go(`/meeting/${encodeURIComponent(sent.id)}`)}>
            Open “{sent.title}”
          </button>
        </div>
      ) : null}

      <div className="record-start">
        <input className="title-input center" value={title} aria-label="Meeting title" onChange={(e) => setTitle(e.target.value)} />
        <button className="rec-btn" onClick={() => void start()} disabled={starting || !!sending} aria-label="Start recording">
          {starting ? <Spinner /> : <MicIcon size={34} />}
        </button>
        <p className="fine">For in-person meetings. Set the phone down with Rowan open; the screen stays on while it records.</p>
      </div>

      <section>
        <h2 className="section-title">Recorded with the phone locked?</h2>
        <p className="fine left">
          Record in Voice Memos, then tap Share → Save to Files, and pick the file here. It’s transcribed the same way.
        </p>
        <button className="btn-secondary" disabled={!!sending} onClick={() => fileRef.current?.click()}>
          Choose a recording…
        </button>
        <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp4,.wav,.webm,.mp3" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      </section>

      {unsent.length > 0 && (
        <section>
          <h2 className="section-title">Not sent yet</h2>
          <div className="group">
            {unsent.map((r) => (
              <div key={r.id} className="row unsent">
                <span className="row-main">
                  <input
                    className="row-title-input"
                    defaultValue={r.title}
                    aria-label="Recording title"
                    onBlur={(e) => void updatePending(r.id, { title: e.target.value }).then(refreshUnsent)}
                  />
                  <span className="row-sub">
                    {[dayLabel(r.startedAt), timeOf(r.startedAt), duration(r.durationMs), r.interrupted ? 'stopped early' : ''].filter(Boolean).join(' · ')}
                  </span>
                  {r.error && <span className="row-note error">{r.error}</span>}
                </span>
                <span className="row-actions">
                  <button className="btn-primary small" disabled={!!sending} onClick={() => void sendOne(r)}>
                    Send
                  </button>
                  <button
                    className="link danger"
                    onClick={() => {
                      if (confirm('Delete this recording from the phone? It hasn’t been sent.')) void forget(r.id).then(refreshUnsent)
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
