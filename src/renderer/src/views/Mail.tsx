import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MailFiledDraft,
  MailMessage,
  MailStatus,
  MailTriage,
  PersonSummary
} from '../../../shared/types'
import { ClickupPushDialog } from '../ClickupPush'
import { MailGuideDialog } from '../MailGuide'
import { MailCompose } from '../MailCompose'

// ---------------------------------------------------------------------------
// The mail client. Three panes the way Gmail lays them out: a folder rail,
// the conversation list, and a reading pane, with Rowan's own tools (drafting
// with context, summaries, ClickUp) built into the reading pane rather than
// bolted on. The bridge is one-way, so "handled" stands in for archive and
// stars live in Rowan alone; nothing here writes back to Exchange.
// ---------------------------------------------------------------------------

/** time today, "Sep 2" this year, "Sep 2, 2025" otherwise */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  const thisYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

/** "Tue, Sep 2, 2:14 PM" for a message header */
function formatFull(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** "2h ago", "yesterday", "3 days ago" — for the flow-health line */
function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (isNaN(ms)) return ''
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** a thread: every message sharing a conversation, newest first */
type Thread = { key: string; latest: MailMessage; messages: MailMessage[]; unread: number }

function toThreads(messages: MailMessage[], isUnread: (m: MailMessage) => boolean): Thread[] {
  const map = new Map<string, Thread>()
  for (const m of messages) {
    const key = m.conversationId || m.id
    const t = map.get(key)
    const unread = isUnread(m) ? 1 : 0
    if (t) {
      t.messages.push(m)
      t.unread += unread
    } else {
      map.set(key, { key, latest: m, messages: [m], unread })
    }
  }
  return [...map.values()]
}

type Group = { label: string; threads: Thread[] }

/** today / yesterday / this week / older, so a busy inbox still reads at a glance */
function byDay(threads: Thread[]): Group[] {
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  const weekAgo = Date.now() - 7 * 86_400_000
  const groups: Group[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'This week', threads: [] },
    { label: 'Older', threads: [] }
  ]
  for (const t of threads) {
    const d = new Date(t.latest.receivedAt)
    const day = d.toDateString()
    if (day === today) groups[0].threads.push(t)
    else if (day === yesterday) groups[1].threads.push(t)
    else if (d.getTime() > weekAgo) groups[2].threads.push(t)
    else groups[3].threads.push(t)
  }
  return groups.filter((g) => g.threads.length > 0)
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** plain text with the links made clickable */
function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    // a trailing period or comma belongs to the sentence, not the URL
    const url = m[0].replace(/[.,;:]+$/, '')
    out.push(
      <a key={`${start}-${url}`} href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
    )
    last = start + url.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** where the quoted history starts: Outlook's header block, "On … wrote:", or "> " lines */
const QUOTE_RE =
  /^(?:-{2,}\s*Original Message\s*-{2,}.*|From:\s.+\r?\n(?:Sent|Date|To):\s.+|On .{3,200}? wrote:.*|>\s?.*)$/m

function splitQuoted(body: string): { main: string; quoted: string | null } {
  const m = QUOTE_RE.exec(body)
  if (!m || m.index < 40) return { main: body, quoted: null }
  return { main: body.slice(0, m.index).trimEnd(), quoted: body.slice(m.index).trim() }
}

function MailBody({ text }: { text: string }): React.JSX.Element {
  const { main, quoted } = useMemo(() => splitQuoted(text), [text])
  return (
    <div className="mail-body">
      {linkify(main)}
      {quoted && (
        <details className="mail-quoted">
          <summary>Show earlier messages</summary>
          <div className="mail-quoted-text">{linkify(quoted)}</div>
        </details>
      )}
    </div>
  )
}

/** a stable hue per sender, so avatars are recognisable at a glance */
function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

function initials(name: string): string {
  const parts = name
    .replace(/<.*>/, '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function Avatar({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      className="mailc-avatar"
      style={{ '--avatar-hue': hueFor(name.toLowerCase()) } as React.CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

function StarIcon({ on }: { on: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={on ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 3 2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.5 6.3 20.6l1.2-6.4L2.8 9.7l6.4-.8Z" />
    </svg>
  )
}

/** the flow has gone quiet when nothing has landed in this long (work-hours aside) */
const STALE_AFTER_MS = 24 * 3_600_000

type Folder = 'inbox' | 'starred' | 'handled' | 'automated' | 'drafts'

const FOLDERS: { id: Folder; label: string; hint: string }[] = [
  { id: 'inbox', label: 'Inbox', hint: 'Mail from people that still needs you' },
  { id: 'starred', label: 'Starred', hint: 'Starred here in Rowan; Outlook does not see it' },
  { id: 'handled', label: 'Handled', hint: 'Marked handled here; nothing changes in Outlook' },
  { id: 'automated', label: 'Automated', hint: 'Newsletters, notifications, and no-reply senders' },
  { id: 'drafts', label: 'Drafts', hint: 'Filed to Outlook and waiting for the flow to pick them up' }
]

function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

export function MailView({
  onSettings,
  onOpenPerson
}: {
  onSettings: () => void
  /** open a colleague's page; senders in the directory become links */
  onOpenPerson?: (person: string) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [drafts, setDrafts] = useState<MailFiledDraft[]>([])
  const [triage, setTriage] = useState<MailTriage>({ handled: {}, starred: {}, read: {} })
  const [people, setPeople] = useState<PersonSummary[]>([])
  const [folder, setFolder] = useState<Folder>('inbox')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedDraft, setSelectedDraft] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [taskFrom, setTaskFrom] = useState<MailMessage | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summarizing, setSummarizing] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [compose, setCompose] = useState<{ to?: string[]; subject?: string } | null>(null)
  const [replying, setReplying] = useState(false)
  /** messages opened inside the thread view beyond the latest one */
  const [openMsgs, setOpenMsgs] = useState<Set<string>>(() => new Set())
  /** thread keys ticked for a bulk action */
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const readRef = useRef<HTMLDivElement>(null)

  /** quiet loads (the folder watcher) don't flip the Refresh button */
  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setRefreshing(true)
    try {
      const st = await window.scribe.mail.status()
      setStatus(st)
      setMessages(st.connected ? await window.scribe.mail.list() : [])
      setDrafts(st.connected ? await window.scribe.mail.drafts() : [])
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    window.scribe.mail.triage().then(setTriage).catch(() => {})
    window.scribe.people.list().then(setPeople).catch(() => {})
    // the main process watches the synced folder and pings when it changes
    return window.scribe.mail.onChanged(() => load(true))
  }, [load])

  const peopleNames = useMemo(() => new Set(people.map((p) => p.name)), [people])

  async function summarize(m: MailMessage): Promise<void> {
    setSummarizing(m.id)
    setRowError(null)
    const result = await window.scribe.mail.summarize(m.id)
    setSummarizing(null)
    if (result.ok && result.body) setSummaries((prev) => ({ ...prev, [m.id]: result.body! }))
    else setRowError(result.error ?? 'Could not summarize that message')
  }

  /** mark whole threads: every message in each, so an older reply can't resurface as a row */
  async function setThreadsHandled(threads: Thread[], handled: boolean): Promise<void> {
    const ids = threads.flatMap((t) => t.messages.map((x) => x.id))
    if (ids.length === 0) return
    // optimistic: the file write is local and quick
    setTriage((prev) => {
      const next = { ...prev, handled: { ...prev.handled } }
      const now = new Date().toISOString()
      for (const id of ids) {
        if (handled) next.handled[id] = now
        else delete next.handled[id]
      }
      return next
    })
    setChecked((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      for (const t of threads) next.delete(t.key)
      return next
    })
    try {
      setTriage(await window.scribe.mail.setHandled(ids, handled))
    } catch {
      setRowError('Could not save that')
    }
  }

  async function setThreadsStarred(threads: Thread[], starred: boolean): Promise<void> {
    // a star is on the conversation, carried by its latest message
    const ids = threads.map((t) => t.latest.id)
    setTriage((prev) => {
      const next = { ...prev, starred: { ...prev.starred } }
      const now = new Date().toISOString()
      for (const id of ids) {
        if (starred) next.starred[id] = now
        else delete next.starred[id]
      }
      return next
    })
    try {
      setTriage(await window.scribe.mail.setStarred(ids, starred))
    } catch {
      setRowError('Could not save that')
    }
  }

  /** Rowan's own read mark wins over Outlook's stale one-way flag */
  const isUnread = (m: MailMessage): boolean => {
    const local = triage.read[m.id]
    return local === undefined ? !m.isRead : !local
  }
  const isHandled = (m: MailMessage): boolean => !!triage.handled[m.id]
  const isStarred = (t: Thread): boolean => t.messages.some((m) => !!triage.starred[m.id])

  async function setThreadRead(thread: Thread, read: boolean): Promise<void> {
    const ids = thread.messages.map((x) => x.id)
    if (ids.every((id) => triage.read[id] === read)) return
    setTriage((prev) => {
      const next = { ...prev, read: { ...prev.read } }
      for (const id of ids) next.read[id] = read
      return next
    })
    try {
      setTriage(await window.scribe.mail.setRead(ids, read))
    } catch {
      // a lost read mark is cosmetic; say nothing
    }
  }

  /** opening a thread is reading it, the way any mail client treats it */
  function openThread(thread: Thread): void {
    setSelectedKey(thread.key)
    setSelectedDraft(null)
    setReplying(false)
    setOpenMsgs(new Set())
    setRowError(null)
    readRef.current?.scrollTo({ top: 0 })
    if (thread.unread > 0) setThreadRead(thread, true)
  }

  function closeThread(): void {
    setSelectedKey(null)
    setReplying(false)
  }

  function toggleChecked(key: string): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function changeFolder(f: Folder): void {
    setFolder(f)
    setChecked(new Set())
    setSelectedKey(null)
    setSelectedDraft(null)
    setReplying(false)
  }

  const needle = query.trim().toLowerCase()

  /** every conversation, so a selected thread survives leaving its folder */
  const allThreads = useMemo(
    () => toThreads(messages, isUnread),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, triage]
  )

  const counts = useMemo(() => {
    let inboxUnread = 0
    let inbox = 0
    let automated = 0
    let handled = 0
    let starred = 0
    for (const t of allThreads) {
      const m = t.latest
      if (isStarred(t)) starred++
      if (isHandled(m)) {
        handled++
        continue
      }
      if (m.automated) automated++
      else {
        inbox++
        if (t.unread > 0) inboxUnread++
      }
    }
    return { inbox, inboxUnread, automated, handled, starred, drafts: drafts.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allThreads, triage, drafts])

  /** the list: the folder's conversations, or a search across everything */
  const threads = useMemo(() => {
    const kept: MailMessage[] = []
    for (const m of messages) {
      if (needle) {
        const hay = [m.subject, m.fromName ?? '', m.from, m.preview, m.body, ...m.to, ...m.cc]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(needle)) continue
        kept.push(m)
        continue
      }
      const handled = isHandled(m)
      if (folder === 'handled' ? !handled : handled) continue
      if (folder === 'inbox' && m.automated) continue
      if (folder === 'automated' && !m.automated) continue
      kept.push(m)
    }
    const out = toThreads(kept, isUnread)
    if (!needle && folder === 'starred') return out.filter(isStarred)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, needle, folder, triage])

  const selectedThread = selectedKey
    ? (allThreads.find((t) => t.key === selectedKey) ?? null)
    : null
  const selectedFiled = selectedDraft ? (drafts.find((d) => d.id === selectedDraft) ?? null) : null
  const showingDrafts = folder === 'drafts' && !needle

  // ---- keyboard: the Gmail set, minus what the bridge can't do ----
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) {
        // Esc leaves the field first; a second Esc closes whatever is open
        if (e.key === 'Escape') {
          if (document.activeElement === searchRef.current) setQuery('')
          ;(document.activeElement as HTMLElement).blur()
        }
        return
      }
      if (e.key === 'Escape') {
        if (compose) setCompose(null)
        else if (replying) setReplying(false)
        else closeThread()
        return
      }
      if (compose) return
      const list = showingDrafts ? [] : threads
      const idx = selectedKey ? list.findIndex((t) => t.key === selectedKey) : -1
      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          if (list.length === 0) return
          e.preventDefault()
          openThread(list[Math.min(idx + 1, list.length - 1)])
          return
        }
        case 'k':
        case 'ArrowUp': {
          if (list.length === 0) return
          e.preventDefault()
          openThread(list[Math.max(idx - 1, 0)])
          return
        }
        case '/':
          e.preventDefault()
          searchRef.current?.focus()
          return
        case 'c':
          setCompose({})
          return
      }
      if (!selectedThread) return
      switch (e.key) {
        case 'e': {
          const on = !isHandled(selectedThread.latest)
          setThreadsHandled([selectedThread], on)
          // handled leaves the inbox, so step to the neighbour the way Gmail does
          if (on && folder !== 'handled' && !needle) {
            const next = list[idx + 1] ?? list[idx - 1]
            if (next) openThread(next)
            else closeThread()
          }
          return
        }
        case 'u':
          setThreadRead(selectedThread, false)
          closeThread()
          return
        case 's':
          setThreadsStarred([selectedThread], !isStarred(selectedThread))
          return
        case 'r':
          if (!selectedThread.latest.automated) {
            e.preventDefault()
            setReplying(true)
          }
          return
        case 'x':
          toggleChecked(selectedThread.key)
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- not connected ----
  if (!status) {
    return (
      <>
        <div className="page-head">
          <h1>Mail</h1>
        </div>
        <p className="today-quiet">Reading the mail folder…</p>
      </>
    )
  }

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
        <div className="empty-state-actions">
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

  const newestAt = messages[0]?.receivedAt ?? null
  const stale = !!newestAt && Date.now() - new Date(newestAt).getTime() > STALE_AFTER_MS

  const senderName = (m: MailMessage): React.ReactNode => {
    const name = m.fromName
    if (name && onOpenPerson && peopleNames.has(name)) {
      return (
        <button className="mail-person" onClick={() => onOpenPerson(name)} title="Open in People">
          {name}
        </button>
      )
    }
    return name ?? m.from
  }

  // ---- the rail ----
  const rail = (
    <aside className="mailc-rail">
      <button className="btn btn-primary mailc-compose" onClick={() => setCompose({})}>
        <span className="mailc-compose-plus" aria-hidden="true">
          +
        </span>
        Compose
      </button>
      <nav className="mailc-folders" aria-label="Mail folders">
        {FOLDERS.map((f) => {
          const n =
            f.id === 'inbox'
              ? counts.inboxUnread
              : f.id === 'starred'
                ? counts.starred
                : f.id === 'handled'
                  ? counts.handled
                  : f.id === 'automated'
                    ? counts.automated
                    : counts.drafts
          return (
            <button
              key={f.id}
              className={`mailc-folder ${folder === f.id && !needle ? 'active' : ''}`}
              onClick={() => changeFolder(f.id)}
              title={f.hint}
            >
              <span>{f.label}</span>
              {n > 0 && <span className="mailc-folder-count">{n}</span>}
            </button>
          )
        })}
      </nav>
      <div className="mailc-rail-foot">
        <span className={`mailc-fresh ${stale ? 'mail-stale' : ''}`} title={newestAt ? new Date(newestAt).toLocaleString() : undefined}>
          {newestAt
            ? stale
              ? `Nothing new since ${formatAgo(newestAt)}`
              : `Latest ${formatAgo(newestAt)}`
            : 'Nothing received yet'}
        </span>
        <button className="link-btn" onClick={() => load()} disabled={refreshing}>
          {refreshing ? 'Reading…' : 'Refresh'}
        </button>
        <button className="link-btn" onClick={() => setGuideOpen(true)}>
          Setup guide
        </button>
      </div>
    </aside>
  )

  // ---- the list ----
  const row = (thread: Thread): React.JSX.Element => {
    const m = thread.latest
    const active = selectedKey === thread.key
    const handled = isHandled(m)
    const starred = isStarred(thread)
    const classes = [
      'mailc-row',
      active ? 'active' : '',
      checked.has(thread.key) ? 'checked' : '',
      thread.unread > 0 && !handled ? 'unread' : '',
      m.automated ? 'automated' : '',
      handled ? 'handled' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <div key={thread.key} className={classes}>
        <input
          type="checkbox"
          className="rollup-check mailc-check"
          checked={checked.has(thread.key)}
          onChange={() => toggleChecked(thread.key)}
          aria-label={`Select "${m.subject}"`}
        />
        <button
          className={`mailc-star ${starred ? 'on' : ''}`}
          onClick={() => setThreadsStarred([thread], !starred)}
          title={starred ? 'Unstar' : 'Star'}
          aria-label={starred ? 'Unstar' : 'Star'}
          aria-pressed={starred}
        >
          <StarIcon on={starred} />
        </button>
        <button className="mailc-row-main" onClick={() => openThread(thread)}>
          <span className="mailc-row-top">
            <span className="mailc-row-from">
              {m.fromName ?? m.from}
              {thread.messages.length > 1 && (
                <span className="mailc-row-n"> {thread.messages.length}</span>
              )}
            </span>
            <span className="mailc-row-when">
              {m.hasAttachments && (
                <span className="mail-clip" title="Has attachments">
                  📎
                </span>
              )}
              {m.importance === 'high' && (
                <span className="mail-important" title="High importance">
                  !
                </span>
              )}
              {formatWhen(m.receivedAt)}
            </span>
          </span>
          <span className="mailc-row-subject">
            {m.external && (
              <span className="mail-ext" title="From outside Rowan">
                EXT
              </span>
            )}
            {m.automated && (
              <span className="mail-ext" title="Sent by a system, not a person">
                AUTO
              </span>
            )}
            {m.subject}
          </span>
          <span className="mailc-row-preview">{m.preview}</span>
        </button>
        <span className="mailc-row-hover">
          <button
            className="mailc-ic"
            onClick={() => setThreadsHandled([thread], !handled)}
            title={handled ? 'Put it back in the inbox' : 'Mark handled (e)'}
            aria-label={handled ? 'Unmark handled' : 'Mark handled'}
          >
            {handled ? '↩' : '✓'}
          </button>
          <button
            className="mailc-ic"
            onClick={() => {
              if (thread.unread > 0) setThreadRead(thread, true)
              else {
                setThreadRead(thread, false)
                if (active) closeThread()
              }
            }}
            title={thread.unread > 0 ? 'Mark read' : 'Mark unread (u)'}
            aria-label={thread.unread > 0 ? 'Mark read' : 'Mark unread'}
          >
            {thread.unread > 0 ? '◌' : '●'}
          </button>
        </span>
      </div>
    )
  }

  const draftRow = (d: MailFiledDraft): React.JSX.Element => (
    <div
      key={d.id}
      className={`mailc-row draft ${selectedDraft === d.id ? 'active' : ''}`}
    >
      <button
        className="mailc-row-main"
        onClick={() => {
          setSelectedDraft(d.id)
          setSelectedKey(null)
          setReplying(false)
        }}
      >
        <span className="mailc-row-top">
          <span className="mailc-row-from">
            <span className="mailc-draft-tag">{d.kind === 'reply' ? 'Reply' : 'Draft'}</span>
            {d.to || '(no recipient)'}
          </span>
          <span className="mailc-row-when">{formatWhen(d.queuedAt)}</span>
        </span>
        <span className="mailc-row-subject">{d.subject || '(no subject)'}</span>
        <span className="mailc-row-preview">{d.body.slice(0, 160)}</span>
      </button>
    </div>
  )

  const checkedThreads = threads.filter((t) => checked.has(t.key))
  const groups = byDay(threads)
  const folderLabel = FOLDERS.find((f) => f.id === folder)?.label ?? 'Inbox'

  const list = (
    <section className="mailc-list" aria-label={needle ? 'Search results' : folderLabel}>
      <div className="mailc-list-head">
        <span className="cu-search-wrap mailc-search-wrap">
          <input
            ref={searchRef}
            className="text-input mailc-search"
            placeholder="Search mail  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search mail"
          />
          {query && (
            <button
              className="cu-search-clear"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="Clear search"
              title="Clear"
            >
              ×
            </button>
          )}
        </span>
      </div>

      {checkedThreads.length > 0 ? (
        <div className="mailc-bulk" role="toolbar" aria-label="Selected conversations">
          <span className="mail-bulk-count">{checkedThreads.length} selected</span>
          {checkedThreads.some((t) => !isHandled(t.latest)) && (
            <button className="btn mailc-bulk-btn" onClick={() => setThreadsHandled(checkedThreads, true)}>
              Handled
            </button>
          )}
          {checkedThreads.some((t) => isHandled(t.latest)) && (
            <button className="btn mailc-bulk-btn" onClick={() => setThreadsHandled(checkedThreads, false)}>
              Unhandle
            </button>
          )}
          <button
            className="btn btn-ghost mailc-bulk-btn"
            onClick={() => checkedThreads.forEach((t) => setThreadRead(t, true))}
          >
            Read
          </button>
          <button
            className="btn btn-ghost mailc-bulk-btn"
            onClick={() => setChecked(new Set(threads.map((t) => t.key)))}
            disabled={checked.size === threads.length}
          >
            All
          </button>
          <button className="btn btn-ghost mailc-bulk-btn" onClick={() => setChecked(new Set())}>
            Clear
          </button>
        </div>
      ) : (
        <div className="mailc-list-sub">
          <span>
            {needle
              ? `Results for “${query.trim()}”`
              : showingDrafts
                ? 'Filed to Outlook'
                : folderLabel}
          </span>
          <span className="mailc-list-n">
            {showingDrafts
              ? `${drafts.length}`
              : `${threads.length}${folder === 'inbox' && !needle && counts.inboxUnread > 0 ? ` · ${counts.inboxUnread} unread` : ''}`}
          </span>
        </div>
      )}

      <div className="mailc-rows">
        {showingDrafts ? (
          drafts.length === 0 ? (
            <p className="mailc-empty">
              Nothing waiting. A draft you file from here sits in this list until the flow
              turns it into an Outlook draft, usually within a minute.
            </p>
          ) : (
            drafts.map(draftRow)
          )
        ) : messages.length === 0 ? (
          <p className="mailc-empty">
            The folder is connected but empty. Nothing arrives until the Power Automate flow
            files its first message — send yourself a test email.
          </p>
        ) : threads.length === 0 ? (
          <p className="mailc-empty">
            {needle
              ? `Nothing matches “${query.trim()}”.`
              : folder === 'inbox'
                ? 'All caught up.'
                : folder === 'starred'
                  ? 'Nothing starred. Click the star on a conversation to keep it close.'
                  : 'Nothing here.'}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mailc-group">
              <div className="mailc-group-head">
                <span>{g.label}</span>
                {folder === 'inbox' && !needle && (
                  <button
                    className="link-btn mailc-group-action"
                    onClick={() => setThreadsHandled(g.threads, true)}
                    title={`Mark every conversation under ${g.label} handled`}
                  >
                    Handle all
                  </button>
                )}
              </div>
              {g.threads.map(row)}
            </div>
          ))
        )}
      </div>
    </section>
  )

  // ---- the reading pane ----
  const messageCard = (m: MailMessage, thread: Thread, latest: boolean): React.JSX.Element => {
    const open = latest || openMsgs.has(m.id)
    const name = m.fromName ?? m.from
    const toggle = (): void =>
      setOpenMsgs((prev) => {
        const next = new Set(prev)
        if (next.has(m.id)) next.delete(m.id)
        else next.add(m.id)
        return next
      })
    return (
      <article key={m.id} className={`mailc-msg ${open ? 'open' : ''}`}>
        <div
          className="mailc-msg-head"
          onClick={latest ? undefined : toggle}
          role={latest ? undefined : 'button'}
          tabIndex={latest ? undefined : 0}
          onKeyDown={latest ? undefined : (e) => e.key === 'Enter' && toggle()}
          aria-expanded={latest ? undefined : open}
        >
          <Avatar name={name} />
          <div className="mailc-msg-who">
            <span className="mailc-msg-from">
              {senderName(m)}
              {m.fromName && open && <span className="mail-addr-raw"> &lt;{m.from}&gt;</span>}
            </span>
            {open ? (
              <span className="mailc-msg-to">
                to {m.to.length ? m.to.join(', ') : 'you'}
                {m.cc.length > 0 && <> · cc {m.cc.join(', ')}</>}
              </span>
            ) : (
              <span className="mailc-msg-snippet">{m.preview}</span>
            )}
          </div>
          <span className="mailc-msg-when" title={new Date(m.receivedAt).toLocaleString()}>
            {open ? formatFull(m.receivedAt) : formatWhen(m.receivedAt)}
          </span>
        </div>
        {open && (
          <div className="mailc-msg-body">
            {summaries[m.id] && (
              <div className="mail-summary">
                <span className="card-subhead">Summary</span>
                <p>{summaries[m.id]}</p>
              </div>
            )}
            <MailBody text={m.body} />
            {!latest && (
              <div className="mailc-msg-tools">
                <button
                  className="link-btn"
                  onClick={() => summarize(m)}
                  disabled={summarizing === m.id}
                >
                  {summarizing === m.id ? 'Summarizing…' : summaries[m.id] ? 'Re-summarize' : 'Summarize'}
                </button>
                {thread.messages.length > 1 && (
                  <button className="link-btn" onClick={toggle}>
                    Collapse
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </article>
    )
  }

  const threadView = (thread: Thread): React.JSX.Element => {
    const m = thread.latest
    const handled = isHandled(m)
    const starred = isStarred(thread)
    const ordered = [...thread.messages].reverse()
    return (
      <>
        <div className="mailc-read-bar">
          <button className="mailc-ic" onClick={closeThread} title="Back to the list (Esc)" aria-label="Close">
            ←
          </button>
          <button
            className={`mailc-ic ${handled ? 'on' : ''}`}
            onClick={() => setThreadsHandled([thread], !handled)}
            title={handled ? 'Put it back in the inbox' : 'Mark handled (e)'}
          >
            ✓
          </button>
          <button
            className="mailc-ic"
            onClick={() => {
              setThreadRead(thread, false)
              closeThread()
            }}
            title="Mark unread (u)"
            aria-label="Mark unread"
          >
            ●
          </button>
          <button
            className={`mailc-ic mailc-star ${starred ? 'on' : ''}`}
            onClick={() => setThreadsStarred([thread], !starred)}
            title={starred ? 'Unstar (s)' : 'Star (s)'}
            aria-pressed={starred}
          >
            <StarIcon on={starred} />
          </button>
          <span className="mailc-read-bar-gap" />
          <button
            className="btn btn-ghost mailc-read-tool"
            onClick={() => summarize(m)}
            disabled={summarizing === m.id}
          >
            {summarizing === m.id ? 'Summarizing…' : summaries[m.id] ? 'Re-summarize' : 'Summarize'}
          </button>
          <button className="btn btn-ghost mailc-read-tool" onClick={() => setTaskFrom(m)}>
            ClickUp task
          </button>
          {m.webLink && (
            <a className="btn btn-ghost mailc-read-tool" href={m.webLink} target="_blank" rel="noreferrer">
              Outlook ↗
            </a>
          )}
        </div>
        <div className="mailc-read-scroll" ref={readRef}>
          <header className="mailc-subject">
            <h2>
              {m.subject}
            </h2>
            <span className="mailc-subject-tags">
              {m.external && (
                <span className="mail-ext" title="From outside Rowan">
                  EXT
                </span>
              )}
              {m.automated && (
                <span className="mail-ext" title="Sent by a system, not a person">
                  AUTO
                </span>
              )}
              {handled && <span className="mail-ext mailc-tag-handled">HANDLED</span>}
              {thread.messages.length > 1 && (
                <span className="mailc-list-n">{thread.messages.length} messages</span>
              )}
            </span>
          </header>
          {rowError && <p className="field-note error">{rowError}</p>}
          <div className="mailc-thread">
            {ordered.map((x) => messageCard(x, thread, x.id === m.id))}
          </div>
          {m.automated ? (
            <p className="mailc-noreply">
              Sent by a system, so there is no one to reply to.
            </p>
          ) : replying ? (
            <ReplyBox
              message={m}
              onClose={() => setReplying(false)}
              onFiled={() => load(true)}
            />
          ) : (
            <div className="mailc-reply-cta">
              <button className="btn mailc-reply-btn" onClick={() => setReplying(true)}>
                ↩ Reply
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  setCompose({
                    subject: /^fwd?:/i.test(m.subject) ? m.subject : `FW: ${m.subject}`
                  })
                }
                title="Start a new message with this subject; paste what you need from above"
              >
                Forward
              </button>
              <span className="mailc-reply-hint">
                Drafted with what Rowan knows about {m.fromName ?? 'the sender'}; sent from Outlook.
              </span>
            </div>
          )}
        </div>
      </>
    )
  }

  const filedView = (d: MailFiledDraft): React.JSX.Element => (
    <>
      <div className="mailc-read-bar">
        <button
          className="mailc-ic"
          onClick={() => setSelectedDraft(null)}
          title="Back to the list (Esc)"
          aria-label="Close"
        >
          ←
        </button>
        <span className="mailc-read-bar-gap" />
      </div>
      <div className="mailc-read-scroll">
        <header className="mailc-subject">
          <h2>{d.subject || '(no subject)'}</h2>
          <span className="mailc-subject-tags">
            <span className="mail-ext">{d.kind === 'reply' ? 'REPLY' : 'NEW'}</span>
            <span className="mailc-list-n">filed {formatAgo(d.queuedAt)}</span>
          </span>
        </header>
        <p className="mailc-msg-to">to {d.to || '(no recipient)'}</p>
        <div className="mail-body">{linkify(d.body)}</div>
        <p className="mailc-noreply">
          Waiting for the Power Automate flow. It becomes a draft in Outlook within about a
          minute and leaves this list; review and send it from there.
        </p>
      </div>
    </>
  )

  const read = (
    <section className="mailc-read" aria-label="Reading pane">
      {selectedThread ? (
        threadView(selectedThread)
      ) : selectedFiled ? (
        filedView(selectedFiled)
      ) : (
        <div className="mailc-read-empty">
          <p>
            {showingDrafts
              ? 'Pick a filed draft to read it.'
              : threads.length > 0
                ? 'Pick a conversation to read it.'
                : ' '}
          </p>
          <p className="mailc-keys">
            <kbd>j</kbd>
            <kbd>k</kbd> move · <kbd>e</kbd> handled · <kbd>s</kbd> star · <kbd>u</kbd> unread
            · <kbd>r</kbd> reply · <kbd>c</kbd> compose · <kbd>/</kbd> search
          </p>
        </div>
      )}
    </section>
  )

  return (
    <div className="mailc">
      {rail}
      {list}
      {read}
      {compose && (
        <MailCompose
          key={`${compose.subject ?? ''}|${(compose.to ?? []).join(',')}`}
          initialTo={compose.to}
          initialSubject={compose.subject}
          people={people}
          onClose={() => setCompose(null)}
          onFiled={() => load(true)}
        />
      )}
      {guideOpen && <MailGuideDialog onClose={() => setGuideOpen(false)} />}
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
    </div>
  )
}

/**
 * The inline reply box at the foot of a thread. The model writes the draft
 * with Rowan's context behind it (who the sender is, what they owe you, what
 * you owe them); you edit it, and it goes to Outlook as a draft. Rowan never
 * sends.
 */
function ReplyBox({
  message,
  onClose,
  onFiled
}: {
  message: MailMessage
  onClose: () => void
  onFiled: () => void
}): React.JSX.Element {
  const [instruction, setInstruction] = useState('')
  const [body, setBody] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(false)
  const [copied, setCopied] = useState(false)
  const [signed, setSigned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const instructionRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    instructionRef.current?.focus()
    // the signature is appended on the way out, so say so rather than
    // pasting it into a box the model is about to rewrite
    window.scribe.settings.get().then((s) => setSigned(!!s.mailSignatureHtml))
  }, [])

  async function draft(): Promise<void> {
    setDrafting(true)
    setError(null)
    const result = await window.scribe.mail.draftReply(message.id, instruction || undefined)
    setDrafting(false)
    if (result.ok && result.body) {
      setBody(result.body)
      setQueued(false)
      bodyRef.current?.focus()
    } else setError(result.error ?? 'Could not draft a reply')
  }

  async function queue(): Promise<void> {
    if (!body.trim()) return
    setBusy(true)
    setError(null)
    const result = await window.scribe.mail.queueDraft({ messageId: message.id, body: body.trim() })
    setBusy(false)
    if (result.ok) {
      setQueued(true)
      onFiled()
    } else setError(result.error ?? 'Could not file the draft')
  }

  async function copyDraft(): Promise<void> {
    if (!body.trim()) return
    await navigator.clipboard.writeText(body.trim())
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="mailc-replybox">
      <div className="mailc-replybox-head">
        <Avatar name={message.fromName ?? message.from} />
        <span className="mailc-replybox-to">
          ↩ Reply to <strong>{message.fromName ?? message.from}</strong>
          {message.fromName && <span className="mail-addr-raw"> &lt;{message.from}&gt;</span>}
        </span>
      </div>
      <div className="mailc-ai-row">
        <input
          ref={instructionRef}
          className="text-input mailc-ai-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="How should this be answered? e.g. push it to next week, or say yes but ask for the numbers first"
          onKeyDown={(e) => e.key === 'Enter' && !drafting && draft()}
          aria-label="How should this be answered"
        />
        <button className="btn mailc-ai-btn" onClick={draft} disabled={drafting}>
          {drafting ? 'Drafting…' : body ? '✦ Redraft' : '✦ Draft it'}
        </button>
      </div>
      <textarea
        ref={bodyRef}
        className="text-input mailc-replybox-body"
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          setQueued(false)
          setCopied(false)
        }}
        rows={10}
        placeholder="Draft it above with Rowan's context, or just write."
        aria-label="Reply"
      />
      {error && <p className="field-note error">{error}</p>}
      {queued && (
        <p className="field-note ok">
          Filed. It becomes a draft in Outlook within about a minute — review and send it
          from there.
        </p>
      )}
      <div className="mailc-replybox-foot">
        <button
          type="button"
          className="btn btn-primary"
          onClick={queue}
          disabled={busy || queued || !body.trim()}
        >
          {busy ? 'Filing…' : queued ? 'Filed ✓' : 'Send to Outlook drafts'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={copyDraft} disabled={!body.trim()}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <span className="mailc-replybox-note">
          {signed && !queued ? 'Your signature is added when this is filed.' : ''}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {queued ? 'Done' : 'Discard'}
        </button>
      </div>
    </div>
  )
}
