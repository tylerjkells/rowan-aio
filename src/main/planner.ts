import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { PlanItem, PlanItemInput, PlanStatus } from '../shared/types'

// ---------------------------------------------------------------------------
// Planner: off-the-books work (asks and projects that aren't in ClickUp or a
// ServiceNow ticket) in userData/planner.json. Every call returns the whole
// list so the renderer can simply replace what it shows.
// ---------------------------------------------------------------------------

const STATUSES: PlanStatus[] = ['now', 'next', 'waiting', 'later', 'done']

function file(): string {
  return join(app.getPath('userData'), 'planner.json')
}

/** fill anything a hand-edited or older file left out */
function normalize(raw: Partial<PlanItem>): PlanItem {
  const now = new Date().toISOString()
  return {
    id: raw.id || randomUUID(),
    title: raw.title ?? '',
    status: STATUSES.includes(raw.status as PlanStatus) ? (raw.status as PlanStatus) : 'next',
    requester: raw.requester ?? '',
    project: raw.project ?? '',
    due: raw.due ?? '',
    notes: raw.notes ?? '',
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    links: Array.isArray(raw.links) ? raw.links : [],
    updates: Array.isArray(raw.updates) ? raw.updates : [],
    ...(raw.clickupUrl ? { clickupUrl: raw.clickupUrl } : {}),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    doneAt: raw.doneAt ?? '',
    order: typeof raw.order === 'number' ? raw.order : 0
  }
}

export function listPlan(): PlanItem[] {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { items?: Partial<PlanItem>[] }
    return (raw.items ?? []).map(normalize)
  } catch {
    return []
  }
}

function write(items: PlanItem[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  // write then rename, so a crash mid-write never leaves half a file
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify({ items }, null, 2))
  renameSync(tmp, file())
}

/** the order that puts an item at the top (or bottom) of a column */
function edgeOrder(items: PlanItem[], status: PlanStatus, top: boolean): number {
  const orders = items.filter((i) => i.status === status).map((i) => i.order)
  if (orders.length === 0) return 0
  return top ? Math.min(...orders) - 1 : Math.max(...orders) + 1
}

/** Add a new item; it goes to the bottom of its column (top of Done). */
export function addPlanItem(input: PlanItemInput): { items: PlanItem[]; id: string } {
  const items = listPlan()
  const status = input.status ?? 'now'
  const now = new Date().toISOString()
  const item = normalize({
    ...input,
    id: randomUUID(),
    title: input.title.trim() || 'Untitled',
    status,
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : '',
    order: edgeOrder(items, status, status === 'done')
  })
  items.push(item)
  write(items)
  return { items, id: item.id }
}

/**
 * Change fields on an item. A status change moves it to the end of its new
 * column (or the top of Done) and stamps or clears the done time.
 */
export function updatePlanItem(
  id: string,
  patch: Partial<Omit<PlanItem, 'id' | 'createdAt'>>
): PlanItem[] {
  const items = listPlan()
  const i = items.findIndex((x) => x.id === id)
  if (i < 0) return items
  const before = items[i]
  const next = normalize({ ...before, ...patch, id: before.id, createdAt: before.createdAt })
  if (patch.status && patch.status !== before.status) {
    next.order = edgeOrder(items, patch.status, patch.status === 'done')
    next.doneAt = patch.status === 'done' ? new Date().toISOString() : ''
  }
  next.updatedAt = new Date().toISOString()
  items[i] = next
  write(items)
  return items
}

/**
 * Drag-and-drop: put an item in a column, just before another item there
 * (or at the end when beforeId is null), renumbering that column.
 */
export function movePlanItem(id: string, status: PlanStatus, beforeId: string | null): PlanItem[] {
  const items = listPlan()
  const item = items.find((x) => x.id === id)
  if (!item) return items
  if (item.status !== status) {
    item.doneAt = status === 'done' ? new Date().toISOString() : ''
    item.status = status
  }
  item.updatedAt = new Date().toISOString()
  const column = items
    .filter((x) => x.status === status && x.id !== id)
    .sort((a, b) => a.order - b.order)
  const at = beforeId ? column.findIndex((x) => x.id === beforeId) : -1
  column.splice(at < 0 ? column.length : at, 0, item)
  column.forEach((x, n) => (x.order = n))
  write(items)
  return items
}

export function removePlanItem(id: string): PlanItem[] {
  const kept = listPlan().filter((x) => x.id !== id)
  write(kept)
  return kept
}
