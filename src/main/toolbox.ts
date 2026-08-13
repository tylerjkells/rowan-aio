import { app, clipboard, dialog, nativeImage } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import mammoth from 'mammoth'
import type { ToolboxData, ToolboxFile, ToolboxGuide, ToolboxImage } from '../shared/types'

// ---------------------------------------------------------------------------
// Toolbox: the working-materials shelf. Guides are Word docs converted to
// HTML once at upload (mammoth) and rendered in-app with copyable steps;
// images are reusable assets copied to the clipboard for pasting into
// Tableau and friends; files are templates stored here and saved out as
// copies when needed. Everything lives under userData/toolbox.
// ---------------------------------------------------------------------------

function root(): string {
  return join(app.getPath('userData'), 'toolbox')
}
const dirs = {
  guides: (): string => join(root(), 'guides'),
  images: (): string => join(root(), 'images'),
  files: (): string => join(root(), 'files')
}

function dataFile(): string {
  return join(root(), 'toolbox.json')
}

export function readToolbox(): ToolboxData {
  try {
    const raw = JSON.parse(readFileSync(dataFile(), 'utf8')) as Partial<ToolboxData>
    // stores written before a section existed simply lack its key
    return {
      guides: raw.guides ?? [],
      images: raw.images ?? [],
      files: raw.files ?? [],
      queries: raw.queries ?? []
    }
  } catch {
    return { guides: [], images: [], files: [], queries: [] }
  }
}

function write(data: ToolboxData): void {
  mkdirSync(root(), { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2))
}

// ---- guides ----

/** Pick a .docx, convert to HTML, store both. Null = canceled. */
export async function addToolboxGuide(): Promise<ToolboxData | { error: string } | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add a guide (Word document)',
    properties: ['openFile'],
    filters: [{ name: 'Word documents', extensions: ['docx'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  const src = res.filePaths[0]
  try {
    const converted = await mammoth.convertToHtml({ path: src })
    const html = converted.value
    if (!html.trim()) return { error: 'That document came out empty.' }
    const id = randomUUID()
    const dir = join(dirs.guides(), id)
    mkdirSync(dir, { recursive: true })
    copyFileSync(src, join(dir, 'source.docx'))
    writeFileSync(join(dir, 'content.html'), html)
    // the first heading names the guide; the filename is the fallback
    const heading = /<h[12][^>]*>(.*?)<\/h[12]>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '')
    const guide: ToolboxGuide = {
      id,
      title: (heading ?? basename(src, extname(src))).trim().slice(0, 120),
      addedAt: new Date().toISOString(),
      source: basename(src)
    }
    const data = readToolbox()
    data.guides.unshift(guide)
    write(data)
    return data
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not read that document.' }
  }
}

export function getGuideHtml(id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null
  try {
    return readFileSync(join(dirs.guides(), id, 'content.html'), 'utf8')
  } catch {
    return null
  }
}

/** Rename a guide and/or overwrite its edited HTML. */
export function updateToolboxGuide(
  id: string,
  patch: { title?: string; html?: string }
): ToolboxData {
  const data = readToolbox()
  const guide = data.guides.find((g) => g.id === id)
  if (guide) {
    if (patch.title?.trim()) guide.title = patch.title.trim().slice(0, 120)
    if (typeof patch.html === 'string' && patch.html.trim()) {
      try {
        writeFileSync(join(dirs.guides(), id, 'content.html'), patch.html)
      } catch {
        // disk hiccup: the title change still persists
      }
    }
    write(data)
  }
  return data
}

export function removeToolboxGuide(id: string): ToolboxData {
  const data = readToolbox()
  data.guides = data.guides.filter((g) => g.id !== id)
  try {
    rmSync(join(dirs.guides(), id), { recursive: true, force: true })
  } catch {
    // best effort
  }
  write(data)
  return data
}

// ---- images ----

export async function addToolboxImages(): Promise<ToolboxData | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const data = readToolbox()
  mkdirSync(dirs.images(), { recursive: true })
  for (const src of res.filePaths) {
    const id = randomUUID()
    const file = `${id}${extname(src).toLowerCase()}`
    copyFileSync(src, join(dirs.images(), file))
    data.images.unshift({ id, name: basename(src, extname(src)), file })
  }
  write(data)
  return data
}

/** Put the image on the clipboard as a bitmap, ready to paste into Tableau. */
export function copyToolboxImage(id: string): { ok: boolean; error?: string } {
  const entry = readToolbox().images.find((i) => i.id === id)
  if (!entry) return { ok: false, error: 'Image not found' }
  const path = join(dirs.images(), entry.file)
  if (entry.file.endsWith('.svg')) {
    // SVG has no bitmap form; hand over the markup instead
    try {
      clipboard.writeText(readFileSync(path, 'utf8'))
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not read the SVG' }
    }
  }
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return { ok: false, error: 'Could not load the image' }
  clipboard.writeImage(image)
  return { ok: true }
}

export function removeToolboxImage(id: string): ToolboxData {
  const data = readToolbox()
  const entry = data.images.find((i) => i.id === id)
  if (entry) {
    try {
      rmSync(join(dirs.images(), entry.file), { force: true })
    } catch {
      // best effort
    }
  }
  data.images = data.images.filter((i) => i.id !== id)
  write(data)
  return data
}

// ---- files ----

export async function addToolboxFiles(): Promise<ToolboxData | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add files',
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const data = readToolbox()
  mkdirSync(dirs.files(), { recursive: true })
  for (const src of res.filePaths) {
    const id = randomUUID()
    const file = `${id}-${basename(src)}`
    copyFileSync(src, join(dirs.files(), file))
    data.files.unshift({
      id,
      name: basename(src),
      file,
      bytes: statSync(src).size,
      addedAt: new Date().toISOString()
    })
  }
  write(data)
  return data
}

/** "Save a copy…" — the stored file goes wherever the user points. */
export async function saveToolboxFileCopy(id: string): Promise<{ ok: boolean; error?: string }> {
  const entry = readToolbox().files.find((f) => f.id === id)
  if (!entry) return { ok: false, error: 'File not found' }
  const res = await dialog.showSaveDialog({ defaultPath: entry.name })
  if (res.canceled || !res.filePath) return { ok: false }
  try {
    copyFileSync(join(dirs.files(), entry.file), res.filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the file' }
  }
}

export function removeToolboxFile(id: string): ToolboxData {
  const data = readToolbox()
  const entry = data.files.find((f) => f.id === id)
  if (entry) {
    try {
      rmSync(join(dirs.files(), entry.file), { force: true })
    } catch {
      // best effort
    }
  }
  data.files = data.files.filter((f) => f.id !== id)
  write(data)
  return data
}

// ---- queries ----

/** Add (no id) or update (with id) a saved SQL query. */
export function saveToolboxQuery(input: {
  id?: string
  name: string
  sql: string
  note?: string
}): ToolboxData {
  const data = readToolbox()
  const name = input.name.trim().slice(0, 120)
  const sql = input.sql.trim()
  const note = input.note?.trim() || undefined
  if (!name || !sql) return data
  if (input.id) {
    const q = data.queries.find((x) => x.id === input.id)
    if (q) {
      q.name = name
      q.sql = sql
      q.note = note
    }
  } else {
    data.queries.unshift({
      id: randomUUID(),
      name,
      sql,
      note,
      addedAt: new Date().toISOString()
    })
  }
  write(data)
  return data
}

export function removeToolboxQuery(id: string): ToolboxData {
  const data = readToolbox()
  data.queries = data.queries.filter((q) => q.id !== id)
  write(data)
  return data
}

export function toolboxImagesDir(): string {
  return dirs.images()
}
