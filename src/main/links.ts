import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { LinkEntry } from '../shared/types'

// ---------------------------------------------------------------------------
// Link hub: org links (dashboards, data centers, …) in userData/links.json.
// ---------------------------------------------------------------------------

function file(): string {
  return join(app.getPath('userData'), 'links.json')
}

export function listLinks(): LinkEntry[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return []
  }
}

function write(links: LinkEntry[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(links, null, 2))
}

/** Add (no id) or update (with id) a link; returns the full list. */
export function saveLink(entry: Partial<LinkEntry> & Omit<LinkEntry, 'id'>): LinkEntry[] {
  const links = listLinks()
  if (entry.id) {
    const i = links.findIndex((l) => l.id === entry.id)
    if (i >= 0) links[i] = { ...links[i], ...entry } as LinkEntry
  } else {
    links.push({ ...entry, id: randomUUID() })
  }
  write(links)
  return links
}

export function removeLink(id: string): LinkEntry[] {
  const links = listLinks().filter((l) => l.id !== id)
  write(links)
  return links
}

export function toggleLinkPin(id: string): LinkEntry[] {
  const links = listLinks()
  const link = links.find((l) => l.id === id)
  if (link) link.pinned = !link.pinned
  write(links)
  return links
}
