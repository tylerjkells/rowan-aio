import { BrowserWindow, Notification } from 'electron'
import { refreshCalendar } from './calendar'
import { getSettings } from './settings'
import { hasActiveRecording } from './store'
import type { AutoEndReason } from '../shared/types'

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
  const n = new Notification({
    title: 'Recording ended automatically',
    body:
      reason === 'silence'
        ? `“${title}” went quiet, so MeetingScribe stopped and is transcribing it.`
        : `“${title}” ran past its scheduled end, so MeetingScribe stopped and is transcribing it.`
  })
  n.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  n.show()
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

    const n = new Notification({
      title: 'Meeting started — record it?',
      body: `${e.title} is on now and nothing is recording. Click to open MeetingScribe.`
    })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('nudge:openRecord')
    })
    n.show()
    return // one nudge at a time; overlapping events wait for the next tick
  }
}
