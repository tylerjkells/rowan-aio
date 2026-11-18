import { useEffect, useRef, useState } from 'react'
import { parseDueDate } from '../../../src/shared/dates'
import type { Meeting } from '../../../src/shared/types'
import { HubError } from '../api'
import { useApp } from '../App'
import { loadMeeting, peek, recordingUrl, renameMeeting, setActionDone, setNotes } from '../data'
import { BackIcon, Check, Problem, Spinner, Stale, clock, dayLabel, dueLabel, duration, stageNote, timeOf } from '../ui'

function speakerOf(m: Meeting, s: string | undefined): string {
  if (!s) return ''
  if (s === 'me') return m.speakerNames?.me ?? 'Me'
  if (s === 'them') return m.speakerNames?.them ?? 'Them'
  return s
}

export function MeetingView({ id }: { id: string }): React.JSX.Element {
  const { hub, back, fail, tick } = useApp()
  const [meeting, setMeeting] = useState<Meeting | null>(() => peek(`meeting.${id}`))
  const [loaded, setLoaded] = useState(meeting !== null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotesDraft] = useState(meeting?.notes ?? '')
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [audio, setAudio] = useState<{ state: 'idle' | 'loading' | 'ready' | 'missing'; url?: string }>({ state: 'idle' })
  const [showTranscript, setShowTranscript] = useState(false)
  const notesDirty = useRef(false)
  const saveTimer = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    loadMeeting(hub, id)
      .then((r) => {
        if (!live) return
        setMeeting(r.value)
        setStale(r.stale)
        setLoaded(true)
        if (!notesDirty.current) setNotesDraft(r.value?.notes ?? '')
        setError(null)
      })
      .catch((err) => {
        if (!live) return
        setLoaded(true)
        setError(fail(err))
      })
    return () => {
      live = false
    }
  }, [hub, id, tick, fail])

  useEffect(() => () => {
    if (audio.url) URL.revokeObjectURL(audio.url)
  }, [audio.url])

  async function saveNotes(text: string): Promise<void> {
    setNotesState('saving')
    try {
      const m = await setNotes(hub, id, text)
      notesDirty.current = false
      setMeeting(m)
      setNotesState('saved')
    } catch (err) {
      setNotesState('idle')
      setError(fail(err))
    }
  }

  function onNotes(text: string): void {
    notesDirty.current = true
    setNotesDraft(text)
    setNotesState('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void saveNotes(text), 1500)
  }

  async function toggle(index: number, task: string, done: boolean): Promise<void> {
    if (!meeting) return
    // show it at once; the hub catches up
    const optimistic = structuredClone(meeting)
    const item = optimistic.summary?.actionItems[index]
    if (item) item.done = done
    setMeeting(optimistic)
    try {
      setMeeting(await setActionDone(hub, id, index, task, done))
    } catch (err) {
      setMeeting(meeting)
      setError(fail(err))
    }
  }

  async function rename(): Promise<void> {
    setRenaming(false)
    if (!meeting || !titleDraft.trim() || titleDraft.trim() === meeting.title) return
    try {
      setMeeting(await renameMeeting(hub, id, titleDraft))
    } catch (err) {
      setError(fail(err))
    }
  }

  async function playRecording(): Promise<void> {
    setAudio({ state: 'loading' })
    try {
      const url = await recordingUrl(hub, id)
      setAudio(url ? { state: 'ready', url } : { state: 'missing' })
    } catch (err) {
      if (err instanceof HubError && err.kind === 'missing') setAudio({ state: 'missing' })
      else {
        setAudio({ state: 'idle' })
        setError(fail(err))
      }
    }
  }

  const s = meeting?.summary
  const note = meeting ? stageNote(meeting.stage, meeting.claimedBy) : null

  return (
    <>
      <nav className="navbar">
        <button className="nav-back" onClick={() => back('/meetings')}>
          <BackIcon size={22} /> Meetings
        </button>
      </nav>
      <Stale show={stale} />
      <Problem error={error} />
      {!meeting ? (
        loaded ? (
          <p className="empty">This meeting isn’t in the hub. It may have been deleted on another device.</p>
        ) : (
          <div className="group skeleton tall" />
        )
      ) : (
        <article className="meeting">
          <header className="meeting-head">
            {renaming ? (
              <input
                className="title-input"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                aria-label="Meeting title"
              />
            ) : (
              <h1
                className="title"
                onClick={() => {
                  setTitleDraft(meeting.title)
                  setRenaming(true)
                }}
              >
                {meeting.title}
              </h1>
            )}
            <p className="meta">
              {[dayLabel(meeting.createdAt), timeOf(meeting.createdAt), duration(meeting.durationMs), meeting.source === 'phone' ? 'recorded on phone' : ''].filter(Boolean).join(' · ')}
            </p>
            {note && <p className="stage-note">{note}</p>}
            {meeting.stage === 'error' && meeting.error && <p className="problem">{meeting.error}</p>}
          </header>

          {meeting.hasAudio && (
            <section className="player">
              {audio.state === 'ready' && audio.url ? (
                <audio controls src={audio.url} preload="metadata" />
              ) : audio.state === 'missing' ? (
                <p className="fine">The recording isn’t in the hub anymore; it’s on the PC that made it.</p>
              ) : (
                <button className="btn-secondary" disabled={audio.state === 'loading'} onClick={() => void playRecording()}>
                  {audio.state === 'loading' ? (
                    <>
                      <Spinner /> Loading recording…
                    </>
                  ) : (
                    'Play recording'
                  )}
                </button>
              )}
            </section>
          )}

          {s?.tldr && <p className="tldr">{s.tldr}</p>}

          {s && s.actionItems.length > 0 && (
            <section>
              <h2 className="section-title">Action items</h2>
              <div className="group">
                {s.actionItems.map((a, i) =>
                  a.dismissed ? null : (
                    <button key={i} className={`row check-row ${a.done ? 'done' : ''}`} onClick={() => void toggle(i, a.task, !a.done)} aria-pressed={!!a.done}>
                      <Check done={!!a.done} />
                      <span className="row-main">
                        <span className="row-title">{a.task}</span>
                        {(a.owner || a.due || a.dueDate) && (
                          <span className="row-sub">
                            {[a.owner, dueLabel(a.dueDate ?? parseDueDate(a.due, meeting.createdAt), a.due)].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                )}
              </div>
            </section>
          )}

          <section>
            <div className="section-head">
              <h2 className="section-title">Notes</h2>
              <span className="save-state" aria-live="polite">
                {notesState === 'saving' ? 'Saving…' : notesState === 'saved' ? 'Saved' : ''}
              </span>
            </div>
            <textarea
              className="notes"
              placeholder="Add notes. They sync to your PCs."
              value={notes}
              rows={Math.min(14, Math.max(3, notes.split('\n').length + 1))}
              onChange={(e) => onNotes(e.target.value)}
              onBlur={() => {
                if (notesDirty.current) {
                  if (saveTimer.current) clearTimeout(saveTimer.current)
                  void saveNotes(notes)
                }
              }}
            />
          </section>

          {s?.topics && s.topics.length > 0 ? (
            <section>
              <h2 className="section-title">Discussion</h2>
              {s.topics.map((t, i) => (
                <div key={i} className="topic">
                  <h3>{t.heading}</h3>
                  <ul>
                    {t.notes.map((n, j) => (
                      <li key={j}>{n}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : (
            s?.keyPoints &&
            s.keyPoints.length > 0 && (
              <section>
                <h2 className="section-title">Key points</h2>
                <ul className="bullets">
                  {s.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </section>
            )
          )}

          {s && s.decisions.length > 0 && (
            <section>
              <h2 className="section-title">Decisions</h2>
              <ul className="bullets">
                {s.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          )}

          {s && s.openQuestions.length > 0 && (
            <section>
              <h2 className="section-title">Open questions</h2>
              <ul className="bullets">
                {s.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </section>
          )}

          {meeting.transcript && meeting.transcript.length > 0 && (
            <section>
              <button className="disclosure" onClick={() => setShowTranscript((v) => !v)} aria-expanded={showTranscript}>
                {showTranscript ? 'Hide transcript' : `Show transcript (${meeting.transcript.length} lines)`}
              </button>
              {showTranscript && (
                <div className="transcript">
                  {meeting.transcript.map((seg, i) => (
                    <p key={i}>
                      <span className="ts">{clock(seg.from)}</span>
                      {seg.speaker && <span className="spk">{speakerOf(meeting, seg.speaker)}</span>}
                      {seg.text}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}
        </article>
      )}
    </>
  )
}
