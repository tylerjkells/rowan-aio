import { app, dialog } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import type { PrepEntry, PrepFile } from '../shared/types'

// ---------------------------------------------------------------------------
// "Before the meeting" prep, keyed by calendar occurrence id (uid:startISO —
// a recurring series gets a fresh note per occurrence). A note carries text
// plus attachments (screenshots, files to have handy); attachments live under
// userData/prep and are served to the renderer via scribe-media://prep/.
// Deliberately separate from the meeting library and never fed to the AI.
// ---------------------------------------------------------------------------

interface StoredPrep {
  text: string
  updatedAt: string
  files?: PrepFile[]
}

type PrepStore = Record<string, StoredPrep>

function prepPath(): string {
  return join(app.getPath('userData'), 'prep.json')
}

export function prepFilesDir(): string {
  return join(app.getPath('userData'), 'prep')
}

function load(): PrepStore {
  try {
    if (existsSync(prepPath())) return JSON.parse(readFileSync(prepPath(), 'utf-8')) as PrepStore
  } catch {
    // corrupted store: start fresh rather than break the Today view
  }
  return {}
}

function persist(store: PrepStore): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(prepPath(), JSON.stringify(store, null, 2))
}

function removeAttachment(f: PrepFile): void {
  try {
    rmSync(join(prepFilesDir(), f.file), { force: true })
  } catch {
    // best effort
  }
}

/** entries for events long past are dead weight; quietly let them go */
function prune(store: PrepStore): void {
  const cutoff = Date.now() - 60 * 86_400_000
  for (const [key, entry] of Object.entries(store)) {
    if (new Date(entry.updatedAt).getTime() < cutoff) {
      for (const f of entry.files ?? []) removeAttachment(f)
      delete store[key]
    }
  }
}

function toEntry(stored: StoredPrep): PrepEntry {
  return { text: stored.text, files: stored.files ?? [] }
}

/** every prep note, as occurrence id → entry */
export function getPrepNotes(): Record<string, PrepEntry> {
  const store = load()
  const out: Record<string, PrepEntry> = {}
  for (const [id, entry] of Object.entries(store)) out[id] = toEntry(entry)
  return out
}

export function setPrepNote(id: string, text: string): Record<string, PrepEntry> {
  const store = load()
  const clean = String(text).trim()
  const existing = store[id]
  if (clean || existing?.files?.length) {
    store[id] = { text: clean, updatedAt: new Date().toISOString(), files: existing?.files ?? [] }
  } else if (existing) {
    for (const f of existing.files ?? []) removeAttachment(f)
    delete store[id]
  }
  prune(store)
  persist(store)
  return getPrepNotes()
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

/** attach files to a prep note via the OS picker */
export async function addPrepFiles(id: string): Promise<Record<string, PrepEntry> | null> {
  const res = await dialog.showOpenDialog({
    title: 'Attach to prep',
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const store = load()
  const entry = store[id] ?? { text: '', updatedAt: new Date().toISOString(), files: [] }
  mkdirSync(prepFilesDir(), { recursive: true })
  for (const src of res.filePaths) {
    const fileId = randomUUID()
    const ext = extname(src).toLowerCase()
    const stored = `${fileId}${ext}`
    try {
      copyFileSync(src, join(prepFilesDir(), stored))
    } catch {
      continue // unreadable file: skip, keep attaching the rest
    }
    entry.files = entry.files ?? []
    entry.files.push({
      id: fileId,
      name: basename(src),
      file: stored,
      image: IMAGE_EXTS.has(ext)
    })
  }
  entry.updatedAt = new Date().toISOString()
  store[id] = entry
  persist(store)
  return getPrepNotes()
}

export function removePrepFile(id: string, fileId: string): Record<string, PrepEntry> {
  const store = load()
  const entry = store[id]
  if (entry) {
    const target = (entry.files ?? []).find((f) => f.id === fileId)
    if (target) removeAttachment(target)
    entry.files = (entry.files ?? []).filter((f) => f.id !== fileId)
    if (!entry.text && entry.files.length === 0) delete store[id]
    persist(store)
  }
  return getPrepNotes()
}

/** absolute path of an attachment, for opening in its own app */
export function prepFilePath(id: string, fileId: string): string | null {
  const entry = load()[id]
  const f = (entry?.files ?? []).find((x) => x.id === fileId)
  return f ? join(prepFilesDir(), f.file) : null
}
