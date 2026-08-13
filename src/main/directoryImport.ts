import { dialog } from 'electron'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { addPerson } from './settings'
import { bulkMergeDetails } from './directory'
import type { DirectoryImportRow, DirectoryImportScan, PersonDetails } from '../shared/types'

// ---------------------------------------------------------------------------
// One-time directory import: point the app at a CSV export (from SQL, Excel
// "Save as CSV", HR systems, …) and populate the org directory in one go.
// Column headers are matched loosely, so "Job Title", "job_title", and
// "TITLE" all land on the title field.
// ---------------------------------------------------------------------------

const FIELD_ALIASES: Record<string, string[]> = {
  name: ['name', 'fullname', 'displayname', 'employee', 'employeename', 'person', 'staffname'],
  title: ['title', 'jobtitle', 'position', 'positiontitle', 'role', 'rank'],
  department: ['department', 'dept', 'division', 'unit', 'college', 'school', 'org', 'orgunit'],
  email: ['email', 'emailaddress', 'mail', 'workemail', 'universityemail'],
  phone: ['phone', 'phonenumber', 'telephone', 'workphone', 'extension', 'ext', 'phoneext'],
  office: ['office', 'location', 'room', 'building', 'officelocation', 'campus'],
  reportsTo: [
    'reportsto',
    'manager',
    'managername',
    'supervisor',
    'supervisorname',
    'reports',
    'reportstoname'
  ],
  notes: ['notes', 'note', 'comments', 'comment']
}

const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/** matches settings.addPerson's idea of a usable directory name */
const isValidName = (name: string): boolean =>
  !!name && name.toLowerCase() !== 'me' && !/[()&+/,]|\b(and|or)\b/i.test(name)

/** "Primas-Young, Carol" → "Carol Primas-Young" (single-comma exports only) */
function unLastFirst(name: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(name)
  if (m && !/\d/.test(name)) return `${m[2].trim()} ${m[1].trim()}`
  return name
}

function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  // sniff the delimiter from the header line
  const firstLine = clean.slice(0, clean.indexOf('\n') === -1 ? clean.length : clean.indexOf('\n'))
  let delimiter = ','
  let best = 0
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length - 1
    if (count > best) {
      best = count
      delimiter = d
    }
  }

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

export async function scanDirectoryCsv(): Promise<DirectoryImportScan | null> {
  const res = await dialog.showOpenDialog({
    title: 'Import directory CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV / delimited text', extensions: ['csv', 'tsv', 'txt'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  const path = res.filePaths[0]
  const file = basename(path)

  let rows: string[][]
  try {
    rows = parseCsv(readFileSync(path, 'utf8'))
  } catch {
    return { file, rows: [], skipped: 0, mapped: {}, error: 'Could not read the file.' }
  }
  if (rows.length < 2) {
    return { file, rows: [], skipped: 0, mapped: {}, error: 'No data rows found under the header.' }
  }

  const headers = rows[0]
  const columnFor: Record<string, number> = {}
  const mapped: Record<string, string> = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const i = headers.findIndex((h) => aliases.includes(normalizeHeader(h)))
    if (i >= 0) {
      columnFor[field] = i
      mapped[field] = headers[i].trim()
    }
  }
  if (columnFor.name === undefined) {
    return {
      file,
      rows: [],
      skipped: 0,
      mapped,
      error: `No name column found. Headers seen: ${headers.map((h) => h.trim()).join(', ')}`
    }
  }

  // last row wins when a name repeats
  const byKey = new Map<string, DirectoryImportRow>()
  let skipped = 0
  for (const raw of rows.slice(1)) {
    const cell = (field: string): string =>
      columnFor[field] !== undefined ? (raw[columnFor[field]] ?? '').trim() : ''
    const name = unLastFirst(cell('name').trim())
    if (!isValidName(name)) {
      skipped++
      continue
    }
    const details: PersonDetails = {
      title: cell('title') || undefined,
      department: cell('department') || undefined,
      email: cell('email') || undefined,
      phone: cell('phone') || undefined,
      office: cell('office') || undefined,
      reportsTo: unLastFirst(cell('reportsTo')) || undefined,
      notes: cell('notes') || undefined
    }
    byKey.set(name.toLowerCase(), { name, details })
  }

  return { file, rows: [...byKey.values()], skipped, mapped }
}

/** Add everyone to the roster and merge their details in one write. */
export function applyDirectoryImport(rows: DirectoryImportRow[]): number {
  for (const r of rows) addPerson(r.name)
  bulkMergeDetails(rows)
  return rows.length
}
