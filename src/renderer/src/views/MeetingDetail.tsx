import { useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../shared/types'
import {
  BackIcon,
  ChevronIcon,
  DueEditor,
  formatDuration,
  formatWhen,
  isOverdue,
  OwnerEditor,
  StageBadge,
  useConfirm
} from '../ui'
import { parseDueDate } from '../../../shared/dates'
import { ClickupPushDialog } from '../ClickupPush'
import { exportFilename, followUpEmail, meetingToMarkdown, summaryToMarkdown } from '../markdown'

function Collapse({
  label,
  meta,
  topic = false,
  defaultOpen = true,
  children
}: {
  label: string
  meta?: string
  topic?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="section">
      <button
        className={`collapse-head ${topic ? 'topic' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={`chevron ${open ? 'open' : ''}`} aria-hidden="true">
          <ChevronIcon />
        </span>
        {label}
        {meta && <span className="collapse-count">{meta}</span>}
      </button>
      {open && <div className="collapse-body">{children}</div>}
    </section>
  )
}

export interface PlayerControl {
  seek: (ms: number, andPlay?: boolean) => void
}

function AudioPlayer({
  src,
  fallbackMs,
  control,
  onTimeMs
}: {
  src: string
  fallbackMs: number
  control?: React.MutableRefObject<PlayerControl | null>
  onTimeMs?: (ms: number) => void
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackMs / 1000)
  const [rate, setRate] = useState(1)

  useEffect(() => {
    if (!control) return
    control.current = {
      seek: (ms, andPlay = true) => {
        const a = audioRef.current
        if (!a) return
        a.currentTime = ms / 1000
        setTime(ms / 1000)
        if (andPlay) a.play()
      }
    }
    return () => {
      control.current = null
    }
  }, [control])

  // Recordings may lack a duration header (MediaRecorder quirk), and probing
  // the file end for it stalls playback on long files. The app already knows
  // the exact duration from the recording session, so fallbackMs is
  // authoritative; only trust the media element when it reports a real,
  // larger value.
  function onLoadedMetadata(): void {
    const a = audioRef.current
    if (!a) return
    if (isFinite(a.duration) && a.duration > fallbackMs / 1000) {
      setDuration(a.duration)
    }
  }

  function toggle(): void {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      // if the playhead is parked at the end (post-scan or after finishing),
      // start from the beginning instead of silently doing nothing
      if (a.ended || (isFinite(a.duration) && a.duration > 0 && a.currentTime >= a.duration - 0.1)) {
        a.currentTime = 0
        setTime(0)
      }
      a.play()
    } else {
      a.pause()
    }
  }

  function cycleRate(): void {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  return (
    <div className="player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime ?? 0
          setTime(t)
          onTimeMs?.(t * 1000)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button className="player-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5" y="4" width="5" height="16" rx="1.5" />
            <rect x="14" y="4" width="5" height="16" rx="1.5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5Z" />
          </svg>
        )}
      </button>
      <span className="player-time">
        {formatDuration(time * 1000)} / {formatDuration(duration * 1000)}
      </span>
      <input
        className="player-seek"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(time, duration)}
        onChange={(e) => {
          const t = Number(e.target.value)
          if (audioRef.current) audioRef.current.currentTime = t
          setTime(t)
        }}
        aria-label="Seek"
      />
      <button className="player-btn player-rate" onClick={cycleRate} aria-label="Playback speed">
        {rate}×
      </button>
    </div>
  )
}

export function MeetingView({
  id,
  focusMs,
  onBack,
  onDeleted,
  onOpenSeries
}: {
  id: string
  /** transcript moment to scroll to and highlight (from an Ask citation) */
  focusMs?: number
  onBack: () => void
  onDeleted: () => void
  onOpenSeries: (title: string) => void
}): React.JSX.Element {
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [flashIdx, setFlashIdx] = useState<number | null>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const [transcriptToggled, setTranscriptToggled] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [exportedTo, setExportedTo] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState<{ subject: string; body: string } | null>(null)
  const [knownOwners, setKnownOwners] = useState<string[]>([])
  const [hasApiKey, setHasApiKey] = useState(false)
  const [hasClickup, setHasClickup] = useState(false)
  const [pushIdx, setPushIdx] = useState<number | null>(null)
  const [identifying, setIdentifying] = useState(false)
  const [identifyError, setIdentifyError] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(-1)
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [transcriptEdited, setTranscriptEdited] = useState(false)
  const cancelEditRef = useRef(false)
  const playerRef = useRef<PlayerControl | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [confirmEl, confirm] = useConfirm()
  const [seriesCount, setSeriesCount] = useState(0)

  useEffect(() => {
    setSeriesCount(0)
    window.scribe.series.siblings(id).then((sibs) => setSeriesCount(sibs.length))
  }, [id, meeting?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Promise.all([window.scribe.settings.get(), window.scribe.actions.list()]).then(
      ([settings, items]) => {
        // resolved canonical names, not the raw strings meetings arrived with
        const seen = items.flatMap((i) => i.owners).filter((o) => o !== 'Me')
        setKnownOwners(['Me', ...[...new Set([...settings.people, ...seen])].sort()])
        setHasApiKey(settings.hasApiKey)
        setHasClickup(settings.hasClickup)
      }
    )
  }, [id])

  useEffect(() => {
    window.scribe.meetings.get(id).then(setMeeting)
    return window.scribe.meetings.onUpdated((m) => {
      if (m.id === id) setMeeting(m)
    })
  }, [id])

  // jump to the cited moment when opened from an Ask citation
  const transcriptLoaded = (meeting?.transcript?.length ?? 0) > 0
  useEffect(() => {
    if (focusMs === undefined || !meeting?.transcript?.length) return
    const t = meeting.transcript
    let idx = t.findIndex((s) => focusMs < s.to)
    if (idx < 0) idx = t.length - 1
    setFlashIdx(idx)
    if (meeting.hasAudio) playerRef.current?.seek(focusMs, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMs, meeting?.id, transcriptLoaded])

  useEffect(() => {
    if (flashIdx !== null) {
      requestAnimationFrame(() => flashRef.current?.scrollIntoView({ block: 'center' }))
    }
  }, [flashIdx])

  // Escape returns to the library (unless typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      // an open dialog or Ask panel owns Escape (they close themselves)
      if (document.querySelector('dialog[open]') || document.querySelector('.askw-panel')) return
      if (e.key === 'Escape' && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  if (!meeting) return <></>

  const working =
    meeting.stage === 'transcribing' || meeting.stage === 'summarizing' || meeting.stage === 'recorded'

  async function rename(): Promise<void> {
    const next = titleRef.current?.value ?? ''
    if (meeting && next.trim() && next !== meeting.title) {
      const updated = await window.scribe.meetings.rename(meeting.id, next)
      if (updated) setMeeting(updated)
    }
  }

  async function copySummary(): Promise<void> {
    if (!meeting) return
    await navigator.clipboard.writeText(summaryToMarkdown(meeting))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function exportMd(): Promise<void> {
    if (!meeting) return
    const path = await window.scribe.meetings.exportMarkdown(
      exportFilename(meeting),
      meetingToMarkdown(meeting)
    )
    if (path) {
      setExportedTo(path)
      setTimeout(() => setExportedTo(null), 4000)
    }
  }

  async function remove(): Promise<void> {
    const sure = await confirm({
      title: `Delete "${meeting?.title}"?`,
      body: 'Audio, transcript, and summary will be removed. This cannot be undone.',
      confirmLabel: 'Delete meeting',
      danger: true
    })
    if (!sure || !meeting) return
    await window.scribe.meetings.delete(meeting.id)
    onDeleted()
  }

  const transcriptOpen = transcriptToggled ?? (focusMs !== undefined || !meeting.summary)
  // people offered when assigning a transcript speaker label to a real person
  const speakerChoices = [...new Set([...knownOwners, ...(meeting.attendees ?? [])])]

  async function saveSegmentEdit(): Promise<void> {
    const idx = editIdx
    setEditIdx(null)
    if (cancelEditRef.current) {
      cancelEditRef.current = false
      return
    }
    if (idx === null || !meeting?.transcript?.[idx]) return
    const original = meeting.transcript[idx].text
    if (editDraft.trim() === original.trim()) return
    // an emptied line is a delete — confirm it like one
    if (!editDraft.trim()) {
      removeSegments(idx, idx)
      return
    }
    const updated = await window.scribe.meetings.editSegment(meeting.id, idx, editDraft)
    if (updated) {
      setMeeting(updated)
      setTranscriptEdited(true)
    }
  }

  async function removeSegments(from: number, to: number): Promise<void> {
    if (!meeting) return
    const count = to - from + 1
    const sure = await confirm({
      title: count === 1 ? 'Delete this transcript line?' : `Delete ${count} transcript lines?`,
      body:
        (count === 1
          ? 'The line is removed from the transcript.'
          : 'Everything from this line to the end of the transcript is removed.') +
        ' The audio recording is not changed. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!sure) return
    const updated = await window.scribe.meetings.deleteSegments(meeting.id, from, to)
    if (updated) {
      setMeeting(updated)
      setTranscriptEdited(true)
    }
  }

  return (
    <div className="main-narrow">
      <div className="detail-head">
        <button className="back-link" onClick={onBack}>
          <BackIcon /> All meetings
        </button>
        <div className="title-row">
          <input
            ref={titleRef}
            className="detail-title"
            key={meeting.title}
            defaultValue={meeting.title}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label="Meeting title"
            title="Click to rename"
          />
          <button
            className="btn btn-ghost icon-btn"
            title="Rename meeting"
            aria-label="Rename meeting"
            onClick={() => {
              titleRef.current?.focus()
              titleRef.current?.select()
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
        </div>
        <div className="detail-meta">
          <span>{formatWhen(meeting.createdAt)}</span>
          <span>{formatDuration(meeting.durationMs)}</span>
          <span>
            {meeting.mode === 'virtual'
              ? 'virtual'
              : meeting.mode === 'imported'
                ? 'imported'
                : 'in person'}
          </span>
          {meeting.attendees && meeting.attendees.length > 0 && (
            <span title={meeting.attendees.join(', ')}>
              with {meeting.attendees.slice(0, 3).join(', ')}
              {meeting.attendees.length > 3 ? ` +${meeting.attendees.length - 3}` : ''}
            </span>
          )}
          {seriesCount > 0 && (
            <button
              className="series-chip"
              onClick={() => onOpenSeries(meeting.title)}
              title="See this series: decisions over time and everything still open"
            >
              Series · {seriesCount + 1} meetings
            </button>
          )}
          <StageBadge stage={meeting.stage} progress={meeting.progress} />
        </div>
        {(meeting.summary || (meeting.transcript && meeting.transcript.length > 0)) && (
          <div className="toolbar-row">
            {meeting.summary && (
              <button className="btn" onClick={copySummary}>
                {copied ? 'Copied ✓' : 'Copy summary'}
              </button>
            )}
            {meeting.summary && (
              <button
                className="btn"
                title="Draft a recap to copy into an email"
                onClick={() => setEmailDraft(emailDraft ? null : followUpEmail(meeting))}
              >
                Follow-up email
              </button>
            )}
            <button className="btn" onClick={exportMd}>
              Export Markdown
            </button>
            {meeting.summary && meeting.transcript && meeting.transcript.length > 0 && (
              <RegenerateButton
                onRegenerate={async (model, label) => {
                  const sure = await confirm({
                    title: 'Rewrite the summary from the transcript?',
                    body:
                      'Owner assignments and checked-off action items will be reset.' +
                      (label ? ` This run uses ${label}.` : ''),
                    confirmLabel: 'Regenerate'
                  })
                  if (sure) window.scribe.meetings.resummarize(meeting.id, model)
                }}
              />
            )}
            {exportedTo && (
              <span className="field-note ok" role="status">
                Saved to {exportedTo}
              </span>
            )}
          </div>
        )}
      </div>

      {emailDraft && (
        <EmailDraft
          draft={emailDraft}
          onChange={setEmailDraft}
          onClose={() => setEmailDraft(null)}
        />
      )}

      {meeting.hasAudio && (
        <AudioPlayer
          src={`scribe-media://${meeting.id}`}
          fallbackMs={meeting.durationMs}
          control={playerRef}
          onTimeMs={setPlayheadMs}
        />
      )}

      {working && (
        <div className="stage-banner" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {meeting.stage === 'summarizing'
            ? 'Writing the summary with Claude…'
            : 'Transcribing on this machine. You can leave this page.'}
          {meeting.stage === 'transcribing' && typeof meeting.progress === 'number' && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${meeting.progress}%` }} />
            </div>
          )}
        </div>
      )}

      {meeting.stage === 'error' && (
        <div className="stage-banner error" role="alert">
          {meeting.error ?? 'Processing failed.'}
          <button className="btn" onClick={() => window.scribe.meetings.retry(meeting.id)}>
            Try again
          </button>
        </div>
      )}

      {meeting.stage === 'transcript-only' && meeting.transcript && (
        <div className="stage-banner">
          {meeting.error
            ? `Summary failed: ${meeting.error}`
            : 'Transcript is ready. Add a Claude API key in Settings to generate summaries.'}
          <button className="btn" onClick={() => window.scribe.meetings.resummarize(meeting.id)}>
            Summarize now
          </button>
        </div>
      )}

      {meeting.summary && (
        <Collapse label="TL;DR">
          <p className="tldr">{meeting.summary.tldr}</p>
        </Collapse>
      )}

      {(meeting.notes || meeting.stage === 'ready' || meeting.stage === 'transcript-only') && (
        <Collapse label="Your notes" defaultOpen={!!meeting.notes}>
          <NotesEditor meeting={meeting} onSaved={setMeeting} />
        </Collapse>
      )}

      {meeting.summary && (
        <>
          {meeting.summary.actionItems.length > 0 && (
            <Collapse label="Action items" meta={`${meeting.summary.actionItems.length}`}>
              <div>
                {meeting.summary.actionItems.map((a, i) => (
                  <div className="action-item" key={i}>
                    <span className="action-task">{a.task}</span>
                    <OwnerEditor
                      owner={a.owner}
                      suggestions={knownOwners}
                      onSave={async (owner) => {
                        const updated = await window.scribe.actions.setOwner(meeting.id, i, owner)
                        if (updated) setMeeting(updated)
                        if (owner && !knownOwners.includes(owner)) {
                          setKnownOwners([...knownOwners, owner])
                        }
                      }}
                    />
                    <DueEditor
                      due={a.due}
                      dueDate={a.dueDate ?? parseDueDate(a.due, meeting.createdAt) ?? undefined}
                      edited={!!a.dueDate}
                      overdue={isOverdue({
                        dueDate: a.dueDate ?? parseDueDate(a.due, meeting.createdAt) ?? undefined,
                        done: a.done
                      })}
                      onSave={async (iso) => {
                        const updated = await window.scribe.actions.setDue(meeting.id, i, iso)
                        if (updated) setMeeting(updated)
                      }}
                    />
                    {a.clickupUrl ? (
                      <a
                        className="cu-pushed"
                        href={a.clickupUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Open the ClickUp task"
                      >
                        In ClickUp ↗
                      </a>
                    ) : (
                      hasClickup && (
                        <button
                          className="btn btn-ghost cu-push-btn"
                          onClick={() => setPushIdx(i)}
                          title="Create a ClickUp task from this item"
                        >
                          → ClickUp
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>
            </Collapse>
          )}

          {meeting.summary.decisions.length > 0 && (
            <Collapse label="Decisions">
              <ul className="point-list">
                {meeting.summary.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </Collapse>
          )}

          {meeting.summary.openQuestions.length > 0 && (
            <Collapse label="Open questions">
              <ul className="point-list">
                {meeting.summary.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </Collapse>
          )}

          {meeting.summary.topics?.map((topic, ti) => (
            <Collapse label={topic.heading} topic key={ti}>
              <ul className="point-list">
                {topic.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Collapse>
          ))}

          {!meeting.summary.topics && (meeting.summary.keyPoints?.length ?? 0) > 0 && (
            <Collapse label="Key points">
              <ul className="point-list">
                {meeting.summary.keyPoints!.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Collapse>
          )}
        </>
      )}

      {meeting.transcript && meeting.transcript.length > 0 && (
        <section className="section">
          <button
            className="collapse-head"
            onClick={() => setTranscriptToggled(!transcriptOpen)}
            aria-expanded={transcriptOpen}
          >
            <span className={`chevron ${transcriptOpen ? 'open' : ''}`} aria-hidden="true">
              <ChevronIcon />
            </span>
            Transcript
            <span className="collapse-count">{meeting.transcript.length} segments</span>
          </button>
          {transcriptOpen && (
            <div className="collapse-body">
              <div className="transcript-tools">
                {meeting.transcript.some((s) => s.speaker === 'me' || s.speaker === 'them') && (
                  <SpeakerNames meeting={meeting} onSaved={setMeeting} />
                )}
                {hasApiKey && (
                  <button
                    className="btn transcript-identify"
                    disabled={identifying}
                    title="Attribute lines to named speakers from conversational context (uses Claude, costs a few cents)"
                    onClick={async () => {
                      setIdentifying(true)
                      setIdentifyError(null)
                      try {
                        const updated = await window.scribe.meetings.identifySpeakers(meeting.id)
                        if (updated) setMeeting(updated)
                      } catch (err) {
                        setIdentifyError(
                          err instanceof Error ? err.message : 'Speaker identification failed.'
                        )
                      } finally {
                        setIdentifying(false)
                      }
                    }}
                  >
                    {identifying ? 'Identifying…' : 'Identify speakers'}
                  </button>
                )}
                {identifyError && (
                  <span className="field-note error" role="alert">
                    {identifyError}
                  </span>
                )}
                {transcriptEdited && meeting.summary && (
                  <span className="field-note ok" role="status">
                    Transcript changed — use Regenerate summary to update the notes.
                  </span>
                )}
              </div>
              <div className="transcript">
                {meeting.transcript.map((seg, i) => {
                  const prev = meeting.transcript![i - 1]
                  const showChip = seg.speaker && seg.speaker !== prev?.speaker
                  const label =
                    seg.speaker === 'me'
                      ? (meeting.speakerNames?.me ?? 'Me')
                      : seg.speaker === 'them'
                        ? (meeting.speakerNames?.them ?? 'Them')
                        : seg.speaker
                  const active = playheadMs >= seg.from && playheadMs < seg.to
                  const seekable = meeting.hasAudio
                  return (
                    <div
                      className={`transcript-seg ${active ? 'active' : ''} ${seekable ? 'seekable' : ''} ${i === flashIdx ? 'cited' : ''}`}
                      ref={i === flashIdx ? flashRef : undefined}
                      key={i}
                      onClick={seekable ? () => playerRef.current?.seek(seg.from) : undefined}
                      title={seekable ? 'Play from here' : undefined}
                    >
                      <span className="transcript-time">{formatDuration(seg.from)}</span>
                      <span className="transcript-text">
                        {showChip && (
                          <SpeakerChip
                            speaker={seg.speaker!}
                            label={label!}
                            suggestions={speakerChoices}
                            onRename={async (to) => {
                              const updated = await window.scribe.meetings.renameSpeaker(
                                meeting.id,
                                seg.speaker!,
                                to
                              )
                              if (updated) setMeeting(updated)
                            }}
                          />
                        )}
                        {editIdx === i ? (
                          <textarea
                            className="text-input seg-edit-input"
                            autoFocus
                            value={editDraft}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onBlur={saveSegmentEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                ;(e.target as HTMLTextAreaElement).blur()
                              } else if (e.key === 'Escape') {
                                cancelEditRef.current = true
                                ;(e.target as HTMLTextAreaElement).blur()
                              }
                            }}
                            aria-label="Edit transcript line"
                          />
                        ) : (
                          seg.text
                        )}
                      </span>
                      {editIdx !== i && (
                        <span className="seg-tools" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="seg-tool"
                            title="Edit this line"
                            onClick={() => {
                              setEditDraft(seg.text)
                              setEditIdx(i)
                            }}
                          >
                            ✎
                          </button>
                          <button
                            className="seg-tool"
                            title="Delete this line"
                            onClick={() => removeSegments(i, i)}
                          >
                            ✕
                          </button>
                          {i < meeting.transcript!.length - 1 && (
                            <button
                              className="seg-tool"
                              title="Delete from here to the end"
                              onClick={() => removeSegments(i, meeting.transcript!.length - 1)}
                            >
                              ✕↓
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="section danger-row">
        {meeting.hasAudio && meeting.transcript && meeting.transcript.length > 0 && (
          <button
            className="btn"
            title="Frees disk space; the transcript, summary, and Q&A stay"
            onClick={async () => {
              const sure = await confirm({
                title: 'Delete the audio recording?',
                body: 'The transcript, summary, and Q&A are kept. This frees disk space but the audio cannot be recovered.',
                confirmLabel: 'Delete audio',
                danger: true
              })
              if (!sure) return
              const updated = await window.scribe.meetings.deleteAudio(meeting.id)
              if (updated) setMeeting(updated)
            }}
          >
            Delete audio, keep notes
          </button>
        )}
        <button className="btn btn-danger" onClick={remove}>
          Delete meeting
        </button>
      </section>
      {confirmEl}
      {pushIdx !== null && meeting.summary?.actionItems[pushIdx] && (
        <ClickupPushDialog
          task={meeting.summary.actionItems[pushIdx].task}
          owner={meeting.summary.actionItems[pushIdx].owner}
          dueDate={
            meeting.summary.actionItems[pushIdx].dueDate ??
            parseDueDate(meeting.summary.actionItems[pushIdx].due, meeting.createdAt) ??
            null
          }
          meetingTitle={meeting.title}
          onDone={async (url) => {
            const updated = await window.scribe.actions.setClickupUrl(meeting.id, pushIdx, url)
            if (updated) setMeeting(updated)
            setPushIdx(null)
          }}
          onClose={() => setPushIdx(null)}
        />
      )}
    </div>
  )
}

/** editable recap draft the user copies into their own email */
function EmailDraft({
  draft,
  onChange,
  onClose
}: {
  draft: { subject: string; body: string }
  onChange: (d: { subject: string; body: string }) => void
  onClose: () => void
}): React.JSX.Element {
  const [copiedWhat, setCopiedWhat] = useState<'subject' | 'body' | null>(null)

  async function copy(what: 'subject' | 'body'): Promise<void> {
    await navigator.clipboard.writeText(what === 'subject' ? draft.subject : draft.body)
    setCopiedWhat(what)
    setTimeout(() => setCopiedWhat(null), 1800)
  }

  return (
    <section className="section email-draft">
      <div className="email-draft-head">
        <span className="card-subhead">Follow-up email draft</span>
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div>
        <label className="field-label" htmlFor="email-draft-subject">
          Subject
        </label>
        <div className="field-row">
          <input
            id="email-draft-subject"
            className="text-input"
            value={draft.subject}
            onChange={(e) => onChange({ ...draft, subject: e.target.value })}
          />
          <button className="btn email-copy-btn" onClick={() => copy('subject')}>
            {copiedWhat === 'subject' ? 'Copied ✓' : 'Copy subject'}
          </button>
        </div>
      </div>
      <div>
        <label className="field-label" htmlFor="email-draft-body">
          Body
        </label>
        <textarea
          id="email-draft-body"
          className="text-input email-draft-body"
          value={draft.body}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </div>
      <div className="email-draft-actions">
        <span className="opt-desc">Edit freely, then paste into a new email.</span>
        <button className="btn email-copy-btn" onClick={() => copy('body')}>
          {copiedWhat === 'body' ? 'Copied ✓' : 'Copy body'}
        </button>
      </div>
    </section>
  )
}

/** typed notes attached to the meeting; edits feed the next summary regeneration */
function NotesEditor({
  meeting,
  onSaved
}: {
  meeting: Meeting
  onSaved: (m: Meeting) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(meeting.notes ?? '')

  async function save(): Promise<void> {
    if (draft.trim() === (meeting.notes ?? '').trim()) return
    const updated = await window.scribe.meetings.setNotes(meeting.id, draft)
    if (updated) onSaved(updated)
  }

  return (
    <div className="notes-editor">
      <textarea
        className="text-input notes-input"
        placeholder="Notes typed during the meeting land here — you can also add them after the fact."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        aria-label="Meeting notes"
      />
      <p className="opt-desc">
        Notes are folded into the summary — regenerate it after big edits.
      </p>
    </div>
  )
}

const REGEN_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }
]

/**
 * Split button: the main half regenerates with the default model from
 * Settings; the arrow opens a menu to run this one meeting on a specific
 * (usually stronger) model without changing the default.
 */
function RegenerateButton({
  onRegenerate
}: {
  onRegenerate: (model?: string, label?: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <span className="split-btn" ref={wrapRef}>
      <button
        className="btn split-btn-main"
        onClick={() => {
          setOpen(false)
          onRegenerate(undefined, undefined)
        }}
      >
        Regenerate summary
      </button>
      <button
        className="btn split-btn-arrow"
        aria-label="Regenerate with a specific model"
        aria-expanded={open}
        title="Regenerate this meeting with a specific model"
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div className="split-menu" role="menu">
          {REGEN_MODELS.map((m) => (
            <button
              key={m.id}
              className="split-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onRegenerate(m.id, m.label)
              }}
            >
              With {m.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * A transcript speaker label. Identified labels ("Speaker 1", or a name the
 * model got wrong) are clickable: pick a person from the directory (or type
 * one) and every segment attributed to that label is reassigned. The mic
 * channels ('me'/'them') are renamed via SpeakerNames instead.
 */
function SpeakerChip({
  speaker,
  label,
  suggestions,
  onRename
}: {
  speaker: string
  label: string
  suggestions: string[]
  onRename: (to: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [typed, setTyped] = useState(false)
  const [hi, setHi] = useState(-1)

  const editable = speaker !== 'me' && speaker !== 'them'
  if (!editable) {
    return <span className={`speaker-chip ${speaker === 'me' ? 'me' : 'them'}`}>{label}</span>
  }

  if (!editing) {
    return (
      <button
        className="speaker-chip them speaker-chip-btn"
        title={`Replace "${label}" with a person everywhere in this transcript`}
        onClick={(e) => {
          e.stopPropagation()
          setDraft('')
          setTyped(false)
          setHi(-1)
          setEditing(true)
        }}
      >
        {label}
      </button>
    )
  }

  // full list until the user types; then filter by what they typed
  const query = draft.trim().toLowerCase()
  const options =
    typed && query ? suggestions.filter((s) => s.toLowerCase().includes(query)) : suggestions

  function pick(next: string): void {
    setEditing(false)
    const name = next.trim()
    if (name && name !== speaker) onRename(name)
  }

  return (
    <span className="owner-wrap speaker-chip-edit" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        className="text-input owner-input"
        placeholder={label}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setTyped(true)
          setHi(e.target.value.trim() ? 0 : -1)
        }}
        onBlur={() => pick(draft)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => (h + 1) % Math.max(options.length, 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => (h <= 0 ? options.length - 1 : h - 1))
          } else if (e.key === 'Enter') {
            if (hi >= 0 && options[hi]) pick(options[hi])
            else pick(draft)
          } else if (e.key === 'Escape') {
            setEditing(false)
          }
        }}
        role="combobox"
        aria-expanded="true"
        aria-label={`Assign ${label} to a person`}
      />
      <div className="owner-pop" role="listbox">
        {options.map((s, i) => (
          <button
            className={`owner-opt ${i === hi ? 'hi' : ''}`}
            role="option"
            aria-selected={i === hi}
            key={s}
            onMouseDown={(e) => {
              e.preventDefault()
              pick(s)
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </span>
  )
}

function SpeakerNames({
  meeting,
  onSaved
}: {
  meeting: Meeting
  onSaved: (m: Meeting) => void
}): React.JSX.Element {
  const [me, setMe] = useState(meeting.speakerNames?.me ?? 'Me')
  const [them, setThem] = useState(meeting.speakerNames?.them ?? 'Them')

  async function save(): Promise<void> {
    const updated = await window.scribe.meetings.setSpeakers(meeting.id, { me, them })
    if (updated) onSaved(updated)
  }

  return (
    <div className="speaker-names">
      <span className="speaker-chip me">Mic</span>
      <input
        className="text-input speaker-input"
        value={me}
        onChange={(e) => setMe(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Name for your own lines"
      />
      <span className="speaker-chip them">Call audio</span>
      <input
        className="text-input speaker-input"
        value={them}
        onChange={(e) => setThem(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Name for the other participants' lines"
      />
    </div>
  )
}
