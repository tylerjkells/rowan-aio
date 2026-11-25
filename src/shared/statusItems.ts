import type { StatusDef, StatusItem, StatusLabel, StatusSection, StatusUpdateData } from './types'

// ---------------------------------------------------------------------------
// The monthly status update's items as the email lists them: in area order,
// On Hold told apart by its status, and each status's chip colors. The
// desktop's editor and email and the phone's read-only view share these.
// ---------------------------------------------------------------------------

export const AREAS = ['Rowan Online', 'WLS', 'Rowan Reach', 'University Dashboards']

/** the original builder's preset chip colors: light (email, light themes) and dark */
export const TONES: Record<string, { bg: string; fg: string; dbg: string; dfg: string }> = {
  dev: { bg: '#F6E7D3', fg: '#88431E', dbg: '#4A2E1C', dfg: '#F2C6A0' },
  tan: { bg: '#F1E7D2', fg: '#7A5F2E', dbg: '#3F3420', dfg: '#E8D3A6' },
  req: { bg: '#FFF3C4', fg: '#7A5A00', dbg: '#4A3D0A', dfg: '#FFE27A' },
  orange: { bg: '#FBE3C7', fg: '#9A4F00', dbg: '#4D2E0C', dfg: '#FFC48A' },
  alert: { bg: '#F6DDE2', fg: '#8E142D', dbg: '#4A1A24', dfg: '#F5A9B7' },
  pink: { bg: '#F7DFEA', fg: '#8A2A5B', dbg: '#46202F', dfg: '#F4B3D2' },
  purple: { bg: '#E8E0F2', fg: '#5B3A87', dbg: '#30264A', dfg: '#CDB8F0' },
  navy: { bg: '#D6E2EE', fg: '#1F3A5F', dbg: '#1C2A3D', dfg: '#A9C4E6' },
  test: { bg: '#DCEBF5', fg: '#0067A0', dbg: '#173548', dfg: '#9FD0F2' },
  sky: { bg: '#D9F0FA', fg: '#10688C', dbg: '#143A48', dfg: '#9EDDF5' },
  teal: { bg: '#DDF0EE', fg: '#2C6E6A', dbg: '#183A37', dfg: '#9FDCD5' },
  go: { bg: '#E3EEDB', fg: '#4A7729', dbg: '#24371A', dfg: '#B7E09A' },
  forest: { bg: '#D5E8DD', fg: '#1F5A3A', dbg: '#173226', dfg: '#9DD3B4' },
  lime: { bg: '#EAF5D0', fg: '#4B6B00', dbg: '#2C3A0E', dfg: '#CBE88A' },
  slate: { bg: '#DFE6E8', fg: '#3F5759', dbg: '#25302F', dfg: '#B5CBCC' },
  hold: { bg: '#E8E8E8', fg: '#5A5C5E', dbg: '#33353A', dfg: '#C6C8CC' }
}

export interface Chip {
  base: string
  bg: string
  fg: string
  dbg: string
  dfg: string
}

export const isHex = (h: unknown): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h)
export const hexRgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
export const rgbHex = (c: number[]): string =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()
export const mix = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t)
export function lum(c: number[]): number {
  const l = c.map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
export function contrast(a: number[], b: number[]): number {
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** any picked color as a readable chip: a light tint with dark text, and a dark version for dark themes */
export function deriveChip(hex: string): Omit<Chip, 'base'> {
  const base = hexRgb(hex)
  const W = [255, 255, 255]
  const K = [0, 0, 0]
  const D = [22, 17, 16]
  const bg = mix(base, W, 0.8)
  let t = 0.25
  let fg = mix(base, K, t)
  while (contrast(fg, bg) < 4.8 && t < 0.95) {
    t += 0.07
    fg = mix(base, K, t)
  }
  const dbg = mix(base, D, 0.7)
  let u = 0.45
  let dfg = mix(base, W, u)
  while (contrast(dfg, dbg) < 4.8 && u < 0.95) {
    u += 0.07
    dfg = mix(base, W, u)
  }
  return { bg: rgbHex(bg), fg: rgbHex(fg), dbg: rgbHex(dbg), dfg: rgbHex(dfg) }
}

export function chipColors(s: StatusDef | { color: string } | undefined): Chip {
  if (s && isHex(s.color)) return { base: s.color.toUpperCase(), ...deriveChip(s.color) }
  const tn = TONES[(s && 'tone' in s && s.tone) || 'dev'] ?? TONES.dev
  return { base: tn.fg, ...tn }
}

export const holdFlag = (s: StatusDef | undefined): boolean =>
  !!s && (typeof s.hold === 'boolean' ? s.hold : s.tone === 'hold')

export const statusDef = (d: StatusUpdateData, name: string | undefined): StatusDef | undefined =>
  d.statuses.find((x) => x.name === name)
export const isHold = (d: StatusUpdateData, it: StatusItem): boolean =>
  it.section === 'progress' && holdFlag(statusDef(d, it.status))
export const isUrl = (u: string | undefined): boolean => /^https?:\/\/\S+$/i.test(String(u || '').trim())

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** a section's items A to Z by name, whatever their area */
export function sectionItems(items: StatusItem[], key: StatusSection): StatusItem[] {
  return items
    .filter((it) => (it.section || 'progress') === key)
    .sort((a, b) => byName(a.name.trim(), b.name.trim()) || byName(a.area, b.area) || a.order - b.order)
}

export function countsOf(d: StatusUpdateData): { completed: number; progress: number; hold: number; fresh: number } {
  const prog = d.items.filter((i) => i.section === 'progress')
  return {
    completed: d.items.filter((i) => i.section === 'completed').length,
    progress: prog.filter((i) => !isHold(d, i)).length,
    hold: prog.filter((i) => isHold(d, i)).length,
    fresh: d.items.filter((i) => i.section === 'new').length
  }
}

export const isHidden = (d: StatusUpdateData, key: StatusSection): boolean => d.meta.hidden.includes(key)

/** what goes out: anything with a name or a note */
export const filled = (list: StatusItem[]): StatusItem[] => list.filter((i) => i.name.trim() || i.note.trim())

// ---- wording ------------------------------------------------------------------
// Every fixed word in the email can be changed; only changes are saved, so a
// label left alone follows any later change to its default.

export interface LabelDef {
  key: StatusLabel
  /** the panel's heading this one sits under */
  group: string
  name: string
  def: string
  hint?: string
  /** shown in capitals in the email */
  upper?: boolean
  multi?: boolean
}

export const STATUS_LABELS: LabelDef[] = [
  { key: 'team', group: 'Header', name: 'Team name', def: 'Rowan Online Operational Effectiveness Team', upper: true },
  { key: 'title', group: 'Header', name: 'Title, after the month', def: 'Dashboard Status Update' },
  { key: 'completed', group: 'Sections and counts', name: 'Completed', def: 'Completed', upper: true },
  { key: 'progress', group: 'Sections and counts', name: 'In Progress', def: 'In Progress', upper: true },
  { key: 'hold', group: 'Sections and counts', name: 'On Hold', def: 'On Hold', upper: true },
  { key: 'new', group: 'Sections and counts', name: 'New Requests', def: 'New Requests', upper: true },
  { key: 'newDashboards', group: 'Sections and counts', name: 'Completed: new dashboards', def: 'New Dashboards', upper: true },
  { key: 'updates', group: 'Sections and counts', name: 'Completed: updates', def: 'Updates and Enhancements', upper: true },
  { key: 'newSub', group: 'Sections and counts', name: 'Under New Requests', def: 'Currently in requirements gathering' },
  { key: 'colDashboard', group: 'Table headings', name: 'Name column', def: 'Dashboard' },
  { key: 'colCovers', group: 'Table headings', name: 'New dashboards: about', def: 'What it covers' },
  { key: 'colChanged', group: 'Table headings', name: 'Updates: about', def: 'What changed' },
  { key: 'colLink', group: 'Table headings', name: 'Link column', def: 'Link' },
  { key: 'colStatus', group: 'Table headings', name: 'In Progress: status', def: 'Status' },
  { key: 'colReason', group: 'Table headings', name: 'On Hold: reason', def: 'Reason' },
  { key: 'colPurpose', group: 'Table headings', name: 'New Requests: purpose', def: 'Purpose' },
  { key: 'openDashboard', group: 'Buttons and small print', name: 'Dashboard button', def: 'Open dashboard' },
  { key: 'linkSoon', group: 'Buttons and small print', name: 'No link yet', def: 'Link coming soon' },
  { key: 'requestedBy', group: 'Buttons and small print', name: 'Before a requester’s name', def: 'Requested by' },
  { key: 'spotlight', group: 'Buttons and small print', name: 'Spotlight label', def: 'Spotlight', upper: true },
  { key: 'spotButton', group: 'Buttons and small print', name: 'Spotlight button', def: 'Take a look' },
  { key: 'requestTitle', group: 'Bottom of the email', name: 'Request box title', def: 'Submit a Request' },
  {
    key: 'requestBody',
    group: 'Bottom of the email',
    name: 'Request box text',
    def: 'Send all dashboard and reporting requests to {mailbox}, including dashboard updates, discrepancies or issues, and one-time or recurring reports. This keeps requests captured, prioritized, and assigned.',
    hint: '{mailbox} is where the request mailbox goes, as a link.',
    multi: true
  },
  { key: 'hoursTitle', group: 'Bottom of the email', name: 'Office hours title', def: 'Weekly Office Hours' },
  {
    key: 'past',
    group: 'Bottom of the email',
    name: 'Past updates line',
    def: 'Past monthly updates can be found [here].',
    hint: 'The words in [brackets] link to the past updates.'
  },
  {
    key: 'footer',
    group: 'Bottom of the email',
    name: 'Footer',
    def: 'Rowan Online Operational Effectiveness Team | Monthly updates are sent the last Wednesday of every month.'
  }
]

export const labelDef = (key: StatusLabel): LabelDef => STATUS_LABELS.find((l) => l.key === key)!

/** a piece of the email's wording: yours where you changed it, else the default */
export function label(d: StatusUpdateData, key: StatusLabel): string {
  const v = d.meta.labels?.[key]
  return v?.trim() ? v : labelDef(key).def
}
