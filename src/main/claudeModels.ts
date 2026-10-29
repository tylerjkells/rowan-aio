import Anthropic from '@anthropic-ai/sdk'
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getApiKey } from './settings'
import {
  CLAUDE_FALLBACK,
  CLAUDE_FAMILIES,
  familyOf,
  type ClaudeFamily,
  type ClaudeLineup
} from '../shared/claudeModels'

// ---------------------------------------------------------------------------
// The newest Claude model in each family, so the app never sits on an old
// one. Once a day (and whenever the API key changes) it asks Anthropic's
// Models API what this key can use and keeps the newest Haiku, Sonnet and
// Opus in userData/claude-models.json. Until then, or offline, it uses the
// newest it knew of when it was built.
// ---------------------------------------------------------------------------

const DAY_MS = 864e5

interface LineupFile {
  checkedAt: string
  lineup: ClaudeLineup
}

function file(): string {
  return join(app.getPath('userData'), 'claude-models.json')
}

let cache: LineupFile | null = null

function load(): LineupFile | null {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as LineupFile
  } catch {
    cache = null
  }
  return cache
}

/** the newest model in each family: what the Models API last reported, else this build's */
export function claudeLineup(): ClaudeLineup {
  const known = load()?.lineup
  const out = { ...CLAUDE_FALLBACK }
  for (const f of CLAUDE_FAMILIES) if (known?.[f]?.id) out[f] = known[f]
  return out
}

/**
 * The model to call for a choice: a family runs on its newest model, and so
 * does a version saved before families existed. Anything else (a model
 * outside the three, or another provider's) is used as given.
 */
export function resolveClaudeModel(choice: string): string {
  const family = familyOf(choice)
  return family ? claudeLineup()[family].id : choice
}

let inflight: Promise<ClaudeLineup> | null = null

/** Ask the Models API for the newest of each family; at most daily unless forced. Never throws. */
export function refreshClaudeLineup(force = false): Promise<ClaudeLineup> {
  const last = load()
  if (!force && last && Date.now() - Date.parse(last.checkedAt) < DAY_MS) return Promise.resolve(claudeLineup())
  inflight ??= (async () => {
    const apiKey = getApiKey()
    if (!apiKey) return claudeLineup()
    try {
      const newest: Partial<Record<ClaudeFamily, { id: string; name: string; at: number }>> = {}
      for await (const m of new Anthropic({ apiKey }).models.list()) {
        // only the three lines, by their own name: claude-haiku-…, claude-sonnet-…, claude-opus-…
        const family = /^claude-(haiku|sonnet|opus)-/.exec(m.id)?.[1] as ClaudeFamily | undefined
        if (!family) continue
        const at = Date.parse(m.created_at)
        if (!newest[family] || at > newest[family]!.at) newest[family] = { id: m.id, name: m.display_name, at }
      }
      const lineup = { ...claudeLineup() }
      for (const f of CLAUDE_FAMILIES) {
        const n = newest[f]
        if (n) lineup[f] = { id: n.id, name: n.name }
      }
      cache = { checkedAt: new Date().toISOString(), lineup }
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file(), JSON.stringify(cache, null, 2))
    } catch {
      // offline or the key was refused: keep what's known, try again next time
    }
    return claudeLineup()
  })().finally(() => {
    inflight = null
  })
  return inflight
}
