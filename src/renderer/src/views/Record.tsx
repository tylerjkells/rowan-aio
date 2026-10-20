import { useEffect, useRef, useState } from 'react'
import type {
  CalendarEvent,
  EngineProgress,
  EngineStatus,
  PrepEntry,
  RecordingMode,
  TranscriptSegment
} from '../../../shared/types'
import { startRecording, readLevel, type RecorderHandles } from '../recorder'
import { PrepBody } from '../PrepDialog'
import { formatDuration, MicIcon, StopIcon, useConfirm } from '../ui'

/** "12:34" on the transcript's own clock, so a note lines up with what was said */
export function noteStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** the last stretch of a calendar meeting turns amber; past the end it says so */
const WARN_MS = 5 * 60 * 1000

function TimeLeft({ event, now }: { event: CalendarEvent; now: number }): React.JSX.Element {
  const end = new Date(event.end).getTime()
  const left = end - now
  const span = `${new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} – ${new Date(event.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  let chip: string
  if (left <= 0) chip = `Over by ${Math.max(1, Math.round(-left / 60000))} min`
  else if (left <= WARN_MS) chip = `${formatDuration(left)} left`
  else chip = `${Math.ceil(left / 60000)} min left`
  return (
    <div className="rec-event" aria-live="off">
      <span className="rec-event-span">{span}</span>
      <span className={`rec-left ${left <= WARN_MS ? 'warn' : ''}`}>{chip}</span>
    </div>
  )
}

export function RecordView({
  engine,
  autostart,
  onEngineReady,
  rec,
  setRec,
  paused,
  setPaused,
  finishing,
  stopError,
  onStop,
  onCancel
}: {
  engine: EngineStatus | null
  /** a notification or the tray asked to start recording right away */
  autostart?: { mode: RecordingMode; nonce: number }
  onEngineReady: (s: EngineStatus) => void
  rec: RecorderHandles | null
  setRec: (r: RecorderHandles | null) => void
  paused: boolean
  setPaused: (p: boolean) => void
  /** the shell is saving the recording (it also owns the auto-end path);
   *  transcription carries on in the background after that */
  finishing: boolean
  stopError: string | null
  onStop: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<RecordingMode>('virtual')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [liveSegs, setLiveSegs] = useState<TranscriptSegment[]>([])
  const [confirmEl, confirm] = useConfirm()
  const [notes, setNotes] = useState('')
  const [prepNote, setPrepNote] = useState<{ id: string; entry: PrepEntry } | null>(null)
  const [liveEvent, setLiveEvent] = useState<CalendarEvent | null>(null)
  const [recTitle, setRecTitle] = useState('')
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autostarted = useRef<number | null>(null)

  // prep written on the calendar follows you in here: if a calendar event is
  // live (or starts within a few minutes), its "before the meeting" note shows
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const ev = await window.scribe.calendar.liveEvent(new Date().toISOString())
        if (!ev || !alive) return
        const all = await window.scribe.prep.all()
        if (alive && all[ev.id]) setPrepNote({ id: ev.id, entry: all[ev.id] })
      } catch {
        // no calendar connected — nothing to show
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  const livePanelRef = useRef<HTMLDivElement>(null)

  // the calendar event this recording belongs to, for its name and how long is left
  useEffect(() => {
    setRecTitle('')
    if (!rec) {
      setLiveEvent(null)
      return
    }
    let alive = true
    window.scribe.calendar
      .liveEvent(new Date(rec.startedAt).toISOString())
      .then((ev) => {
        if (alive) setLiveEvent(ev && !ev.allDay ? ev : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [rec])

  // notes live next to the in-progress recording on disk, so they survive
  // navigating away, crashes, and app restarts
  useEffect(() => {
    if (!rec) return
    window.scribe.rec.readNotes(rec.id).then(setNotes)
  }, [rec])

  /**
   * Starting a fresh line stamps it with the recording time, so the note can
   * jump back to that moment later (and the summary knows when it was said).
   */
  function stampLine(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (!rec || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key.length !== 1 || e.key === ' ') return
    const ta = e.currentTarget
    const pos = ta.selectionStart
    if (pos !== ta.selectionEnd) return
    const before = ta.value.slice(0, pos)
    const after = ta.value.slice(pos)
    const lineSoFar = before.slice(before.lastIndexOf('\n') + 1)
    const restOfLine = after.split('\n')[0]
    if (lineSoFar.trim() || restOfLine.trim()) return
    e.preventDefault()
    // a native insert at the caret: synchronous (fast typing can't overtake
    // it), keeps undo working, and fires the usual change event
    document.execCommand('insertText', false, `[${noteStamp(rec.elapsedMs())}] ${e.key}`)
  }

  /** a name typed mid-recording goes to the session now, so it survives leaving the page */
  function updateTitle(text: string): void {
    setRecTitle(text)
    if (!rec) return
    if (titleTimer.current) clearTimeout(titleTimer.current)
    const id = rec.id
    titleTimer.current = setTimeout(() => window.scribe.rec.setTitle(id, text), 400)
  }

  function updateNotes(text: string): void {
    setNotes(text)
    if (!rec) return
    if (notesTimer.current) clearTimeout(notesTimer.current)
    const id = rec.id
    notesTimer.current = setTimeout(() => window.scribe.rec.stashNotes(id, text), 600)
  }

  function flushNotes(): void {
    if (notesTimer.current) clearTimeout(notesTimer.current)
    if (rec) window.scribe.rec.stashNotes(rec.id, notes)
  }

  useEffect(() => {
    if (!rec) return
    setLiveSegs([])
    return window.scribe.rec.onLive((u) => {
      if (u.id !== rec.id) return
      setLiveSegs(u.segments)
      // follow the newest text unless the user scrolled up to re-read
      requestAnimationFrame(() => {
        const el = livePanelRef.current
        if (!el) return
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        if (nearBottom) el.scrollTop = el.scrollHeight
      })
    })
  }, [rec])

  const engineReady = engine?.binaryReady && engine?.modelReady

  // timer (excludes paused time)
  useEffect(() => {
    if (!rec) return
    setElapsed(rec.elapsedMs())
    const t = setInterval(() => setElapsed(rec.elapsedMs()), 250)
    return () => clearInterval(t)
  }, [rec])

  async function begin(as: RecordingMode = mode): Promise<void> {
    setError(null)
    try {
      const handles = await startRecording(as)
      setRec(handles)
      setPaused(false)
      setElapsed(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording')
    }
  }

  function stop(): void {
    if (!rec || finishing) return
    flushNotes()
    onStop()
  }

  async function discard(): Promise<void> {
    if (!rec) return
    const sure = await confirm({
      title: 'Discard this recording?',
      body: 'The audio will be deleted.',
      confirmLabel: 'Discard',
      danger: true
    })
    if (!sure) return
    await rec.cancel()
    setRec(null)
    setPaused(false)
    onCancel()
  }

  // started from a notification or the tray: go straight to recording
  useEffect(() => {
    if (!autostart || !engineReady || rec || autostarted.current === autostart.nonce) return
    autostarted.current = autostart.nonce
    setMode(autostart.mode)
    begin(autostart.mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart?.nonce, engineReady, rec])

  if (!engineReady) {
    return <EngineSetup engine={engine} onReady={onEngineReady} />
  }

  if (!rec) {
    return (
      <div className="record-stage">
        <div className="mode-toggle" role="radiogroup" aria-label="Recording mode">
          <button
            className={mode === 'virtual' ? 'active' : ''}
            role="radio"
            aria-checked={mode === 'virtual'}
            onClick={() => setMode('virtual')}
          >
            Virtual meeting
          </button>
          <button
            className={mode === 'in-person' ? 'active' : ''}
            role="radio"
            aria-checked={mode === 'in-person'}
            onClick={() => setMode('in-person')}
          >
            In person
          </button>
        </div>
        <p className="mode-hint">
          {mode === 'virtual'
            ? 'Captures your microphone and everything you hear: Webex, Teams, or any other call audio.'
            : 'Captures your microphone only. Place your laptop where it can hear the room.'}
        </p>
        <button className="big-record" onClick={() => begin()} aria-label="Start recording">
          <MicIcon />
        </button>
        {prepNote && (
          <div className="rec-prep">
            <span className="rec-prep-label">Before the meeting</span>
            <PrepBody eventId={prepNote.id} entry={prepNote.entry} />
          </div>
        )}
        {error && (
          <div className="stage-banner error" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-ghost" onClick={onCancel}>
          Back to meetings
        </button>
      </div>
    )
  }

  return (
    <div className="record-stage">
      <span className={`rec-live ${paused ? 'paused' : ''}`}>
        <span className="dot" aria-hidden="true" />
        {paused ? 'PAUSED' : `RECORDING ${rec.mode === 'virtual' ? '· MIC + SYSTEM AUDIO' : '· MIC'}`}
      </span>
      <input
        className="rec-title"
        value={recTitle}
        placeholder={liveEvent?.title ?? 'Name this recording'}
        onChange={(e) => updateTitle(e.target.value)}
        onBlur={() => rec && window.scribe.rec.setTitle(rec.id, recTitle)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label="Recording name"
        title={
          liveEvent
            ? 'Named after the calendar event unless you type a name'
            : 'Give this recording a name'
        }
      />
      <div className="rec-timer" aria-live="off">
        {formatDuration(elapsed)}
      </div>
      {/* re-renders with the elapsed timer, so Date.now() stays current */}
      {liveEvent && <TimeLeft event={liveEvent} now={Date.now()} />}
      <Meters rec={rec} />
      {liveSegs.length > 0 && (
        <div className="live-panel" ref={livePanelRef} aria-live="polite" aria-label="Live transcript">
          {liveSegs.map((seg, i) => (
            <div className="transcript-seg" key={i}>
              <span className="transcript-time">{formatDuration(seg.from)}</span>
              <span className="transcript-text">{seg.text}</span>
            </div>
          ))}
        </div>
      )}
      {prepNote && (
        <div className="rec-prep">
          <span className="rec-prep-label">Before the meeting</span>
          <PrepBody eventId={prepNote.id} entry={prepNote.entry} />
        </div>
      )}
      <textarea
        className="text-input rec-notes"
        placeholder="Type notes as you go: names, numbers, decisions. Each line is stamped with the moment you start it, so you can jump back to it later, and notes sharpen the summary."
        value={notes}
        onKeyDown={stampLine}
        onChange={(e) => updateNotes(e.target.value)}
        onBlur={flushNotes}
        aria-label="Meeting notes"
      />
      <p className="mode-hint">
        You can browse other meetings while this records; the sidebar shows a live indicator that
        brings you back here.
      </p>
      <div className="rec-actions">
        <button
          className="btn"
          onClick={() => {
            if (paused) rec.resume()
            else rec.pause()
            setPaused(!paused)
          }}
          disabled={finishing}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn btn-primary" onClick={stop} disabled={finishing}>
          <StopIcon /> {finishing ? 'Saving…' : 'Stop and transcribe'}
        </button>
        <button className="btn btn-ghost btn-danger" onClick={discard} disabled={finishing}>
          Discard
        </button>
      </div>
      {(error ?? stopError) && (
        <div className="stage-banner error" role="alert">
          {error ?? stopError}
        </div>
      )}
      {confirmEl}
    </div>
  )
}

function Meters({ rec }: { rec: RecorderHandles }): React.JSX.Element {
  const micRef = useRef<HTMLDivElement>(null)
  const sysRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const micBuf = new Uint8Array(rec.micAnalyser.fftSize)
    const sysBuf = rec.sysAnalyser ? new Uint8Array(rec.sysAnalyser.fftSize) : null
    let raf = 0
    const tick = (): void => {
      if (micRef.current) {
        micRef.current.style.transform = `scaleX(${readLevel(rec.micAnalyser, micBuf)})`
      }
      if (rec.sysAnalyser && sysBuf && sysRef.current) {
        sysRef.current.style.transform = `scaleX(${readLevel(rec.sysAnalyser, sysBuf)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rec])

  return (
    <div className="meters">
      <div className="meter-row">
        <span>Your mic</span>
        <div className="meter-track">
          <div className="meter-fill" ref={micRef} style={{ transform: 'scaleX(0)' }} />
        </div>
      </div>
      {rec.sysAnalyser && (
        <div className="meter-row">
          <span>Meeting audio</span>
          <div className="meter-track">
            <div className="meter-fill" ref={sysRef} style={{ transform: 'scaleX(0)' }} />
          </div>
        </div>
      )}
    </div>
  )
}

function EngineSetup({
  engine,
  onReady
}: {
  engine: EngineStatus | null
  onReady: (s: EngineStatus) => void
}): React.JSX.Element {
  const [progress, setProgress] = useState<EngineProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => window.scribe.engine.onProgress(setProgress), [])

  async function setup(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const status = await window.scribe.engine.setup()
      onReady(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
      setRunning(false)
    }
  }

  return (
    <div className="setup-card">
      <h2>One-time setup</h2>
      <p>
        Rowan AIO transcribes on your own machine. Nothing is uploaded, and there is no
        subscription. It first needs to download the speech engine and a language model (about 550
        MB total).
      </p>
      <button className="btn btn-primary" onClick={setup} disabled={running}>
        {running ? 'Downloading…' : engine?.binaryReady ? 'Download speech model' : 'Download engine'}
      </button>
      {running && progress && (
        <div className="setup-progress" aria-live="polite">
          {progress.detail}
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: progress.percent >= 0 ? `${progress.percent}%` : '100%',
                opacity: progress.percent >= 0 ? 1 : 0.35
              }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="stage-banner error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
