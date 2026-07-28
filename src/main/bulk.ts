import { app, BrowserWindow, dialog } from 'electron'
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from 'fs'
import { tmpdir } from 'os'
import { join, relative, extname, basename } from 'path'
import { createImportedMeeting, importKeyFor, parseNotionPage } from './importer'
import { existingImportKeys } from './store'
import { processMeeting } from './pipeline'
import type { BulkCandidate, BulkProgress, BulkScan, BulkSelection } from '../shared/types'

// ---------------------------------------------------------------------------
// Bulk import: point the app at a Notion export (a .zip, or the folder you
// unzipped it into) and it reads every page as a meeting. Scanning only reads
// and reports; nothing is written to the library until the user has reviewed
// the list and confirmed. Summaries then run one at a time in the background
// so a hundred meetings cannot stampede the Claude API.
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
/** a Notion workspace export can hold thousands of pages; stay bounded */
const MAX_FILES = 2000
/** below this a page is almost certainly a stub, not a meeting */
const MIN_WORDS = 25

/** temp copy of an extracted archive; replaced on each scan, cleared on quit */
let extractedRoot: string | null = null

function clearExtracted(): void {
  if (!extractedRoot) return
  rmSync(extractedRoot, { recursive: true, force: true })
  extractedRoot = null
}

app.on('will-quit', clearExtracted)

/** Ask for a Notion export archive or a folder of transcripts. */
export async function pickBulkSource(
  win: BrowserWindow | null,
  kind: 'zip' | 'folder'
): Promise<string | null> {
  const result =
    kind === 'zip'
      ? await dialog.showOpenDialog(win!, {
          title: 'Choose a Notion export',
          properties: ['openFile'],
          filters: [{ name: 'Notion export', extensions: ['zip'] }]
        })
      : await dialog.showOpenDialog(win!, {
          title: 'Choose a folder of transcripts',
          properties: ['openDirectory']
        })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
}

/** Unpack a zip with the bsdtar that ships with Windows (as backups do). */
async function extractZip(zipPath: string): Promise<string> {
  clearExtracted()
  const dest = mkdtempSync(join(tmpdir(), 'meetingscribe-import-'))
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  await new Promise<void>((resolve, reject) => {
    const p = spawn(tar, ['-x', '-f', zipPath, '-C', dest], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Could not unpack that archive: ${err.slice(-300) || `tar exited ${code}`}`))
    )
    p.on('error', reject)
  })
  extractedRoot = dest
  return dest
}

function walk(dir: string, out: string[]): void {
  if (out.length >= MAX_FILES) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // unreadable folder: skip it rather than failing the whole scan
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full)
    if (out.length >= MAX_FILES) return
  }
}

/**
 * Read every page under a folder (or archive) and report what an import would
 * do with it, without touching the library.
 */
export async function scanBulkSource(sourcePath: string): Promise<BulkScan> {
  const isZip = extname(sourcePath).toLowerCase() === '.zip'
  const root = isZip ? await extractZip(sourcePath) : sourcePath

  const files: string[] = []
  walk(root, files)
  files.sort((a, b) => a.localeCompare(b))

  const known = existingImportKeys()
  const seenInScan = new Set<string>()
  const candidates: BulkCandidate[] = []

  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const page = parseNotionPage(raw, file)
    const words = page.body.trim() ? page.body.trim().split(/\s+/).length : 0
    const key = importKeyFor(page.body)
    const duplicate = known.has(key) || seenInScan.has(key)
    if (words > 0) seenInScan.add(key)

    candidates.push({
      path: file,
      relPath: relative(root, file) || basename(file),
      title: page.title || basename(file, extname(file)),
      dateIso: page.dateIso ?? fileDate(file),
      dateSource: page.dateIso ? page.dateSource! : 'file',
      words,
      attendees: page.attendees,
      skip: words < MIN_WORDS ? 'empty' : duplicate ? 'duplicate' : undefined
    })
  }

  return { root, sourceLabel: basename(sourcePath), candidates }
}

/** last-resort date: when the file was written */
function fileDate(file: string): string {
  try {
    return statSync(file).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

// --- the import run ---------------------------------------------------------

let running = false
let cancelRequested = false
let latest: BulkProgress | null = null

export function isBulkImportRunning(): boolean {
  return running
}

/**
 * Where a run has got to, for a review page that was navigated away from and
 * come back to. Null once it has finished — a stale "all done" screen days
 * later would be worse than the picker.
 */
export function bulkImportStatus(): BulkProgress | null {
  return running ? latest : null
}

export function cancelBulkImport(): void {
  if (running) cancelRequested = true
}

function report(progress: BulkProgress): void {
  latest = progress
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('bulk:progress', progress)
  }
}

/**
 * Create every selected meeting, then summarize them one at a time. Meetings
 * appear in the library immediately with their transcripts; summaries fill in
 * behind them, and a failure only costs that one meeting (it lands as
 * transcript-only and can be resummarized from its page).
 */
export async function runBulkImport(selection: BulkSelection[]): Promise<void> {
  if (running) throw new Error('A bulk import is already running.')
  running = true
  cancelRequested = false

  const imported: string[] = []
  const failed: { title: string; error: string }[] = []
  const total = selection.length
  const created: { id: string; title: string }[] = []

  try {
    for (const item of selection) {
      if (cancelRequested) break
      const label = item.title || basename(item.path)
      report({ phase: 'creating', done: created.length, total, current: label, imported, failed })
      try {
        const raw = readFileSync(item.path, 'utf-8')
        const page = parseNotionPage(raw, item.path)
        const meeting = createImportedMeeting(item.title || page.title, item.dateIso, page.body, {
          attendees: item.attendees?.length ? item.attendees : page.attendees
        })
        imported.push(meeting.id)
        created.push({ id: meeting.id, title: meeting.title })
      } catch (err) {
        failed.push({ title: label, error: err instanceof Error ? err.message : 'Import failed' })
      }
    }

    // one at a time: transcripts are already in hand, so this stage is purely
    // the Claude call (or an instant stage flip when summaries are switched off)
    let done = 0
    for (const meeting of created) {
      if (cancelRequested) break
      report({
        phase: 'summarizing',
        done,
        total: created.length,
        current: meeting.title,
        imported,
        failed
      })
      try {
        await processMeeting(meeting.id)
      } catch (err) {
        // processMeeting files its own errors on the meeting; keep going
        failed.push({
          title: meeting.title,
          error: err instanceof Error ? err.message : 'Summarization failed'
        })
      }
      done++
    }

    report({
      phase: cancelRequested ? 'cancelled' : 'done',
      done: created.length,
      total,
      current: '',
      imported,
      failed
    })
  } finally {
    running = false
    cancelRequested = false
  }
}
