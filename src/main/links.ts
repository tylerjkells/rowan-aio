import { app, BrowserWindow, dialog } from 'electron'
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

/**
 * Load the link's page in a hidden, sandboxed window and screenshot it as
 * the thumbnail. Pages behind a login capture the login page — that's what
 * the manual image picker is for.
 */
export async function autoLinkThumb(
  id: string
): Promise<{ links?: LinkEntry[]; error?: string }> {
  const links = listLinks()
  const link = links.find((l) => l.id === id)
  if (!link) return { links }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // its own cookie jar, fully separate from the app
      partition: 'thumb-capture'
    }
  })
  try {
    await Promise.race([
      win.loadURL(link.url),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('Page took too long')), 20_000))
    ])
    // let late-rendering pages (charts, dashboards) settle
    await new Promise((r) => setTimeout(r, 2000))
    const image = await win.webContents.capturePage()
    const jpeg = image.resize({ width: 800 }).toJPEG(82)
    const name = `${id}-${Date.now()}.jpg`
    mkdirSync(thumbsDir(), { recursive: true })
    writeFileSync(join(thumbsDir(), name), jpeg)
    deleteThumbFile(link.thumb)
    link.thumb = name
    write(links)
    return { links }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not capture the page' }
  } finally {
    win.destroy()
  }
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
