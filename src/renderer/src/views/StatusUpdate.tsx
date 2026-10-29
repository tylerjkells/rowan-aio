import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  StatusDef,
  StatusImage,
  StatusIssue,
  StatusItem,
  StatusMeta,
  StatusSection,
  StatusUpdateData
} from '../../../shared/types'
import { useConfirm } from '../ui'

// ---------------------------------------------------------------------------
// RO Ops status update: the team's monthly email of what was completed, what's
// in progress and what's newly requested. Edit on the left, the email as it
// will paste into Outlook on the right. Start next month saves the month as
// sent and clears the completed items.
// ---------------------------------------------------------------------------

const AREAS = ['Rowan Online', 'WLS', 'Rowan Reach', 'University Dashboards']

interface Sec {
  key: StatusSection
  label: string
  noteLabel: string
  notePh: string
}
const SECTIONS: Sec[] = [
  { key: 'completed', label: 'Completed', noteLabel: 'Update', notePh: 'What was done, and when it published' },
  { key: 'progress', label: 'In Progress', noteLabel: 'Notes', notePh: 'Where it stands and what’s next' },
  { key: 'new', label: 'New Requests', noteLabel: 'Purpose', notePh: 'What the request is meant to do' }
]
const secOf = (key: StatusSection): Sec => SECTIONS.find((s) => s.key === key)!

/** the original builder's preset chip colors: light (email, light themes) and dark */
const TONES: Record<string, { bg: string; fg: string; dbg: string; dfg: string }> = {
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

/** Rowan brand colors, offered in the status color picker */
const BRAND_COLORS = [
  '#57150B', '#88431E', '#AD7C59', '#FFCC00', '#DE7C00', '#CBA052', '#8E142D', '#0067A0',
  '#41B6E6', '#5CB8B2', '#007B4B', '#4A7729', '#84BD00', '#658081', '#5B3A87', '#75787B'
]

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

type PanelKey = 'meta' | 'spot' | 'statuses' | 'issues' | 'data'

/** the settings that open under the pills above the items */
const PANELS: { key: PanelKey; label: string; hint: string }[] = [
  { key: 'meta', label: 'Email details', hint: 'Month, intro, request mailbox and office hours' },
  { key: 'spot', label: 'Spotlight', hint: 'An optional featured dashboard or tip' },
  { key: 'statuses', label: 'Statuses', hint: 'Add, rename and recolor the In Progress statuses' },
  { key: 'issues', label: 'Past issues', hint: 'Each month as it was sent' },
  { key: 'data', label: 'Import / export', hint: 'Move everything to or from a file' }
]

// ---- chip colors ------------------------------------------------------------

interface Chip {
  base: string
  bg: string
  fg: string
  dbg: string
  dfg: string
}

const isHex = (h: unknown): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h)
const hexRgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const rgbHex = (c: number[]): string =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()
const mix = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t)
function lum(c: number[]): number {
  const l = c.map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
function contrast(a: number[], b: number[]): number {
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** any picked color as a readable chip: a light tint with dark text, and a dark version for dark themes */
function deriveChip(hex: string): Omit<Chip, 'base'> {
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

function chipColors(s: StatusDef | { color: string } | undefined): Chip {
  if (s && isHex(s.color)) return { base: s.color.toUpperCase(), ...deriveChip(s.color) }
  const tn = TONES[(s && 'tone' in s && s.tone) || 'dev'] ?? TONES.dev
  return { base: tn.fg, ...tn }
}

const chipVars = (c: Chip): React.CSSProperties =>
  ({ '--c-bg': c.bg, '--c-fg': c.fg, '--c-dbg': c.dbg, '--c-dfg': c.dfg }) as React.CSSProperties

const holdFlag = (s: StatusDef | undefined): boolean =>
  !!s && (typeof s.hold === 'boolean' ? s.hold : s.tone === 'hold')

// ---- items ------------------------------------------------------------------

const statusDef = (d: StatusUpdateData, name: string | undefined): StatusDef | undefined =>
  d.statuses.find((x) => x.name === name)
const isHold = (d: StatusUpdateData, it: StatusItem): boolean =>
  it.section === 'progress' && holdFlag(statusDef(d, it.status))
/** in progress, with the same note that went out last month */
const isStale = (it: StatusItem): boolean =>
  it.section === 'progress' &&
  typeof it.lastSentNote === 'string' &&
  (it.note || '').trim() === it.lastSentNote.trim()
const isUrl = (u: string | undefined): boolean => /^https?:\/\/\S+$/i.test(String(u || '').trim())

function areaRank(a: string): number {
  const i = AREAS.indexOf(a)
  return i === -1 ? (a ? 50 : 99) : i
}

function sectionItems(items: StatusItem[], key: StatusSection): StatusItem[] {
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

function groupByArea(list: StatusItem[]): { area: string; items: StatusItem[] }[] {
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

function countsOf(d: StatusUpdateData): { completed: number; progress: number; hold: number; fresh: number } {
  const prog = d.items.filter((i) => i.section === 'progress')
  return {
    completed: d.items.filter((i) => i.section === 'completed').length,
    progress: prog.filter((i) => !isHold(d, i)).length,
    hold: prog.filter((i) => isHold(d, i)).length,
    fresh: d.items.filter((i) => i.section === 'new').length
  }
}

const isHidden = (d: StatusUpdateData, key: StatusSection): boolean => d.meta.hidden.includes(key)

/** one thing to fix before sending, and the field that fixes it */
interface Check {
  text: string
  focus: string
  panel?: PanelKey
  /** the item it's about, so its section can open */
  item?: string
  section?: StatusSection
}

function checksOf(d: StatusUpdateData): Check[] {
  const out: Check[] = []
  if (!d.meta.month.trim()) out.push({ text: 'The month and year is blank', focus: 'su-m-month', panel: 'meta' })
  for (const sec of SECTIONS) {
    if (isHidden(d, sec.key)) continue
    for (const it of sectionItems(d.items, sec.key)) {
      const nm = it.name.trim()
      const at = { item: it.id, section: sec.key }
      if (!nm) {
        out.push({ text: `An item in ${sec.label} has no name`, focus: `su-${it.id}-name`, ...at })
        continue
      }
      if (!it.note.trim())
        out.push({ text: `${nm}: ${sec.noteLabel.toLowerCase()} is empty`, focus: `su-${it.id}-note`, ...at })
      if (sec.key === 'completed' && it.launched) {
        if (!(it.link || '').trim())
          out.push({ text: `${nm}: new dashboard has no link (shows Link coming soon)`, focus: `su-${it.id}-link`, ...at })
        else if (!isUrl(it.link))
          out.push({ text: `${nm}: dashboard link doesn’t look like a web address`, focus: `su-${it.id}-link`, ...at })
      }
      if (isStale(it)) out.push({ text: `${nm}: notes unchanged since last month`, focus: `su-${it.id}-note`, ...at })
    }
  }
  const m = d.meta
  if (m.spotOn) {
    if (!m.spotTitle.trim()) out.push({ text: 'Spotlight is on but has no title', focus: 'su-m-spotTitle', panel: 'spot' })
    if (!m.spotBody.trim()) out.push({ text: 'Spotlight is on but has no text', focus: 'su-m-spotBody', panel: 'spot' })
    if (m.spotLink.trim() && !isUrl(m.spotLink))
      out.push({ text: 'Spotlight link doesn’t look like a web address', focus: 'su-m-spotLink', panel: 'spot' })
  }
  return out
}

function nextMonthLabel(cur: string): string {
  const m = cur.match(/([A-Za-z]+)[^0-9]*([0-9]{4})/)
  if (!m) return ''
  const i = MONTHS.findIndex((x) => x.toLowerCase().slice(0, 3) === m[1].toLowerCase().slice(0, 3))
  if (i < 0) return ''
  return i === 11 ? `January ${Number(m[2]) + 1}` : `${MONTHS[i + 1]} ${m[2]}`
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'issue'

const newId = (): string => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// ---- the email --------------------------------------------------------------
// Outlook strips text-transform, white-space and px sizes from pasted divs, so
// every text run carries its own font tag and inline span in pt units,
// uppercase is literal, and colored blocks use bgcolor on table cells.

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const SANS = 'Arial,Helvetica,sans-serif'
const SERIF = 'Georgia,serif'

interface TextOpts {
  size: string
  color: string
  bold?: boolean
  serif?: boolean
  spacing?: string
  lh?: string
  /** extra attributes on the text's span (the preview's edit markers) */
  attrs?: string
}

function t(text: string, o: TextOpts): string {
  const fam = o.serif ? SERIF : SANS
  const face = o.serif ? 'Georgia' : 'Arial'
  const style = `font-family:${fam};font-size:${o.size};color:${o.color};${o.bold ? 'font-weight:bold;' : 'font-weight:normal;'}${o.spacing ? `letter-spacing:${o.spacing};` : ''}line-height:${o.lh || '1.4'};`
  const inner = o.bold ? `<b>${text}</b>` : text
  return `<font face="${face}" color="${o.color}"><span style="${style}"${o.attrs ?? ''}>${inner}</span></font>`
}

/**
 * Text that can be edited in place in the preview: "item:<id>:name",
 * "meta:intro", …. Only the preview carries these; the copied email never does.
 */
const editAttr = (ed: boolean, key: string): string =>
  ed ? ` data-su-edit="${esc(key)}" contenteditable="plaintext-only"` : ''
const rowAttr = (ed: boolean, id: string): string => (ed ? ` data-su-row="${esc(id)}"` : '')

const br = (s: string | undefined): string => esc(s).replace(/\n/g, '<br>')
const up = (s: string | undefined): string => esc(String(s || '').toUpperCase())
const CELL = 'padding:9px 10px;border-bottom:1px solid #E6DCCB;'
const tableOpen = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`
const th = (text: string, attrs = ''): string =>
  `<td ${attrs} bgcolor="#4A4A4A" style="background-color:#4A4A4A;padding:8px 10px;">${t(text, { size: '9pt', color: '#FFFFFF', bold: true })}</td>`
const chip = (text: string, bg: string, fg: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td nowrap bgcolor="${bg}" style="background-color:${bg};padding:3px 8px;">${t(text, { size: '8pt', color: fg, bold: true, spacing: '0.5px', lh: '1.2' })}</td></tr></table>`
const subLabel = (text: string, top: number): string =>
  `<tr><td style="padding:${top}px 32px 6px 32px;">${t(up(text), { size: '9pt', color: '#88431E', bold: true, spacing: '1px' })}</td></tr>`
const reqLine = (it: StatusItem): string =>
  (it.requestedBy || '').trim()
    ? '<br>' + t('Requested by ' + esc(it.requestedBy!.trim()), { size: '8.5pt', color: '#75787B' })
    : ''
const btnLink = (href: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td nowrap bgcolor="#57150B" style="background-color:#57150B;padding:6px 12px;"><a href="${esc(href)}" style="color:#FFFFFF;text-decoration:none;">${t(label, { size: '9pt', color: '#FFFFFF', bold: true, lh: '1.2' })}</a></td></tr></table>`

const spotOn = (d: StatusUpdateData): boolean =>
  d.meta.spotOn && !!(d.meta.spotTitle.trim() || d.meta.spotBody.trim() || d.spotImg)

function spotImgHtml(d: StatusUpdateData, link: string): string {
  const im = d.spotImg
  if (!im?.data) return ''
  const w = Math.min(575, im.w || 575)
  const h = Math.round(((im.h || 300) * w) / (im.w || 575))
  const tag = `<img src="${im.data}" width="${w}" height="${h}" alt="${esc(d.meta.spotTitle.trim() || 'Spotlight')}" border="0" style="display:block;width:${w}px;max-width:100%;height:auto;border:0;">`
  const inner = isUrl(link) ? `<a href="${esc(link)}">${tag}</a>` : tag
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:10px 0 10px 0;">${inner}</td></tr></table>`
}

function spotlightHtml(d: StatusUpdateData, ed: boolean): string {
  if (!spotOn(d)) return ''
  const m = d.meta
  const link = m.spotLink.trim()
  return `<tr><td style="padding:20px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="5" bgcolor="#57150B" style="background-color:#57150B;width:5px;">&nbsp;</td>
<td valign="top" bgcolor="#FFF6D6" style="background-color:#FFF6D6;padding:16px 18px;">${t('SPOTLIGHT', { size: '8.5pt', color: '#88431E', bold: true, spacing: '1px' })}${m.spotTitle.trim() ? '<br>' + t(esc(m.spotTitle.trim()), { size: '13pt', color: '#57150B', bold: true, serif: true, lh: '1.3', attrs: editAttr(ed, 'meta:spotTitle') }) : ''}${spotImgHtml(d, link)}${m.spotBody.trim() ? (d.spotImg ? '' : '<br>') + t(br(m.spotBody.trim()), { size: '10pt', color: '#2B2B2B', lh: '1.5', attrs: editAttr(ed, 'meta:spotBody') }) : ''}${isUrl(link) ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-top:10px;">${btnLink(link, 'Take&nbsp;a&nbsp;look')}</td></tr></table>` : ''}</td>
</tr></table></td></tr>`
}

function emailRows(d: StatusUpdateData, list: StatusItem[], isProg: boolean, ed: boolean): string {
  const cols = isProg ? 3 : 2
  const groups = groupByArea(list)
  const showHeads = groups.some((g) => g.area)
  let rows = ''
  for (const g of groups) {
    if (showHeads)
      rows += `<tr><td colspan="${cols}" bgcolor="#F0E1BE" style="background-color:#F0E1BE;padding:6px 10px;">${t(up(g.area || 'Other'), { size: '9pt', color: '#57150B', bold: true, spacing: '0.5px' })}</td></tr>`
    for (const it of g.items) {
      const hold = isHold(d, it)
      const st = chipColors(statusDef(d, it.status))
      rows += `<tr${rowAttr(ed, it.id)}>
<td valign="top" style="${CELL}">${t(esc(it.name), { size: '10pt', color: hold ? '#75787B' : '#2B2B2B', bold: true, attrs: editAttr(ed, `item:${it.id}:name`) })}${reqLine(it)}</td>
${isProg ? `<td valign="top" style="${CELL}">${chip(up(it.status || 'In Development').replace(/ /g, '&nbsp;'), st.bg, st.fg)}${(it.target || '').trim() ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-top:5px;">${t('Target: ' + esc(it.target!.trim()), { size: '8.5pt', color: '#57150B' })}</td></tr></table>` : ''}</td>` : ''}
<td valign="top" style="${CELL}">${t(br(it.note), { size: '10pt', color: hold ? '#5A5C5E' : '#2B2B2B', attrs: editAttr(ed, `item:${it.id}:note`) })}</td>
</tr>`
    }
  }
  return rows
}

function launchedTable(list: StatusItem[], ed: boolean): string {
  let rows = ''
  for (const it of list) {
    const link = isUrl(it.link)
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr><td nowrap bgcolor="#57150B" style="background-color:#57150B;padding:6px 12px;"><a href="${esc(it.link!.trim())}" style="color:#FFFFFF;text-decoration:none;">${t('Open&nbsp;dashboard', { size: '9pt', color: '#FFFFFF', bold: true, lh: '1.2' })}</a></td></tr></table>`
      : t('Link&nbsp;coming&nbsp;soon', { size: '9pt', color: '#75787B' })
    rows += `<tr${rowAttr(ed, it.id)}>
<td valign="top" style="${CELL}">${t(esc(it.name), { size: '10pt', color: '#2B2B2B', bold: true, attrs: editAttr(ed, `item:${it.id}:name`) })}${it.area ? '<br>' + t(esc(it.area), { size: '8.5pt', color: '#75787B' }) : ''}${reqLine(it)}</td>
<td valign="top" style="${CELL}">${t(br(it.note), { size: '10pt', color: '#2B2B2B', attrs: editAttr(ed, `item:${it.id}:note`) })}</td>
<td valign="top" align="right" nowrap style="${CELL}">${link}</td>
</tr>`
  }
  return `<tr><td style="padding:4px 32px 0 32px;">${tableOpen}
<tr>${th('Dashboard', 'width="30%"')}${th('What it covers')}${th('Link', 'width="150" align="right"')}</tr>${rows}</table></td></tr>`
}

function emailSection(d: StatusUpdateData, sec: Sec, symbol: string, ed: boolean): string {
  const list = sectionItems(d.items, sec.key).filter((i) => i.name.trim() || i.note.trim())
  if (!list.length) return ''
  const isProg = sec.key === 'progress'
  const title = `<tr><td style="padding:28px 32px 8px 32px;">${tableOpen}<tr><td bgcolor="#57150B" style="background-color:#57150B;border-bottom:4px solid #FFCC00;padding:9px 12px;"><h2 style="margin:0;padding:0;font-size:15pt;line-height:1.2;">${t(symbol + '&nbsp; ' + up(sec.label), { size: '15pt', color: '#FFFFFF', bold: true, serif: true, spacing: '0.5px', lh: '1.2' })}</h2></td></tr></table>${sec.key === 'new' ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-top:6px;">${t('Currently in requirements gathering', { size: '9pt', color: '#75787B' })}</td></tr></table>` : ''}</td></tr>`
  const head = isProg
    ? th('Dashboard / Project', 'width="28%"') + th('Status', 'width="24%"') + th(sec.noteLabel)
    : th('Dashboard / Project', 'width="34%"') + th(sec.noteLabel)
  const table = (l: StatusItem[]): string => `<tr><td style="padding:4px 32px 0 32px;">${tableOpen}
<tr>${head}</tr>${emailRows(d, l, isProg, ed)}</table></td></tr>`
  if (sec.key !== 'completed') return title + table(list)
  const launched = list.filter((i) => i.launched)
  const rest = list.filter((i) => !i.launched)
  if (!launched.length) return title + table(rest)
  return (
    title +
    subLabel('New Dashboards', 6) +
    launchedTable(launched, ed) +
    (rest.length ? subLabel('Updates and Enhancements', 22) + table(rest) : '')
  )
}

/** "Thursdays, Room 105, 11:00 AM to 12:00 PM": day and room on one line, the time range on the next, kept unbroken */
function ohFmt(line: string): string {
  const raw = line.trim()
  const keep = (x: string): string => esc(x).replace(/ /g, '&nbsp;')
  const m = raw.match(/^(.*),\s*([0-9].*)$/)
  return m ? esc(m[1]) + '<br>' + keep(m[2]) : esc(raw).replace(/([0-9]) (AM|PM)/gi, '$1&nbsp;$2')
}

/** the email as it is copied; ed adds the preview's edit-in-place markers */
function buildEmail(d: StatusUpdateData, ed = false): string {
  const m = d.meta
  const s = countsOf(d)
  const tileDefs: [number, string, string, string, string][] = []
  if (!isHidden(d, 'completed')) tileDefs.push([s.completed, 'Completed', '#57150B', '#FFCC00', '#FFFFFF'])
  if (!isHidden(d, 'progress'))
    tileDefs.push(
      [s.progress, 'In Progress', '#88431E', '#FFFFFF', '#FFFFFF'],
      [s.hold, 'On Hold', '#75787B', '#FFFFFF', '#FFFFFF']
    )
  if (!isHidden(d, 'new')) tileDefs.push([s.fresh, 'New Requests', '#FFCC00', '#57150B', '#57150B'])
  const tw = tileDefs.length ? Math.floor(100 / tileDefs.length) : 100
  const tile = (n: number, label: string, bg: string, numColor: string, labColor: string, last: boolean): string =>
    `<td width="${tw}%" align="center" valign="middle" bgcolor="${bg}" style="background-color:${bg};padding:14px 4px;${last ? '' : 'border-right:4px solid #FFFFFF;'}"><h2 style="margin:0;padding:0;font-size:22pt;line-height:1.1;">${t(String(n), { size: '22pt', color: numColor, bold: true, serif: true, lh: '1.1' })}</h2>${t(up(label), { size: '8pt', color: labColor, bold: true, spacing: '1px' })}</td>`
  const tilesHtml = tileDefs.map((x, i) => tile(...x, i === tileDefs.length - 1)).join('\n')
  const mailbox = esc(m.mailbox)
  const band = (pad: string, inner: string): string =>
    `<tr><td bgcolor="#57150B" style="background-color:#57150B;padding:${pad};">${inner}</td></tr>`
  return `<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#FFFFFF" style="width:680px;max-width:680px;background-color:#FFFFFF;border:1px solid #E2D6BF;margin:0 auto;">
<tr><td bgcolor="#FFCC00" height="6" style="background-color:#FFCC00;height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>
${band('24px 32px 2px 32px', t('ROWAN ONLINE OPERATIONAL EFFECTIVENESS TEAM', { size: '9pt', color: '#FFCC00', bold: true, spacing: '1.5px' }))}
${band('4px 32px 22px 32px', `<h1 style="margin:0;padding:0;font-size:21pt;line-height:1.2;">${t(`<span${editAttr(ed, 'meta:month')}>${esc(m.month)}</span> Status Update`, { size: '21pt', color: '#FFFFFF', bold: true, serif: true, lh: '1.2' })}</h1>`)}
${m.intro ? `<tr><td style="padding:24px 32px 8px 32px;">${t(br(m.intro), { size: '10.5pt', color: '#2B2B2B', lh: '1.5', attrs: editAttr(ed, 'meta:intro') })}</td></tr>` : ''}
${
  tileDefs.length
    ? `<tr><td style="padding:12px 32px 8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${tilesHtml}
</tr></table></td></tr>`
    : ''
}
${spotlightHtml(d, ed)}
${isHidden(d, 'completed') ? '' : emailSection(d, SECTIONS[0], '&#10003;', ed)}
${isHidden(d, 'progress') ? '' : emailSection(d, SECTIONS[1], '&#9658;', ed)}
${isHidden(d, 'new') ? '' : emailSection(d, SECTIONS[2], '&#9733;', ed)}
<tr><td style="padding:32px 32px 28px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="5" bgcolor="#FFCC00" style="background-color:#FFCC00;width:5px;">&nbsp;</td>
<td width="50%" valign="top" bgcolor="#FBF6EC" style="background-color:#FBF6EC;padding:16px 18px;">${t('Submit a Request', { size: '10.5pt', color: '#57150B', bold: true })}<br>${t(`Send all dashboard and reporting requests to <a href="mailto:${mailbox}" style="color:#57150B;"><b>${mailbox}</b></a>, including dashboard updates, discrepancies or issues, and one-time or recurring reports. This keeps requests captured, prioritized, and assigned.`, { size: '10pt', color: '#2B2B2B' })}</td>
<td width="50%" valign="top" bgcolor="#FBF6EC" style="background-color:#FBF6EC;padding:16px 18px;">${t('Weekly Office Hours', { size: '10.5pt', color: '#57150B', bold: true })}<br>${t(ohFmt(m.oh1) + (m.oh2 ? '<br><br>' + ohFmt(m.oh2) : ''), { size: '10pt', color: '#2B2B2B' })}</td>
</tr></table></td></tr>
${band('12px 32px', t('Rowan Online Operational Effectiveness Team &nbsp;|&nbsp; Monthly updates are sent the last Wednesday of every month.', { size: '8.5pt', color: '#F0E1BE' }))}
</table>`
}

function buildPlain(d: StatusUpdateData): string {
  const m = d.meta
  const lines = [`${m.month} Status Update`, '', m.intro, '']
  if (spotOn(d)) {
    lines.push(
      'SPOTLIGHT: ' + m.spotTitle.trim(),
      m.spotBody.trim() + (isUrl(m.spotLink) ? ' ' + m.spotLink.trim() : ''),
      ''
    )
  }
  for (const sec of SECTIONS) {
    if (isHidden(d, sec.key)) continue
    const list = sectionItems(d.items, sec.key)
    if (!list.length) continue
    lines.push(sec.label.toUpperCase())
    for (const g of groupByArea(list)) {
      if (g.area) lines.push('  ' + g.area)
      for (const it of g.items) {
        const prog = sec.key === 'progress'
        lines.push(
          `    - ${it.name}${prog ? ` [${it.status || ''}]` : ''}${it.launched ? ' (new dashboard)' : ''}: ${it.note}` +
            (it.launched && isUrl(it.link) ? ' ' + it.link!.trim() : '') +
            ((it.target || '').trim() && prog ? ` (Target: ${it.target!.trim()})` : '') +
            ((it.requestedBy || '').trim() ? ` (Requested by ${it.requestedBy!.trim()})` : '')
        )
      }
    }
    lines.push('')
  }
  lines.push(`Requests: ${m.mailbox}`, `Office hours: ${m.oh1}; ${m.oh2}`)
  return lines.join('\n')
}

// ---- spotlight image ----------------------------------------------------------

/**
 * A screenshot squeezed to a JPEG small enough to paste into Outlook. The
 * file is read as a data: URL because the page's CSP doesn't allow blob: images.
 */
async function shrinkImage(file: File): Promise<StatusImage> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('unreadable'))
    r.readAsDataURL(file)
  })
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let w = Math.min(img.naturalWidth || 1150, 1150)
      let q = 0.85
      let data = ''
      let h = 0
      for (let i = 0; i < 7; i++) {
        h = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const x = c.getContext('2d')!
        x.fillStyle = '#FFFFFF'
        x.fillRect(0, 0, w, h)
        x.drawImage(img, 0, 0, w, h)
        data = c.toDataURL('image/jpeg', q)
        if (data.length < 170000) break
        w = Math.round(w * 0.82)
        q = Math.max(0.6, q - 0.06)
      }
      resolve({ data, w, h })
    }
    img.onerror = () => reject(new Error('unreadable'))
    img.src = url
  })
}

// ---- the view -------------------------------------------------------------------

export function StatusUpdate({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [data, setData] = useState<StatusUpdateData | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [pane, setPane] = useState<'edit' | 'preview'>(() =>
    localStorage.getItem('statusUpdatePane') === 'preview' ? 'preview' : 'edit'
  )
  const [narrow, setNarrow] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [rollMonth, setRollMonth] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#88431E')
  const [confirmEl, confirm] = useConfirm()
  // a render with nothing changed, so a pending focus lands once the field is on screen
  const [, setTick] = useState(0)
  const rerender = (): void => setTick((n) => n + 1)
  const rootRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<StatusUpdateData | null>(null)
  const dirty = useRef(new Set<keyof StatusUpdateData>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusAfter = useRef<{ id: string; select?: boolean; scrollOnly?: boolean } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  /** the value a preview field had when editing started, for Escape */
  const editStart = useRef<{ key: string; value: string } | null>(null)
  // the one settings panel open under the pills, if any
  const [panel, setPanel] = useState<PanelKey | null>(null)
  const [collapsed, setCollapsed] = useState<Set<StatusSection>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('statusUpdateCollapsed') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  // items with their details (area, section, requested by, …) showing
  const [openItems, setOpenItems] = useState<Set<string>>(new Set())
  // the item being worked on, in the editor or the preview, lit up in the other
  const [active, setActive] = useState<{ id: string; from: 'editor' | 'preview' } | null>(null)
  // the preview as it was when editing in it started; it holds still while you type
  const [frozen, setFrozen] = useState<string | null>(null)
  const [checksAll, setChecksAll] = useState(false)

  /** send what changed since the last save */
  function flush(): Promise<void> {
    clearTimeout(saveTimer.current)
    const d = dataRef.current
    if (!d || !dirty.current.size) return Promise.resolve()
    const patch: Partial<StatusUpdateData> = {}
    for (const k of dirty.current) (patch as Record<string, unknown>)[k] = d[k]
    dirty.current.clear()
    setSaving('saving')
    return window.scribe.statusUpdate.save(patch).then(
      () => setSaving('saved'),
      () => {
        // keep them queued, so the next change tries again
        for (const k of Object.keys(patch) as (keyof StatusUpdateData)[]) dirty.current.add(k)
        setSaving('error')
        setToast('A change didn’t save. Try again in a moment.')
      }
    )
  }

  useEffect(() => {
    window.scribe.statusUpdate.get().then((d) => {
      dataRef.current = d
      setData(d)
    })
    const onHide = (): void => void flush()
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('beforeunload', onHide)
      void flush()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  // editor and preview sit side by side when there's room, as tabs when not
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 1180))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const f = focusAfter.current
    if (!f) return
    focusAfter.current = null
    const el = document.getElementById(f.id)
    if (!el) return
    if (f.scrollOnly) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
    if (f.select && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select()
  })

  const html = useMemo(() => (data ? buildEmail(data, true) : ''), [data])
  const checks = useMemo(() => (data ? checksOf(data) : []), [data])
  // React replaces the inner HTML whenever this object is new, which would
  // drop the cursor mid-edit, so it changes only when the markup does
  const shownHtml = frozen ?? html
  const previewHtml = useMemo(() => ({ __html: shownHtml }), [shownHtml])

  // the item being worked on in the editor stays in view in the preview
  useEffect(() => {
    if (active?.from !== 'editor') return
    previewRef.current
      ?.querySelector(`[data-su-row="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, html])

  // and edited in the preview: its card in the editor comes into view
  useEffect(() => {
    if (active?.from !== 'preview') return
    document.getElementById(`su-row-${active.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active])

  // ---- changes ----

  const cur = (): StatusUpdateData => dataRef.current!

  function change(patch: Partial<StatusUpdateData>, delay = 600): void {
    if (!dataRef.current) return
    const next = { ...dataRef.current, ...patch }
    dataRef.current = next
    setData(next)
    for (const k of Object.keys(patch) as (keyof StatusUpdateData)[]) dirty.current.add(k)
    clearTimeout(saveTimer.current)
    if (delay === 0) void flush()
    else saveTimer.current = setTimeout(flush, delay)
  }

  const setMeta = (p: Partial<StatusMeta>, delay?: number): void => change({ meta: { ...cur().meta, ...p } }, delay)

  function patchItems(patches: Record<string, Partial<StatusItem>>, delay?: number): void {
    change({ items: cur().items.map((i) => (patches[i.id] ? { ...i, ...patches[i.id] } : i)) }, delay)
  }
  const patchItem = (id: string, p: Partial<StatusItem>, delay?: number): void => patchItems({ [id]: p }, delay)

  const firstStatus = (): string => cur().statuses[0]?.name ?? 'In Development'
  const maxOrder = (pred: (i: StatusItem) => boolean): number =>
    cur().items.filter(pred).reduce((m, i) => Math.max(m, i.order), 0)

  /** a second click within a few seconds confirms */
  function confirmed(key: string): boolean {
    clearTimeout(armTimer.current)
    if (armed === key) {
      setArmed(null)
      return true
    }
    setArmed(key)
    armTimer.current = setTimeout(() => setArmed(null), 3500)
    return false
  }

  function setCollapse(key: StatusSection, shut: boolean): void {
    setCollapsed((prev) => {
      if (prev.has(key) === shut) return prev
      const next = new Set(prev)
      if (shut) next.add(key)
      else next.delete(key)
      localStorage.setItem('statusUpdateCollapsed', JSON.stringify([...next]))
      return next
    })
  }

  function toggleItem(id: string, open?: boolean): void {
    setOpenItems((prev) => {
      const show = open ?? !prev.has(id)
      if (prev.has(id) === show) return prev
      const next = new Set(prev)
      if (show) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** open the item's section, so a field in it can take focus */
  function reveal(id: string): void {
    const it = cur().items.find((i) => i.id === id)
    if (it) setCollapse(it.section, false)
  }

  function jumpTo(key: StatusSection): void {
    setCollapse(key, false)
    changePane('edit')
    focusAfter.current = { id: `su-sec-${key}`, scrollOnly: true }
    rerender()
  }

  function changePane(p: 'edit' | 'preview'): void {
    setPane(p)
    localStorage.setItem('statusUpdatePane', p)
  }

  function addItem(section: StatusSection): void {
    const id = newId()
    const it: StatusItem = {
      id,
      section,
      area: section === 'new' ? '' : 'Rowan Online',
      name: '',
      note: '',
      order: maxOrder((i) => i.section === section) + 10
    }
    if (section === 'progress') it.status = firstStatus()
    setCollapse(section, false)
    toggleItem(id, true)
    focusAfter.current = { id: `su-${id}-name` }
    change({ items: [...cur().items, it] }, 0)
  }

  function moveItem(id: string, dir: -1 | 1): void {
    const it = cur().items.find((i) => i.id === id)
    if (!it) return
    const group = sectionItems(cur().items, it.section).filter(
      (i) => i.area === it.area && !!i.launched === !!it.launched
    )
    const idx = group.findIndex((i) => i.id === id)
    const other = group[idx + dir]
    if (!other) return
    const patches: Record<string, Partial<StatusItem>> = {}
    let a = it.order
    let b = other.order
    if (a === b) {
      group.forEach((g, n) => (patches[g.id] = { order: (n + 1) * 10 }))
      a = (idx + 1) * 10
      b = (idx + dir + 1) * 10
    }
    patches[it.id] = { order: b }
    patches[other.id] = { order: a }
    focusAfter.current = { id: `su-${id}-${dir < 0 ? 'up' : 'down'}` }
    patchItems(patches, 0)
  }

  function changeSection(id: string, section: StatusSection): void {
    const it = cur().items.find((i) => i.id === id)
    if (!it) return
    const p: Partial<StatusItem> = { section, order: maxOrder((i) => i.section === section) + 10 }
    if (section === 'progress' && !it.status) p.status = firstStatus()
    setCollapse(section, false)
    patchItem(id, p, 0)
    setToast(`Moved to ${secOf(section).label}.`)
  }

  function changeArea(id: string, area: string): void {
    const it = cur().items.find((i) => i.id === id)
    if (!it) return
    const order =
      maxOrder((i) => i.section === it.section && !!i.launched === !!it.launched && i.area === area) + 10
    patchItem(id, { area, order }, 0)
  }

  function setLaunched(id: string, launched: boolean): void {
    const it = cur().items.find((i) => i.id === id)
    if (!it) return
    const order =
      maxOrder((i) => i.section === 'completed' && !!i.launched === launched && i.area === it.area) + 10
    if (launched) focusAfter.current = { id: `su-${id}-link` }
    patchItem(id, { launched, order }, 0)
  }

  function markDone(id: string): void {
    const it = cur().items.find((i) => i.id === id)
    if (!it) return
    const order = maxOrder((i) => i.section === 'completed' && !i.launched && i.area === it.area) + 10
    setCollapse('completed', false)
    focusAfter.current = { id: `su-${id}-note`, select: true }
    patchItem(id, { section: 'completed', launched: false, order }, 0)
    setToast('Moved to Completed. Update the note with what was finished.')
  }

  function deleteItem(id: string): void {
    if (!confirmed('item:' + id)) return
    const name = cur().items.find((i) => i.id === id)?.name.trim() || 'Item'
    change({ items: cur().items.filter((i) => i.id !== id) }, 0)
    setToast(`Deleted ${name}.`)
  }

  function toggleHidden(key: StatusSection): void {
    const hid = isHidden(cur(), key)
    setMeta({ hidden: hid ? cur().meta.hidden.filter((k) => k !== key) : [...cur().meta.hidden, key] }, 0)
    const label = secOf(key).label
    setToast(hid ? `${label} is back in the email.` : `${label} is hidden from the email. Its items are kept.`)
  }

  function setItemStatus(id: string, value: string): void {
    if (value === '__new__') {
      setPanel('statuses')
      focusAfter.current = { id: 'su-st-new' }
      rerender()
      return
    }
    patchItem(id, { status: value }, 0)
  }

  // ---- statuses ----

  const usage = (name: string): number =>
    cur().items.filter((i) => i.section === 'progress' && i.status === name).length
  const dupName = (name: string, except: number): boolean =>
    cur().statuses.some((s, i) => i !== except && s.name.toLowerCase() === name.toLowerCase())

  function setStatus(n: number, p: Partial<StatusDef>, delay?: number): void {
    change({ statuses: cur().statuses.map((s, i) => (i === n ? { ...s, ...p } : s)) }, delay)
  }

  function renameStatus(n: number, input: HTMLInputElement): void {
    const st = cur().statuses[n]
    const name = input.value.trim()
    if (!st || !name || name === st.name) {
      if (st) input.value = st.name
      return
    }
    if (name === '__new__' || dupName(name, n)) {
      setToast(`${name} already exists.`)
      input.value = st.name
      return
    }
    change(
      {
        statuses: cur().statuses.map((s, i) => (i === n ? { ...s, name } : s)),
        items: cur().items.map((i) => (i.section === 'progress' && i.status === st.name ? { ...i, status: name } : i))
      },
      0
    )
    setToast(`Renamed ${st.name} to ${name}.`)
  }

  function removeStatus(n: number): void {
    const st = cur().statuses[n]
    if (!st || usage(st.name)) return
    if (cur().statuses.length <= 1) {
      setToast('Keep at least one status.')
      return
    }
    change({ statuses: cur().statuses.filter((_, i) => i !== n) }, 0)
    setToast(`Removed status ${st.name}.`)
  }

  function addStatus(): void {
    const name = newName.trim()
    if (!name) {
      setToast('Type a status name first.')
      document.getElementById('su-st-new')?.focus()
      return
    }
    if (name === '__new__' || dupName(name, -1)) {
      setToast(`${name} already exists.`)
      return
    }
    const color = isHex(newColor) ? newColor.toUpperCase() : '#88431E'
    change({ statuses: [...cur().statuses, { name, tone: 'dev', color, hold: false }] }, 0)
    setNewName('')
    setToast(`Added status ${name}.`)
  }

  // ---- spotlight image ----

  async function pickImage(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!/^image\//.test(f.type)) {
      setToast('That file isn’t an image. Use a PNG or JPG.')
      return
    }
    try {
      change({ spotImg: await shrinkImage(f) }, 0)
      setToast('Image added to the spotlight.')
    } catch {
      setToast('Couldn’t read that image. Try a PNG or JPG.')
    }
  }

  // ---- copy, months, import ----

  async function copy(emailHtml: string, plain: string, done: string): Promise<void> {
    try {
      await window.scribe.clipboard.writeRich(emailHtml, plain)
      setToast(done)
    } catch {
      setToast('Couldn’t reach the clipboard. Try again in a moment.')
    }
  }

  function copyCurrent(): void {
    void flush()
    const n = checks.length
    void copy(
      buildEmail(cur()),
      buildPlain(cur()),
      (n ? `Copied, with ${n} item${n === 1 ? '' : 's'} still flagged. ` : 'Copied. ') +
        'In Outlook, paste and choose Keep source formatting.'
    )
  }

  function openRollover(): void {
    setRollMonth(nextMonthLabel(cur().meta.month.trim()))
    setViewing(null)
    changePane('edit')
    focusAfter.current = { id: 'su-ro-month', select: true }
  }

  function startNextMonth(): void {
    const next = (rollMonth ?? '').trim()
    if (!next) {
      setToast('Type the new month first, like November 2026.')
      document.getElementById('su-ro-month')?.focus()
      return
    }
    const d = cur()
    const month = d.meta.month.trim() || 'Untitled month'
    const id = slugify(month)
    const issue: StatusIssue = {
      id,
      month,
      html: buildEmail(d),
      plain: buildPlain(d),
      archivedAt: new Date().toISOString(),
      items: d.items.map((it) => {
        const o: NonNullable<StatusIssue['items']>[number] = {
          section: it.section,
          area: it.area,
          name: it.name,
          note: it.note
        }
        for (const k of ['status', 'launched', 'link', 'target', 'requestedBy'] as const) {
          if (it[k] !== undefined) (o as Record<string, unknown>)[k] = it[k]
        }
        return o
      })
    }
    change(
      {
        issues: [issue, ...d.issues.filter((x) => x.id !== id)],
        items: d.items.filter((i) => i.section !== 'completed').map((i) => ({ ...i, lastSentNote: i.note })),
        meta: { ...d.meta, month: next, spotOn: false }
      },
      0
    )
    setRollMonth(null)
    setToast(`Saved ${month} to Past issues. Now working on ${next}.`)
  }

  function deleteIssue(x: StatusIssue): void {
    if (!confirmed('issue:' + x.id)) return
    change({ issues: cur().issues.filter((i) => i.id !== x.id) }, 0)
    if (viewing === x.id) setViewing(null)
    setToast(`Deleted the saved ${x.month} issue.`)
  }

  async function importFile(): Promise<void> {
    const d = cur()
    if (d.items.length || d.issues.length) {
      const ok = await confirm({
        title: 'Replace what’s here?',
        body: 'Importing replaces the items, statuses, spotlight and past issues here with the ones in the file.',
        confirmLabel: 'Import',
        danger: true
      })
      if (!ok) return
    }
    await flush()
    const r = await window.scribe.statusUpdate.importFile()
    if (!r) return
    if (!r.ok) {
      setToast(r.error)
      return
    }
    dataRef.current = r.data
    setData(r.data)
    setViewing(null)
    setToast(`Imported ${r.data.items.length} item${r.data.items.length === 1 ? '' : 's'} for ${r.data.meta.month}.`)
  }

  async function exportFile(): Promise<void> {
    await flush()
    const r = await window.scribe.statusUpdate.exportFile()
    if (r) setToast(r.ok ? `Saved to ${r.path}.` : `Couldn’t save the file: ${r.error}`)
  }

  /** links in the preview open in the browser, not in the app */
  function previewClick(e: React.MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) window.open(href, '_blank')
  }

  // ---- editing in the preview ----
  // Names, notes, the month, the intro and the spotlight's title and text can
  // be edited right in the email. Each keystroke updates the editor too; the
  // preview holds still until you click away, so the cursor stays put.

  const editTarget = (e: React.SyntheticEvent): HTMLElement | null =>
    (e.target as HTMLElement).closest<HTMLElement>('[data-su-edit]')
  const singleLine = (key: string): boolean => /:(name|month|spotTitle)$/.test(key)

  function fieldValue(key: string): string {
    const [kind, a, b] = key.split(':')
    if (kind === 'item') {
      const it = cur().items.find((i) => i.id === a)
      return it ? String(it[b as 'name' | 'note'] ?? '') : ''
    }
    return String(cur().meta[a as 'month' | 'intro' | 'spotTitle' | 'spotBody'] ?? '')
  }

  function previewEdit(key: string, value: string): void {
    const [kind, a, b] = key.split(':')
    if (kind === 'item') patchItem(a, { [b]: value } as Partial<StatusItem>)
    else setMeta({ [a]: value } as Partial<StatusMeta>)
  }

  function previewFocus(e: React.FocusEvent): void {
    const el = editTarget(e)
    if (!el) return
    const key = el.dataset.suEdit!
    if (frozen === null) setFrozen(html)
    editStart.current = { key, value: fieldValue(key) }
    const [kind, id] = key.split(':')
    if (kind === 'item') {
      reveal(id)
      setActive({ id, from: 'preview' })
    }
  }

  function previewInput(e: React.FormEvent): void {
    const el = editTarget(e)
    if (!el) return
    const key = el.dataset.suEdit!
    let text = el.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '')
    if (singleLine(key)) text = text.replace(/\n/g, ' ')
    previewEdit(key, text)
  }

  function previewKey(e: React.KeyboardEvent): void {
    const el = editTarget(e)
    if (!el) return
    if (e.key === 'Escape' && editStart.current) {
      // put it back as it was
      el.innerText = editStart.current.value
      previewEdit(editStart.current.key, editStart.current.value)
      el.blur()
    } else if (e.key === 'Enter' && singleLine(el.dataset.suEdit!)) {
      e.preventDefault()
      el.blur()
    }
  }

  function previewBlur(): void {
    // moving straight to other text in the preview keeps it still
    setTimeout(() => {
      if (previewRef.current?.contains(document.activeElement)) return
      editStart.current = null
      setFrozen(null)
      setActive((a) => (a?.from === 'preview' ? null : a))
    }, 0)
  }

  // ---- render ----

  const month = data?.meta.month.trim() || 'Monthly'
  const toolbar = (
    <div className="cuc-toolbar tkr-toolbar">
      <button className="btn btn-ghost tkr-back" onClick={onBack}>
        ‹ My tickets
      </button>
      <h2 className="cuc-title">{month} status update</h2>
      {narrow && data && (
        <div className="mode-toggle view-toggle tkr-periods" role="radiogroup" aria-label="View">
          <button
            className={pane === 'edit' ? 'active' : ''}
            role="radio"
            aria-checked={pane === 'edit'}
            onClick={() => changePane('edit')}
          >
            Edit
          </button>
          <button
            className={pane === 'preview' ? 'active' : ''}
            role="radio"
            aria-checked={pane === 'preview'}
            onClick={() => changePane('preview')}
          >
            Email preview
          </button>
        </div>
      )}
      <span className="mailc-read-bar-gap" />
      <span className="su-saved" aria-live="polite">
        {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'All saved' : saving === 'error' ? 'Not saved' : ''}
      </span>
      {data && (
        <>
          <button className="btn btn-ghost" onClick={openRollover} title="Save this month under Past issues and start the next one">
            Start next month
          </button>
          <button className="btn btn-primary" onClick={copyCurrent} title="Copy the email, formatted, to paste into Outlook">
            Copy for Outlook
          </button>
        </>
      )}
    </div>
  )

  if (!data) {
    return (
      <div className="tkr su" ref={rootRef}>
        {toolbar}
        <p className="cuc-empty">Loading…</p>
      </div>
    )
  }

  const counts = countsOf(data)
  const issue = viewing ? data.issues.find((x) => x.id === viewing) : undefined
  const issues = [...data.issues].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
  const fresh = data.items.length === 0 && data.issues.length === 0

  const row = (it: StatusItem, sec: Sec, pos: number, len: number): React.JSX.Element => {
    const prog = sec.key === 'progress'
    const statusNames = data.statuses.map((s) => s.name)
    if (it.status && !statusNames.includes(it.status)) statusNames.push(it.status)
    const areas = it.area && !AREAS.includes(it.area) ? [...AREAS, it.area] : AREAS
    const delArmed = armed === 'item:' + it.id
    const open = openItems.has(it.id)
    const linked = active?.id === it.id && active.from === 'preview'
    const chipC = prog ? chipColors(statusDef(data, it.status)) : null
    const summary = [
      it.requestedBy?.trim() && `Requested by ${it.requestedBy.trim()}`,
      prog && it.target?.trim() && `Target ${it.target.trim()}`
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div
        key={it.id}
        id={`su-row-${it.id}`}
        className={`su-row ${prog ? 'has-chip' : ''} ${isHold(data, it) ? 'hold' : ''} ${open ? 'open' : ''} ${linked ? 'linked' : ''}`}
        style={chipC ? chipVars(chipC) : undefined}
        onFocus={() => {
          if (active?.id !== it.id || active.from !== 'editor') setActive({ id: it.id, from: 'editor' })
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setActive((a) => (a?.id === it.id && a.from === 'editor' ? null : a))
        }}
      >
        <div className="su-row-main">
          <input
            id={`su-${it.id}-name`}
            className="su-name"
            value={it.name}
            placeholder="Dashboard or project name"
            aria-label="Name"
            onChange={(e) => patchItem(it.id, { name: e.target.value })}
          />
          {isStale(it) && (
            <span className="su-stale" title="These notes match what went out last month">
              Not updated since last month
            </span>
          )}
          {prog && (
            <button className="su-done" onClick={() => markDone(it.id)} title="Move to Completed">
              Mark done
            </button>
          )}
          {prog && (
            <select
              id={`su-${it.id}-status`}
              className="su-status su-chip"
              value={it.status || firstStatus()}
              aria-label="Status"
              onChange={(e) => setItemStatus(it.id, e.target.value)}
            >
              {statusNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="__new__">+ New status…</option>
            </select>
          )}
          <button
            className="su-more"
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            title={open ? 'Hide details' : 'Details: area, section, requested by, move or delete'}
            onClick={() => toggleItem(it.id)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
        {sec.key === 'completed' && it.launched && (
          <div className="su-link-row">
            <span className="su-link-lbl">Link</span>
            <input
              id={`su-${it.id}-link`}
              className={`su-link ${it.link && !isUrl(it.link) ? 'bad' : ''}`}
              value={it.link ?? ''}
              placeholder="Paste the dashboard link (https://…)"
              aria-label="Dashboard link"
              inputMode="url"
              onChange={(e) => patchItem(it.id, { link: e.target.value })}
            />
          </div>
        )}
        <textarea
          id={`su-${it.id}-note`}
          className="su-note"
          rows={1}
          value={it.note}
          placeholder={sec.notePh}
          aria-label={sec.noteLabel}
          onChange={(e) => patchItem(it.id, { note: e.target.value })}
        />
        {!open && summary && (
          <button className="su-summary" onClick={() => toggleItem(it.id, true)}>
            {summary}
          </button>
        )}
        {open && (
          <div className="su-drawer">
            <div className="su-extra">
              <label>
                Requested by
                <input
                  className="su-mini"
                  value={it.requestedBy ?? ''}
                  placeholder="Optional"
                  onChange={(e) => patchItem(it.id, { requestedBy: e.target.value })}
                />
              </label>
              {prog && (
                <label>
                  Target
                  <input
                    className="su-mini"
                    value={it.target ?? ''}
                    placeholder="Optional, e.g. Dec 2026"
                    onChange={(e) => patchItem(it.id, { target: e.target.value })}
                  />
                </label>
              )}
            </div>
            <div className="su-tools">
              <label>
                Area
                <select className="cuc-select" value={it.area} onChange={(e) => changeArea(it.id, e.target.value)}>
                  <option value="">None</option>
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Section
                <select
                  className="cuc-select"
                  value={sec.key}
                  onChange={(e) => changeSection(it.id, e.target.value as StatusSection)}
                >
                  {SECTIONS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              {sec.key === 'completed' && (
                <label className="su-check-lbl">
                  <input
                    type="checkbox"
                    checked={!!it.launched}
                    onChange={(e) => setLaunched(it.id, e.target.checked)}
                  />
                  New dashboard
                </label>
              )}
              <span className="su-grow" />
              <button
                id={`su-${it.id}-up`}
                className="su-ic"
                onClick={() => moveItem(it.id, -1)}
                disabled={pos === 0}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                id={`su-${it.id}-down`}
                className="su-ic"
                onClick={() => moveItem(it.id, 1)}
                disabled={pos === len - 1}
                aria-label="Move down"
              >
                ↓
              </button>
              <button className={`su-del ${delArmed ? 'armed' : ''}`} onClick={() => deleteItem(it.id)}>
                {delArmed ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const groups = (sec: Sec, list: StatusItem[]): React.JSX.Element[] => {
    const gs = groupByArea(list)
    return gs.map((g) => (
      <div key={g.area || '-'} className="su-group">
        {(g.area || gs.length > 1) && <div className="su-area">{g.area || 'No area'}</div>}
        {g.items.map((it, n) => row(it, sec, n, g.items.length))}
      </div>
    ))
  }

  const sectionBody = (sec: Sec, list: StatusItem[]): React.JSX.Element | React.JSX.Element[] => {
    if (!list.length) return <p className="su-empty">Nothing here yet. Use Add item to start this section.</p>
    if (sec.key !== 'completed') return groups(sec, list)
    const launched = list.filter((i) => i.launched)
    const rest = list.filter((i) => !i.launched)
    return (
      <>
        <div className="su-sub">
          New dashboards <span className="su-count">{launched.length}</span>
        </div>
        {launched.length ? (
          groups(sec, launched)
        ) : (
          <p className="su-empty">
            No new dashboards yet. Tick “New dashboard” in a completed item’s details to list it here with a link.
          </p>
        )}
        <div className="su-sub">
          Updates and enhancements <span className="su-count">{rest.length}</span>
        </div>
        {rest.length ? groups(sec, rest) : <p className="su-empty">No updates listed.</p>}
      </>
    )
  }

  const metaInput = (
    key: 'month' | 'mailbox' | 'oh1' | 'oh2' | 'spotTitle' | 'spotLink',
    label: string,
    ph = ''
  ): React.JSX.Element => (
    <label className="su-lbl">
      {label}
      <input
        id={`su-m-${key}`}
        className="text-input"
        value={data.meta[key]}
        placeholder={ph}
        onChange={(e) => setMeta({ [key]: e.target.value } as Partial<StatusMeta>)}
      />
    </label>
  )

  const panelBody = (key: PanelKey): React.JSX.Element => {
    if (key === 'meta')
      return (
        <div className="su-grid">
          {metaInput('month', 'Month and year')}
          {metaInput('mailbox', 'Request mailbox')}
          <label className="su-lbl full">
            Intro line
            <textarea
              id="su-m-intro"
              className="text-input"
              rows={2}
              value={data.meta.intro}
              onChange={(e) => setMeta({ intro: e.target.value })}
            />
          </label>
          {metaInput('oh1', 'Office hours, first line')}
          {metaInput('oh2', 'Office hours, second line')}
        </div>
      )
    if (key === 'spot')
      return (
        <div className="su-grid">
          <label className="su-check-lbl full">
            <input
              type="checkbox"
              checked={data.meta.spotOn}
              onChange={(e) => setMeta({ spotOn: e.target.checked }, 0)}
            />
            Include a spotlight in this month’s email
          </label>
          {metaInput('spotTitle', 'Title', 'e.g. Get more out of RO Student Details')}
          {metaInput('spotLink', 'Link (optional)', 'https://…')}
          <label className="su-lbl full">
            Text
            <textarea
              id="su-m-spotBody"
              className="text-input"
              rows={3}
              value={data.meta.spotBody}
              placeholder="Two or three sentences: what it is, who it helps, and one tip for using it."
              onChange={(e) => setMeta({ spotBody: e.target.value })}
            />
          </label>
          <div className="su-lbl full">
            Image (optional)
            <div className="su-img-row">
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                aria-label="Spotlight image"
                onChange={pickImage}
              />
              {data.spotImg && (
                <button
                  className="btn"
                  onClick={() => {
                    change({ spotImg: null }, 0)
                    setToast('Image removed.')
                  }}
                >
                  Remove image
                </button>
              )}
            </div>
            {data.spotImg && <img className="su-img-prev" src={data.spotImg.data} alt="Spotlight image preview" />}
            <span className="su-hint">
              A screenshot of the dashboard works well. It’s resized automatically and shows above the title, linked
              to the dashboard if you added a link.
            </span>
          </div>
        </div>
      )
    if (key === 'statuses')
      return (
        <div className="su-st-panel">
          <div className="su-st-list">
            {data.statuses.map((st, n) => {
              const used = usage(st.name)
              const c = chipColors(st)
              return (
                <div key={n + st.name} className="su-st-row">
                  <span className="su-chip su-swatch" style={chipVars(c)}>
                    {st.name}
                  </span>
                  <input
                    className="text-input"
                    defaultValue={st.name}
                    maxLength={40}
                    aria-label="Status name"
                    onBlur={(e) => renameStatus(n, e.currentTarget)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <label className="su-color">
                    Color
                    <input
                      type="color"
                      value={c.base}
                      list="su-brand-colors"
                      aria-label={`Color for ${st.name}`}
                      onChange={(e) => isHex(e.target.value) && setStatus(n, { color: e.target.value.toUpperCase() })}
                    />
                  </label>
                  <label className="su-check-lbl small">
                    <input
                      type="checkbox"
                      checked={holdFlag(st)}
                      onChange={(e) => setStatus(n, { hold: e.target.checked }, 0)}
                    />
                    On Hold
                  </label>
                  {used ? (
                    <span className="su-used">{used} in use</span>
                  ) : (
                    <button className="su-del" onClick={() => removeStatus(n)}>
                      Remove
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="su-st-add">
            <input
              id="su-st-new"
              className="text-input"
              value={newName}
              placeholder="New status name, like Blocked or QA Complete"
              aria-label="New status name"
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addStatus()
                }
              }}
            />
            <label className="su-color">
              Color
              <input
                type="color"
                value={newColor}
                list="su-brand-colors"
                aria-label="New status color"
                onChange={(e) => setNewColor(e.target.value)}
              />
            </label>
            <span className="su-chip su-swatch" style={chipVars(chipColors({ color: newColor }))}>
              {newName.trim() || 'Preview'}
            </span>
            <button className="btn" onClick={addStatus}>
              Add status
            </button>
          </div>
          <p className="su-hint">
            Pick any color; the chip gets a light tint with dark text so it stays readable in the email. Renaming a
            status updates every item that uses it. Tick On Hold for statuses that should count toward the On Hold
            tile. A status can be removed once no item uses it.
          </p>
          <datalist id="su-brand-colors">
            {BRAND_COLORS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      )
    if (key === 'issues')
      return (
        <div className="su-issues">
          {issues.length === 0 ? (
            <p className="su-empty">No past issues yet. Start next month saves the current issue here.</p>
          ) : (
            issues.map((x) => {
              const when = new Date(x.archivedAt)
              const delArmed = armed === 'issue:' + x.id
              return (
                <div key={x.id} className="su-issue">
                  <b>{x.month}</b>
                  <span className="su-when">
                    {Number.isNaN(when.getTime())
                      ? ''
                      : `Saved ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
                    {viewing === x.id ? ' · showing in preview' : ''}
                  </span>
                  <span className="su-grow" />
                  <button
                    className="btn"
                    onClick={() => {
                      setViewing(x.id)
                      changePane('preview')
                    }}
                  >
                    View
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      copy(x.html, x.plain, `Copied ${x.month}. In Outlook, paste and choose Keep source formatting.`)
                    }
                  >
                    Copy
                  </button>
                  <button className={`su-del ${delArmed ? 'armed' : ''}`} onClick={() => deleteIssue(x)}>
                    {delArmed ? 'Confirm delete' : 'Delete'}
                  </button>
                </div>
              )
            })
          )}
        </div>
      )
    return (
      <div className="su-data">
        <p className="su-hint">
          Everything here stays on this computer and is part of the library backup. Export saves it all to a file;
          import replaces what’s here with a file exported from this app or from the RO Ops Status Builder.
        </p>
        <div className="su-data-actions">
          <button className="btn" onClick={exportFile}>
            Export to a file
          </button>
          <button className="btn" onClick={importFile}>
            Import from a file
          </button>
        </div>
      </div>
    )
  }

  const pillNote = (key: PanelKey): string =>
    key === 'spot'
      ? data.meta.spotOn
        ? 'On'
        : 'Off'
      : key === 'statuses'
        ? String(data.statuses.length)
        : key === 'issues'
          ? String(data.issues.length)
          : ''

  const shownChecks = checksAll ? checks : checks.slice(0, 3)
  const allShut = SECTIONS.every((s) => collapsed.has(s.key))

  const editor = (
    <section className="su-edit" aria-label="Editor">
      {fresh && (
        <div className="su-callout">
          <span>Starting fresh. Add items below, or bring in an export from the RO Ops Status Builder.</span>
          <button className="btn" onClick={importFile}>
            Import from a file
          </button>
        </div>
      )}
      {rollMonth !== null && (
        <div className="su-roll">
          <h3>Wrap up {data.meta.month.trim() || 'this month'} and start the next month</h3>
          <ul>
            <li>
              Saves {data.meta.month.trim() || 'this month'} exactly as it looks now under Past issues
              {data.issues.some((x) => x.id === slugify(data.meta.month.trim() || 'Untitled month'))
                ? ' (replacing the copy already saved for that month)'
                : ''}
              .
            </li>
            <li>
              Clears the {counts.completed} completed item{counts.completed === 1 ? '' : 's'}. They stay in the saved
              issue.
            </li>
            <li>
              Keeps In Progress and New Requests, and remembers their current notes so next month’s check can flag
              anything not updated.
            </li>
            <li>Turns the spotlight off. Hidden sections stay hidden.</li>
          </ul>
          <div className="su-roll-actions">
            <label className="su-lbl">
              New month
              <input
                id="su-ro-month"
                className="text-input"
                value={rollMonth}
                placeholder="e.g. November 2026"
                onChange={(e) => setRollMonth(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startNextMonth()}
              />
            </label>
            <button className="btn btn-primary" onClick={startNextMonth}>
              Save and start new month
            </button>
            <button className="btn" onClick={() => setRollMonth(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className={`su-checks ${checks.length ? '' : 'ok'}`} aria-live="polite">
        {checks.length === 0 ? (
          <>
            <b>Ready to send</b>
            Nothing flagged. Every item has notes, new dashboards have links, and in-progress notes have been updated.
          </>
        ) : (
          <>
            <b>
              {checks.length} {checks.length === 1 ? 'thing' : 'things'} to check before sending
            </b>
            <ul>
              {shownChecks.map((x) => (
                <li key={x.focus + x.text}>
                  <button
                    onClick={() => {
                      if (x.panel) setPanel(x.panel)
                      if (x.section) setCollapse(x.section, false)
                      changePane('edit')
                      focusAfter.current = { id: x.focus }
                      rerender()
                    }}
                  >
                    {x.text}
                  </button>
                </li>
              ))}
            </ul>
            {checks.length > 3 && (
              <button className="link-btn su-checks-more" onClick={() => setChecksAll(!checksAll)}>
                {checksAll ? 'Show fewer' : `Show ${checks.length - 3} more`}
              </button>
            )}
          </>
        )}
      </div>
      <div className="su-stats">
        {(
          [
            ['Completed', counts.completed, 'completed'],
            ['In Progress', counts.progress, 'progress'],
            ['On Hold', counts.hold, 'progress'],
            ['New Requests', counts.fresh, 'new']
          ] as const
        ).map(([l, n, key]) => (
          <button key={l} className="su-stat" onClick={() => jumpTo(key)} title={`Go to ${secOf(key).label}`}>
            <b>{n}</b>
            <span>{l}</span>
          </button>
        ))}
      </div>

      <div className="su-pills" role="group" aria-label="Email settings">
        {PANELS.map((p) => {
          const note = pillNote(p.key)
          return (
            <button
              key={p.key}
              className={`su-pill ${panel === p.key ? 'active' : ''}`}
              aria-expanded={panel === p.key}
              onClick={() => setPanel(panel === p.key ? null : p.key)}
            >
              {p.label}
              {note && <span className="su-pill-n">{note}</span>}
            </button>
          )
        })}
      </div>
      {panel && (
        <div className="su-panel">
          <div className="su-panel-head">
            <b>{PANELS.find((p) => p.key === panel)!.label}</b>
            <span className="su-hint">{PANELS.find((p) => p.key === panel)!.hint}</span>
            <span className="su-grow" />
            <button className="mailc-ic" onClick={() => setPanel(null)} aria-label="Close">
              ×
            </button>
          </div>
          {panelBody(panel)}
        </div>
      )}

      <div className="su-items-bar">
        <span>Items</span>
        <button
          className="link-btn"
          onClick={() => {
            for (const s of SECTIONS) setCollapse(s.key, !allShut)
          }}
        >
          {allShut ? 'Expand all' : 'Collapse all'}
        </button>
      </div>
      {SECTIONS.map((sec) => {
        const list = sectionItems(data.items, sec.key)
        const hid = isHidden(data, sec.key)
        const shut = collapsed.has(sec.key)
        const flagged = checks.filter((c) => c.section === sec.key).length
        return (
          <section
            key={sec.key}
            id={`su-sec-${sec.key}`}
            className={`su-section ${hid ? 'is-hidden' : ''} ${shut ? 'shut' : ''}`}
            aria-labelledby={`su-h-${sec.key}`}
          >
            <div className="su-section-head">
              <h3 id={`su-h-${sec.key}`}>
                <button className="su-fold" aria-expanded={!shut} onClick={() => setCollapse(sec.key, !shut)}>
                  <span className="su-chev" aria-hidden="true">
                    ›
                  </span>
                  {sec.label}
                  <span className="su-count">{list.length}</span>
                </button>
              </h3>
              {flagged > 0 && (
                <span className="su-flagged" title="Items here are on the list to check before sending">
                  {flagged} to check
                </span>
              )}
              {hid && <span className="su-hidden-tag">Hidden from email</span>}
              <span className="su-grow" />
              <button className="btn btn-ghost su-vis" aria-pressed={hid} onClick={() => toggleHidden(sec.key)}>
                {hid ? 'Show in email' : 'Hide from email'}
              </button>
              <button className="btn" onClick={() => addItem(sec.key)}>
                + Add item
              </button>
            </div>
            {!shut && <div className="su-section-body">{sectionBody(sec, list)}</div>}
          </section>
        )
      })}
    </section>
  )

  const preview = (
    <section className="su-preview" aria-label="Email preview">
      <div className="su-preview-head">
        {issue ? (
          <>
            <b className="su-viewing">Viewing past issue: {issue.month}</b>
            <span className="su-preview-actions">
              <button
                className="btn"
                onClick={() =>
                  copy(
                    issue.html,
                    issue.plain,
                    `Copied ${issue.month}. In Outlook, paste and choose Keep source formatting.`
                  )
                }
              >
                Copy this issue
              </button>
              <button className="btn" onClick={() => setViewing(null)}>
                Back to current
              </button>
            </span>
          </>
        ) : (
          <>
            <h3>Email preview</h3>
            <span>Click any name or note to edit it here. This is exactly what gets copied.</span>
          </>
        )}
      </div>
      {issue ? (
        <div className="su-email" onClick={previewClick} dangerouslySetInnerHTML={{ __html: issue.html }} />
      ) : (
        <div
          ref={previewRef}
          className="su-email editable"
          onClick={previewClick}
          onFocus={previewFocus}
          onBlur={previewBlur}
          onInput={previewInput}
          onKeyDown={previewKey}
          dangerouslySetInnerHTML={previewHtml}
        />
      )}
    </section>
  )

  return (
    <div className="tkr su" ref={rootRef}>
      {toolbar}
      <div className={`su-work ${narrow ? 'narrow' : ''}`}>
        {(!narrow || pane === 'edit') && editor}
        {(!narrow || pane === 'preview') && preview}
      </div>
      {toast && (
        <div className="su-toast" role="status">
          {toast}
        </div>
      )}
      {confirmEl}
    </div>
  )
}
