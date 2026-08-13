import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings, AppTheme, WhisperModel } from '../shared/types'

interface StoredSettings {
  whisperModel: WhisperModel
  claudeModel: string
  autoSummarize: boolean
  recordNudge: boolean
  autoEndSilence: boolean
  autoEndSilenceMinutes: number
  autoEndOverrun: boolean
  autoEndOverrunMinutes: number
  theme: AppTheme
  vocabulary: string
  closeToTray: boolean
  launchAtLogin: boolean
  recordHotkey: boolean
  backupFolder: string | null
  backupSkipAudio: boolean
  /** epoch ms of the last automatic backup */
  lastBackupAt: number
  people: string[]
  /** the user's own name, so "Tyler" in a meeting resolves to Me */
  yourName: string
  /** identity merges: normalized raw name -> canonical display name */
  personAliases: Record<string, string>
  /** base64 of safeStorage-encrypted API key */
  apiKeyEncrypted: string | null
  /** base64 of safeStorage-encrypted iCal feed URL (the URL is a secret) */
  calendarUrlEncrypted: string | null
}

const DEFAULTS: StoredSettings = {
  whisperModel: 'small.en',
  claudeModel: 'claude-haiku-4-5',
  autoSummarize: true,
  recordNudge: true,
  autoEndSilence: true,
  autoEndSilenceMinutes: 10,
  autoEndOverrun: true,
  autoEndOverrunMinutes: 15,
  theme: 'studio',
  vocabulary: '',
  closeToTray: true,
  launchAtLogin: false,
  recordHotkey: true,
  backupFolder: null,
  backupSkipAudio: true,
  lastBackupAt: 0,
  people: [],
  yourName: '',
  personAliases: {},
  apiKeyEncrypted: null,
  calendarUrlEncrypted: null
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: StoredSettings | null = null

function load(): StoredSettings {
  if (cache) return cache
  try {
    if (existsSync(settingsPath())) {
      cache = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf-8')) }
      return cache!
    }
  } catch {
    // corrupted settings fall back to defaults
  }
  cache = { ...DEFAULTS }
  return cache
}

function persist(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2))
}

export function getSettings(): AppSettings {
  const s = load()
  return {
    whisperModel: s.whisperModel,
    claudeModel: s.claudeModel,
    autoSummarize: s.autoSummarize,
    recordNudge: s.recordNudge !== false,
    autoEndSilence: s.autoEndSilence !== false,
    autoEndSilenceMinutes: clampMinutes(s.autoEndSilenceMinutes, DEFAULTS.autoEndSilenceMinutes),
    autoEndOverrun: s.autoEndOverrun !== false,
    autoEndOverrunMinutes: clampMinutes(s.autoEndOverrunMinutes, DEFAULTS.autoEndOverrunMinutes),
    theme: s.theme ?? 'studio',
    vocabulary: s.vocabulary ?? '',
    closeToTray: s.closeToTray !== false,
    launchAtLogin: s.launchAtLogin === true,
    recordHotkey: s.recordHotkey !== false,
    backupFolder: s.backupFolder ?? null,
    backupSkipAudio: s.backupSkipAudio !== false,
    people: s.people ?? [],
    yourName: s.yourName ?? '',
    personAliases: s.personAliases ?? {},
    hasApiKey: !!s.apiKeyEncrypted,
    hasCalendar: !!s.calendarUrlEncrypted
  }
}

/** auto-end delays are minutes; keep them sane whatever lands in the file */
const MIN_AUTO_END_MINUTES = 1
const MAX_AUTO_END_MINUTES = 240

function clampMinutes(value: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_AUTO_END_MINUTES, Math.max(MIN_AUTO_END_MINUTES, n))
}

export function updateSettings(
  patch: Partial<
    Pick<
      AppSettings,
      | 'whisperModel'
      | 'claudeModel'
      | 'autoSummarize'
      | 'recordNudge'
      | 'autoEndSilence'
      | 'autoEndSilenceMinutes'
      | 'autoEndOverrun'
      | 'autoEndOverrunMinutes'
      | 'theme'
      | 'vocabulary'
      | 'closeToTray'
      | 'launchAtLogin'
      | 'recordHotkey'
      | 'backupFolder'
      | 'backupSkipAudio'
      | 'people'
      | 'yourName'
    >
  >
): AppSettings {
  const s = load()
  if (patch.whisperModel) s.whisperModel = patch.whisperModel
  if (patch.claudeModel) s.claudeModel = patch.claudeModel
  if (typeof patch.autoSummarize === 'boolean') s.autoSummarize = patch.autoSummarize
  if (typeof patch.recordNudge === 'boolean') s.recordNudge = patch.recordNudge
  if (typeof patch.autoEndSilence === 'boolean') s.autoEndSilence = patch.autoEndSilence
  if (patch.autoEndSilenceMinutes !== undefined) {
    s.autoEndSilenceMinutes = clampMinutes(
      patch.autoEndSilenceMinutes,
      DEFAULTS.autoEndSilenceMinutes
    )
  }
  if (typeof patch.autoEndOverrun === 'boolean') s.autoEndOverrun = patch.autoEndOverrun
  if (patch.autoEndOverrunMinutes !== undefined) {
    s.autoEndOverrunMinutes = clampMinutes(
      patch.autoEndOverrunMinutes,
      DEFAULTS.autoEndOverrunMinutes
    )
  }
  if (patch.theme) s.theme = patch.theme
  if (typeof patch.vocabulary === 'string') s.vocabulary = patch.vocabulary.trim()
  if (typeof patch.closeToTray === 'boolean') s.closeToTray = patch.closeToTray
  if (typeof patch.launchAtLogin === 'boolean') s.launchAtLogin = patch.launchAtLogin
  if (typeof patch.recordHotkey === 'boolean') s.recordHotkey = patch.recordHotkey
  if (patch.backupFolder !== undefined) s.backupFolder = patch.backupFolder
  if (typeof patch.backupSkipAudio === 'boolean') s.backupSkipAudio = patch.backupSkipAudio
  if (Array.isArray(patch.people)) {
    s.people = dedupeNames(patch.people)
  }
  if (typeof patch.yourName === 'string') s.yourName = patch.yourName.trim()
  persist()
  return getSettings()
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = String(raw).trim()
    const key = name.toLowerCase()
    if (!name || key === 'me' || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export function getLastBackupAt(): number {
  return load().lastBackupAt ?? 0
}

export function setLastBackupAt(ms: number): void {
  const s = load()
  s.lastBackupAt = ms
  persist()
}

/** Add someone to the team directory (used when assigning a new name). */
export function addPerson(name: string): void {
  const trimmed = name.trim()
  if (!trimmed || trimmed.toLowerCase() === 'me') return
  // compound or qualified strings ("A and B", "Carol (maybe)") are not directory names
  if (/[()&+/,]|\b(and|or)\b/i.test(trimmed)) return
  const s = load()
  if ((s.people ?? []).some((p) => p.toLowerCase() === trimmed.toLowerCase())) return
  s.people = dedupeNames([...(s.people ?? []), trimmed])
  persist()
}

/** Remove someone from the team directory (their meeting history is untouched). */
export function removePerson(name: string): void {
  const key = name.trim().toLowerCase()
  if (!key) return
  const s = load()
  s.people = (s.people ?? []).filter((p) => p.toLowerCase() !== key)
  persist()
}

/**
 * Record that one name is really another person (a merge from the People
 * page). The alias applies at read time everywhere identities are resolved.
 */
export function addPersonAlias(from: string, to: string): void {
  const key = from.trim().toLowerCase()
  const target = to.trim()
  if (!key || !target || key === target.toLowerCase()) return
  const s = load()
  s.personAliases = { ...(s.personAliases ?? {}), [key]: target }
  // the merged-away spelling should no longer be offered in the directory
  s.people = (s.people ?? []).filter((p) => p.toLowerCase() !== key)
  if (target.toLowerCase() !== 'me') {
    if (!s.people.some((p) => p.toLowerCase() === target.toLowerCase())) {
      s.people = dedupeNames([...s.people, target])
    }
  }
  persist()
}

export function setApiKey(key: string | null): AppSettings {
  const s = load()
  if (!key) {
    s.apiKeyEncrypted = null
  } else if (safeStorage.isEncryptionAvailable()) {
    s.apiKeyEncrypted = safeStorage.encryptString(key.trim()).toString('base64')
  } else {
    // last-resort fallback: obfuscated, not secure — safeStorage is available on
    // any normal Windows login session so this path should not be hit in practice
    s.apiKeyEncrypted = 'plain:' + Buffer.from(key.trim()).toString('base64')
  }
  persist()
  return getSettings()
}

export function getApiKey(): string | null {
  const s = load()
  return decryptStored(s.apiKeyEncrypted)
}

export function setCalendarUrl(url: string | null): AppSettings {
  const s = load()
  if (!url) {
    s.calendarUrlEncrypted = null
  } else if (safeStorage.isEncryptionAvailable()) {
    s.calendarUrlEncrypted = safeStorage.encryptString(url.trim()).toString('base64')
  } else {
    s.calendarUrlEncrypted = 'plain:' + Buffer.from(url.trim()).toString('base64')
  }
  persist()
  return getSettings()
}

export function getCalendarUrl(): string | null {
  const s = load()
  return decryptStored(s.calendarUrlEncrypted)
}

function decryptStored(value: string | null): string | null {
  if (!value) return null
  try {
    if (value.startsWith('plain:')) {
      return Buffer.from(value.slice(6), 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}
