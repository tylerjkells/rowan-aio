import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AutoEndReason } from '../../shared/types'
import type { RecorderHandles } from './recorder'

/**
 * Auto-end watchdog. A recording stops itself when the room has been silent
 * for a while, or when it is well past the end of the calendar event it
 * belongs to. Both rules give a visible grace period first, so a long quiet
 * stretch in a live meeting is one click away from being overruled.
 *
 * It lives at the app shell rather than on the Record page: the user is free
 * to browse the library mid-recording, and a forgotten recording is exactly
 * the case this exists for.
 */

const GRACE_MS = 30_000
const CHECK_MS = 1000

export function AutoEndWatch({
  rec,
  settings,
  paused,
  busy,
  onStop
}: {
  rec: RecorderHandles | null
  settings: AppSettings | null
  paused: boolean
  /** a stop is already in flight; stay out of the way */
  busy: boolean
  onStop: (reason: AutoEndReason) => void
}): React.JSX.Element {
  const [scheduledEnd, setScheduledEnd] = useState<number | null>(null)
  const [pending, setPending] = useState<{ reason: AutoEndReason; at: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** per-rule "not before" stamps, set when the user overrules a prompt */
  const snooze = useRef<Record<AutoEndReason, number>>({ silence: 0, overrun: 0 })

  // when this recording was supposed to end, from the calendar event it
  // started inside (null without a calendar, or off the schedule entirely)
  useEffect(() => {
    setScheduledEnd(null)
    setPending(null)
    snooze.current = { silence: 0, overrun: 0 }
    if (!rec) return
    let live = true
    window.scribe.calendar
      .liveEvent(new Date(rec.startedAt).toISOString())
      .then((event) => {
        if (live && event && !event.allDay) setScheduledEnd(new Date(event.end).getTime())
      })
      .catch(() => {
        // no calendar, or the feed is unreachable: the silence rule still applies
      })
    return () => {
      live = false
    }
  }, [rec])

  /** hold a rule off for one more full window */
  function holdOff(reason: AutoEndReason): void {
    if (!settings) return
    const minutes =
      reason === 'silence' ? settings.autoEndSilenceMinutes : settings.autoEndOverrunMinutes
    snooze.current[reason] = Date.now() + minutes * 60_000
    setPending(null)
  }

  /** stop, holding the rule off too in case the stop itself fails */
  function fire(reason: AutoEndReason): void {
    holdOff(reason)
    onStop(reason)
  }

  useEffect(() => {
    if (!rec || !settings || busy) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)

      if (pending) {
        if (t >= pending.at) fire(pending.reason)
        return
      }

      const silenceMs = settings.autoEndSilenceMinutes * 60_000
      if (
        settings.autoEndSilence &&
        !paused &&
        t >= snooze.current.silence &&
        rec.silentMs() >= silenceMs
      ) {
        setPending({ reason: 'silence', at: t + GRACE_MS })
        return
      }

      const overrunMs = settings.autoEndOverrunMinutes * 60_000
      if (
        settings.autoEndOverrun &&
        scheduledEnd !== null &&
        t >= snooze.current.overrun &&
        t >= scheduledEnd + overrunMs
      ) {
        setPending({ reason: 'overrun', at: t + GRACE_MS })
      }
    }, CHECK_MS)
    return () => clearInterval(timer)
  }, [rec, settings, paused, busy, scheduledEnd, pending, onStop])

  if (!rec || !settings || !pending || busy) return <></>

  const seconds = Math.max(0, Math.ceil((pending.at - now) / 1000))
  const why =
    pending.reason === 'silence'
      ? `no audio for ${settings.autoEndSilenceMinutes} minutes`
      : `${settings.autoEndOverrunMinutes} minutes past the scheduled end`

  return (
    <div className="autoend-prompt" role="alertdialog" aria-live="assertive">
      <span className="digest-prompt-text">
        <strong>Stopping this recording in {seconds}s</strong> — {why}.
      </span>
      <button className="btn btn-ghost" onClick={() => holdOff(pending.reason)}>
        Keep recording
      </button>
      <button className="btn btn-primary" onClick={() => fire(pending.reason)}>
        Stop now
      </button>
    </div>
  )
}
