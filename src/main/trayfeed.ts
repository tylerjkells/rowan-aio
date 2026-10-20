import { findLiveEvent, getTodayEvents } from './calendar'
import { getSettings } from './settings'
import { activeRecording } from './store'
import { setTrayInfo, type TrayInfo } from './system'

// Keeps the tray current: what is recording, and what is left on today's
// calendar. Calendar reads come from the feed's cache, so the half-minute
// refresh costs nothing; recording starts and stops refresh right away.

const REFRESH_MS = 30_000
/** a meeting that started this recently still shows as coming up */
const JUST_STARTED_MS = 10 * 60 * 1000

let started = false

export function startTrayFeed(): void {
  if (started) return
  started = true
  refreshTrayFeed().catch(() => {})
  setInterval(() => refreshTrayFeed().catch(() => {}), REFRESH_MS)
}

export async function refreshTrayFeed(): Promise<void> {
  const rec = activeRecording()
  let recording: TrayInfo['recording'] = null
  let upcoming: TrayInfo['upcoming'] = []
  const calendar = getSettings().hasCalendar

  if (rec) {
    recording = { since: new Date(rec.startedAt).getTime(), title: null }
    if (calendar) {
      try {
        recording.title = (await findLiveEvent(rec.startedAt))?.title ?? null
      } catch {
        // untitled is fine
      }
    }
  }

  if (calendar) {
    try {
      const now = Date.now()
      upcoming = (await getTodayEvents())
        .filter(
          (e) =>
            !e.allDay &&
            new Date(e.end).getTime() > now &&
            new Date(e.start).getTime() > now - JUST_STARTED_MS
        )
        .map((e) => ({ title: e.title, start: e.start, joinUrl: e.joinUrl, location: e.location }))
    } catch {
      // feed unreachable: show no schedule
    }
  }

  setTrayInfo({ recording, upcoming })
}
