export type RecordingMode = 'in-person' | 'virtual' | 'imported'

export type MeetingStage =
  | 'recorded'
  | 'transcribing'
  | 'summarizing'
  | 'ready'
  | 'transcript-only'
  | 'error'

export interface TranscriptSegment {
  /** start time in ms */
  from: number
  /** end time in ms */
  to: number
  text: string
  /**
   * who spoke: 'me'/'them' from audio-source labeling, or a display name
   * (e.g. "Priya") once speakers have been identified
   */
  speaker?: string
  /** tinydiarize: the speaker changes after this segment */
  turn?: boolean
}

/** periodic per-source loudness sample captured while recording */
export interface EnergySample {
  /** active-recording time in ms (pauses excluded) */
  t: number
  mic: number
  sys: number
}

export interface ActionItem {
  task: string
  owner: string | null
  due: string | null
  /** user-toggled completion state (not set by the model) */
  done?: boolean
  /** user-set ISO due date; overrides whatever parses out of the free-text due */
  dueDate?: string | null
  /** set once the item has been pushed to ClickUp */
  clickupUrl?: string
}

/** one Q&A exchange in "ask about this meeting" */
export interface MeetingQA {
  q: string
  a: string
}

/** one cited meeting under a library-wide answer */
export interface AskSource {
  /** marker used inline in the answer text, e.g. 1 for [1] */
  ref: number
  meetingId: string
  /** resolved at answer time so history renders even if the meeting is later deleted */
  meetingTitle: string
  createdAt: string
  /** moment in the meeting that best supports the answer, if the model tied it to one */
  timestampMs: number | null
}

/** one Q&A exchange in the library-wide Ask page */
export interface LibraryQA {
  q: string
  a: string
  sources: AskSource[]
  askedAt: string
}

/** a single action item in the cross-meeting rollup */
export interface ActionRollupItem {
  meetingId: string
  meetingTitle: string
  createdAt: string
  /** index into that meeting's summary.actionItems */
  index: number
  task: string
  owner: string | null
  due: string | null
  done: boolean
  /** effective ISO due date: the user's edit if set, else parsed from the free text */
  dueDate?: string
  /** the user set dueDate explicitly (so the free-text due is superseded) */
  dueEdited?: boolean
  /** canonical owner names after identity resolution ('Me' for the user); empty = unassigned */
  owners: string[]
}

export interface SummaryTopic {
  heading: string
  notes: string[]
}

export interface MeetingSummary {
  title: string
  tldr: string
  /** discussion grouped into topical sections, meeting-minutes style */
  topics?: SummaryTopic[]
  /** legacy flat list from summaries generated before topics existed */
  keyPoints?: string[]
  decisions: string[]
  actionItems: ActionItem[]
  openQuestions: string[]
}

export interface Meeting {
  id: string
  title: string
  createdAt: string
  durationMs: number
  mode: RecordingMode
  stage: MeetingStage
  /** progress 0-100 while transcribing */
  progress?: number
  error?: string
  hasAudio: boolean
  transcript?: TranscriptSegment[]
  summary?: MeetingSummary
  qa?: MeetingQA[]
  /** display names for the two audio sources, e.g. { me: 'Tyler', them: 'David' } */
  speakerNames?: { me: string; them: string }
  /** participant names inherited from the matching calendar event */
  attendees?: string[]
  /** notes the user typed during or after the meeting; fed to the summarizer */
  notes?: string
  /** fingerprint of imported transcript text, so a re-import can skip it */
  importKey?: string
}

/** Lightweight listing shape (no transcript body) */
export interface MeetingListItem {
  id: string
  title: string
  createdAt: string
  durationMs: number
  mode: RecordingMode
  stage: MeetingStage
  progress?: number
  error?: string
  tldr?: string
}

/** one event from the connected calendar feed */
export interface CalendarEvent {
  id: string
  title: string
  /** ISO start/end */
  start: string
  end: string
  allDay: boolean
  location: string | null
  /** join link when a known meeting platform was found in the event */
  joinUrl: string | null
  /** display names of invitees + organizer, when the feed includes them */
  attendees: string[]
}

/** pre-meeting brief: where a meeting series left off last time */
export interface EventBrief {
  meetingId: string
  meetingTitle: string
  createdAt: string
  /**
   * true when matched by topic words rather than exact title — the brief's
   * lists are then filtered to points mentioning those words
   */
  related: boolean
  /** the words a related match was filtered by */
  filterWords?: string[]
  tldr: string | null
  decisions: string[]
  openActions: { task: string; owner: string | null; due: string | null }[]
  openQuestions: string[]
}

/** a recurring meeting thread: everything sharing one title */
export interface SeriesData {
  title: string
  /** newest first */
  occurrences: { id: string; title: string; createdAt: string; durationMs: number; tldr?: string }[]
  /** decisions grouped by occurrence, newest first */
  decisions: { meetingId: string; createdAt: string; items: string[] }[]
  /** open action items across the whole series */
  openActions: ActionRollupItem[]
}

/** the Monday-morning rollup */
export interface WeeklyDigest {
  /** e.g. "July 14" (the day the digest was generated) */
  weekLabel: string
  lastWeekMeetings: { id: string; title: string; createdAt: string; durationMs: number }[]
  /** open items assigned to Me, all meetings */
  myOpen: ActionRollupItem[]
  /** open items (any owner) from meetings more than two weeks old */
  aging: ActionRollupItem[]
  /** open-item counts per colleague */
  byPerson: { name: string; count: number }[]
}

/** one open ClickUp task assigned to the user */
export interface ClickupTask {
  id: string
  name: string
  /** plain-text description, trimmed */
  description: string | null
  status: string
  statusColor: string | null
  /** ISO date (YYYY-MM-DD) or null */
  dueDate: string | null
  url: string
  listId: string
  listName: string
  folderName: string | null
  priority: string | null
  /** ClickUp's last-modified stamp, used for change detection */
  dateUpdated: string | null
}

/** one entry in the local ClickUp changelog, produced by diffing refreshes */
export interface ClickupActivityEvent {
  id: string
  /** ISO timestamp of when the change was noticed (or made) */
  at: string
  kind: 'new' | 'done' | 'status' | 'due' | 'comment' | 'removed' | 'you'
  taskName: string
  detail?: string
  url?: string
}

/** one list a task can be pushed to */
export interface ClickupList {
  id: string
  name: string
  folder: string | null
  space: string
}

export interface ClickupStatus {
  connected: boolean
  userName?: string
  userEmail?: string
  teamName?: string
  error?: string
}

export interface ClickupPushInput {
  listId: string
  name: string
  description?: string
  /** owner name or email; resolved against workspace members */
  assignee?: string
  /** ISO date */
  dueDate?: string | null
}

export interface ClickupPushResult {
  ok: boolean
  url?: string
  /** who the task got assigned to, if the assignee resolved */
  assignedTo?: string
  error?: string
}

/** one saved link in the link hub */
export interface LinkEntry {
  id: string
  name: string
  url: string
  category: string
  note?: string
  pinned?: boolean
  /** thumbnail filename under userData/link-thumbs (card view) */
  thumb?: string
}

/** one color in the brand guide */
export interface BrandColor {
  name: string
  /** #RRGGBB; null only for print-only spot colors */
  hex: string | null
  pantone?: string
  cmyk?: number[] | null
  printOnly?: boolean
}

export interface BrandPalette {
  name: string
  colors: BrandColor[]
}

export interface BrandData {
  palettes: BrandPalette[]
  notes: string[]
  typography?: { primarySans: string; alternatives: string[] }
}

/** editable directory fields for one colleague */
export interface PersonDetails {
  title?: string
  department?: string
  email?: string
  phone?: string
  office?: string
  /** display name of their manager (another person in the directory) */
  reportsTo?: string
  notes?: string
}

/** one parsed row of a directory CSV import */
export interface DirectoryImportRow {
  name: string
  details: PersonDetails
}

/** result of scanning a CSV file chosen for directory import */
export interface DirectoryImportScan {
  file: string
  rows: DirectoryImportRow[]
  /** rows dropped for missing/invalid names */
  skipped: number
  /** which directory field was read from which CSV column */
  mapped: Record<string, string>
  error?: string
}

/** one row on the People page */
export interface PersonSummary {
  name: string
  meetingCount: number
  openItems: number
  details?: PersonDetails
}

export interface PersonMeetingRef {
  id: string
  title: string
  createdAt: string
  tldr?: string
}

/** everything the app knows about one colleague */
export interface PersonProfile {
  name: string
  details?: PersonDetails
  /** meetings they appeared in (attendee, named speaker, or item owner) */
  meetings: PersonMeetingRef[]
  /** action items they own, open and done */
  items: ActionRollupItem[]
  /** your own open items from meetings you shared with them */
  myCommitments: ActionRollupItem[]
}

/** why a recording stopped itself */
export type AutoEndReason = 'silence' | 'overrun'

/** one file found by a bulk import scan */
export interface BulkCandidate {
  /** absolute path of the source file (also the selection key) */
  path: string
  /** path shown in the UI, relative to the chosen folder or archive */
  relPath: string
  title: string
  /** best guess at when the meeting happened */
  dateIso: string
  /** where that guess came from, so the UI can flag the weak ones */
  dateSource: 'property' | 'filename' | 'file'
  words: number
  /** names read from an Attendees/Participants property */
  attendees: string[]
  /** set when the file cannot be imported as-is */
  skip?: 'empty' | 'duplicate'
}

export interface BulkScan {
  /** folder that was scanned (the extracted copy, for an archive) */
  root: string
  /** the archive or folder the user actually picked */
  sourceLabel: string
  candidates: BulkCandidate[]
}

/** what the user chose to import, after reviewing the scan */
export interface BulkSelection {
  path: string
  title: string
  dateIso: string
  attendees: string[]
}

export interface BulkProgress {
  phase: 'creating' | 'summarizing' | 'done' | 'cancelled'
  done: number
  total: number
  /** title of the meeting currently being worked on */
  current: string
  /** ids of meetings created so far */
  imported: string[]
  failed: { title: string; error: string }[]
}

export type WhisperModel = 'base.en' | 'small.en' | 'medium.en' | 'small.en-tdrz'

export type AppTheme = 'studio' | 'rowan' | 'slate' | 'paper' | 'notion' | 'ios'

export interface AppSettings {
  whisperModel: WhisperModel
  claudeModel: string
  autoSummarize: boolean
  hasApiKey: boolean
  /** a calendar feed URL is connected */
  hasCalendar: boolean
  /** a ClickUp personal API token is connected */
  hasClickup: boolean
  /** notify when a calendared meeting starts and nothing is recording */
  recordNudge: boolean
  /** stop a recording by itself once the room has gone quiet */
  autoEndSilence: boolean
  /** minutes of silence before the automatic stop */
  autoEndSilenceMinutes: number
  /** stop a recording by itself once its calendar event is well over */
  autoEndOverrun: boolean
  /** minutes past the scheduled end before the automatic stop */
  autoEndOverrunMinutes: number
  theme: AppTheme
  /** names, acronyms, and jargon fed to transcription and summaries */
  vocabulary: string
  /** closing the window hides to the tray instead of quitting */
  closeToTray: boolean
  /** start (in the tray) when Windows starts */
  launchAtLogin: boolean
  /** global Ctrl+Alt+R opens the Record page from anywhere */
  recordHotkey: boolean
  /** folder for weekly automatic backups; null = off */
  backupFolder: string | null
  /** skip audio files in backups (much smaller archives) */
  backupSkipAudio: boolean
  /** team directory: names offered when assigning action items */
  people: string[]
  /** the user's own name, so transcripts saying "Tyler" resolve to Me */
  yourName: string
  /** identity merges: normalized raw name -> canonical display name */
  personAliases: Record<string, string>
}

export interface EngineStatus {
  binaryReady: boolean
  modelReady: boolean
  /** which model file is present, if any */
  models: WhisperModel[]
}

export interface EngineProgress {
  phase: 'binary' | 'model'
  /** 0-100, or -1 for indeterminate */
  percent: number
  detail: string
  done?: boolean
  error?: string
}

/** one calendar month of local Claude API cost tracking */
export interface MonthUsage {
  /** estimated cost in USD, computed from token counts at list prices */
  costUsd: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export interface UsageSummary {
  thisMonth: MonthUsage
  lastMonth: MonthUsage | null
}
