import { app, dialog } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  StatusDef,
  StatusImage,
  StatusImportResult,
  StatusIssue,
  StatusItem,
  StatusMeta,
  StatusSection,
  StatusUpdateData
} from '../shared/types'

// ---------------------------------------------------------------------------
// RO Ops status update: the monthly email of what the team completed, what's
// in progress and what's newly requested, in userData/status-update.json.
// The renderer edits it in place and saves back only the parts it changed;
// past issues ride along so a sent month can be viewed or copied again.
// ---------------------------------------------------------------------------

const SECTIONS: StatusSection[] = ['completed', 'progress', 'new']

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function defaultMeta(): StatusMeta {
  const now = new Date()
  return {
    month: `${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    intro:
      "Here's a look at what the team completed, what's in flight, and what's new this month across Rowan Online, WLS, Rowan Reach, and University dashboards.",
    mailbox: 'ROOperations@rowan.edu',
    oh1: 'Tuesdays, Room 105, 10:00 AM to 11:00 AM',
    oh2: 'Thursdays, Room 105, 11:00 AM to 12:00 PM',
    hidden: [],
    spotOn: false,
    spotTitle: '',
    spotBody: '',
    spotLink: ''
  }
}

const DEFAULT_STATUSES: StatusDef[] = [
  { name: 'In Development', tone: 'dev' },
  { name: 'Testing', tone: 'test' },
  { name: 'Under Review', tone: 'test' },
  { name: 'IDA Review', tone: 'test' },
  { name: 'Requirements', tone: 'req' },
  { name: 'Launching Soon', tone: 'go' },
  { name: 'On Hold', tone: 'hold' }
]

function file(): string {
  return join(app.getPath('userData'), 'status-update.json')
}

let cache: StatusUpdateData | null = null

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

function item(id: string, r: Record<string, unknown>): StatusItem {
  const section = SECTIONS.includes(r.section as StatusSection) ? (r.section as StatusSection) : 'progress'
  const it: StatusItem = {
    id,
    section,
    area: str(r.area),
    name: str(r.name),
    note: str(r.note),
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : 0
  }
  if (typeof r.status === 'string') it.status = r.status
  if (typeof r.launched === 'boolean') it.launched = r.launched
  for (const k of ['link', 'target', 'requestedBy', 'lastSentNote'] as const) {
    if (typeof r[k] === 'string') it[k] = r[k] as string
  }
  return it
}

/**
 * Whatever came off disk or out of an import, in today's shape: items as a
 * list or keyed by id (the original builder's export), anything missing
 * filled from the defaults.
 */
function normalize(raw: Record<string, unknown>): StatusUpdateData {
  const rawItems = raw.items
  const items: StatusItem[] = []
  if (Array.isArray(rawItems)) {
    rawItems.forEach((r, n) => {
      if (r && typeof r === 'object') {
        const rec = r as Record<string, unknown>
        items.push(item(str(rec.id) || `i${n}`, rec))
      }
    })
  } else if (rawItems && typeof rawItems === 'object') {
    for (const [id, r] of Object.entries(rawItems as Record<string, unknown>)) {
      if (r && typeof r === 'object') items.push(item(id, r as Record<string, unknown>))
    }
  }
  const m = (raw.meta && typeof raw.meta === 'object' ? raw.meta : {}) as Record<string, unknown>
  const base = defaultMeta()
  const meta: StatusMeta = {
    month: typeof m.month === 'string' ? m.month : base.month,
    intro: typeof m.intro === 'string' ? m.intro : base.intro,
    mailbox: typeof m.mailbox === 'string' ? m.mailbox : base.mailbox,
    oh1: typeof m.oh1 === 'string' ? m.oh1 : base.oh1,
    oh2: typeof m.oh2 === 'string' ? m.oh2 : base.oh2,
    hidden: Array.isArray(m.hidden) ? (m.hidden.filter((k) => SECTIONS.includes(k)) as StatusSection[]) : [],
    spotOn: m.spotOn === true,
    spotTitle: str(m.spotTitle),
    spotBody: str(m.spotBody),
    spotLink: str(m.spotLink)
  }
  const statuses: StatusDef[] = Array.isArray(raw.statuses)
    ? (raw.statuses as Record<string, unknown>[])
        .filter((s) => s && typeof s.name === 'string' && s.name)
        .map((s) => ({
          name: s.name as string,
          tone: typeof s.tone === 'string' ? s.tone : 'dev',
          ...(isHex(s.color) ? { color: s.color.toUpperCase() } : {}),
          ...(typeof s.hold === 'boolean' ? { hold: s.hold } : {})
        }))
    : []
  const issues: StatusIssue[] = Array.isArray(raw.issues)
    ? (raw.issues as StatusIssue[]).filter((x) => x && typeof x.html === 'string' && typeof x.id === 'string')
    : []
  const img = raw.spotImg as StatusImage | null | undefined
  const spotImg =
    img && typeof img.data === 'string' && img.data.startsWith('data:image/')
      ? { data: img.data, w: Number(img.w) || 575, h: Number(img.h) || 300 }
      : null
  return {
    meta,
    statuses: statuses.length ? statuses : DEFAULT_STATUSES.map((s) => ({ ...s })),
    items,
    issues,
    spotImg
  }
}

function write(d: StatusUpdateData): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(d, null, 2))
}

export function getStatusUpdate(): StatusUpdateData {
  if (cache) return cache
  try {
    cache = normalize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    cache = normalize({})
  }
  return cache
}

/** replace the parts the renderer changed; the rest stays as stored */
export function saveStatusUpdate(patch: Partial<StatusUpdateData>): StatusUpdateData {
  const next = { ...getStatusUpdate() }
  for (const k of ['meta', 'statuses', 'items', 'issues', 'spotImg'] as const) {
    if (k in patch) (next as Record<string, unknown>)[k] = patch[k]
  }
  cache = next
  write(next)
  return next
}

/** bring in a saved export (from here or from the original builder); null = canceled */
export async function importStatusUpdate(): Promise<StatusImportResult> {
  const res = await dialog.showOpenDialog({
    title: 'Import a status update',
    properties: ['openFile'],
    filters: [{ name: 'Status update', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
  } catch {
    return { ok: false, error: 'That file couldn’t be read as a status update export.' }
  }
  if (!raw || typeof raw !== 'object' || !('items' in raw || 'meta' in raw)) {
    return { ok: false, error: 'That file doesn’t look like a status update export.' }
  }
  cache = normalize(raw as Record<string, unknown>)
  write(cache)
  return { ok: true, data: cache }
}

/** save everything to a JSON file the user picks; null = canceled */
export async function exportStatusUpdate(): Promise<{ ok: boolean; path?: string; error?: string } | null> {
  const res = await dialog.showSaveDialog({
    title: 'Export the status update',
    defaultPath: 'ro-ops-status-update.json',
    filters: [{ name: 'Status update', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  try {
    writeFileSync(res.filePath, JSON.stringify(getStatusUpdate(), null, 2))
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
