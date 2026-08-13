import { app, dialog } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
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
  const links = listLinks()
  deleteThumbFile(links.find((l) => l.id === id)?.thumb)
  const kept = links.filter((l) => l.id !== id)
  write(kept)
  return kept
}

export function toggleLinkPin(id: string): LinkEntry[] {
  const links = listLinks()
  const link = links.find((l) => l.id === id)
  if (link) link.pinned = !link.pinned
  write(links)
  return links
}

export function thumbsDir(): string {
  return join(app.getPath('userData'), 'link-thumbs')
}

function deleteThumbFile(name: string | undefined): void {
  if (!name) return
  try {
    rmSync(join(thumbsDir(), name), { force: true })
  } catch {
    // best effort
  }
}

/** Pick an image and store it as the link's card thumbnail. Null = canceled. */
export async function pickLinkThumb(id: string): Promise<LinkEntry[] | null> {
  const links = listLinks()
  const link = links.find((l) => l.id === id)
  if (!link) return links
  const res = await dialog.showOpenDialog({
    title: 'Choose a thumbnail image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  const src = res.filePaths[0]
  const ext = extname(src).toLowerCase() || '.png'
  // timestamped name so a replaced image never fights the renderer cache
  const name = `${id}-${Date.now()}${ext}`
  mkdirSync(thumbsDir(), { recursive: true })
  copyFileSync(src, join(thumbsDir(), name))
  deleteThumbFile(link.thumb)
  link.thumb = name
  write(links)
  return links
}

export function clearLinkThumb(id: string): LinkEntry[] {
  const links = listLinks()
  const link = links.find((l) => l.id === id)
  if (link) {
    deleteThumbFile(link.thumb)
    delete link.thumb
    write(links)
  }
  return links
}
