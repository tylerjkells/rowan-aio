import { useEffect, useRef, useState } from 'react'
import type { LibraryQA, MeetingQA } from '../../shared/types'
import { formatDuration, formatWhen, SparkIcon, useConfirm } from './ui'

const EXAMPLES = [
  'What did we decide about…',
  'What is still open from my meetings this month?',
  'What is the email for…',
  'Which of my ClickUp tasks are overdue?'
]

type AskMode = 'library' | 'meeting'

/**
 * Floating assistant, bottom-right on every page. On a meeting page it
 * answers from that meeting's transcript; everywhere else (or via the
 * toggle) it answers across the whole library with cited sources.
 */
export function AskWidget({
  meetingContext,
  onOpenMeeting
}: {
  /** set when the user is viewing a meeting */
  meetingContext: { id: string; title: string } | null
  onOpenMeeting: (id: string, at?: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AskMode>('library')
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [libraryHistory, setLibraryHistory] = useState<LibraryQA[]>([])
  const [meetingQA, setMeetingQA] = useState<MeetingQA[]>([])
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [confirmEl, confirm] = useConfirm()
  // set when navigation came from a citation chip: that's a continuation of
  // the library conversation, so don't switch the panel to meeting mode
  const stayInLibrary = useRef(false)

  useEffect(() => {
    window.scribe.ask.history().then(setLibraryHistory)
  }, [])

  // follow the page: a meeting page talks about that meeting by default
  useEffect(() => {
    if (meetingContext) {
      if (stayInLibrary.current) stayInLibrary.current = false
      else setMode('meeting')
      window.scribe.meetings.get(meetingContext.id).then((m) => setMeetingQA(m?.qa ?? []))
    } else {
      setMode('library')
    }
    setError(null)
  }, [meetingContext?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToEnd(): void {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  useEffect(() => {
    if (open) {
      scrollToEnd()
      inputRef.current?.focus()
    }
  }, [open, mode])

  // Escape closes the panel (the page's own Escape handlers check for it)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const inMeeting = mode === 'meeting' && meetingContext !== null

  async function ask(): Promise<void> {
    const q = question.trim()
    if (!q || pending) return
    setPending(q)
    setError(null)
    setQuestion('')
    scrollToEnd()
    try {
      if (inMeeting) {
        const answer = await window.scribe.meetings.ask(meetingContext!.id, q)
        setMeetingQA((prev) => [...prev, { q, a: answer }])
      } else {
        const record = await window.scribe.ask.ask(q)
        setLibraryHistory((prev) => [...prev, record])
      }
      scrollToEnd()
    } catch (err) {
      setQuestion(q)
      setError(err instanceof Error ? err.message : 'The question could not be answered.')
    } finally {
      setPending(null)
    }
  }

  async function clearHistory(): Promise<void> {
    const sure = await confirm({
      title: 'Clear the Ask history?',
      body: 'Your meetings are not affected.',
      confirmLabel: 'Clear history',
      danger: true
    })
    if (!sure) return
    await window.scribe.ask.clear()
    setLibraryHistory([])
  }

  const thread: (LibraryQA | MeetingQA)[] = inMeeting ? meetingQA : libraryHistory
  const visible = thread.slice(-8)

  return (
    <>
      {open && (
        <div className="askw-panel" role="dialog" aria-label="Ask">
          <div className="askw-head">
            {meetingContext ? (
              <div className="mode-toggle askw-toggle" role="radiogroup" aria-label="Ask scope">
                <button
                  className={mode === 'meeting' ? 'active' : ''}
                  role="radio"
                  aria-checked={mode === 'meeting'}
                  onClick={() => setMode('meeting')}
                >
                  This meeting
                </button>
                <button
                  className={mode === 'library' ? 'active' : ''}
                  role="radio"
                  aria-checked={mode === 'library'}
                  onClick={() => setMode('library')}
                >
                  Everything
                </button>
              </div>
            ) : (
              <span className="askw-title">Ask your meetings</span>
            )}
            <div className="askw-head-tools">
              {!inMeeting && libraryHistory.length > 0 && (
                <button className="btn btn-ghost askw-clear" onClick={clearHistory}>
                  Clear
                </button>
              )}
              <button
                className="btn btn-ghost askw-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {inMeeting && (
            <p className="askw-context" title={meetingContext!.title}>
              Answers come from “{meetingContext!.title}”.
            </p>
          )}

          <div className="askw-thread">
            {thread.length === 0 && !pending && (
              <div className="askw-empty">
                <p className="today-quiet">
                  {inMeeting
                    ? 'Ask anything about this meeting — grounded in its transcript.'
                    : 'Ask across your meetings, people, links, brand colors, and tasks — meeting answers come with cited sources.'}
                </p>
                {!inMeeting && (
                  <div className="ask-examples">
                    {EXAMPLES.map((ex) => (
                      <button
                        className="who-chip"
                        key={ex}
                        onClick={() => {
                          setQuestion(ex.endsWith('…') ? ex.slice(0, -1) : ex)
                          inputRef.current?.focus()
                        }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {thread.length > 8 && (
              <p className="today-quiet askw-earlier">Showing the last 8 questions.</p>
            )}
            {visible.map((x, i) => (
              <div className="qa-pair" key={i}>
                <p className="qa-q">{x.q}</p>
                <p className="qa-a">{x.a}</p>
                {'sources' in x && x.sources.length > 0 && (
                  <div className="ask-sources">
                    {x.sources.map((s) => (
                      <button
                        className="source-chip"
                        key={s.ref}
                        onClick={() => {
                          stayInLibrary.current = true
                          onOpenMeeting(s.meetingId, s.timestampMs ?? undefined)
                        }}
                        title={
                          s.timestampMs !== null
                            ? 'Open this meeting at the cited moment'
                            : 'Open this meeting'
                        }
                      >
                        <span className="source-ref">[{s.ref}]</span>
                        {s.meetingTitle} · {formatWhen(s.createdAt)}
                        {s.timestampMs !== null && ` · ${formatDuration(s.timestampMs)}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <div className="qa-pair">
                <p className="qa-q">{pending}</p>
                <p className="qa-a ask-thinking">
                  <span className="spinner" aria-hidden="true" />{' '}
                  {inMeeting ? 'Reading the transcript…' : 'Reading your meetings…'}
                </p>
              </div>
            )}
            {error && (
              <p className="field-note error" role="alert">
                {error}
              </p>
            )}
            <div ref={endRef} />
          </div>

          <div className="field-row askw-input-row">
            <input
              ref={inputRef}
              className="text-input"
              type="text"
              placeholder={inMeeting ? 'What did we decide about…' : 'Ask across your workspace…'}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
              disabled={!!pending}
              aria-label="Ask a question"
            />
            <button className="btn btn-primary" onClick={ask} disabled={!!pending || !question.trim()}>
              {pending ? '…' : 'Ask'}
            </button>
          </div>
        </div>
      )}

      <button
        className={`askw-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Close Ask' : 'Ask your meetings'}
        aria-expanded={open}
        title="Ask your workspace"
      >
        <SparkIcon />
      </button>
      {confirmEl}
    </>
  )
}
