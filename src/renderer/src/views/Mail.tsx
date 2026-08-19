import { useCallback, useEffect, useState } from 'react'
import type { MailMessage, MailStatus } from '../../../shared/types'
import { ClickupPushDialog } from '../ClickupPush'
import { MailReplyDialog } from '../MailReply'
import { MailGuideDialog } from '../MailGuide'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

type Group = { label: string; messages: MailMessage[] }

/** today / yesterday / earlier, so a busy inbox still reads at a glance */
function byDay(messages: MailMessage[]): Group[] {
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  const groups: Group[] = [
    { label: 'Today', messages: [] },
    { label: 'Yesterday', messages: [] },
    { label: 'Earlier', messages: [] }
  ]
  for (const m of messages) {
    const day = new Date(m.receivedAt).toDateString()
    if (day === today) groups[0].messages.push(m)
    else if (day === yesterday) groups[1].messages.push(m)
    else groups[2].messages.push(m)
  }
  return groups.filter((g) => g.messages.length > 0)
}

export function MailView({ onSettings }: { onSettings: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [taskFrom, setTaskFrom] = useState<MailMessage | null>(null)
  const [replyTo, setReplyTo] = useState<MailMessage | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summarizing, setSummarizing] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const st = await window.scribe.mail.status()
      setStatus(st)
      setMessages(st.connected ? await window.scribe.mail.list() : [])
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    // the main process watches the synced folder and pings when it changes
    return window.scribe.mail.onChanged(load)
  }, [load])

  async function summarize(m: MailMessage): Promise<void> {
    setSummarizing(m.id)
    setRowError(null)
    const result = await window.scribe.mail.summarize(m.id)
    setSummarizing(null)
    if (result.ok && result.body) setSummaries((prev) => ({ ...prev, [m.id]: result.body! }))
    else setRowError(result.error ?? 'Could not summarize that message')
  }

  if (!status) return <></>

  if (!status.connected) {
    return (
      <div className="empty-state">
        <h2>Mail</h2>
        <p>
          Rowan reads your inbox from a OneDrive folder that a Power Automate flow files
          messages into — no mailbox password, no tokens, nothing to approve. Point it at
          the synced folder to get started.
          {status.error && <> ({status.error})</>}
        </p>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={onSettings}>
            Set it up in Settings
          </button>
          <button className="btn" onClick={() => setGuideOpen(true)}>
            Read the setup guide
          </button>
        </div>
        {guideOpen && <MailGuideDialog onClose={() => setGuideOpen(false)} />}
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? messages.filter((m) =>
        [m.subject, m.fromName ?? '', m.from, m.preview].join(' ').toLowerCase().includes(needle)
      )
    : messages

  const row = (m: MailMessage): React.JSX.Element => {
    const expanded = expandedId === m.id
    return (
      <div key={m.id} className={`mail-item ${expanded ? 'expanded' : ''} ${m.isRead ? '' : 'unread'}`}>
        <div className="mail-row">
          <button
            className="mail-main"
            onClick={() => setExpandedId(expanded ? null : m.id)}
          >
            <span className="mail-from">{m.fromName ?? m.from}</span>
            <span className="mail-subject">
              {m.external && <span className="mail-ext" title="From outside Rowan">EXT</span>}
              {m.subject}
            </span>
            <span className="mail-preview">{m.preview}</span>
          </button>
          <span className="mail-meta">
            {m.hasAttachments && <span className="mail-clip" title="Has attachments">📎</span>}
            {m.importance === 'high' && <span className="mail-important">!</span>}
            <span className="mail-when">{formatWhen(m.receivedAt)}</span>
          </span>
        </div>
        {expanded && (
          <div className="mail-detail">
            <div className="mail-addr">
              <span>
                <strong>From</strong> {m.fromName ? `${m.fromName} <${m.from}>` : m.from}
              </span>
              {m.to.length > 0 && (
                <span>
                  <strong>To</strong> {m.to.join(', ')}
                </span>
              )}
              {m.cc.length > 0 && (
                <span>
                  <strong>Cc</strong> {m.cc.join(', ')}
                </span>
              )}
            </div>
            {summaries[m.id] && (
              <div className="mail-summary">
                <span className="card-subhead">Summary</span>
                <p>{summaries[m.id]}</p>
              </div>
            )}
            <pre className="mail-body">{m.body}</pre>
            <div className="mail-actions">
              <button className="btn btn-primary" onClick={() => setReplyTo(m)}>
                Draft a reply
              </button>
              <button
                className="btn"
                onClick={() => summarize(m)}
                disabled={summarizing === m.id}
              >
                {summarizing === m.id
                  ? 'Summarizing…'
                  : summaries[m.id]
                    ? 'Re-summarize'
                    : 'Summarize'}
              </button>
              <button className="btn" onClick={() => setTaskFrom(m)}>
                Make a ClickUp task
              </button>
              {m.webLink && (
                <a className="cu-pushed" href={m.webLink} target="_blank" rel="noreferrer">
                  Open in Outlook ↗
                </a>
              )}
            </div>
            {rowError && <p className="field-note error">{rowError}</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Mail</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
          <input
            className="text-input mail-search"
            placeholder="Search subject, sender, preview…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={load} disabled={refreshing}>
            {refreshing ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {messages.length === 0 && (
        <p className="today-quiet">
          The folder is connected but empty. Nothing arrives until the Power Automate flow
          files its first message — send yourself a test email.
        </p>
      )}
      {messages.length > 0 && filtered.length === 0 && (
        <p className="today-quiet">Nothing matches “{query}”.</p>
      )}
      {byDay(filtered).map((g) => (
        <section className="section" key={g.label}>
          <span className="card-subhead">
            {g.label} · {g.messages.length}
          </span>
          <div className="mail-list">{g.messages.map(row)}</div>
        </section>
      ))}
      {replyTo && <MailReplyDialog message={replyTo} onClose={() => setReplyTo(null)} />}
      {taskFrom && (
        <ClickupPushDialog
          task={taskFrom.subject}
          description={[
            `From email: ${taskFrom.subject}`,
            `Sender: ${taskFrom.fromName ? `${taskFrom.fromName} <${taskFrom.from}>` : taskFrom.from}`,
            taskFrom.webLink ?? ''
          ]
            .filter(Boolean)
            .join('\n')}
          onDone={() => setTaskFrom(null)}
          onClose={() => setTaskFrom(null)}
        />
      )}
    </>
  )
}
