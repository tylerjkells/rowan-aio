import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { basename } from 'path'
import { getSettings } from './settings'
import type { MicApp } from '../shared/types'

// ---------------------------------------------------------------------------
// Call detection. Windows keeps a per-app record of microphone use (the same
// data behind the mic icon in the taskbar): every app that has used the mic
// has a key under ConsentStore\microphone, and LastUsedTimeStop reads 0 while
// it is holding the mic right now. Polling that tells us when Webex, Teams,
// Zoom or a browser call starts and stops, without touching any audio.
//
// Only transitions seen while the app is running count as a call starting
// or ending: an app that crashed mid-call can leave a stale "in use" entry
// behind for good, and that must never look like a live call.
// ---------------------------------------------------------------------------

const KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
const POLL_MS = 4000
/** Windows FILETIME (100ns ticks since 1601) of the Unix epoch */
const FILETIME_EPOCH = 116444736000000000n

/** audio-chain tools that hold the mic all day; never a call */
const ALWAYS_IGNORED =
  /nvidia broadcast|nvidiabroadcast|rtx voice|krisp|voicemeeter|steelseries|sonar|wavelink|wave link|elgato|nahimic|realtek|dolby|maxxaudio|voiceaccess|speechruntime|cortana|soundrecorder|voicerecorder|obs64|obs32/i

const KNOWN: [RegExp, string][] = [
  [/webex|ciscocollab|atmgr|ptoneclk/i, 'Webex'],
  [/ms-teams|msteams|\bteams\b/i, 'Teams'],
  [/zoom/i, 'Zoom'],
  [/msedgewebview/i, 'Edge WebView'],
  [/msedge|microsoftedge/i, 'Edge'],
  [/chrome/i, 'Chrome'],
  [/firefox/i, 'Firefox'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/skype/i, 'Skype'],
  [/gotomeeting|g2m|goto\b/i, 'GoTo'],
  [/ringcentral/i, 'RingCentral'],
  [/whatsapp/i, 'WhatsApp'],
  [/phonelink|yourphone/i, 'Phone Link']
]

/** "C:#Program Files#Webex#CiscoCollabHost.exe" or "MSTeams_8wekyb3d8bbwe" → "Webex" / "Teams" */
export function micAppName(id: string): string {
  const leaf = id.split('#').pop() ?? id
  const known = KNOWN.find(([re]) => re.test(leaf))
  if (known) return known[1]
  const bare = leaf
    .replace(/\.exe$/i, '')
    .replace(/_[a-z0-9]{13}$/i, '') // packaged-app publisher hash
    .replace(/^Microsoft\./, '')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

interface Entry {
  start: bigint
  stop: bigint
}

/** reg.exe output → registry key → its LastUsedTime pair */
function parseRegOutput(out: string): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  let current: string | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      current = line.trim()
      continue
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line)
    if (!m || !current) continue
    const e = entries.get(current) ?? { start: 0n, stop: 0n }
    const v = BigInt(m[2])
    if (/start/i.test(m[1])) e.start = v
    else e.stop = v
    entries.set(current, e)
  }
  return entries
}

function inUse(e: Entry): boolean {
  return e.start > 0n && (e.stop === 0n || e.start > e.stop)
}

function filetimeMs(ft: bigint): number {
  return ft > FILETIME_EPOCH ? Number((ft - FILETIME_EPOCH) / 10000n) : Date.now()
}

/** the key's own name: an exe path with # for \, or a packaged app family */
function entryId(key: string): string {
  const parts = key.split('\\')
  return parts[parts.length - 1]
}

const ownExe = basename(process.execPath).toLowerCase()

function ignored(id: string, name: string, mine: string[]): boolean {
  const leaf = (id.split('#').pop() ?? id).toLowerCase()
  if (leaf === ownExe) return true
  if (ALWAYS_IGNORED.test(leaf) || ALWAYS_IGNORED.test(name)) return true
  return mine.some((t) => name.toLowerCase().includes(t) || leaf.includes(t))
}

export interface MicChange {
  /** every app holding the mic now (ignored ones left out) */
  active: MicApp[]
  /** apps seen picking the mic up since the last poll */
  started: MicApp[]
  /** apps seen letting it go since the last poll */
  stopped: MicApp[]
  /**
   * ids already holding the mic when watching began and never seen letting
   * go: possibly a real call, possibly a stale entry left by a crash
   */
  doubtful: string[]
}

let active = new Map<string, MicApp>()
/** keys already in use at the first poll: maybe real, maybe stale */
let baseline: Set<string> | null = null
let timer: NodeJS.Timeout | null = null
const listeners: ((c: MicChange) => void)[] = []

export function onMicChange(fn: (c: MicChange) => void): void {
  listeners.push(fn)
}

/** apps holding the mic right now, as of the last poll */
export function micApps(): MicApp[] {
  return [...active.values()]
}

/** the current picture, for a window that just opened */
export function micState(): MicChange {
  return { active: micApps(), started: [], stopped: [], doubtful: doubtfulIds() }
}

function doubtfulIds(): string[] {
  return baseline ? [...baseline].filter((id) => active.has(id)) : []
}

function readRegistry(): Promise<Map<string, Entry>> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', KEY, '/s'],
      { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? new Map() : parseRegOutput(String(stdout)))
    )
  })
}

async function poll(): Promise<void> {
  const entries = await readRegistry()
  const mine = getSettings().micIgnoreApps.map((t) => t.toLowerCase())
  const next = new Map<string, MicApp>()
  for (const [key, e] of entries) {
    if (!inUse(e)) continue
    const id = entryId(key)
    const name = micAppName(id)
    if (ignored(id, name, mine)) continue
    next.set(id, active.get(id) ?? { id, name, since: filetimeMs(e.start) })
  }

  if (baseline === null) {
    baseline = new Set(next.keys())
    active = next
    broadcast(micState())
    return
  }

  const started = [...next.values()].filter((a) => !active.has(a.id))
  const stopped = [...active.values()].filter((a) => !next.has(a.id))
  // an entry that drops out was real after all; it no longer needs the doubt
  for (const a of stopped) baseline.delete(a.id)
  active = next
  if (started.length || stopped.length) {
    broadcast({ active: micApps(), started, stopped, doubtful: doubtfulIds() })
  }
}

function broadcast(change: MicChange): void {
  for (const fn of listeners) {
    try {
      fn(change)
    } catch {
      // one listener failing must not stop the others
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('mic:state', change)
  }
}

export function startMicWatch(): void {
  if (process.platform !== 'win32' || timer) return
  const tick = (): void => {
    poll()
      .catch(() => {})
      .finally(() => {
        timer = setTimeout(tick, POLL_MS)
      })
  }
  tick()
}
