import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingStage } from '../../shared/types'

export interface ConfirmOptions {
  title: string
  body?: string
  /** label for the confirming button, e.g. "Delete" */
  confirmLabel?: string
  /** destructive actions get the accent-solid treatment */
  danger?: boolean
}

/**
 * In-app replacement for window.confirm. Returns the dialog element (render
 * it anywhere in the view) and an async confirm(opts) that resolves true on
 * confirm, false on cancel/Escape/backdrop click.
 */
export function useConfirm(): [React.JSX.Element, (opts: ConfirmOptions) => Promise<boolean>] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((v: boolean) => void) | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const confirm = useCallback((o: ConfirmOptions): Promise<boolean> => {
    setOpts(o)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  useEffect(() => {
    if (opts) dialogRef.current?.showModal()
  }, [opts])

  function settle(value: boolean): void {
    resolver.current?.(value)
    resolver.current = null
    dialogRef.current?.close()
    setOpts(null)
  }

  const element = opts ? (
    <dialog
      ref={dialogRef}
      className="confirm"
      onClose={() => settle(false)}
      onClick={(e) => {
        // click on the backdrop (the dialog element itself) cancels
        if (e.target === dialogRef.current) settle(false)
      }}
    >
      <h3>{opts.title}</h3>
      {opts.body && <p>{opts.body}</p>}
      <div className="confirm-actions">
        <button className="btn" onClick={() => settle(false)}>
          Cancel
        </button>
        <button
          className={`btn ${opts.danger ? 'btn-solid-danger' : 'btn-primary'}`}
          autoFocus
          onClick={() => settle(true)}
        >
          {opts.confirmLabel ?? 'OK'}
        </button>
      </div>
    </dialog>
  ) : (
    <></>
  )

  return [element, confirm]
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** a dated, not-done action item whose due day has passed */
export function isOverdue(item: { dueDate?: string; done?: boolean }): boolean {
  if (!item.dueDate || item.done) return false
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return item.dueDate < today
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

export function StageBadge({
  stage,
  progress
}: {
  stage: MeetingStage
  progress?: number
}): React.JSX.Element | null {
  switch (stage) {
    case 'transcribing':
      return (
        <span className="badge badge-working">
          <span className="spinner" aria-hidden="true" />
          Transcribing{typeof progress === 'number' && progress > 0 ? ` ${progress}%` : '…'}
        </span>
      )
    case 'summarizing':
      return (
        <span className="badge badge-working">
          <span className="spinner" aria-hidden="true" />
          Summarizing…
        </span>
      )
    case 'recorded':
      return <span className="badge badge-quiet">Queued</span>
    case 'transcript-only':
      return <span className="badge badge-quiet">Transcript only</span>
    case 'error':
      return <span className="badge badge-error">Needs attention</span>
    default:
      return null
  }
}

/**
 * Click-to-edit owner chip for action items. Opens a combobox that shows the
 * whole directory up front (no pre-filtering by the current owner) and only
 * narrows once the user actually types.
 */
export function OwnerEditor({
  owner,
  suggestions,
  onSave,
  label
}: {
  owner: string | null
  suggestions: string[]
  onSave: (owner: string | null) => void
  /** display text for the chip; defaults to the raw owner */
  label?: string | null
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [typed, setTyped] = useState(false)
  const [hi, setHi] = useState(-1)
  const display = label ?? owner

  if (!editing) {
    return (
      <button
        className={`owner-btn ${display ? '' : 'unassigned'}`}
        title={display ? `Assigned to ${display} (click to change)` : 'Assign to someone'}
        onClick={() => {
          setDraft(owner ?? '')
          setTyped(false)
          setHi(-1)
          setEditing(true)
        }}
      >
        {display ?? '+ Assign'}
      </button>
    )
  }

  // comma-aware: complete only the segment being typed, so shared items can
  // list several people ("Carol Primas-Young, Andrew Bunoza")
  const lastComma = draft.lastIndexOf(',')
  const head = lastComma >= 0 ? draft.slice(0, lastComma + 1) : ''
  const tail = draft.slice(lastComma + 1).trim()
  const already = new Set(
    head
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  )
  const query = tail.toLowerCase()
  const options = suggestions
    .filter((s) => !already.has(s.toLowerCase()))
    .filter((s) => (typed && query ? s.toLowerCase().includes(query) : true))

  /** trim segments, drop empties and duplicates, join back "A, B" */
  function normalize(value: string): string | null {
    const seen = new Set<string>()
    const parts = value
      .split(',')
      .map((p) => p.trim())
      .filter((p) => {
        if (!p || seen.has(p.toLowerCase())) return false
        seen.add(p.toLowerCase())
        return true
      })
    return parts.length > 0 ? parts.join(', ') : null
  }

  function pick(next: string | null): void {
    setEditing(false)
    const final = next === null ? null : normalize(head ? `${head} ${next}` : next)
    if (final !== owner) onSave(final)
  }

  function commitTyped(): void {
    setEditing(false)
    const final = normalize(draft)
    if (final !== owner) onSave(final)
  }

  return (
    <span className="owner-wrap">
      <input
        autoFocus
        className="text-input owner-input"
        placeholder="Name (comma for several)"
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          setDraft(e.target.value)
          setTyped(true)
          setHi(e.target.value.trim() ? 0 : -1)
        }}
        onBlur={commitTyped}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => (h + 1) % Math.max(options.length, 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => (h <= 0 ? options.length - 1 : h - 1))
          } else if (e.key === 'Enter') {
            if (hi >= 0 && options[hi]) pick(options[hi])
            else commitTyped()
          } else if (e.key === 'Escape') {
            setEditing(false)
          }
        }}
        role="combobox"
        aria-expanded="true"
        aria-label="Action item owner"
      />
      <div className="owner-pop" role="listbox">
        {owner && (
          <button
            className="owner-opt owner-opt-clear"
            role="option"
            aria-selected="false"
            onMouseDown={(e) => {
              e.preventDefault()
              pick(null)
            }}
          >
            Unassign
          </button>
        )}
        {options.map((s, i) => (
          <button
            className={`owner-opt ${i === hi ? 'hi' : ''} ${s === owner ? 'current' : ''}`}
            role="option"
            aria-selected={s === owner}
            key={s}
            onMouseDown={(e) => {
              e.preventDefault()
              pick(s)
            }}
            onMouseEnter={() => setHi(i)}
          >
            {s}
          </button>
        ))}
        {options.length === 0 && <span className="owner-opt-empty">New name — press Enter</span>}
      </div>
    </span>
  )
}

/** "Jul 21", with the year only when it isn't this year */
export function formatDueLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: y === new Date().getFullYear() ? undefined : 'numeric'
  })
}

/**
 * Click-to-edit due date for action items. Shows the summarizer's free text
 * with the date it resolved to ("before Monday · Jul 21"); once the user sets
 * a date explicitly, the date alone is the truth.
 */
/**
 * "August 24 · Aug 24" says nothing twice: when the summary's free-text due
 * is itself just the date the chip already shows, drop the text and keep the
 * label. Relative phrasings ("before Monday · Sep 9") still show both.
 */
function dueTextRedundant(due: string, dueDate: string): boolean {
  const d = new Date(`${dueDate}T12:00:00`)
  const day = d.getDate()
  const year = d.getFullYear()
  const long = d.toLocaleDateString('en-US', { month: 'long' })
  const short = d.toLocaleDateString('en-US', { month: 'short' })
  const clean = due
    .toLowerCase()
    .replace(/^(due|by|on)\s+/g, '')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[.,]/g, '')
    .trim()
  return [
    `${long} ${day}`,
    `${short} ${day}`,
    `${long} ${day} ${year}`,
    `${short} ${day} ${year}`,
    `${d.getMonth() + 1}/${day}`,
    `${d.getMonth() + 1}/${day}/${year}`,
    dueDate
  ].some((f) => f.toLowerCase() === clean)
}

export function DueEditor({
  due,
  dueDate,
  edited,
  overdue,
  onSave
}: {
  /** free text from the summary, e.g. "before Monday" */
  due: string | null
  /** effective ISO date (user-set or parsed), if any */
  dueDate?: string
  /** the user set the date explicitly */
  edited?: boolean
  overdue?: boolean
  onSave: (isoDate: string | null) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)

  if (!editing) {
    const text = edited && dueDate
      ? formatDueLabel(dueDate)
      : due
        ? dueDate
          ? dueTextRedundant(due, dueDate)
            ? formatDueLabel(dueDate)
            : `${due} · ${formatDueLabel(dueDate)}`
          : due
        : dueDate
          ? formatDueLabel(dueDate)
          : null
    return (
      <button
        className={`due-btn ${overdue ? 'overdue' : ''} ${text ? '' : 'no-due'}`}
        title={text ? 'Change due date' : 'Set a due date'}
        onClick={() => {
          cancelled.current = false
          setEditing(true)
        }}
      >
        {text ?? '+ Due'}
      </button>
    )
  }

  function commit(value: string): void {
    setEditing(false)
    if (cancelled.current) return
    const next = value || null
    if (next !== (dueDate ?? null)) onSave(next)
  }

  return (
    <input
      autoFocus
      type="date"
      className="text-input due-input"
      defaultValue={dueDate ?? ''}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          setEditing(false)
        }
      }}
      aria-label="Action item due date"
    />
  )
}

/* 16px stroke icons, consistent weight */

export function MicIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  )
}

export function ListIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function GearIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </svg>
  )
}

export function TodayIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2.5" />
      <path d="M3 9h18M8 2v4M16 2v4" />
      <circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function UsersIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M18.5 15.3c1.6.8 2.6 2.1 3 4.2" />
    </svg>
  )
}

export function WrenchIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.3L3 17.3a2.1 2.1 0 0 0 3 3l5.7-5.7a4.5 4.5 0 0 0 5.3-6L13.5 12l-1.8-.3-.3-1.8Z" />
    </svg>
  )
}

export function BoardIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M9 3v18M15 3v10" />
    </svg>
  )
}

export function LinkIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

export function PaletteIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21a9 9 0 1 1 9-9c0 2.6-1.9 3.3-3.4 3.3h-1.8a2 2 0 0 0-1.5 3.3c.4.5.5 1 .2 1.5-.4.7-1.4.9-2.5.9Z" />
      <circle cx="7.8" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="17.3" cy="11" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SparkIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9Z" />
    </svg>
  )
}

export function CheckIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

export function StopIcon(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

export function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

export function BackIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}
