import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  AutoEndReason,
  EngineStatus,
  MeetingListItem
} from '../../shared/types'
import type { RecorderHandles } from './recorder'
import { LibraryView } from './views/Library'
import { RecordView } from './views/Record'
import { MeetingView } from './views/MeetingDetail'
import { SettingsView } from './views/Settings'
import { ActionsView } from './views/Actions'
import { ImportView } from './views/Import'
import { AutoEndWatch } from './AutoEnd'
import { TodayView } from './views/Today'
import { PeopleView, PersonView } from './views/People'
import { LinksView } from './views/Links'
import { BrandView } from './views/Brand'
import { ProjectsView } from './views/Projects'
import { MailView } from './views/Mail'
import { ToolboxView } from './views/Toolbox'
import { SeriesView } from './views/Series'
import { AskWidget } from './AskWidget'
import { Digest } from './Digest'
import { WhatsNew } from './WhatsNew'
import {
  MicIcon,
  ListIcon,
  GearIcon,
  CheckIcon,
  TodayIcon,
  UsersIcon,
  LinkIcon,
  PaletteIcon,
  BoardIcon,
  MailIcon,
  WrenchIcon,
  formatDuration
} from './ui'

export type View =
  | { name: 'today' }
  | { name: 'library' }
  | { name: 'record' }
  | { name: 'meeting'; id: string; at?: number }
  | { name: 'actions' }
  | { name: 'people' }
  | { name: 'person'; person: string }
  | { name: 'links' }
  | { name: 'brand' }
  | { name: 'projects' }
  | { name: 'mail' }
  | { name: 'toolbox' }
  | { name: 'series'; title: string }
  | { name: 'import' }
  | { name: 'settings' }

/** compact live timer for the sidebar recording indicator */
function RecTicker({ rec }: { rec: RecorderHandles }): React.JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  return <>{formatDuration(rec.elapsedMs())}</>
}

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ name: 'today' })
  const [meetings, setMeetings] = useState<MeetingListItem[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  // the live recorder is held here so it survives view changes
  const [rec, setRec] = useState<RecorderHandles | null>(null)
  const [paused, setPaused] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [digestRequested, setDigestRequested] = useState(false)
  const [channel, setChannel] = useState<'stable' | 'test' | 'dev'>('stable')
  // finishing state lives here because a recording can also be stopped by the
  // auto-end watchdog while the user is on some other page
  const [finishing, setFinishing] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  useEffect(() => window.scribe.update.onReady(setUpdateVersion), [])

  useEffect(() => {
    window.scribe.appChannel().then(setChannel)
  }, [])

  // record-nudge notification clicked: land on the Record page
  useEffect(() => window.scribe.nudge.onOpenRecord(() => setView({ name: 'record' })), [])

  const refreshMeetings = useCallback(() => {
    window.scribe.meetings.list().then(setMeetings)
  }, [])

  useEffect(() => {
    refreshMeetings()
    window.scribe.settings.get().then(setSettings)
    window.scribe.engine.status().then(setEngine)
    const off = window.scribe.meetings.onUpdated(() => refreshMeetings())
    return off
  }, [refreshMeetings])

  // guard against losing an active recording by closing the window
  useEffect(() => {
    if (!rec) return
    const guard = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = false
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [rec])

  const openMeeting = (id: string, at?: number): void => setView({ name: 'meeting', id, at })

  /** the one way a recording ends: by the stop button or by the auto-end rules */
  const stopRecording = useCallback(
    async (autoEnd: AutoEndReason | null = null): Promise<void> => {
      if (!rec || finishing) return
      setFinishing(true)
      setStopError(null)
      try {
        const meeting = await rec.stop(autoEnd)
        setRec(null)
        setPaused(false)
        refreshMeetings()
        setView({ name: 'meeting', id: meeting.id })
      } catch (err) {
        setStopError(err instanceof Error ? err.message : 'Failed to save recording')
        setView({ name: 'record' })
      } finally {
        setFinishing(false)
      }
    },
    [rec, finishing, refreshMeetings]
  )

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true" />
          Rowan AIO
          {channel !== 'stable' && <span className="channel-chip">{channel}</span>}
        </div>
        <button
          className={`nav-btn ${view.name === 'today' ? 'active' : ''}`}
          onClick={() => setView({ name: 'today' })}
        >
          <TodayIcon /> Today
        </button>
        <div className="nav-section">Meetings</div>
        <button
          className={`nav-btn ${
            view.name === 'library' ||
            view.name === 'meeting' ||
            view.name === 'series' ||
            view.name === 'import'
              ? 'active'
              : ''
          }`}
          onClick={() => setView({ name: 'library' })}
        >
          <ListIcon /> Library
        </button>
        <button
          className={`nav-btn ${view.name === 'actions' ? 'active' : ''}`}
          onClick={() => setView({ name: 'actions' })}
        >
          <CheckIcon /> Action items
        </button>
        <div className="nav-section">Workspace</div>
        <button
          className={`nav-btn ${view.name === 'people' || view.name === 'person' ? 'active' : ''}`}
          onClick={() => setView({ name: 'people' })}
        >
          <UsersIcon /> People
        </button>
        <button
          className={`nav-btn ${view.name === 'projects' ? 'active' : ''}`}
          onClick={() => setView({ name: 'projects' })}
        >
          <BoardIcon /> Projects
        </button>
        <button
          className={`nav-btn ${view.name === 'mail' ? 'active' : ''}`}
          onClick={() => setView({ name: 'mail' })}
        >
          <MailIcon /> Mail
        </button>
        <button
          className={`nav-btn ${view.name === 'links' ? 'active' : ''}`}
          onClick={() => setView({ name: 'links' })}
        >
          <LinkIcon /> Links
        </button>
        <button
          className={`nav-btn ${view.name === 'brand' ? 'active' : ''}`}
          onClick={() => setView({ name: 'brand' })}
        >
          <PaletteIcon /> Brand
        </button>
        <button
          className={`nav-btn ${view.name === 'toolbox' ? 'active' : ''}`}
          onClick={() => setView({ name: 'toolbox' })}
        >
          <WrenchIcon /> Toolbox
        </button>
        <div className="sidebar-spacer" />
        <button
          className={`nav-btn ${view.name === 'settings' ? 'active' : ''}`}
          onClick={() => setView({ name: 'settings' })}
        >
          <GearIcon /> Settings
        </button>
        {updateVersion && !rec && (
          <button
            className="update-chip"
            onClick={() => window.scribe.update.install()}
            title={`Version ${updateVersion} is downloaded and ready`}
          >
            Update ready · restart
          </button>
        )}
        {rec ? (
          view.name !== 'record' && (
            <button
              className={`rec-indicator ${paused ? 'paused' : ''}`}
              onClick={() => setView({ name: 'record' })}
              title="Back to the recording"
            >
              <span className="dot" aria-hidden="true" />
              {paused ? 'Paused' : 'Recording'} · <RecTicker rec={rec} />
            </button>
          )
        ) : (
          view.name !== 'record' && (
            <button className="record-cta" onClick={() => setView({ name: 'record' })}>
              <MicIcon /> New recording
            </button>
          )
        )}
      </nav>

      <main
        className="main"
        key={
          view.name +
          ('id' in view ? view.id : '') +
          ('person' in view ? view.person : '') +
          ('title' in view ? view.title : '')
        }
      >
        <div className="view-enter" style={{ height: view.name === 'record' ? '100%' : undefined }}>
          {view.name === 'today' && (
            <TodayView
              meetings={meetings}
              onOpen={openMeeting}
              onRecord={() => setView({ name: 'record' })}
              onSettings={() => setView({ name: 'settings' })}
              onActions={() => setView({ name: 'actions' })}
              onDigest={() => setDigestRequested(true)}
              onProjects={() => setView({ name: 'projects' })}
            />
          )}
          {view.name === 'library' && (
            <LibraryView
              meetings={meetings}
              onOpen={openMeeting}
              onRecord={() => setView({ name: 'record' })}
              onImport={() => setView({ name: 'import' })}
            />
          )}
          {view.name === 'record' && (
            <RecordView
              engine={engine}
              onEngineReady={setEngine}
              rec={rec}
              setRec={setRec}
              paused={paused}
              setPaused={setPaused}
              finishing={finishing}
              stopError={stopError}
              onStop={() => stopRecording(null)}
              onCancel={() => setView({ name: 'library' })}
            />
          )}
          {view.name === 'meeting' && (
            <MeetingView
              id={view.id}
              focusMs={view.at}
              onBack={() => setView({ name: 'library' })}
              onDeleted={() => {
                refreshMeetings()
                setView({ name: 'library' })
              }}
              onOpenSeries={(title) => setView({ name: 'series', title })}
            />
          )}
          {view.name === 'series' && (
            <SeriesView
              title={view.title}
              onBack={() => setView({ name: 'library' })}
              onOpenMeeting={openMeeting}
            />
          )}
          {view.name === 'actions' && <ActionsView onOpen={openMeeting} />}
          {view.name === 'people' && (
            <PeopleView onOpenPerson={(person) => setView({ name: 'person', person })} />
          )}
          {view.name === 'person' && (
            <PersonView
              name={view.person}
              onBack={() => setView({ name: 'people' })}
              onOpenMeeting={openMeeting}
              onOpenPerson={(person) => setView({ name: 'person', person })}
            />
          )}
          {view.name === 'links' && <LinksView />}
          {view.name === 'brand' && <BrandView />}
          {view.name === 'projects' && (
            <ProjectsView onSettings={() => setView({ name: 'settings' })} />
          )}
          {view.name === 'mail' && <MailView onSettings={() => setView({ name: 'settings' })} />}
          {view.name === 'toolbox' && <ToolboxView />}
          {view.name === 'import' && (
            <ImportView
              onDone={(m) => {
                refreshMeetings()
                setView({ name: 'meeting', id: m.id })
              }}
              onBulkDone={() => {
                refreshMeetings()
                setView({ name: 'library' })
              }}
              onCancel={() => setView({ name: 'library' })}
            />
          )}
          {view.name === 'settings' && settings && (
            <SettingsView settings={settings} onChange={setSettings} engine={engine} />
          )}
        </div>
      </main>

      <AutoEndWatch
        rec={rec}
        settings={settings}
        paused={paused}
        busy={finishing}
        onStop={(reason) => stopRecording(reason)}
      />

      <WhatsNew />
      <Digest
        openRequested={digestRequested}
        onOpenHandled={() => setDigestRequested(false)}
        onOpenMeeting={openMeeting}
        onOpenPerson={(person) => setView({ name: 'person', person })}
      />

      <AskWidget
        meetingContext={
          view.name === 'meeting'
            ? {
                id: view.id,
                title: meetings.find((m) => m.id === view.id)?.title ?? 'this meeting'
              }
            : null
        }
        onOpenMeeting={openMeeting}
      />
    </div>
  )
}
