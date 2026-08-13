import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PersonDetails } from '../shared/types'

// ---------------------------------------------------------------------------
// Directory details: title, contact info, and reporting line per person,
// keyed by lowercase display name in userData/directory.json. The roster of
// names itself stays in settings (the team directory), where identity
// resolution already reads it — this file only carries the extra fields.
// ---------------------------------------------------------------------------

function file(): string {
  return join(app.getPath('userData'), 'directory.json')
}

export function readDirectory(): Record<string, PersonDetails> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

function writeDirectory(dir: Record<string, PersonDetails>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(dir, null, 2))
}

/** drop empty-string fields so cleared inputs don't linger as "" */
function prune(details: PersonDetails): PersonDetails {
  const out: PersonDetails = {}
  for (const [k, v] of Object.entries(details)) {
    const s = typeof v === 'string' ? v.trim() : v
    if (s) out[k as keyof PersonDetails] = s
  }
  return out
}

export function detailsFor(name: string): PersonDetails | undefined {
  return readDirectory()[name.trim().toLowerCase()]
}

export function setDetails(name: string, details: PersonDetails): void {
  const dir = readDirectory()
  const key = name.trim().toLowerCase()
  const pruned = prune(details)
  if (Object.keys(pruned).length === 0) delete dir[key]
  else dir[key] = pruned
  writeDirectory(dir)
}

/**
 * Follow a person merge: move `from`'s details onto `to` (existing fields on
 * `to` win) and repoint anyone who reported to `from`.
 */
export function mergeDetails(from: string, to: string): void {
  const dir = readDirectory()
  const fromKey = from.trim().toLowerCase()
  const toKey = to.trim().toLowerCase()
  if (fromKey === toKey) return
  const moved = dir[fromKey]
  if (moved) {
    dir[toKey] = { ...moved, ...(dir[toKey] ?? {}) }
    delete dir[fromKey]
  }
  for (const details of Object.values(dir)) {
    if (details.reportsTo?.trim().toLowerCase() === fromKey) details.reportsTo = to
  }
  writeDirectory(dir)
}

/** Batch-merge imported details; fields present in the import win. */
export function bulkMergeDetails(entries: { name: string; details: PersonDetails }[]): void {
  const dir = readDirectory()
  for (const { name, details } of entries) {
    const key = name.trim().toLowerCase()
    const pruned = prune(details)
    if (Object.keys(pruned).length === 0) continue
    dir[key] = { ...(dir[key] ?? {}), ...pruned }
  }
  writeDirectory(dir)
}

export function removeDetails(name: string): void {
  const dir = readDirectory()
  const key = name.trim().toLowerCase()
  delete dir[key]
  for (const details of Object.values(dir)) {
    if (details.reportsTo?.trim().toLowerCase() === key) delete details.reportsTo
  }
  writeDirectory(dir)
}
