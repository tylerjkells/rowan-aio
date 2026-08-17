import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// "Before the meeting" prep notes, keyed by calendar occurrence id
// (uid:startISO — a recurring series gets a fresh note per occurrence).
// Deliberately separate from the meeting library: prep belongs to an upcoming
// calendar event, not a recording, and never feeds the AI summary.
// ---------------------------------------------------------------------------

type PrepStore = Record<string, { text: string; updatedAt: string }>

function prepPath(): string {
  return join(app.getPath('userData'), 'prep.json')
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

/** every prep note, as occurrence id → text */
export function getPrepNotes(): Record<string, string> {
  const store = load()
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(store)) out[id] = entry.text
  return out
}

export function setPrepNote(id: string, text: string): Record<string, string> {
  const store = load()
  const clean = String(text).trim()
  if (clean) store[id] = { text: clean, updatedAt: new Date().toISOString() }
  else delete store[id]
  // notes for events long past are dead weight; quietly let them go
  const cutoff = Date.now() - 60 * 86_400_000
  for (const [key, entry] of Object.entries(store)) {
    if (new Date(entry.updatedAt).getTime() < cutoff) delete store[key]
  }
  persist(store)
  return getPrepNotes()
}
