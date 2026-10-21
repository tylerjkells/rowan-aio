import { Notification } from 'electron'
import { findLiveEvent, refreshCalendar } from './calendar'
import { micApps, onMicChange } from './micwatch'
import { getSettings } from './settings'
import { hasActiveRecording } from './store'
import { joinAndRecord, showMainWindow } from './system'
import type { AutoEndReason, CalendarEvent, MicApp, RecordingMode } from '../shared/types'

// A local Notification can be garbage-collected while its toast still sits in
// the notification center — the click handler dies with it and Windows falls
// back to a raw app activation. Hold the latest one until it's withdrawn.
let liveNotification: Notification | null = null
/** what the live toast is about, so it can be withdrawn once it no longer applies */
let liveTopic: { kind: 'calendar' | 'call' | 'info'; key: string } | null = null
/** what clicking the live toast does; taken once, by whichever click path gets there first */
let liveAction: (() => void) | null = null
let withdrawTimer: NodeJS.Timeout | null = null

/**
 * Withdraw our toast when the app quits. A toast that outlives its process
 * gets a raw exe activation from Windows on click — which for a dev run
 * opens Electron's bare welcome window instead of the app.
 */
export function dismissNotifications(): void {
  if (withdrawTimer) clearTimeout(withdrawTimer)
  withdrawTimer = null
  liveNotification?.close()
  liveNotification = null
  liveTopic = null
  liveAction = null
}

function runLiveAction(): void {
  const action = liveAction
  dismissNotifications()
  action?.()
}

/**
 * Every toast click Windows routes to this run, whether or not the
 * Notification object still exists to hear it: one clicked from the
 * notification center, or one that started the app. Alongside the toast's
 * own click event, so whichever arrives first acts and the other finds
 * nothing left to do.
 */
export function listenForToastClicks(): void {
  if (process.platform !== 'win32' || typeof Notification.handleActivation !== 'function') return
  Notification.handleActivation(() => {
    if (liveAction) runLiveAction()
    else showMainWindow()
  })
}

function notify(
  title: string,
  body: string,
  onClick: () => void,
  topic: { kind: 'calendar' | 'call' | 'info'; key: string } = { kind: 'info', key: '' },
  /** take it out of the notification center after this long */
  ttlMs?: number
): void {
  // one toast at a time: an older one left behind would only go stale
  dismissNotifications()
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (liveNotification === n) runLiveAction()
  })
  // no letting go on 'close': Windows sends it when the popup times out into
  // the notification center, where the toast can still be clicked
  liveNotification = n
  liveTopic = topic
  liveAction = onClick
  if (ttlMs) {
    withdrawTimer = setTimeout(() => {
      if (liveNotification === n) dismissNotifications()
    }, ttlMs)
  }
  n.show()
}

/** a recording started: an offer to record is moot now */
export function onRecordingStarted(): void {
  if (liveTopic && liveTopic.kind !== 'info') dismissNotifications()
}

// ---------------------------------------------------------------------------
// Record nudge: as a calendared meeting starts and nothing is recording,
// raise one system notification. Clicking it joins the call (when the invite
// has a link) and starts recording. Each event occurrence nudges at most once
// per app run, and the toast is withdrawn a few minutes into the meeting.
// ---------------------------------------------------------------------------

/** how long after its start a meeting is still worth nudging about */
const NUDGE_WINDOW_MS = 8 * 60 * 1000
/** nudge this early, so "join" lands on time */
const NUDGE_LEAD_MS = 60 * 1000
/** pull the calendar toast this long after the meeting starts */
const CALENDAR_TOAST_TTL_MS = 5 * 60 * 1000
/** a call has to hold the mic this long before it counts (skips quick mic checks) */
const CALL_SETTLE_MS = 15 * 1000

const nudged = new Set<string>()

export function startRecordNudge(): void {
  // soon after launch (the app may open mid-meeting), then every minute
  setTimeout(() => check().catch(() => 0), 5_000)
  setInterval(() => check().catch(() => 0), 30_000)
  onMicChange(({ started, stopped }) => {
    for (const app of started) setTimeout(() => callNudge(app).catch(() => 0), CALL_SETTLE_MS)
    // the call this toast offered to record is over
    if (liveTopic?.kind === 'call' && stopped.some((a) => a.id === liveTopic?.key)) {
      dismissNotifications()
    }
  })
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
      : reason === 'callEnded'
        ? `The call for “${title}” ended, so Rowan AIO stopped and is transcribing it.`
        : `“${title}” ran past its scheduled end, so Rowan AIO stopped and is transcribing it.`,
    () => showMainWindow()
  )
}

/** a call link, or a location that names a call platform, means a virtual meeting */
function modeFor(e: CalendarEvent): RecordingMode {
  if (e.joinUrl) return 'virtual'
  return /teams|webex|zoom|google meet|online|virtual|call/i.test(e.location ?? '')
    ? 'virtual'
    : 'in-person'
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
    if (now < start - NUDGE_LEAD_MS || now > Math.min(start + NUDGE_WINDOW_MS, end)) continue
    if (nudged.has(e.id)) continue
    nudged.add(e.id)

    const soon = now < start
    notify(
      soon ? `${e.title} is starting` : `${e.title} is on now`,
      e.joinUrl
        ? 'Click to join the call and start recording.'
        : 'Nothing is recording yet. Click to start recording.',
      () => joinAndRecord(e.joinUrl, modeFor(e)),
      { kind: 'calendar', key: e.id },
      Math.max(60_000, start + CALENDAR_TOAST_TTL_MS - now)
    )
    return // one nudge at a time; overlapping events wait for the next tick
  }
}

// ---------------------------------------------------------------------------
// Call nudge: another app (Webex, Teams, a browser) picked up the mic and has
// held it for a little while, and nothing is recording. Covers the calls the
// calendar never knew about. The calendar event live right now, if any,
// names the toast.
// ---------------------------------------------------------------------------

const callNudged = new Map<string, number>()

async function callNudge(app: MicApp): Promise<void> {
  const settings = getSettings()
  if (!settings.callDetect || hasActiveRecording() || !Notification.isSupported()) return
  // still on the same call (it may have ended inside the settle time)
  const current = micApps().find((a) => a.id === app.id)
  if (!current || current.since !== app.since) return
  if (callNudged.get(app.id) === app.since) return
  callNudged.set(app.id, app.since)

  let event: CalendarEvent | null = null
  try {
    event = settings.hasCalendar ? await findLiveEvent(new Date().toISOString()) : null
  } catch {
    // no calendar: a generic title is fine
  }
  if (hasActiveRecording()) return
  notify(
    event ? `${event.title}: record it?` : `${app.name} call: record it?`,
    `${app.name} is using your microphone and nothing is recording. Click to start recording.`,
    () => joinAndRecord(null, 'virtual'),
    { kind: 'call', key: app.id }
  )
}
