import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AutoEndReason } from '../../shared/types'
import type { MicChange } from '../../preload/index'
import type { RecorderHandles } from './recorder'

/**
 * Auto-end watchdog. A recording stops itself when the room has been silent
 * for a while, when it is well past the end of the calendar event it
 * belongs to, or (virtual meetings) when the call app lets go of the mic.
 * Every rule gives a visible grace period first, so a long quiet stretch in
 * a live meeting is one click away from being overruled.
 *
 * It lives at the app shell rather than on the Record page: the user is free
 * to browse the library mid-recording, and a forgotten recording is exactly
 * the case this exists for.
 */

const GRACE_MS = 30_000
const CHECK_MS = 1000
/** the mic has to stay free this long before the call counts as over (device switches blip) */
const CALL_GONE_MS = 15_000
/** a call app letting go this early in a recording was a call that ended before it */
const CALL_MIN_REC_MS = 30_000

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
  const snooze = useRef<Record<AutoEndReason, number>>({ silence: 0, overrun: 0, callEnded: 0 })
  /** call apps seen holding the mic during this recording */
  const callApps = useRef<Set<string>>(new Set())
  /** when the last of them let go (null while a call is on) */
  const callGoneAt = useRef<number | null>(null)
  const callName = useRef('The call app')

  // call detection: the main process reports which apps hold the mic
  useEffect(() => {
    callApps.current = new Set()
    callGoneAt.current = null
    if (!rec || rec.mode !== 'virtual') return
    const apply = (c: MicChange): void => {
      // stale-looking entries from before the app started don't count as a call in progress
      const live = c.active.filter((a) => !c.doubtful.includes(a.id))
      for (const a of c.active) callApps.current.add(a.id)
      if (live.length > 0) {
        callGoneAt.current = null
        callName.current = live[0].name
        // the call picked back up while the stop was counting down
        setPending((p) => (p?.reason === 'callEnded' ? null : p))
        return
      }
      const ended = c.stopped.find((a) => callApps.current.has(a.id))
      if (ended && rec.elapsedMs() >= CALL_MIN_REC_MS && callGoneAt.current === null) {
        callGoneAt.current = Date.now()
        callName.current = ended.name
      }
    }
    window.scribe.mic.state().then(apply).catch(() => {})
    return window.scribe.mic.onChange(apply)
  }, [rec])

  // when this recording was supposed to end, from the calendar event it
  // started inside (null without a calendar, or off the schedule entirely)
  useEffect(() => {
    setScheduledEnd(null)
    setPending(null)
    snooze.current = { silence: 0, overrun: 0, callEnded: 0 }
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
    if (reason === 'callEnded') {
      // wait for the next call to end rather than a fixed window
      callGoneAt.current = null
      setPending(null)
      return
    }
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

      if (
        settings.autoEndCallEnded &&
        callGoneAt.current !== null &&
        t - callGoneAt.current >= CALL_GONE_MS
      ) {
        setPending({ reason: 'callEnded', at: t + GRACE_MS })
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
      : pending.reason === 'callEnded'
        ? `${callName.current} let go of the microphone, so the call looks over`
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
