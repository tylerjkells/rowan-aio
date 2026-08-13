import { Notification } from 'electron'
import { refreshCalendar } from './calendar'
import { getSettings } from './settings'
import { hasActiveRecording } from './store'
import { showMainWindow } from './system'
import type { AutoEndReason } from '../shared/types'

// A local Notification can be garbage-collected while its toast still sits in
// the notification center — the click handler dies with it and Windows falls
// back to a raw app activation. Hold the latest one until it's dismissed.
let liveNotification: Notification | null = null

function notify(title: string, body: string, onClick: () => void): void {
  const n = new Notification({ title, body })
  n.on('click', () => {
    onClick()
    if (liveNotification === n) liveNotification = null
  })
  n.on('close', () => {
    if (liveNotification === n) liveNotification = null
  })
  liveNotification = n
  n.show()
}

// ---------------------------------------------------------------------------
// Record nudge: when a calendared meeting starts and nothing is recording,
// raise one system notification. Clicking it brings the app forward on the
// Record page. Each event occurrence nudges at most once per app run.
// ---------------------------------------------------------------------------

/** how long after its start a meeting is still worth nudging about */
const NUDGE_WINDOW_MS = 8 * 60 * 1000

const nudged = new Set<string>()

export function startRecordNudge(): void {
  // soon after launch (the app may open mid-meeting), then every minute
  setTimeout(() => check().catch(() => 0), 5_000)
  setInterval(() => check().catch(() => 0), 60_000)
}

/**
 * A recording that stopped itself deserves a word — the whole point of the
 * rule is that nobody was watching the window at the time.
 */
export function notifyAutoEnd(title: string, reason: AutoEndReason): void {
  if (!Notification.isSupported()) return
  notify(
    'Recording ended automatically',
    reason === 'silence'
      ? `“${title}” went quiet, so Rowan AIO stopped and is transcribing it.`
      : `“${title}” ran past its scheduled end, so Rowan AIO stopped and is transcribing it.`,
    () => showMainWindow()
  )
}

async function check(): Promise<void> {
  const settings = getSettings()
  if (!settings.hasCalendar || !settings.recordNudge) return
  if (hasActiveRecording()) return
  if (!Notification.isSupported()) return

  let events
  try {
    events = await refreshCalendar()
  } catch {
    return // feed unreachable: try again next minute
  }

  const now = Date.now()
  for (const e of events) {
    // nudge only for things that look like actual meetings: a call link or a room
    if (e.allDay || (!e.joinUrl && !e.location)) continue
    const start = new Date(e.start).getTime()
    const end = new Date(e.end).getTime()
    if (now < start || now > Math.min(start + NUDGE_WINDOW_MS, end)) continue
    if (nudged.has(e.id)) continue
    nudged.add(e.id)

    notify(
      'Meeting started — record it?',
      `${e.title} is on now and nothing is recording. Click to open Rowan AIO.`,
      () => showMainWindow('record')
    )
    return // one nudge at a time; overlapping events wait for the next tick
  }
}
