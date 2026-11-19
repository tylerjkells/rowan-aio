import { useEffect, useRef, useState } from 'react'
import { HubError } from '../api'
import { useApp } from '../App'
import { recordingFile } from '../data'
import { playableVersions, type Version } from '../playable'
import { Spinner } from '../ui'

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; note: string }
  | { kind: 'ready'; url: string; version: Version }
  | { kind: 'missing' }
  | { kind: 'unplayable' }

/**
 * A meeting's recording, fetched when asked for. A PC's recording (WebM) is
 * repackaged for Safari, and if a version won't play, the next one is made
 * (see playable.ts).
 */
export function RecordingPlayer({ meetingId, onError }: { meetingId: string; onError: (msg: string) => void }): React.JSX.Element {
  const { hub, fail } = useApp()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const versions = useRef<ReturnType<typeof playableVersions>>([])
  const url = state.kind === 'ready' ? state.url : null

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url]
  )

  async function next(): Promise<void> {
    while (versions.current.length) {
      const v = versions.current.shift() as (typeof versions.current)[number]
      if (v.kind === 'wav') setState({ kind: 'loading', note: 'Preparing it for this phone…' })
      try {
        const blob = await v.make((f) => setState({ kind: 'loading', note: `Preparing it for this phone… ${Math.round(f * 100)}%` }))
        if (blob) {
          setState({ kind: 'ready', url: URL.createObjectURL(blob), version: v.kind })
          return
        }
      } catch {
        // this way didn't work here: try the next
      }
    }
    setState({ kind: 'unplayable' })
  }

  async function start(): Promise<void> {
    setState({ kind: 'loading', note: 'Loading recording…' })
    try {
      const file = await recordingFile(hub, meetingId)
      if (!file) return setState({ kind: 'missing' })
      versions.current = playableVersions(file.blob, file.ext)
      await next()
    } catch (err) {
      if (err instanceof HubError && err.kind === 'missing') setState({ kind: 'missing' })
      else {
        setState({ kind: 'idle' })
        onError(fail(err))
      }
    }
  }

  return (
    <section className="player">
      {state.kind === 'ready' ? (
        <audio
          key={state.url}
          controls
          src={state.url}
          preload="metadata"
          data-version={state.version}
          onError={() => {
            setState({ kind: 'loading', note: 'Trying another way to play it…' })
            void next()
          }}
        />
      ) : state.kind === 'missing' ? (
        <p className="fine">The recording isn’t in the hub anymore; it’s on the PC that made it.</p>
      ) : state.kind === 'unplayable' ? (
        <p className="fine">This phone can’t play this recording. It plays in Rowan on your PC.</p>
      ) : (
        <button className="btn-secondary" disabled={state.kind === 'loading'} onClick={() => void start()}>
          {state.kind === 'loading' ? (
            <>
              <Spinner /> {state.note}
            </>
          ) : (
            'Play recording'
          )}
        </button>
      )}
    </section>
  )
}
