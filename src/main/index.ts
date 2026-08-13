import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  protocol,
  dialog,
  nativeTheme
} from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, createReadStream } from 'fs'
import { autoUpdater } from 'electron-updater'
// imported first: redirects userData for dev/test channels before any other
// module resolves a path under it
import { channel } from './channel'
import {
  listMeetings,
  readMeeting,
  writeMeeting,
  deleteMeeting,
  beginRecording,
  appendPcm,
  finishRecording,
  cancelRecording,
  stashNotes,
  readStashedNotes,
  findAudio,
  meetingsRoot,
  meetingDir,
  recoverOrphanedRecordings
} from './store'
import {
  getSettings,
  updateSettings,
  setApiKey,
  setCalendarUrl,
  addPerson,
  addPersonAlias,
  removePerson,
  renamePerson,
  setOpenaiKey
} from './settings'
import { mergeDetails, removeDetails, setDetails } from './directory'
import { applyDirectoryImport, scanDirectoryCsv } from './directoryImport'
import {
  autoLinkThumb,
  clearLinkThumb,
  listLinks,
  pickLinkThumb,
  removeLink,
  saveLink,
  thumbsDir,
  toggleLinkPin
} from './links'
import { getBrand, saveBrand } from './brand'
import {
  addToolboxFiles,
  addToolboxGuide,
  addToolboxImages,
  copyToolboxImage,
  getGuideHtml,
  readToolbox,
  removeToolboxFile,
  removeToolboxGuide,
  removeToolboxImage,
  removeToolboxQuery,
  importToolboxQueries,
  saveToolboxQuery,
  updateToolboxGuide,
  saveToolboxFileCopy,
  toolboxImagesDir
} from './toolbox'
import {
  clickupLists,
  clickupListStatuses,
  clickupStatus,
  commentClickupTask,
  completeClickupTask,
  connectClickup,
  disconnectClickup,
  pushClickupTask,
  refreshClickup,
  setClickupTaskDue,
  setClickupTaskStatus
} from './clickup'
import {
  refreshCalendar,
  getTodayEvents,
  getEventsBetween,
  findLiveEvent,
  clearCalendarCache
} from './calendar'
import { startRecordNudge, notifyAutoEnd } from './nudge'
import {
  bulkImportStatus,
  cancelBulkImport,
  isBulkImportRunning,
  pickBulkSource,
  runBulkImport,
  scanBulkSource
} from './bulk'
import { briefForEvent } from './brief'
import { listPeople, personProfile } from './people'
import { buildDigest } from './digest'
import { seriesSiblings, seriesData } from './series'
import { identifySpeakers } from './identify'
import { getUsage } from './usage'
import {
  applySystemSettings,
  isQuitting,
  registerWindowFactory,
  showMainWindow,
  startHidden
} from './system'
import { runBackup, startAutoBackup } from './backup'
import { actionRollup, identityContext } from './identity'
import { claudeConnectionStatus, connectClaude, disconnectClaude } from './claudeConnect'
import { engineStatus, setupEngine } from './whisper'
import { activeAiModel, testOpenaiKey } from './ai'
import { processMeeting, summarizeMeeting } from './pipeline'
import { askAboutMeeting, testApiKey } from './summarize'
import { askLibrary, clearAskHistory, readAskHistory } from './ask'
import { createImportedMeeting } from './importer'
import { patchLegacyAudioDurations } from './migrate'
import type {
  ActionRollupItem,
  AppSettings,
  AutoEndReason,
  BrandData,
  BulkSelection,
  ClickupPushInput,
  DirectoryImportRow,
  EnergySample,
  LinkEntry,
  Meeting,
  PersonDetails,
  RecordingMode,
  WhisperModel
} from '../shared/types'

/** pre-paint window color per theme, so launch doesn't flash the wrong shade */
const WINDOW_BG: Record<string, string> = {
  studio: '#101013',
  rowan: '#17120a',
  slate: '#101318',
  paper: '#f8f6f3',
  notion: '#ffffff',
  ios: '#f2f2f7'
}

/**
 * The OS draws the window frame, and by default it follows the system
 * dark-mode setting — so a light app theme kept a dark titlebar. Steer the
 * frame to match the chosen theme instead.
 */
function applyFrameTheme(): void {
  const light = new Set(['paper', 'notion', 'ios'])
  nativeTheme.themeSource = light.has(getSettings().theme) ? 'light' : 'dark'
}

function createWindow(): BrowserWindow {
  applyFrameTheme()
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BG[getSettings().theme] ?? '#101013',
    title: 'Rowan AIO',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => {
    // a hidden (login) start stays in the tray — unless there is no tray
    if (!startHidden() || !getSettings().closeToTray) win.show()
  })
  // closing hides to the tray (when enabled); quitting comes from the tray menu
  win.on('close', (e) => {
    if (!isQuitting() && getSettings().closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // a renderer that dies while hidden in the tray would otherwise show as an
  // empty window shell next time something brings the app forward
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

protocol.registerSchemesAsPrivileged([
  // corsEnabled lets the renderer draw toolbox images to a canvas untainted,
  // which is how images get onto the clipboard in every format
  { scheme: 'scribe-media', privileges: { stream: true, supportFetchAPI: true, corsEnabled: true } }
])

// Windows toasts need the app identity to match the installed shortcut
app.setAppUserModelId('com.tylerkells.meetingscribe')

// One instance only: with close-to-tray, a "closed" app is still running, and
// a second launch would fight it for the same data folder. Launching again
// just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // a second launch (including a notification click routed through the OS)
  // brings the existing instance forward, recovering the window if needed
  app.on('second-instance', () => showMainWindow())
}

app.whenReady().then(() => {
  // System-audio (loopback) capture for virtual meetings: when the renderer
  // calls getDisplayMedia we hand it a screen source with loopback audio and
  // immediately discard the video track on the renderer side.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )

  // Serve stored meeting audio to the renderer without exposing the
  // filesystem. Range support matters: without it the media player cannot
  // probe the end of a file for its duration or seek within long recordings.
  session.defaultSession.protocol.handle('scribe-media', (request) => {
    const parsed = new URL(request.url)
    const id = decodeURIComponent(parsed.hostname)

    // scribe-media://thumb/<filename> serves link-card thumbnails;
    // scribe-media://toolbox/<filename> serves toolbox images
    if (id === 'thumb' || id === 'toolbox') {
      const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
      if (!/^[\w.-]+$/.test(name) || name.includes('..')) {
        return new Response('bad name', { status: 400 })
      }
      const file = join(id === 'thumb' ? thumbsDir() : toolboxImagesDir(), name)
      if (!existsSync(file)) return new Response('not found', { status: 404 })
      const ext = name.split('.').pop()!.toLowerCase()
      const mime =
        ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'svg'
                ? 'image/svg+xml'
                : 'image/jpeg'
      return new Response(Readable.toWeb(createReadStream(file)) as never, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    if (!/^[\w-]+$/.test(id)) return new Response('bad id', { status: 400 })
    const file = findAudio(id)
    if (!file) return new Response('not found', { status: 404 })

    const total = statSync(file).size
    const mime = file.endsWith('.wav') ? 'audio/wav' : 'audio/webm'
    const range = request.headers.get('range')

    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1
      if (!Number.isFinite(start)) start = 0
      if (!Number.isFinite(end) || end >= total) end = total - 1
      if (start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` }
        })
      }
      const stream = Readable.toWeb(createReadStream(file, { start, end }))
      return new Response(stream as never, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`
        }
      })
    }

    const stream = Readable.toWeb(createReadStream(file))
    return new Response(stream as never, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total)
      }
    })
  })

  registerIpc()
  registerWindowFactory(createWindow)
  createWindow()
  setupAutoUpdate()
  startRecordNudge()
  applySystemSettings()
  startAutoBackup()

  // Repair pre-0.2.1 recordings whose webm lacks a duration header (seeking)
  patchLegacyAudioDurations().catch(() => 0)

  // Salvage recordings orphaned by a crash, then resume interrupted processing
  recoverOrphanedRecordings()
    .catch(() => [])
    .then(() => {
      for (const m of listMeetings()) {
        if (m.stage === 'recorded' || m.stage === 'transcribing' || m.stage === 'summarizing') {
          processMeeting(m.id)
        }
      }
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

function setupAutoUpdate(): void {
  // only the installed release self-updates; a test build finding the GitHub
  // releases feed would replace itself with the production app
  if (channel !== 'stable') return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:ready', info.version)
    }
  })
  autoUpdater.on('error', () => {
    // offline or GitHub unreachable: try again on the next interval
  })
  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}

function registerIpc(): void {
  // --- settings ---
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    applySystemSettings()
    if (patch.theme) applyFrameTheme()
    return next
  })
  ipcMain.handle('settings:setApiKey', (_e, key: string | null) => setApiKey(key))
  ipcMain.handle('settings:testApiKey', (_e, key: string) => testApiKey(key))
  ipcMain.handle('settings:setOpenaiKey', (_e, key: string | null) => setOpenaiKey(key))
  ipcMain.handle('settings:testOpenaiKey', (_e, key: string) => testOpenaiKey(key))
  ipcMain.handle('usage:get', () => getUsage())

  // --- transcription engine ---
  ipcMain.handle('engine:status', () => engineStatus(getSettings().whisperModel))
  ipcMain.handle('engine:setup', async (e, model?: WhisperModel) => {
    const target = model ?? getSettings().whisperModel
    try {
      return await setupEngine(target, (p) => e.sender.send('engine:progress', p))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Engine setup failed'
      e.sender.send('engine:progress', { phase: 'binary', percent: -1, detail: msg, error: msg })
      throw err
    }
  })

  // --- recording ---
  ipcMain.handle('rec:begin', (_e, mode: RecordingMode) => beginRecording(mode))
  ipcMain.on('rec:pcm', (_e, id: string, chunk: ArrayBuffer) => {
    appendPcm(id, Buffer.from(chunk))
  })
  ipcMain.handle(
    'rec:finish',
    async (
      _e,
      id: string,
      webm: ArrayBuffer,
      durationMs: number,
      energy: EnergySample[] | null,
      autoEnd: AutoEndReason | null
    ) => {
      const meeting = await finishRecording(id, Buffer.from(webm), durationMs, energy)
      // recording made during a calendar event inherits its title (the
      // summarizer keeps non-default titles, so this survives auto-titling)
      try {
        const event = await findLiveEvent(meeting.createdAt)
        if (event) {
          meeting.title = event.title
          if (event.attendees.length > 0) meeting.attendees = event.attendees
          writeMeeting(meeting)
        }
      } catch {
        // calendar unreachable: keep the default title
      }
      if (autoEnd) notifyAutoEnd(meeting.title, autoEnd)
      // fire-and-forget: transcribe + summarize in the background
      processMeeting(id)
      return meeting
    }
  )
  ipcMain.handle('rec:cancel', (_e, id: string) => cancelRecording(id))
  ipcMain.on('rec:stashNotes', (_e, id: string, text: string) => {
    if (/^[\w-]+$/.test(id)) stashNotes(id, String(text))
  })
  ipcMain.handle('rec:readNotes', (_e, id: string) =>
    /^[\w-]+$/.test(id) ? readStashedNotes(id) : ''
  )

  // --- meetings ---
  ipcMain.handle('meetings:list', () => listMeetings())
  ipcMain.handle('meetings:get', (_e, id: string) => readMeeting(id))
  ipcMain.handle('meetings:rename', (_e, id: string, title: string) => {
    const m = readMeeting(id)
    if (!m) return null
    m.title = title.trim() || m.title
    writeMeeting(m)
    // Today and the calendar list by title; tell every window
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('meeting:updated', m)
    }
    return m
  })
  ipcMain.handle('meetings:delete', (_e, id: string) => deleteMeeting(id))
  ipcMain.handle('meetings:retry', (_e, id: string) => {
    processMeeting(id)
  })
  ipcMain.handle('meetings:resummarize', (_e, id: string, model?: string) => {
    summarizeMeeting(id, model)
  })
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:channel', () => channel)

  // full-text search across titles, summaries, and transcripts
  ipcMain.handle('meetings:search', (_e, query: string): { id: string; snippet: string }[] => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const results: { id: string; snippet: string }[] = []
    for (const entry of listMeetings()) {
      const m = readMeeting(entry.id)
      if (!m) continue
      const transcriptText = (m.transcript ?? []).map((s) => s.text).join(' ')
      const summaryText = m.summary ? JSON.stringify(m.summary) : ''
      const haystack = `${m.title} ${summaryText} ${transcriptText}`.toLowerCase()
      if (!words.every((w) => haystack.includes(w))) continue
      // snippet: context around the first word's first appearance in the transcript
      let snippet = ''
      const pos = transcriptText.toLowerCase().indexOf(words[0])
      if (pos >= 0) {
        const start = Math.max(0, pos - 50)
        snippet =
          (start > 0 ? '…' : '') +
          transcriptText.slice(start, pos + 90).trim() +
          (pos + 90 < transcriptText.length ? '…' : '')
      }
      results.push({ id: m.id, snippet })
    }
    return results
  })

  ipcMain.handle('meetings:deleteAudio', (_e, id: string) => {
    const m = readMeeting(id)
    if (!m) return null
    const file = findAudio(id)
    if (file) rmSync(file, { force: true })
    m.hasAudio = false
    writeMeeting(m)
    return m
  })

  ipcMain.handle('meetings:storageStats', () => {
    let totalBytes = 0
    let audioBytes = 0
    let count = 0
    for (const entry of readdirSync(meetingsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      count++
      for (const f of readdirSync(meetingDir(entry.name))) {
        const size = statSync(join(meetingDir(entry.name), f)).size
        totalBytes += size
        if (f === 'audio.webm' || f === 'audio.wav') audioBytes += size
      }
    }
    return { count, totalBytes, audioBytes }
  })

  ipcMain.handle('meetings:import', (_e, title: string, dateIso: string, text: string) => {
    const meeting = createImportedMeeting(title, dateIso, text)
    // transcript already exists, so this goes straight to summarization
    processMeeting(meeting.id)
    return meeting
  })

  // --- bulk import (Notion export or a folder of transcripts) ---
  ipcMain.handle('bulk:pick', async (e, kind: 'zip' | 'folder') => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const source = await pickBulkSource(win, kind)
    if (!source) return null
    return scanBulkSource(source)
  })
  ipcMain.handle('bulk:run', (_e, selection: BulkSelection[]) => {
    if (isBulkImportRunning()) throw new Error('A bulk import is already running.')
    // fire-and-forget: progress arrives on the bulk:progress channel
    runBulkImport(selection).catch(() => {
      // per-item failures are already reported; nothing left to do here
    })
  })
  ipcMain.handle('bulk:cancel', () => cancelBulkImport())
  ipcMain.handle('bulk:status', () => bulkImportStatus())

  ipcMain.handle(
    'meetings:setSpeakers',
    (_e, id: string, names: { me: string; them: string }) => {
      const m = readMeeting(id)
      if (!m) return null
      m.speakerNames = {
        me: names.me.trim() || 'Me',
        them: names.them.trim() || 'Them'
      }
      if (m.speakerNames.them !== 'Them') addPerson(m.speakerNames.them)
      writeMeeting(m)
      return m
    }
  )

  ipcMain.handle('meetings:editSegment', (_e, id: string, index: number, text: string) => {
    const m = readMeeting(id)
    if (!m?.transcript || !m.transcript[index]) return m ?? null
    const t = String(text).trim()
    if (t) m.transcript[index] = { ...m.transcript[index], text: t }
    else m.transcript.splice(index, 1) // clearing a line deletes it
    writeMeeting(m)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('meeting:updated', m)
    }
    return m
  })

  ipcMain.handle('meetings:deleteSegments', (_e, id: string, from: number, to: number) => {
    const m = readMeeting(id)
    if (!m?.transcript?.length) return m ?? null
    const start = Math.max(0, Math.floor(from))
    const end = Math.min(m.transcript.length - 1, Math.floor(to))
    if (start > end) return m
    m.transcript.splice(start, end - start + 1)
    writeMeeting(m)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('meeting:updated', m)
    }
    return m
  })

  ipcMain.handle('meetings:renameSpeaker', (_e, id: string, from: string, to: string) => {
    const m = readMeeting(id)
    if (!m?.transcript || !from.trim() || !to.trim()) return m ?? null
    const name = to.trim()
    // naming yourself routes to the 'me' channel rather than a literal string
    const target =
      name.toLowerCase() === 'me' || name === (m.speakerNames?.me ?? '') ? 'me' : name
    for (const seg of m.transcript) {
      if (seg.speaker === from) seg.speaker = target
    }
    if (target !== 'me' && !/^speaker \d+$/i.test(target)) addPerson(target)
    writeMeeting(m)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('meeting:updated', m)
    }
    return m
  })

  ipcMain.handle('meetings:setNotes', (_e, id: string, text: string) => {
    const m = readMeeting(id)
    if (!m) return null
    m.notes = String(text).trim() || undefined
    writeMeeting(m)
    return m
  })

  ipcMain.handle('meetings:setAttendees', (_e, id: string, names: string[]) => {
    const m = readMeeting(id)
    if (!m) return null
    const clean = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))]
    m.attendees = clean.length > 0 ? clean : undefined
    writeMeeting(m)
    return m
  })

  // attendees of the calendar event this meeting was recorded during, if the
  // subscribed calendar still carries the event
  ipcMain.handle('meetings:attendeesFromCalendar', async (_e, id: string): Promise<string[] | null> => {
    const m = readMeeting(id)
    if (!m) return null
    try {
      const event = await findLiveEvent(m.createdAt)
      return event && event.attendees.length > 0 ? event.attendees : null
    } catch {
      return null
    }
  })

  ipcMain.handle('meetings:identifySpeakers', async (_e, id: string): Promise<Meeting | null> => {
    const meeting = readMeeting(id)
    if (!meeting) throw new Error('Meeting not found')
    const transcript = await identifySpeakers(meeting)
    meeting.transcript = transcript
    // real names discovered here feed the team directory
    for (const name of new Set(transcript.map((s) => s.speaker))) {
      if (name && name !== 'me' && name !== 'them' && !/^speaker \d+$/i.test(name)) {
        addPerson(name)
      }
    }
    writeMeeting(meeting)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('meeting:updated', meeting)
    }
    return meeting
  })

  ipcMain.handle('meetings:ask', async (_e, id: string, question: string): Promise<string> => {
    const meeting = readMeeting(id)
    if (!meeting) throw new Error('Meeting not found')
    const answer = await askAboutMeeting(meeting, question, activeAiModel())
    meeting.qa = [...(meeting.qa ?? []), { q: question, a: answer }]
    writeMeeting(meeting)
    return answer
  })

  // --- calendar ---
  ipcMain.handle('calendar:connect', async (_e, url: string) => {
    setCalendarUrl(url)
    clearCalendarCache()
    try {
      const events = await refreshCalendar(true)
      return { ok: true, countThisWeek: events.length }
    } catch (err) {
      setCalendarUrl(null)
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that feed.' }
    }
  })
  ipcMain.handle('calendar:disconnect', () => {
    clearCalendarCache()
    return setCalendarUrl(null)
  })
  ipcMain.handle('meetings:briefFor', (_e, eventTitle: string) => briefForEvent(eventTitle))
  ipcMain.handle('calendar:range', async (_e, fromIso: string, toIso: string) => {
    if (!getSettings().hasCalendar) return { events: [] }
    try {
      return { events: await getEventsBetween(fromIso, toIso) }
    } catch (err) {
      return {
        events: [],
        error: err instanceof Error ? err.message : 'The calendar feed could not be reached.'
      }
    }
  })
  // the event a live recording sits inside, so the app knows when it was meant
  // to end (auto-end) — null when no calendar is connected
  ipcMain.handle('calendar:liveEvent', async (_e, startedAtIso: string) => {
    if (!getSettings().hasCalendar) return null
    try {
      return await findLiveEvent(startedAtIso)
    } catch {
      return null
    }
  })
  ipcMain.handle('calendar:today', async () => {
    if (!getSettings().hasCalendar) return { events: [] }
    try {
      return { events: await getTodayEvents() }
    } catch (err) {
      return {
        events: [],
        error: err instanceof Error ? err.message : 'The calendar feed could not be reached.'
      }
    }
  })

  // --- library-wide Q&A ---
  ipcMain.handle('ask:history', () => readAskHistory())
  ipcMain.handle('ask:ask', (_e, question: string) =>
    askLibrary(question, activeAiModel())
  )
  ipcMain.handle('ask:clear', () => clearAskHistory())

  ipcMain.handle('digest:build', () => buildDigest())

  // --- Claude Desktop connection ---
  ipcMain.handle('claude:status', () => claudeConnectionStatus())
  ipcMain.handle('claude:connect', () => connectClaude())
  ipcMain.handle('claude:disconnect', () => disconnectClaude())

  // --- backup ---
  ipcMain.handle('backup:run', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Back up library',
      defaultPath: join(
        app.getPath('documents'),
        `RowanAIO-backup-${new Date().toISOString().slice(0, 10)}.zip`
      ),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    return runBackup(result.filePath, getSettings().backupSkipAudio)
  })
  ipcMain.handle('backup:chooseFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder for weekly backups',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return getSettings()
    return updateSettings({ backupFolder: result.filePaths[0] })
  })

  // --- meeting series ---
  ipcMain.handle('series:siblings', (_e, meetingId: string) => seriesSiblings(meetingId))
  ipcMain.handle('series:get', (_e, title: string) => seriesData(title))

  // --- person pages ---
  ipcMain.handle('people:list', () => listPeople())
  ipcMain.handle('people:profile', (_e, name: string) => personProfile(name))
  ipcMain.handle('people:merge', (_e, from: string, to: string) => {
    addPersonAlias(from, to)
    mergeDetails(from, to)
    return listPeople()
  })
  ipcMain.handle('people:setDetails', (_e, name: string, details: PersonDetails) => {
    addPerson(name) // no-op if already in the roster
    setDetails(name, details)
    return listPeople()
  })
  ipcMain.handle('people:remove', (_e, name: string) => {
    removePerson(name)
    removeDetails(name)
    return listPeople()
  })

  ipcMain.handle('people:rename', (_e, from: string, to: string) => {
    renamePerson(from, to)
    mergeDetails(from, to)
    return listPeople()
  })
  ipcMain.handle('people:importScan', () => scanDirectoryCsv())
  ipcMain.handle('people:importApply', (_e, rows: DirectoryImportRow[]) => {
    applyDirectoryImport(rows)
    return listPeople()
  })

  ipcMain.handle('links:list', () => listLinks())
  ipcMain.handle('links:save', (_e, entry: Partial<LinkEntry> & Omit<LinkEntry, 'id'>) =>
    saveLink(entry)
  )
  ipcMain.handle('links:remove', (_e, id: string) => removeLink(id))
  ipcMain.handle('links:togglePin', (_e, id: string) => toggleLinkPin(id))
  ipcMain.handle('links:pickThumb', (_e, id: string) => pickLinkThumb(id))
  ipcMain.handle('links:autoThumb', (_e, id: string) => autoLinkThumb(id))
  ipcMain.handle('links:clearThumb', (_e, id: string) => clearLinkThumb(id))

  ipcMain.handle('brand:get', () => getBrand())
  ipcMain.handle('brand:save', (_e, data: BrandData) => saveBrand(data))

  ipcMain.handle('toolbox:get', () => readToolbox())
  ipcMain.handle('toolbox:addGuide', () => addToolboxGuide())
  ipcMain.handle('toolbox:guideHtml', (_e, id: string) => getGuideHtml(id))
  ipcMain.handle('toolbox:removeGuide', (_e, id: string) => removeToolboxGuide(id))
  ipcMain.handle('toolbox:updateGuide', (_e, id: string, patch: { title?: string; html?: string }) =>
    updateToolboxGuide(id, patch)
  )
  ipcMain.handle('toolbox:addImages', () => addToolboxImages())
  ipcMain.handle('toolbox:copyImage', (_e, id: string) => copyToolboxImage(id))
  ipcMain.handle('toolbox:removeImage', (_e, id: string) => removeToolboxImage(id))
  ipcMain.handle(
    'toolbox:saveQuery',
    (_e, input: { id?: string; name: string; sql: string; note?: string }) =>
      saveToolboxQuery(input)
  )
  ipcMain.handle('toolbox:removeQuery', (_e, id: string) => removeToolboxQuery(id))
  ipcMain.handle('toolbox:importQueries', () => importToolboxQueries())
  ipcMain.handle('toolbox:addFiles', () => addToolboxFiles())
  ipcMain.handle('toolbox:saveFileCopy', (_e, id: string) => saveToolboxFileCopy(id))
  ipcMain.handle('toolbox:removeFile', (_e, id: string) => removeToolboxFile(id))

  ipcMain.handle('clickup:status', () => clickupStatus())
  ipcMain.handle('clickup:connect', (_e, token: string) => connectClickup(token))
  ipcMain.handle('clickup:disconnect', () => {
    disconnectClickup()
    return getSettings()
  })
  ipcMain.handle('clickup:refresh', (_e, scope: 'mine' | 'all' = 'mine') => refreshClickup(scope))
  ipcMain.handle('clickup:lists', () => clickupLists())
  ipcMain.handle('clickup:push', (_e, input: ClickupPushInput) => pushClickupTask(input))
  ipcMain.handle(
    'clickup:complete',
    (_e, taskId: string, listId: string, name: string, url?: string) =>
      completeClickupTask(taskId, listId, name, url)
  )
  ipcMain.handle('clickup:listStatuses', (_e, listId: string) => clickupListStatuses(listId))
  ipcMain.handle(
    'clickup:setStatus',
    (_e, taskId: string, listId: string, status: string, name: string, url?: string) =>
      setClickupTaskStatus(taskId, listId, status, name, url)
  )
  ipcMain.handle(
    'clickup:setTaskDue',
    (_e, taskId: string, iso: string | null, name: string, url?: string) =>
      setClickupTaskDue(taskId, iso, name, url)
  )
  ipcMain.handle(
    'clickup:comment',
    (_e, taskId: string, text: string, name: string, url?: string) =>
      commentClickupTask(taskId, text, name, url)
  )
  ipcMain.handle(
    'actions:setClickupUrl',
    (_e, meetingId: string, index: number, url: string | null) => {
      const m = readMeeting(meetingId)
      const item = m?.summary?.actionItems[index]
      if (!m || !item) return null
      item.clickupUrl = url || undefined
      writeMeeting(m)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('meeting:updated', m)
      }
      return m
    }
  )

  ipcMain.handle('actions:list', (): ActionRollupItem[] => {
    const ctx = identityContext()
    const items: ActionRollupItem[] = []
    for (const entry of listMeetings()) {
      const m = readMeeting(entry.id)
      if (!m?.summary) continue
      items.push(...actionRollup(m, ctx))
    }
    return items
  })

  ipcMain.handle('actions:toggle', (_e, meetingId: string, index: number): boolean => {
    const m = readMeeting(meetingId)
    const item = m?.summary?.actionItems[index]
    if (!m || !item) return false
    item.done = !item.done
    writeMeeting(m)
    return item.done
  })

  ipcMain.handle(
    'actions:setOwner',
    (_e, meetingId: string, index: number, owner: string | null) => {
      const m = readMeeting(meetingId)
      const item = m?.summary?.actionItems[index]
      if (!m || !item) return null
      item.owner = owner?.trim() || null
      if (item.owner) addPerson(item.owner)
      writeMeeting(m)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('meeting:updated', m)
      }
      return m
    }
  )

  ipcMain.handle(
    'actions:setDue',
    (_e, meetingId: string, index: number, isoDate: string | null) => {
      const m = readMeeting(meetingId)
      const item = m?.summary?.actionItems[index]
      if (!m || !item) return null
      item.dueDate = isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate : null
      writeMeeting(m)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('meeting:updated', m)
      }
      return m
    }
  )

  ipcMain.handle(
    'meetings:exportMarkdown',
    async (e, defaultName: string, content: string): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export meeting',
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePath) return null
      writeFileSync(result.filePath, content, 'utf-8')
      return result.filePath
    }
  )
}
