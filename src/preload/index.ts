import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionRollupItem,
  AppSettings,
  AutoEndReason,
  BulkProgress,
  BulkScan,
  BulkSelection,
  CalendarEvent,
  EnergySample,
  EngineProgress,
  EngineStatus,
  EventBrief,
  LibraryQA,
  Meeting,
  MeetingListItem,
  PersonDetails,
  PersonProfile,
  PersonSummary,
  RecordingMode,
  SeriesData,
  TranscriptSegment,
  UsageSummary,
  WeeklyDigest,
  WhisperModel
} from '../shared/types'

export interface LiveUpdate {
  id: string
  segments: TranscriptSegment[]
  transcribedMs: number
}

export interface StorageStats {
  count: number
  totalBytes: number
  audioBytes: number
}

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', patch),
    setApiKey: (key: string | null): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setApiKey', key),
    testApiKey: (key: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:testApiKey', key)
  },
  usage: {
    get: (): Promise<UsageSummary> => ipcRenderer.invoke('usage:get')
  },
  engine: {
    status: (): Promise<EngineStatus> => ipcRenderer.invoke('engine:status'),
    setup: (model?: WhisperModel): Promise<EngineStatus> =>
      ipcRenderer.invoke('engine:setup', model),
    onProgress: (cb: (p: EngineProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: EngineProgress): void => cb(p)
      ipcRenderer.on('engine:progress', handler)
      return () => ipcRenderer.removeListener('engine:progress', handler)
    }
  },
  rec: {
    begin: (mode: RecordingMode): Promise<string> => ipcRenderer.invoke('rec:begin', mode),
    pcm: (id: string, chunk: ArrayBuffer): void => ipcRenderer.send('rec:pcm', id, chunk),
    finish: (
      id: string,
      webm: ArrayBuffer,
      durationMs: number,
      energy: EnergySample[] | null,
      autoEnd: AutoEndReason | null
    ): Promise<Meeting> =>
      ipcRenderer.invoke('rec:finish', id, webm, durationMs, energy, autoEnd),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('rec:cancel', id),
    stashNotes: (id: string, text: string): void => ipcRenderer.send('rec:stashNotes', id, text),
    readNotes: (id: string): Promise<string> => ipcRenderer.invoke('rec:readNotes', id),
    onLive: (cb: (u: LiveUpdate) => void): (() => void) => {
      const handler = (_e: unknown, u: LiveUpdate): void => cb(u)
      ipcRenderer.on('rec:live', handler)
      return () => ipcRenderer.removeListener('rec:live', handler)
    }
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  appChannel: (): Promise<'stable' | 'test' | 'dev'> => ipcRenderer.invoke('app:channel'),
  update: {
    onReady: (cb: (version: string) => void): (() => void) => {
      const handler = (_e: unknown, v: string): void => cb(v)
      ipcRenderer.on('update:ready', handler)
      return () => ipcRenderer.removeListener('update:ready', handler)
    },
    install: (): Promise<void> => ipcRenderer.invoke('update:install')
  },
  meetings: {
    list: (): Promise<MeetingListItem[]> => ipcRenderer.invoke('meetings:list'),
    get: (id: string): Promise<Meeting | null> => ipcRenderer.invoke('meetings:get', id),
    rename: (id: string, title: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:rename', id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('meetings:delete', id),
    retry: (id: string): Promise<void> => ipcRenderer.invoke('meetings:retry', id),
    resummarize: (id: string, model?: string): Promise<void> =>
      ipcRenderer.invoke('meetings:resummarize', id, model),
    exportMarkdown: (defaultName: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke('meetings:exportMarkdown', defaultName, content),
    ask: (id: string, question: string): Promise<string> =>
      ipcRenderer.invoke('meetings:ask', id, question),
    identifySpeakers: (id: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:identifySpeakers', id),
    renameSpeaker: (id: string, from: string, to: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:renameSpeaker', id, from, to),
    editSegment: (id: string, index: number, text: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:editSegment', id, index, text),
    deleteSegments: (id: string, from: number, to: number): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:deleteSegments', id, from, to),
    setNotes: (id: string, text: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:setNotes', id, text),
    setSpeakers: (id: string, names: { me: string; them: string }): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:setSpeakers', id, names),
    import: (title: string, dateIso: string, text: string): Promise<Meeting> =>
      ipcRenderer.invoke('meetings:import', title, dateIso, text),
    bulkPick: (kind: 'zip' | 'folder'): Promise<BulkScan | null> =>
      ipcRenderer.invoke('bulk:pick', kind),
    bulkRun: (selection: BulkSelection[]): Promise<void> =>
      ipcRenderer.invoke('bulk:run', selection),
    bulkCancel: (): Promise<void> => ipcRenderer.invoke('bulk:cancel'),
    bulkStatus: (): Promise<BulkProgress | null> => ipcRenderer.invoke('bulk:status'),
    onBulkProgress: (cb: (p: BulkProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: BulkProgress): void => cb(p)
      ipcRenderer.on('bulk:progress', handler)
      return () => ipcRenderer.removeListener('bulk:progress', handler)
    },
    search: (query: string): Promise<{ id: string; snippet: string }[]> =>
      ipcRenderer.invoke('meetings:search', query),
    briefFor: (eventTitle: string): Promise<EventBrief | null> =>
      ipcRenderer.invoke('meetings:briefFor', eventTitle),
    deleteAudio: (id: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:deleteAudio', id),
    storageStats: (): Promise<StorageStats> => ipcRenderer.invoke('meetings:storageStats'),
    onUpdated: (cb: (m: Meeting) => void): (() => void) => {
      const handler = (_e: unknown, m: Meeting): void => cb(m)
      ipcRenderer.on('meeting:updated', handler)
      return () => ipcRenderer.removeListener('meeting:updated', handler)
    }
  },
  nudge: {
    onOpenRecord: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('nudge:openRecord', handler)
      return () => ipcRenderer.removeListener('nudge:openRecord', handler)
    }
  },
  calendar: {
    connect: (url: string): Promise<{ ok: boolean; error?: string; countThisWeek?: number }> =>
      ipcRenderer.invoke('calendar:connect', url),
    disconnect: (): Promise<AppSettings> => ipcRenderer.invoke('calendar:disconnect'),
    today: (): Promise<{ events: CalendarEvent[]; error?: string }> =>
      ipcRenderer.invoke('calendar:today'),
    liveEvent: (startedAtIso: string): Promise<CalendarEvent | null> =>
      ipcRenderer.invoke('calendar:liveEvent', startedAtIso),
    range: (fromIso: string, toIso: string): Promise<{ events: CalendarEvent[]; error?: string }> =>
      ipcRenderer.invoke('calendar:range', fromIso, toIso)
  },
  ask: {
    history: (): Promise<LibraryQA[]> => ipcRenderer.invoke('ask:history'),
    ask: (question: string): Promise<LibraryQA> => ipcRenderer.invoke('ask:ask', question),
    clear: (): Promise<void> => ipcRenderer.invoke('ask:clear')
  },
  digest: {
    build: (): Promise<WeeklyDigest> => ipcRenderer.invoke('digest:build')
  },
  claude: {
    status: (): Promise<{ claudeFound: boolean; configured: boolean; claudeRunning: boolean }> =>
      ipcRenderer.invoke('claude:status'),
    connect: (): Promise<{ claudeFound: boolean; configured: boolean; claudeRunning: boolean }> =>
      ipcRenderer.invoke('claude:connect'),
    disconnect: (): Promise<{ claudeFound: boolean; configured: boolean; claudeRunning: boolean }> =>
      ipcRenderer.invoke('claude:disconnect')
  },
  backup: {
    run: (): Promise<{ path: string; bytes: number } | null> => ipcRenderer.invoke('backup:run'),
    chooseFolder: (): Promise<AppSettings> => ipcRenderer.invoke('backup:chooseFolder')
  },
  series: {
    siblings: (meetingId: string): Promise<string[]> =>
      ipcRenderer.invoke('series:siblings', meetingId),
    get: (title: string): Promise<SeriesData> => ipcRenderer.invoke('series:get', title)
  },
  people: {
    list: (): Promise<PersonSummary[]> => ipcRenderer.invoke('people:list'),
    profile: (name: string): Promise<PersonProfile | null> =>
      ipcRenderer.invoke('people:profile', name),
    merge: (from: string, to: string): Promise<PersonSummary[]> =>
      ipcRenderer.invoke('people:merge', from, to),
    setDetails: (name: string, details: PersonDetails): Promise<PersonSummary[]> =>
      ipcRenderer.invoke('people:setDetails', name, details),
    remove: (name: string): Promise<PersonSummary[]> => ipcRenderer.invoke('people:remove', name)
  },
  actions: {
    list: (): Promise<ActionRollupItem[]> => ipcRenderer.invoke('actions:list'),
    toggle: (meetingId: string, index: number): Promise<boolean> =>
      ipcRenderer.invoke('actions:toggle', meetingId, index),
    setOwner: (meetingId: string, index: number, owner: string | null): Promise<Meeting | null> =>
      ipcRenderer.invoke('actions:setOwner', meetingId, index, owner),
    setDue: (meetingId: string, index: number, isoDate: string | null): Promise<Meeting | null> =>
      ipcRenderer.invoke('actions:setDue', meetingId, index, isoDate)
  }
}

export type ScribeApi = typeof api

contextBridge.exposeInMainWorld('scribe', api)
