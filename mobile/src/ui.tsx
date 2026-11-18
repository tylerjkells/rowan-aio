import type { ReactNode } from 'react'

// small shared pieces: icons, dates and durations, status lines

type IconProps = { size?: number }

function Svg({ size = 24, children }: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const TodayIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    <circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
)

export const MeetingsIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M8 6.5h12M8 12h12M8 17.5h12" />
    <circle cx="4" cy="6.5" r="1" fill="currentColor" />
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="17.5" r="1" fill="currentColor" />
  </Svg>
)

export const MicIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11.5" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
)

export const ActionsIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.3 2.3 4.7-4.9" />
  </Svg>
)

export const PlannerIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="5" height="16" rx="1.5" />
    <rect x="10" y="4" width="5" height="10" rx="1.5" />
    <rect x="16.5" y="4" width="4" height="13" rx="1.5" />
  </Svg>
)

export const BackIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m14.5 5-7 7 7 7" />
  </Svg>
)

export const ChevronIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
)

export function Check({ done }: { done: boolean }): React.JSX.Element {
  return (
    <span className={`check ${done ? 'on' : ''}`} aria-hidden="true">
      {done && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      )}
    </span>
  )
}

export function Spinner(): React.JSX.Element {
  return <span className="spinner" aria-hidden="true" />
}

export function Stale({ show }: { show: boolean }): React.JSX.Element | null {
  return show ? <p className="stale">Offline · showing what was last loaded</p> : null
}

export function Problem({ error }: { error: string | null }): React.JSX.Element | null {
  return error ? (
    <p className="problem" role="alert">
      {error}
    </p>
  ) : null
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- time -------------------------------------------------------------------

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function duration(ms: number | null | undefined): string {
  if (!ms || ms < 1000) return ''
  const min = Math.round(ms / 60_000)
  if (min < 1) return `${Math.round(ms / 1000)} sec`
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "Due today", "Due Fri", "Overdue · Nov 12" for an action item */
export function dueLabel(due: string | null, raw: string | null): string | null {
  if (!due) return raw ? `Due ${raw}` : null
  const d = new Date(`${due}T12:00:00`)
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5)
  if (days < 0) return `Overdue · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days < 7) return `Due ${d.toLocaleDateString(undefined, { weekday: 'short' })}`
  return `Due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** where a phone recording is, in words */
export function stageNote(stage: string, claimedBy: string | null | undefined): string | null {
  switch (stage) {
    case 'uploaded':
      return claimedBy ? 'Your PC is transcribing it' : 'Waiting for one of your PCs to transcribe it'
    case 'recorded':
    case 'transcribing':
    case 'identifying':
    case 'summarizing':
      return 'Being processed on your PC'
    case 'transcript-only':
      return 'Transcript only (no summary)'
    case 'error':
      return 'Needs attention on your PC'
    default:
      return null
  }
}
