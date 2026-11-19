import type { StatusDef, StatusItem, StatusSection, StatusUpdateData } from './types'

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

export function areaRank(a: string): number {
  const i = AREAS.indexOf(a)
  return i === -1 ? (a ? 50 : 99) : i
}

export function sectionItems(items: StatusItem[], key: StatusSection): StatusItem[] {
  return items
    .filter((it) => (it.section || 'progress') === key)
    .sort(
      (a, b) =>
        areaRank(a.area) - areaRank(b.area) ||
        a.area.localeCompare(b.area) ||
        a.order - b.order ||
        a.name.localeCompare(b.name)
    )
}

export function groupByArea(list: StatusItem[]): { area: string; items: StatusItem[] }[] {
  const groups: { area: string; items: StatusItem[] }[] = []
  for (const it of list) {
    let g = groups[groups.length - 1]
    if (!g || g.area !== it.area) {
      g = { area: it.area, items: [] }
      groups.push(g)
    }
    g.items.push(it)
  }
  return groups
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
